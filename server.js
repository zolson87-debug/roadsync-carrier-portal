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
  return String(value ?? "").trim();
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

function payableMatchesLoad(payable, load) {
  const target = normalize(load);

  const candidates = [
    payable.invoice_number,
    payable.po_number,
    payable.reference_id,
    payable.load_id,
    payable.external_id
  ];

  return candidates.some(v => normalize(v) === target);
}

function payeeMatchesDotOrMc(payee, dotOrMc) {
  const target = normalize(dotOrMc).toUpperCase();

  const candidates = [
    payee.dot_number,
    payee.mc_number
  ].map(v => normalize(v).toUpperCase());

  return candidates.includes(target);
}

app.get("/api/search", async (req, res) => {
  try {
    const { load, dot } = req.query;

    if (!load || !dot) {
      return res.status(400).json({ error: "load_and_dot_required" });
    }

    const [transactions, payees] = await Promise.all([
      roadsyncGet("/transactions"),
      roadsyncGet("/payees")
    ]);

    const payeesById = new Map(payees.map(p => [String(p.id), p]));
    const matchingResults = [];

    for (const tx of transactions) {
      const payables = Array.isArray(tx.payables) ? tx.payables : [];

      for (const payable of payables) {
        if (!payableMatchesLoad(payable, load)) continue;

        // In RoadSync, the carrier may be nested under payable.carrier_payee,
        // while tx.payee may be a factoring company.
        const carrierPayeeId =
          payable?.carrier_payee?.id ??
          tx?.carrier_payee_id ??
          tx?.payee?.id;

        const carrier =
          carrierPayeeId != null ? payeesById.get(String(carrierPayeeId)) : null;

        // Try match against actual carrier payee first.
        if (carrier && payeeMatchesDotOrMc(carrier, dot)) {
          matchingResults.push({
            carrier: {
              id: carrier.id,
              name: carrier.payee_name,
              dot: carrier.dot_number || "",
              mc: carrier.mc_number || "",
              verified: carrier.is_verified,
              isFactoringCompany: carrier.is_factoring_company,
              paymentTypes: carrier.available_payment_types || []
            },
            payment: {
              transactionId: tx.id,
              status: tx.status,
              amount: tx.amount,
              method: tx.payment_method,
              eta: tx.eta || null,
              invoiceNumber: payable.invoice_number || "",
              poNumber: payable.po_number || "",
              scheduledForDate: payable.scheduled_for_date || "",
              checkPreviewUrl: tx?.check_preview?.url || ""
            }
          });
          continue;
        }

        // Fallback: sometimes a user may paste an MC instead of DOT,
        // or the broker may be paying a factor directly.
        const txPayeeId = tx?.payee?.id;
        const txPayee = txPayeeId != null ? payeesById.get(String(txPayeeId)) : null;

        if (txPayee && payeeMatchesDotOrMc(txPayee, dot)) {
          matchingResults.push({
            carrier: {
              id: txPayee.id,
              name: txPayee.payee_name,
              dot: txPayee.dot_number || "",
              mc: txPayee.mc_number || "",
              verified: txPayee.is_verified,
              isFactoringCompany: txPayee.is_factoring_company,
              paymentTypes: txPayee.available_payment_types || []
            },
            payment: {
              transactionId: tx.id,
              status: tx.status,
              amount: tx.amount,
              method: tx.payment_method,
              eta: tx.eta || null,
              invoiceNumber: payable.invoice_number || "",
              poNumber: payable.po_number || "",
              scheduledForDate: payable.scheduled_for_date || "",
              checkPreviewUrl: tx?.check_preview?.url || ""
            }
          });
        }
      }
    }

    if (matchingResults.length === 0) {
      return res.json({
        carrier: null,
        payments: [],
        debug: {
          message: "No match found for that DOT/MC and load number combination."
        }
      });
    }

    // Return first carrier + all matched payments for that same carrier
    const firstCarrierId = matchingResults[0].carrier.id;
    const payments = matchingResults
      .filter(r => r.carrier.id === firstCarrierId)
      .map(r => r.payment);

    return res.json({
      carrier: {
        name: matchingResults[0].carrier.name,
        dot: matchingResults[0].carrier.dot,
        mc: matchingResults[0].carrier.mc,
        verified: matchingResults[0].carrier.verified,
        isFactoringCompany: matchingResults[0].carrier.isFactoringCompany,
        payment_types: matchingResults[0].carrier.paymentTypes
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
