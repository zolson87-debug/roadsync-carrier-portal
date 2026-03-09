const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());

const API_KEY = process.env.ROADSYNC_API_KEY;
const BROKER_ID = process.env.ROADSYNC_BROKER_ID;
const BASE_URL = process.env.ROADSYNC_BASE_URL || "https://api.roadsync.app/rspay/v1";

// Example:
// /transactions?reference_id={{reference_id}}
const TRANSACTION_SEARCH_TEMPLATE =
  process.env.ROADSYNC_TRANSACTION_SEARCH_TEMPLATE ||
  "/transactions?reference_id={{reference_id}}";

if (!API_KEY) throw new Error("Missing ROADSYNC_API_KEY");
if (!BROKER_ID) throw new Error("Missing ROADSYNC_BROKER_ID");
if (!/^\d+$/.test(String(BROKER_ID))) throw new Error("ROADSYNC_BROKER_ID must be numeric");

function normalize(value) {
  return String(value ?? "").trim().toUpperCase();
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
  const target = normalize(userValue);
  const candidates = [
    payee?.dot_number,
    payee?.mc_number
  ].map(normalize);

  return candidates.includes(target);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    configuredBrokerId: String(BROKER_ID),
    transactionSearchTemplate: TRANSACTION_SEARCH_TEMPLATE
  });
});

app.get("/api/search", async (req, res) => {
  try {
    const { dot, reference } = req.query;

    if (!dot || !reference) {
      return res.status(400).json({
        error: "dot_and_reference_required"
      });
    }

    // 1. Find transaction(s) by exact reference_id
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

    // 2. Check each returned transaction against payee DOT/MC
    for (const tx of transactions) {
      if (!tx?.payee_id) continue;

      const payee = await roadsyncGet(`/payees/${tx.payee_id}`, true);

      if (!dotOrMcMatches(payee, dot)) {
        continue;
      }

      const payables = Array.isArray(tx.payables) ? tx.payables : [];

      return res.json({
        carrier: {
          name: payee.payee_name || tx?.payee?.payee_name || "",
          dot: payee.dot_number || "",
          mc: payee.mc_number || "",
          verified: payee.is_verified ?? tx?.payee?.is_verified ?? "",
          isFactoringCompany: payee.is_factoring_company ?? tx?.payee?.is_factoring_company ?? false,
          payment_types: payee.available_payment_types || []
        },
        payments: [
          {
            transactionId: tx.id || "",
            referenceId: tx.reference_id || "",
            externalId: tx.external_id || "",
            transactionStatus: tx.status || "",
            amount: tx.amount || "",
            paymentMethod: tx.payment_method_v2 || tx?.payment_method?.code || "",
            eta: tx.eta || "",
            createdDatetime: tx.created_datetime || "",
            updatedDatetime: tx.updated_datetime || "",
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
        message: "Reference ID matched a transaction, but DOT/MC did not match the linked payee."
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
