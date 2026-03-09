const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());

const API_KEY = process.env.ROADSYNC_API_KEY;
const BROKER_ID = process.env.ROADSYNC_BROKER_ID;
const BASE_URL = process.env.ROADSYNC_BASE_URL || "https://api.roadsync.app/rspay/v1";
const TRANSACTION_SEARCH_TEMPLATE =
  process.env.ROADSYNC_TRANSACTION_SEARCH_TEMPLATE ||
  "/transactions?reference_id={{reference_id}}";

if (!API_KEY) throw new Error("Missing ROADSYNC_API_KEY");
if (!BROKER_ID) throw new Error("Missing ROADSYNC_BROKER_ID");

function normalizeIdLike(value) {
  return String(value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function buildTransactionSearchPath(referenceId) {
  return TRANSACTION_SEARCH_TEMPLATE.replace(
    "{{reference_id}}",
    encodeURIComponent(referenceId)
  );
}

async function roadsyncGet(endpoint, includeBrokerId = true) {
  const headers = {
    "x-api-key": API_KEY,
    "Content-Type": "application/json"
  };

  if (includeBrokerId) {
    headers["broker-id"] = String(BROKER_ID);
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, { headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RoadSync API error ${res.status}: ${text}`);
  }

  return res.json();
}

function toArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function dotOrMcMatches(payee, userValue) {
  const target = normalizeIdLike(userValue);

  const candidates = [
    payee?.dot_number,
    payee?.mc_number
  ]
    .map(normalizeIdLike)
    .filter(Boolean);

  return candidates.includes(target);
}

async function loadCandidatePayees(tx) {
  const candidates = [];
  const seen = new Set();

  for (const p of Array.isArray(tx.payables) ? tx.payables : []) {
    const cpId = p?.carrier_payee?.id;

    if (cpId && !seen.has(`id:${cpId}`)) {
      seen.add(`id:${cpId}`);
      try {
        const fullPayee = await roadsyncGet(`/payees/${cpId}`, true);
        candidates.push({
          source: "payables[].carrier_payee",
          payee: fullPayee,
          lookupError: null
        });
      } catch (e) {
        candidates.push({
          source: "payables[].carrier_payee_lookup_failed",
          payee: { id: cpId },
          lookupError: e.message
        });
      }
    }

    if (p?.carrier_payee && !seen.has(`inline-carrier:${p.carrier_payee.id || p.carrier_payee.payee_name}`)) {
      seen.add(`inline-carrier:${p.carrier_payee.id || p.carrier_payee.payee_name}`);
      candidates.push({
        source: "payables[].carrier_payee_inline",
        payee: p.carrier_payee,
        lookupError: null
      });
    }
  }

  if (tx?.payee_id && !seen.has(`id:${tx.payee_id}`)) {
    seen.add(`id:${tx.payee_id}`);
    try {
      const fullPayee = await roadsyncGet(`/payees/${tx.payee_id}`, true);
      candidates.push({
        source: "transaction.payee_id",
        payee: fullPayee,
        lookupError: null
      });
    } catch (e) {
      candidates.push({
        source: "transaction.payee_id_lookup_failed",
        payee: { id: tx.payee_id },
        lookupError: e.message
      });
    }
  }

  if (tx?.payee && !seen.has(`inline-payee:${tx.payee.id || tx.payee.payee_name}`)) {
    seen.add(`inline-payee:${tx.payee.id || tx.payee.payee_name}`);
    candidates.push({
      source: "transaction.payee_inline",
      payee: tx.payee,
      lookupError: null
    });
  }

  return candidates;
}

app.get("/api/search", async (req, res) => {
  try {
    const { dot, reference } = req.query;

    if (!dot || !reference) {
      return res.status(400).json({
        error: "dot_and_reference_required"
      });
    }

    const transactionPath = buildTransactionSearchPath(reference);
    const transactionsRaw = await roadsyncGet(transactionPath, true);
    const transactions = toArray(transactionsRaw);

    if (transactions.length === 0) {
      return res.json({
        carrier: null,
        payments: [],
        debug: {
          message: "No transaction found for that reference ID."
        }
      });
    }

    for (const tx of transactions) {
      const candidatePayees = await loadCandidatePayees(tx);

      let matchedCandidate = null;
      for (const candidate of candidatePayees) {
        if (dotOrMcMatches(candidate.payee, dot)) {
          matchedCandidate = candidate;
          break;
        }
      }

      if (!matchedCandidate) {
        return res.json({
          carrier: null,
          payments: [],
          debug: {
            message: "Reference ID matched a transaction, but DOT/MC did not match any related payee record.",
            transactionId: tx.id,
            referenceId: tx.reference_id || "",
            payeeId: tx.payee_id || "",
            checkedPayeeSources: candidatePayees.map(c => ({
              source: c.source,
              payeeId: c.payee?.id || "",
              payeeName: c.payee?.payee_name || "",
              dot: c.payee?.dot_number || "",
              mc: c.payee?.mc_number || "",
              lookupError: c.lookupError || null
            }))
          }
        });
      }

      const payee = matchedCandidate.payee;
      const payables = Array.isArray(tx.payables) ? tx.payables : [];

      return res.json({
        carrier: {
          name: payee.payee_name || "",
          dot: payee.dot_number || "",
          mc: payee.mc_number || "",
          verified: payee.is_verified ?? "",
          isFactoringCompany: payee.is_factoring_company ?? false,
          payment_types: payee.available_payment_types || []
        },
        payments: [
          {
            transactionId: tx.id || "",
            referenceId: tx.reference_id || "",
            externalId: tx.external_id || "",
            transactionStatus: tx.status || "",
            amount: tx.amount || "",
            paymentMethod: tx.payment_method_v2 || tx?.payment_method?.code || tx?.payment_method || "",
            eta: tx.eta || "",
            createdDatetime: tx.created_datetime || "",
            updatedDatetime: tx.updated_datetime || "",
            matchedPayeeSource: matchedCandidate.source,
            payables: payables.map(p => ({
              payableId: p.id || "",
              payableStatus: p.status || "",
              invoiceNumber: p.invoice_number || "",
              poNumber: p.po_number || "",
              loadId: p.load_id || "",
              loadNumber: p?.load?.load_number || "",
              loadExternalId: p?.load?.external_id || "",
              scheduledForDate: p.scheduled_for_date || "",
              amount: p.amount || ""
            }))
          }
        ]
      });
    }

    return res.json({
      carrier: null,
      payments: [],
      debug: {
        message: "No matching transaction/payee combination found."
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "search_failed",
      details: err.message
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
