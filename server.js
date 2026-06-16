/**
 * Irame — Infrastructure Sizing & BOM Tool
 * Zero-dependency Node backend.
 *
 *   node server.js          → http://localhost:3000
 *
 * Serves the HTML and exposes /api/prices, which pulls LIVE compute prices
 * from the official Azure Retail Prices API (free, public, no auth):
 *   https://prices.azure.com/api/retail/prices
 *
 * If the API is unreachable (offline / firewall / proxy), the UI falls back
 * to the baked-in baseline prices automatically — nothing breaks.
 */

"use strict";

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT = process.env.PORT || 3000;
const HTML = path.join(__dirname, "index.html");
const HOURS = 730; // hours per month for VM monthly cost

// VM SKUs we price live (must match the SKUs used in the HTML)
const VM_SKUS = [
  "Standard_D16ads_v5",
  "Standard_E16ads_v5",
  "Standard_E32ads_v5",
  "Standard_D8ads_v5",
  "Standard_D2as_v4"
];

// in-memory cache: "region|currency" -> { at, data }
const cache = {};
const TTL = 12 * 60 * 60 * 1000; // 12h

function azGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error("bad JSON")); }
        } else {
          reject(new Error("HTTP " + res.statusCode));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

// Fetch on-demand (Linux, consumption) + 1-yr savings-plan price for one SKU
async function fetchSku(sku, region, currency) {
  const filter =
    "armRegionName eq '" + region + "' and serviceName eq 'Virtual Machines'" +
    " and armSkuName eq '" + sku + "' and priceType eq 'Consumption'";
  const url =
    "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview" +
    "&currencyCode='" + currency + "'&$filter=" + encodeURIComponent(filter);

  const json = await azGet(url);
  const items = (json.Items || json.items || []).filter((it) => {
    const p = it.productName || "";
    const m = it.meterName || "";
    // exclude Windows licence meters and Spot / Low-Priority pricing
    return !/Windows/i.test(p) && !/Spot|Low Priority/i.test(m);
  });
  if (!items.length) return null;

  items.sort((a, b) => a.retailPrice - b.retailPrice); // cheapest = Linux compute
  const it = items[0];
  const monthly = it.retailPrice * HOURS;

  let savings = null;
  if (Array.isArray(it.savingsPlan)) {
    const oneYr = it.savingsPlan.find((s) => /1 Year|P1Y/i.test(s.term || ""));
    if (oneYr && typeof oneYr.retailPrice === "number") {
      savings = oneYr.retailPrice * HOURS;
    }
  }
  return { sku, monthly, savings, unit: it.unitOfMeasure || "1 Hour", meter: it.meterName || "" };
}

async function getPrices(region, currency) {
  const key = region + "|" + currency;
  if (cache[key] && Date.now() - cache[key].at < TTL) return cache[key].data;

  const vm = {};
  for (const sku of VM_SKUS) {
    try {
      const r = await fetchSku(sku, region, currency);
      if (r) vm[sku] = r;
    } catch (e) { /* skip this SKU, keep going */ }
  }

  const data = {
    provider: "azure",
    region, currency, hours: HOURS,
    vm,
    updated: new Date().toISOString(),
    source: Object.keys(vm).length ? "live" : "empty"
  };
  cache[key] = { at: Date.now(), data };
  return data;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/api/prices") {
    const region = u.searchParams.get("region") || "centralindia";
    const currency = u.searchParams.get("currency") || "INR";
    try {
      const data = await getPrices(region, currency);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ source: "error", error: String((e && e.message) || e) }));
    }
    return;
  }

  if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/irame-sizing-tool.html") {
    fs.readFile(HTML, (err, buf) => {
      if (err) { res.writeHead(500); res.end("irame-sizing-tool.html not found next to server.js"); return; }
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
  console.log("Live prices via Azure Retail Prices API (falls back to baseline if offline).");
});
