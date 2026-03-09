const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());

const API_KEY = process.env.ROADSYNC_API_KEY;
const BROKER_ID = process.env.ROADSYNC_BROKER_ID;

const BASE_URL = "https://api.roadsync.com/rspay";

async function roadsyncGet(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      "x-api-key": API_KEY,
      "broker-id": BROKER_ID,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt);
  }

  return res.json();
}

function loadMatches(tx, load) {
  const fields = [
    tx.invoice_number,
    tx.po_number,
    tx.reference,
    tx.external_id,
    tx.load_id
  ];

  return fields.some(f => f && f.toString() === load);
}

function dotMatches(payee, dot) {
  const values = [
    payee.dot,
    payee.dot_number,
    payee.usdot,
    payee.usdot_number
  ];

  return values.some(v => v && v.toString() === dot);
}

app.get("/api/search", async (req, res) => {
  try {

    const { load, dot } = req.query;

    if (!load || !dot) {
      return res.status(400).json({ error: "load_and_dot_required" });
    }

    const transactions = await roadsyncGet("/transactions");
    const payees = await roadsyncGet("/payees");

    const matchingTransactions = transactions.filter(tx => loadMatches(tx, load));

    for (const tx of matchingTransactions) {

      const payee = payees.find(p => p.id === tx.payee_id);

      if (!payee) continue;
      if (!dotMatches(payee, dot)) continue;

      return res.json({
        carrier: {
          name: payee.name,
          dot: payee.dot_number || payee.dot,
          mc: payee.mc_number || payee.mc,
          verified: payee.verified,
          payment_types: payee.available_payment_types || []
        },
        payments: [
          {
            status: tx.status,
            amount: tx.amount,
            method: tx.payment_method,
            eta: tx.eta,
            id: tx.id
          }
        ]
      });
    }

    res.json({ carrier: null, payments: [] });

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: "lookup_failed" });

  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Server running on port " + port);
});
