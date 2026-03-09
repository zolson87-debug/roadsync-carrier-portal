
const express = require("express");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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
  return res.json();
}

app.get("/api/carrier-lookup", async (req, res) => {
  try {
    const { dot, load } = req.query;

    const payees = await roadsyncGet("/payees");
    const transactions = await roadsyncGet("/transactions");

    const carrier = payees.find(p =>
      (p.dot_number && p.dot_number.toString() === dot)
    );

    if (!carrier) {
      return res.json({ carrier: null, payments: [] });
    }

    const payments = transactions.filter(t =>
      (t.payee_id === carrier.id) &&
      (
        (t.invoice_number && t.invoice_number.toString() === load) ||
        (t.po_number && t.po_number.toString() === load)
      )
    );

    res.json({
      carrier: {
        name: carrier.name,
        dot: carrier.dot_number,
        mc: carrier.mc_number,
        payment_methods: carrier.available_payment_types || [],
        verified: carrier.verified
      },
      payments
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "lookup_failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
