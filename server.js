const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());

const ROADSYNC_API_KEY = process.env.ROADSYNC_API_KEY;
const ROADSYNC_BROKER_ID = process.env.ROADSYNC_BROKER_ID;

const RSPAY_BASE_URL =
  process.env.ROADSYNC_BASE_URL || "https://api.roadsync.app/rspay/v1";

const ADVANCE_BASE_URL =
  process.env.ROADSYNC_ADVANCE_BASE_URL || "https://advance.roadsync.app/v1";

const SEARCH_LIMIT = 150;
const MAX_TRANSACTION_PAGES = 5;

if (!ROADSYNC_API_KEY) throw new Error("Missing ROADSYNC_API_KEY");
if (!ROADSYNC_BROKER_ID) throw new Error("Missing ROADSYNC_BROKER_ID");

function maskKey(key) {
  const str = String(key || "");
  return str.length > 8 ? `${str.slice(0, 4)}...${str.slice(-4)}` : "****";
}

async function apiGet(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`RoadSync API error ${res.status}: ${text}`);
    err.status = res.status;
    err.url = url;
    err.responseText = text;
    throw err;
  }

  return JSON.parse(text);
}

// 🔹 ADVANCE (Payee lookup)
async function advanceGet(endpoint) {
  return apiGet(`${ADVANCE_BASE_URL}${endpoint}`, {
    "x-api-key": ROADSYNC_API_KEY,
    "Content-Type": "application/json"
  });
}

// 🔹 RSPAY (Transactions)
async function rspayGet(endpoint) {
  return apiGet(`${RSPAY_BASE_URL}${endpoint}`, {
    "x-api-key": ROADSYNC_API_KEY,
    "broker-id": String(ROADSYNC_BROKER_ID),
    "Content-Type": "application/json"
  });
}

// ✅ ROOT FIX (prevents "Cannot GET /")
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ✅ HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    apiKeyPresent: true,
    apiKeyMasked: maskKey(ROADSYNC_API_KEY),
    brokerId: ROADSYNC_BROKER_ID,
    advanceUrl: ADVANCE_BASE_URL,
    rspayUrl: RSPAY_BASE_URL
  });
});

// ✅ TEST ADVANCE
app.get("/api/test-advance", async (req, res) => {
  try {
    const dot = req.query.dot || "2117808";
    const data = await advanceGet(`/payee?page=1&search=${dot}`);

    res.json({
      ok: true,
      count: data.items?.length || 0,
      sample: data.items?.[0] || null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      where: "ADVANCE",
      status: err.status,
      error: err.message,
      response: err.responseText
    });
  }
});

// ✅ TEST RSPAY
app.get("/api/test-rspay", async (req, res) => {
  try {
    const ref = req.query.reference || "8a868168";
    const data = await rspayGet(`/transactions?page=1&limit=10&invoice_number=${ref}`);

    res.json({
      ok: true,
      count: data.length || 0,
      sample: data[0] || null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      where: "RSPAY",
      status: err.status,
      error: err.message,
      response: err.responseText
    });
  }
});

// ✅ DEBUG BOTH
app.get("/api/debug-auth", async (req, res) => {
  const result = {
    config: {
      apiKeyMasked: maskKey(ROADSYNC_API_KEY),
      brokerId: ROADSYNC_BROKER_ID
    },
    advance: null,
    rspay: null
  };

  try {
    const adv = await advanceGet(`/payee?page=1&search=2117808`);
    result.advance = { ok: true, count: adv.items?.length || 0 };
  } catch (e) {
    result.advance = { ok: false, error: e.message };
  }

  try {
    const rsp = await rspayGet(`/transactions?page=1&limit=5`);
    result.rspay = { ok: true, count: rsp.length || 0 };
  } catch (e) {
    result.rspay = { ok: false, error: e.message };
  }

  res.json(result);
});

// 🔹 START SERVER
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
