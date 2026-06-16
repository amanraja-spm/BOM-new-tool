# Irame — Infrastructure Sizing & BOM Tool

A single-page tool that turns a workload profile into a recommended cloud setup, a
full **Bill of Materials** (8-column Azure-style layout), and a latency projection.
Prices are pulled **live** from the official Azure Retail Prices API, with an
automatic fallback to a baked-in baseline so the tool always works.

## Files

| File             | Purpose                                                             |
|------------------|---------------------------------------------------------------------|
| `index.html`     | The whole tool (UI + logic). Works on its own (baseline prices).    |
| `server.js`      | Tiny zero-dependency Node server: serves the HTML + `/api/prices`.  |
| `api/prices.js`  | Serverless version of the price proxy (for Vercel / similar).       |
| `package.json`   | `npm start` → `node server.js`.                                     |

## Why a server is needed

The browser cannot call the Azure pricing API directly (CORS). A small server-side
**price proxy** (`server.js` or `api/prices.js`) calls Azure server-side and hands the
prices to the page. Without it, the tool still runs — just on baseline prices.

## Run locally

```bash
node server.js
# open http://localhost:3000
```

## Deploy

**Option A — Your own Node host / VPS**

```bash
npm install        # (no deps, but fine to run)
npm start          # node server.js, listens on $PORT or 3000
```

Put it behind nginx and keep it alive with pm2:

```bash
pm2 start server.js --name irame-bom
```

**Option B — Vercel (serverless)**

Import this repo in Vercel and deploy. `index.html` is served statically and
`api/prices.js` runs as the `/api/prices` function automatically. No config needed.

## Notes

- Live prices = current Azure **compute list prices** (Linux, on-demand + 1-year
  savings plan). Storage / DB / monitoring / AI lines are a fixed baseline.
- Currency: ₹ INR primary, with a $ USD toggle (indicative ₹86/$).
- The Azure baseline reproduces the reference estimate exactly
  (₹1,91,652.68 on-demand · ₹1,45,328.00 with 1-yr savings plan).
