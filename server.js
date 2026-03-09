const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());

const API_KEY = process.env.ROADSYNC_API_KEY;
const BROKER_ID = process.env.ROADSYNC_BROKER_ID;
const BASE_URL = "https://api.roadsync.com/rspay";

function normalize(value) {
  return String(value ?? "").trim().toUpperCase();
}

async function roadsyncGet(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      "x-api-key": API_KEY,
      "broker-id": BROKER_ID,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RoadSync API error ${res.status}: ${text}`);
  }

  return res.json();
}

function matchesDotOrMc(payee, dotOrMc) {
  const target = normalize(dotOrMc);

  const candidates = [
    payee?.dot_number,
    payee?.mc_number
  ].map(normalize);

  return candidates.includes(target);
}

function matchesLoad(loadObj, loadInput) {
  const target = normalize(loadInput);

  const candidates = [
    loadObj?.id,           // sometimes user may paste RoadSync load id
    loadObj?.load_number,  // true load number
    loadObj?.external_id   // external broker reference
  ].map(normalize);

  return candidates.includes(target);
}

app.get("/api/search", async (req, res) => {
  try {
    const { load, dot } = req.query;

    if (!load || !dot) {
      return res.status(400).json({ error: "load_and_dot_required" });
    }

    const loads = await roadsyncGet("/loads");
    const loadList = Array.isArray(loads) ? loads : [];

    const matches = loadList.filter(loadObj => {
      if (!matchesLoad(loadObj, load)) return false;

      // Prefer carrier_payee for carrier validation
      if (loadObj.carrier_payee && matchesDotOrMc(loadObj.carrier_payee, dot)) {
        return true;
      }

      // Fallback to payee (for factors / direct payee situations)
      if (loadObj.payee && matchesDotOrMc(loadObj.payee, dot)) {
        return true;
      }

      return false;
    });

    if (matches.length === 0) {
      return res.json({
        carrier: null,
        payments: [],
        debug: {
          message: "No load matched that DOT/MC + load value."
        }
      });
    }

    const first = matches[0];
    const carrier = first.carrier_payee || first.payee || {};
    const payee = first.payee || {};

    const payments = matches.map(item => ({
      loadId: item.id || "",
      loadNumber: item.load_number || "",
      externalId: item.external_id || "",
      status: item?.payable?.status || item.status || "",
      amount: item?.payable?.amount || item.amount || "",
      method: item?.payable?.payment_method || item?.payable?.transaction?.payment_method || "",
      transactionId: item?.payable?.transaction?.id || "",
      transactionStatus: item?.payable?.transaction?.status || "",
      payableId: item?.payable?.id || ""
    }));

    return res.json({
      carrier: {
        name: carrier.payee_name || payee.payee_name || "",
        dot: carrier.dot_number || payee.dot_number || "",
        mc: carrier.mc_number || payee.mc_number || "",
        verified: carrier.is_verified ?? payee.is_verified ?? "",
        isFactoringCompany: payee.is_factoring_company ?? false,
        payment_types: payee.available_payment_types || []
      },
      payments
    });
  } catch (err) {
    console.error(err);
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
