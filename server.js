// server.js (FIXED VERSION)

const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.use(express.json());
app.use(express.static("public"));

const ROADSYNC_API = "https://advance.roadsync.app/v1";
const API_KEY = process.env.ROADSYNC_API_KEY;

// Normalize helper
function normalize(v) {
  return String(v || "").trim().toLowerCase();
}

// Build all possible match candidates from a transaction
function getCandidates(tx) {
  const set = new Set();

  if (tx.reference_id) set.add(normalize(tx.reference_id));
  if (tx.external_id) set.add(normalize(tx.external_id));
  if (tx.id) set.add(normalize(tx.id));

  (tx.payables || []).forEach(p => {
    if (p.invoice_number) set.add(normalize(p.invoice_number));
    if (p.load_id) set.add(normalize(p.load_id));
    if (p.load?.id) set.add(normalize(p.load.id));
    if (p.load?.load_number) set.add(normalize(p.load.load_number));
    if (p.load?.external_id) set.add(normalize(p.load.external_id));
  });

  return set;
}

app.get("/search", async (req, res) => {
  try {
    const { dot, search } = req.query;

    // Step 1: Find payee by DOT
    const payeeRes = await fetch(`${ROADSYNC_API}/payee?page=1&search=${dot}`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    const payeeData = await payeeRes.json();
    const payee = payeeData.items?.[0];

    if (!payee) {
      return res.json({ status: "not_found", message: "DOT not found" });
    }

    // Step 2: Pull recent transactions
    const txRes = await fetch(`${ROADSYNC_API}/transactions?page=1&per_page=50`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    const txData = await txRes.json();
    const transactions = txData;

    const needle = normalize(search);

    let match = null;

    for (const tx of transactions) {
      if (tx.payee_id !== payee.oid) continue;

      const candidates = getCandidates(tx);

      if (!search || candidates.has(needle)) {
        match = tx;
        break;
      }
    }

    if (!match) {
      return res.json({
        status: "not_found",
        message: "We could not find a matching payment or load"
      });
    }

    const payable = match.payables?.[0] || {};
    const load = payable.load || {};

    res.json({
      status: "success",
      payment: {
        amount: match.amount,
        invoice_amount: match.invoice_amount,
        fee: match.fee,
        status: match.status,
        reference_id: match.reference_id,
        created: match.created_datetime,
        load_number: load.load_number,
        load_id: load.id
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
