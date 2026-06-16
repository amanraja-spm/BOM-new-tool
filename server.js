/**
 * Irame — Infrastructure Sizing & BOM Tool — zero-dependency Node server.
 *   node server.js   →   http://localhost:3000
 *
 * Serves index.html and exposes /api/prices, pulling LIVE prices from the
 * official Azure Retail Prices API (VM compute + storage/DB/monitor meters).
 * Falls back to the baked-in baseline in the page if the API is unreachable.
 * Requires Node 18+ (uses global fetch). Add ?debug=1 to inspect meter matches.
 */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT  = process.env.PORT || 3000;
const HTML  = path.join(__dirname, "index.html");
const HOURS = 730;
const BASE  = "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview";

const VM_SKUS = [
  "Standard_D16ads_v5", "Standard_E16ads_v5", "Standard_E32ads_v5",
  "Standard_D8ads_v5", "Standard_D2as_v4"
];

const cache = {};
const TTL = 12 * 60 * 60 * 1000;

async function azQuery(filter, currency) {
  const url = BASE + "&currencyCode='" + currency + "'&$filter=" + encodeURIComponent(filter);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return j.Items || j.items || [];
}

async function fetchSku(sku, region, currency) {
  const filter =
    "armRegionName eq '" + region + "' and serviceName eq 'Virtual Machines'" +
    " and armSkuName eq '" + sku + "' and priceType eq 'Consumption'";
  const items = (await azQuery(filter, currency)).filter((it) => {
    const p = it.productName || "", m = it.meterName || "";
    return !/Windows/i.test(p) && !/Spot|Low Priority/i.test(m);
  });
  if (!items.length) return null;
  items.sort((a, b) => a.retailPrice - b.retailPrice);
  const it = items[0];
  const monthly = it.retailPrice * HOURS;
  let savings = null;
  if (Array.isArray(it.savingsPlan)) {
    const o = it.savingsPlan.find((s) => /1 Year|P1Y/i.test(s.term || ""));
    if (o && typeof o.retailPrice === "number") savings = o.retailPrice * HOURS;
  }
  return { sku, monthly, savings };
}

async function fetchMeter(filter, currency, extra) {
  let items = (await azQuery(filter, currency)).filter(
    (it) => (it.type || it.priceType) === "Consumption" && it.retailPrice > 0
  );
  if (extra) items = items.filter(extra);
  if (!items.length) return null;
  items.sort((a, b) => a.retailPrice - b.retailPrice);
  const it = items[0];
  return { price: it.retailPrice, unit: it.unitOfMeasure || "", meter: it.meterName || "", product: it.productName || "" };
}

async function fetchServices(region, currency) {
  const svc = {}, debug = {};
  const pgFilter = "serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '" + region + "'";
  // Blob Hot LRS — data stored per GB/month
  try {
    const m = await fetchMeter(
      "serviceName eq 'Storage' and armRegionName eq '" + region + "' and meterName eq 'Hot LRS Data Stored'",
      currency, (it) => /Block Blob/i.test(it.productName || ""));
    if (m) { svc.storagePerGB = m.price; debug.storage = m; }
  } catch (e) { debug.storageErr = String(e.message || e); }
  // PostgreSQL Flexible Server, General Purpose Dsv3 (= D2s v3) compute, per vCore/hour
  try {
    const m = await fetchMeter(pgFilter, currency,
      (it) => /Flexible Server General Purpose Dsv3 Series Compute/i.test(it.productName || "") && /vCore/i.test(it.meterName || ""));
    if (m) { svc.pgComputeHourly = m.price; debug.pgCompute = m; }
  } catch (e) { debug.pgComputeErr = String(e.message || e); }
  // PostgreSQL primary storage (Premium SSD v2) per GB/month
  try {
    const m = await fetchMeter(pgFilter, currency,
      (it) => /Flexible Server Storage/i.test(it.productName || "") && /Premium SSD v2 Storage Data Stored/i.test(it.meterName || ""));
    if (m) { svc.pgPrimaryStorageGB = m.price; debug.pgPrimary = m; }
  } catch (e) { debug.pgPrimaryErr = String(e.message || e); }
  // PostgreSQL backup storage (LRS) per GB/month
  try {
    const m = await fetchMeter(pgFilter, currency,
      (it) => /Flexible Server Backup Storage/i.test(it.productName || "") && /Backup Storage LRS Data Stored/i.test(it.meterName || ""));
    if (m) { svc.pgBackupStorageGB = m.price; debug.pgBackup = m; }
  } catch (e) { debug.pgBackupErr = String(e.message || e); }
  return { svc, debug };
}

async function getPrices(region, currency) {
  const key = region + "|" + currency;
  if (cache[key] && Date.now() - cache[key].at < TTL) return cache[key].data;
  const vm = {};
  for (const sku of VM_SKUS) {
    try { const x = await fetchSku(sku, region, currency); if (x) vm[sku] = x; } catch (e) {}
  }
  let svc = {}, debug = {};
  try { const s = await fetchServices(region, currency); svc = s.svc; debug = s.debug; }
  catch (e) { debug.svcErr = String(e.message || e); }
  const data = {
    provider: "azure", region, currency, hours: HOURS, vm, svc, debug,
    updated: new Date().toISOString(), source: Object.keys(vm).length ? "live" : "empty"
  };
  cache[key] = { at: Date.now(), data };
  return data;
}

