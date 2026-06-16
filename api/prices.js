// Vercel serverless function: GET /api/prices?region=centralindia&currency=INR
// Proxies the official Azure Retail Prices API (server-side → no browser CORS issue)
// Returns live VM compute prices (on-demand + 1-yr savings plan) AND live unit
// prices for storage / PostgreSQL / monitor meters. Add &debug=1 to inspect matches.

const HOURS = 730;
const VM_SKUS = [
  "Standard_D16ads_v5",
  "Standard_E16ads_v5",
  "Standard_E32ads_v5",
  "Standard_D8ads_v5",
  "Standard_D2as_v4"
];

const cache = {};
const TTL = 12 * 60 * 60 * 1000; // 12h
const BASE = "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview";

async function azQuery(filter, currency) {
  const url = BASE + "&currencyCode='" + currency + "'&$filter=" + encodeURIComponent(filter);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return j.Items || j.items || [];
}

// ── VM compute ──────────────────────────────────────────────────────────
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

// ── Generic meter lookup: cheapest Consumption item matching a filter ─────
async function fetchMeter(filter, currency, extra) {
  let items = (await azQuery(filter, currency)).filter(
    (it) => (it.type || it.priceType) === "Consumption" && it.retailPrice > 0
  );
  if (extra) items = items.filter(extra);
  if (!items.length) return null;
  items.sort((a, b) => a.retailPrice - b.retailPrice);
  const it = items[0];
  return {
    price: it.retailPrice,
    unit: it.unitOfMeasure || "",
    meter: it.meterName || "",
    product: it.productName || ""
  };
}

// ── Storage / DB / Monitor unit prices ────────────────────────────────────
async function fetchServices(region, currency) {
  const svc = {}, debug = {};

  // Blob Hot LRS — data stored per GB/month
  try {
    const m = await fetchMeter(
      "serviceName eq 'Storage' and armRegionName eq '" + region + "'" +
      " and meterName eq 'Hot LRS Data Stored'", currency,
      (it) => /Block Blob/i.test(it.productName || "")
    );
    if (m) { svc.storagePerGB = m.price; debug.storage = m; }
  } catch (e) { debug.storageErr = String(e.message || e); }

  // Log Analytics — pay-as-you-go data ingestion per GB
  try {
    const m = await fetchMeter(
      "serviceName eq 'Log Analytics' and armRegionName eq '" + region + "'" +
      " and meterName eq 'Pay-as-you-go Data Ingestion'", currency
    );
    if (m) { svc.monitorPerGB = m.price; debug.monitor = m; }
  } catch (e) { debug.monitorErr = String(e.message || e); }

  // PostgreSQL Flexible Server — D2s v3 General Purpose compute (per hour)
  try {
    const m = await fetchMeter(
      "serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '" + region + "'", currency,
      (it) => /Flexible/i.test(it.productName || "") &&
              /General Purpose/i.test(it.productName || "") &&
              /D2s? v3|D2ds? v4|2 v[Cc]ore/i.test((it.meterName || "") + (it.productName || ""))
    );
    if (m) { svc.pgComputeHourly = m.price; debug.pgCompute = m; }
  } catch (e) { debug.pgComputeErr = String(e.message || e); }

  // PostgreSQL Flexible Server — storage per GB/month
  try {
    const m = await fetchMeter(
      "serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '" + region + "'", currency,
      (it) => /Flexible/i.test(it.productName || "") && /Storage/i.test(it.meterName || "")
    );
    if (m) { svc.pgStoragePerGB = m.price; debug.pgStorage = m; }
  } catch (e) { debug.pgStorageErr = String(e.message || e); }

  return { svc, debug };
}

async function getPrices(region, currency) {
  const key = region + "|" + currency;
  if (cache[key] && Date.now() - cache[key].at < TTL) return cache[key].data;

  const vm = {};
  for (const sku of VM_SKUS) {
    try { const x = await fetchSku(sku, region, currency); if (x) vm[sku] = x; }
    catch (e) { /* skip */ }
  }
  let svc = {}, debug = {};
  try { const s = await fetchServices(region, currency); svc = s.svc; debug = s.debug; }
  catch (e) { debug.svcErr = String(e.message || e); }

  const data = {
    provider: "azure", region, currency, hours: HOURS,
    vm, svc, debug,
    updated: new Date().toISOString(),
    source: Object.keys(vm).length ? "live" : "empty"
  };
  cache[key] = { at: Date.now(), data };
  return data;
}

module.exports = async (req, res) => {
  let region = "centralindia", currency = "INR", debug = false, list = "";
  try {
    if (req.query) {
      region = req.query.region || region;
      currency = req.query.currency || currency;
      debug = String(req.query.debug || "") === "1";
      list = req.query.list || "";
    } else {
      const u = new URL(req.url, "http://localhost");
      region = u.searchParams.get("region") || region;
      currency = u.searchParams.get("currency") || currency;
      debug = u.searchParams.get("debug") === "1";
      list = u.searchParams.get("list") || "";
    }
  } catch (e) {}

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
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      (res.status ? res.status(200) : res).end(JSON.stringify({ serviceName: list, region, count: out.length, meters: out }));
    } catch (e) {
      (res.status ? res.status(502) : res).end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
    return;
  }

  try {
    const data = await getPrices(region, currency);
    const out = Object.assign({}, data);
    if (!debug) delete out.debug;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    (res.status ? res.status(200) : res).end(JSON.stringify(out));
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    (res.status ? res.status(502) : res).end(JSON.stringify({ source: "error", error: String((e && e.message) || e) }));
  }
};
