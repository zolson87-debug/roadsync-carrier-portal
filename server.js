const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());

const API_KEY = process.env.ROADSYNC_API_KEY;
const BROKER_ID = process.env.ROADSYNC_BROKER_ID;
const BASE_URL = "https://api.roadsync.app/rspay/v1";

function normalize(value) {
  return String(value ?? "").trim().toUpperCase();
}

async function roadsyncGet(endpoint, includeBrokerId = true) {
  const headers = {
    "x-api-key": API_KEY,
    "Content-Type": "application/json"
  };

  if (includeBrokerId && BROKER_ID) {
    headers["broker-id"] = BROKER_ID;
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, { headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RoadSync API error ${res.status}: ${text}`);
  }

  return res.json();
}

function payeeMatchesDotOrMc(payee, dotOrMc) {
  const target = normalize(dotOrMc);
  const candidates = [
    payee?.dot_number,
    payee?.mc_number
  ].map(normalize);

  return candidates.includes(target);
}

// 1) See which brokers this API key is actually linked to
app.get("/api/brokers", async (req, res) => {
  try {
    const brokers = await roadsyncGet("/brokers", false);
    return res.json({
      configuredBrokerId: BROKER_ID,
      brokers
    });
  } catch (err) {
    return res.status(500).json({
      error: "brokers_lookup_failed",
      details: err.message
    });
  }
});

// 2) Test current broker-id against payees + loads
app.get("/api/health", async (req, res) => {
  try {
    const [payees, loads] = await Promise.all([
      roadsyncGet("/payees", true),
      roadsyncGet("/loads", true)
    ]);

    return res.json({
      ok: true,
      configuredBrokerId: BROKER_ID,
      payeesCount: Array.isArray(payees) ? payees.length : null,
      loadsCount: Array.isArray(loads) ? loads.length : null
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      configuredBrokerId: BROKER_ID,
      error: err.message
    });
  }
});

// 3) Search using loads first
app.get("/api/search", async (req, res) => {
  try {
    const { load, dot } = req.query;

    if (!load || !dot) {
      return res.status(400).json({ error: "load_and_dot_required" });
    }

    const [payeesRaw, loadsRaw] = await Promise.all([
      roadsyncGet("/payees", true),
      roadsyncGet("/loads", true)
    ]);

    const payees = Array.isArray(payeesRaw) ? payeesRaw : [];
    const loads = Array.isArray(loadsRaw) ? loadsRaw : [];
    const payeesById = new Map(payees.map(p => [String(p.id), p]));

    const targetLoad = normalize(load);
    const matches = [];

    for (const loadObj of loads) {
      const loadCandidates = [
        loadObj?.id,
        loadObj?.load_number,
        loadObj?.external_id
      ].map(normalize);

      if (!loadCandidates.includes(targetLoad)) continue;

      const carrier =
        (loadObj?.carrier_payee?.id != null && payeesById.get(String(loadObj.carrier_payee.id))) ||
        (loadObj?.payee?.id != null && payeesById.get(String(loadObj.payee.id))) ||
        loadObj?.carrier_payee ||
        loadObj?.payee ||
        null;

      if (!carrier) continue;
      if (!payeeMatchesDotOrMc(carrier, dot)) continue;

      matches.push({
        carrier: {
          name: carrier.payee_name || "",
          dot: carrier.dot_number || "",
          mc: carrier.mc_number || "",
          verified: carrier.is_verified ?? "",
          isFactoringCompany: carrier.is_factoring_company ?? false,
          payment_types: carrier.available_payment_types || []
        },
        payment: {
          loadId: loadObj.id || "",
          loadNumber: loadObj.load_number || "",
          externalId: loadObj.external_id || "",
          amount: loadObj.amount || "",
          loadStatus: loadObj.status || "",
          payableId: loadObj?.payable?.id || "",
          payableStatus: loadObj?.payable?.status || "",
          paymentMethod: loadObj?.payable?.payment_method || loadObj?.payable?.transaction?.payment_method || "",
          transactionId: loadObj?.payable?.transaction?.id || "",
          transactionStatus: loadObj?.payable?.transaction?.status || ""
        }
      });
    }

    if (matches.length === 0) {
      return res.json({
        carrier: null,
        payments: [],
        debug: {
          message: "No matching load found for that DOT/MC and load value under the configured broker-id."
        }
      });
    }

    return res.json({
      carrier: matches[0].carrier,
      payments: matches.map(m => m.payment)
    });
  } catch (err) {
    return res.status(500).json({
      error: "lookup_failed",
      details: err.message
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