// ── AWS EC2 live pricing via streamed public price file (memory-safe) ──────
const AWS_FX = 86; // indicative US$1 = ₹86
// Azure-tier → AWS instance mapping (worker tiers + secondary/system pools)
const AWS_INSTANCES = ["m5.4xlarge", "r5.4xlarge", "r5.8xlarge", "m5.2xlarge", "t3.large"];
const AWS_CSV = (region) =>
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/" + region + "/index.csv";
let awsCache = {}; // region -> { at, data }
const AWS_TTL = 24 * 60 * 60 * 1000;

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  }
  out.push(cur); return out;
}

async function getAwsPrices(region) {
  if (awsCache[region] && Date.now() - awsCache[region].at < AWS_TTL) return awsCache[region].data;

  const resp = await fetch(AWS_CSV(region));
  if (!resp.ok || !resp.body) throw new Error("AWS HTTP " + resp.status);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", idx = null;
  const need = new Set(AWS_INSTANCES);
  const found = {};

  function handle(line) {
    if (!line) return;
    if (!idx) { const cols = parseCsvLine(line); if (cols[0] === "SKU") { idx = {}; cols.forEach((c, i) => (idx[c] = i)); } return; }
    let hit = false; for (const it of need) { if (line.indexOf(it) >= 0) { hit = true; break; } }
    if (!hit) return;
    const f = parseCsvLine(line);
    const itype = f[idx["Instance Type"]];
    if (!need.has(itype)) return;
    if (f[idx["TermType"]] !== "OnDemand") return;
    if (f[idx["Operating System"]] !== "Linux") return;
    if (f[idx["Tenancy"]] !== "Shared") return;
    if (f[idx["CapacityStatus"]] !== "Used") return;
    if ((f[idx["Pre Installed S/W"]] || "") !== "NA") return;
    const price = parseFloat(f[idx["PricePerUnit"]]);
    if (!isFinite(price) || price <= 0) return;
    found[itype] = price;
    need.delete(itype);
  }

  let stop = false;
  while (!stop) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      handle(line);
      if (need.size === 0) { stop = true; try { await reader.cancel(); } catch (e) {} break; }
    }
  }
  if (buf && need.size > 0) handle(buf);

  const awsVm = {};
  for (const it in found) {
    const monthly = found[it] * HOURS * AWS_FX;     // INR/month on-demand
    awsVm[it] = { monthly, savings: monthly * 0.65 }; // ~35% off ≈ 1yr Std No-Upfront (indicative)
  }
  const data = {
    provider: "aws", region, currency: "INR", fx: AWS_FX, hours: HOURS,
    awsVm, hourlyUSD: found, updated: new Date().toISOString(),
    source: Object.keys(awsVm).length ? "live" : "empty"
  };
  awsCache[region] = { at: Date.now(), data };
  return data;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/prices") {
    const region = u.searchParams.get("region") || "centralindia";
    const currency = u.searchParams.get("currency") || "INR";
    const debug = u.searchParams.get("debug") === "1";
    const list = u.searchParams.get("list") || "";
    const provider = u.searchParams.get("provider") || "azure";

    // AWS live compute prices (streamed price file; first call is slow, then cached 24h)
    if (provider === "aws") {
      try {
        const data = await getAwsPrices(u.searchParams.get("region") || "ap-south-1");
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ provider: "aws", source: "error", error: String((e && e.message) || e) }));
      }
      return;
    }

    // discovery: GET /api/prices?list=<serviceName> → distinct meters in region
    if (list) {
      try {
        const items = await azQuery("serviceName eq '" + list + "' and armRegionName eq '" + region + "'", currency);
        const seen = {}, out = [];
        items.forEach((it) => {
          if ((it.type || it.priceType) === "Consumption") {
            const k = (it.meterName || "") + " | " + (it.productName || "");
            if (!seen[k]) { seen[k] = 1; out.push({ meter: it.meterName, product: it.productName, price: it.retailPrice, unit: it.unitOfMeasure }); }
          }
        });
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ serviceName: list, region, count: out.length, meters: out }));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
      return;
    }

    try {
      const data = await getPrices(region, currency);
      const out = Object.assign({}, data);
      if (!debug) delete out.debug;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ source: "error", error: String((e && e.message) || e) }));
    }
    return;
  }
  // SAFE AWS feasibility check: HEAD only (no download, no parse, cannot OOM)
  if (u.pathname === "/api/awssize") {
    const region = u.searchParams.get("region") || "ap-south-1";
    const urls = {
      ec2: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/" + region + "/index.json",
      ec2csv: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/" + region + "/index.csv"
    };
    const out = {};
    for (const k in urls) {
      try {
        const r = await fetch(urls[k], { method: "HEAD" });
        const len = parseInt(r.headers.get("content-length") || "0", 10);
        out[k] = { status: r.status, bytes: len, mb: len ? +(len / 1048576).toFixed(1) : null };
      } catch (e) { out[k] = { error: String((e && e.message) || e) }; }
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ region, files: out }));
    return;
  }

  if (u.pathname === "/" || u.pathname === "/index.html") {
    fs.readFile(HTML, (err, buf) => {
      if (err) { res.writeHead(500); res.end("index.html not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("Irame sizing tool running →  http://localhost:" + PORT);
});
