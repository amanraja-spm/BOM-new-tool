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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/prices") {
    const region = u.searchParams.get("region") || "centralindia";
    const currency = u.searchParams.get("currency") || "INR";
    const debug = u.searchParams.get("debug") === "1";
    const list = u.searchParams.get("list") || "";

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
