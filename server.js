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

function payeeMatchesDotOrMc(payee, dotOrMc) {
  const target = normalize(dotOrMc).toUpperCase();

  const candidates = [
    payee?.dot_number,
    payee?.mc_number
  ].map(v => normalize(v).toUpperCase());

  return candidates.includes(target);
}

function payableMatchesLoad(payable, load) {
  const target = normalize(load).toUpperCase();

  const candidates = [
    payable?.invoice_number,
    payable?.po_number,
    payable?.id,                 // sometimes the visible "payment id" is actually the payable id
    payable?.idempotency_key
  ].map(v => normalize(v).toUpperCase());

  return candidates.includes(target);
}

app.get("/api/search", async (req, res) => {
  try {
    const { load, dot } = req.query;

    if (!load || !dot) {
      return res.status(400).json({ error: "load_and_dot_required" });
    }

    const [payables, payees] = await Promise.all([
      roadsyncGet("/payables"),
      roadsyncGet("/payees")
    ]);

    const payeesById = new Map(
      (Array.isArray(payees) ? payees : []).map(p => [String(p.id), p])
    );

    const matches = [];

    for (const payable of Array.isArray(payables) ? payables : []) {
      if (!payableMatchesLoad(payable, load)) continue;

      // Prefer the actual carrier
      const carrierPayeeId = payable?.carrier_payee?.id;
      const carrier = carrierPayeeId != null ? payeesById.get(String(carrierPayeeId)) : null;

      if (carrier && payeeMatchesDotOrMc(carrier, dot)) {
        matches.push({
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
            payableId: payable.id,
            status: payable.status,
            amount: payable.amount,
            method: payable.payment_method,
            eta: payable.eta || null,
            invoiceNumber: payable.invoice_number || "",
            poNumber: payable.po_number || "",
            scheduledForDate: payable.scheduled_for_date || ""
          }
        });
        continue;
      }

      // Fallback to payable.payee in case payment is directly against factor/payee
      const payeeId = payable?.payee?.id;
      const payee = payeeId != null ? payeesById.get(String(payeeId)) : null;

      if (payee && payeeMatchesDotOrMc(payee, dot)) {
        matches.push({
          carrier: {
            id: payee.id,
            name: payee.payee_name,
            dot: payee.dot_number || "",
            mc: payee.mc_number || "",
            verified: payee.is_verified,
            isFactoringCompany: payee.is_factoring_company,
            paymentTypes: payee.available_payment_types || []
          },
          payment: {
            payableId: payable.id,
            status: payable.status,
            amount: payable.amount,
            method: payable.payment_method,
            eta: payable.eta || null,
            invoiceNumber: payable.invoice_number || "",
            poNumber: payable.po_number || "",
            scheduledForDate: payable.scheduled_for_date || ""
          }
        });
      }
    }

    if (matches.length === 0) {
      return res.json({
        carrier: null,
        payments: [],
        debug: {
          message: "No payable matched that DOT/MC + load value."
        }
      });
    }

    const firstCarrierId = matches[0].carrier.id;
    const payments = matches
      .filter(m => m.carrier.id === firstCarrierId)
      .map(m => m.payment);

    return res.json({
      carrier: {
        name: matches[0].carrier.name,
        dot: matches[0].carrier.dot,
        mc: matches[0].carrier.mc,
        verified: matches[0].carrier.verified,
        isFactoringCompany: matches[0].carrier.isFactoringCompany,
        payment_types: matches[0].carrier.paymentTypes
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
