// Vercel serverless function: GET /api/prices?region=centralindia&currency=INR
// Proxies the official Azure Retail Prices API (server-side → no browser CORS issue)
// and returns live compute prices (on-demand + 1-yr savings plan) for our VM SKUs.

const HOURS = 730;
const VM_SKUS = [
  "Standard_D16ads_v5",
  "Standard_E16ads_v5",
  "Standard_E32ads_v5",
  "Standard_D8ads_v5",
  "Standard_D2as_v4"
];

// simple in-memory cache (per warm instance)
const cache = {};
const TTL = 12 * 60 * 60 * 1000; // 12h

async function fetchSku(sku, region, currency) {
  const filter =
    "armRegionName eq '" + region + "' and serviceName eq 'Virtual Machines'" +
    " and armSkuName eq '" + sku + "' and priceType eq 'Consumption'";
  const url =
    "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview" +
    "&currencyCode='" + currency + "'&$filter=" + encodeURIComponent(filter);

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();

  const items = (j.Items || j.items || []).filter((it) => {
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

module.exports = async (req, res) => {
  let region = "centralindia", currency = "INR";
  try {
    if (req.query) {
      region = req.query.region || region;
      currency = req.query.currency || currency;
    } else {
      const u = new URL(req.url, "http://localhost");
      region = u.searchParams.get("region") || region;
      currency = u.searchParams.get("currency") || currency;
    }
  } catch (e) {}

  const key = region + "|" + currency;
  try {
    if (!(cache[key] && Date.now() - cache[key].at < TTL)) {
      const vm = {};
      for (const sku of VM_SKUS) {
        try { const x = await fetchSku(sku, region, currency); if (x) vm[sku] = x; }
        catch (e) { /* skip this SKU */ }
      }
      cache[key] = {
        at: Date.now(),
        data: {
          provider: "azure", region, currency, hours: HOURS, vm,
          updated: new Date().toISOString(),
          source: Object.keys(vm).length ? "live" : "empty"
        }
      };
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(JSON.stringify(cache[key].data));
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.status(502).end(JSON.stringify({ source: "error", error: String((e && e.message) || e) }));
  }
};
