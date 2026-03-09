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

function getPayeeSummary(payee) {
  if (!payee) return null;
  return {
    id: payee.id ?? null,
    payee_name: payee.payee_name ?? "",
    dot_number: payee.dot_number ?? "",
    mc_number: payee.mc_number ?? "",
    is_verified: payee.is_verified ?? null,
    is_factoring_company: payee.is_factoring_company ?? null,
    available_payment_types: payee.available_payment_types ?? []
  };
}

function payeeMatchesDotOrMc(payee, dotOrMc) {
  const target = normalize(dotOrMc);
  if (!target) return false;

  const candidates = [
    payee?.dot_number,
    payee?.mc_number
  ].map(normalize);

  return candidates.includes(target);
}

app.get("/api/search", async (req, res) => {
  try {
    const { load, dot } = req.query;

    if (!load || !dot) {
      return res.status(400).json({ error: "load_and_dot_required" });
    }

    const [payeesRaw, payablesRaw, loadsRaw] = await Promise.all([
      roadsyncGet("/payees"),
      roadsyncGet("/payables"),
      roadsyncGet("/loads")
    ]);

    const payees = Array.isArray(payeesRaw) ? payeesRaw : [];
    const payables = Array.isArray(payablesRaw) ? payablesRaw : [];
    const loads = Array.isArray(loadsRaw) ? loadsRaw : [];

    const payeesById = new Map(payees.map(p => [String(p.id), p]));
    const targetLoad = normalize(load);

    // 1) Search payables
    for (const payable of payables) {
      const payableCandidates = [
        payable?.id,
        payable?.invoice_number,
        payable?.po_number,
        payable?.idempotency_key
      ].map(normalize);

      if (!payableCandidates.includes(targetLoad)) continue;

      const carrier =
        (payable?.carrier_payee?.id != null && payeesById.get(String(payable.carrier_payee.id))) ||
        (payable?.payee?.id != null && payeesById.get(String(payable.payee.id))) ||
        null;

      if (!carrier || !payeeMatchesDotOrMc(carrier, dot)) continue;

      return res.json({
        carrier: {
          name: carrier.payee_name || "",
          dot: carrier.dot_number || "",
          mc: carrier.mc_number || "",
          verified: carrier.is_verified ?? "",
          isFactoringCompany: carrier.is_factoring_company ?? false,
          payment_types: carrier.available_payment_types || []
        },
        payments: [{
          source: "payables",
          payableId: payable.id || "",
          status: payable.status || "",
          amount: payable.amount || "",
          method: payable.payment_method || "",
          eta: payable.eta || "",
          invoiceNumber: payable.invoice_number || "",
          poNumber: payable.po_number || "",
          scheduledForDate: payable.scheduled_for_date || ""
        }]
      });
    }

    // 2) Search loads
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

      if (!carrier || !payeeMatchesDotOrMc(carrier, dot)) continue;

      return res.json({
        carrier: {
          name: carrier.payee_name || "",
          dot: carrier.dot_number || "",
          mc: carrier.mc_number || "",
          verified: carrier.is_verified ?? "",
          isFactoringCompany: carrier.is_factoring_company ?? false,
          payment_types: carrier.available_payment_types || []
        },
        payments: [{
          source: "loads",
          loadId: loadObj.id || "",
          loadNumber: loadObj.load_number || "",
          externalId: loadObj.external_id || "",
          status: loadObj?.payable?.status || loadObj.status || "",
          amount: loadObj?.payable?.amount || loadObj.amount || "",
          method: loadObj?.payable?.payment_method || loadObj?.payable?.transaction?.payment_method || "",
          transactionId: loadObj?.payable?.transaction?.id || "",
          transactionStatus: loadObj?.payable?.transaction?.status || ""
        }]
      });
    }

    return res.json({
      carrier: null,
      payments: [],
      debug: {
        message: "No match found in payables.id/invoice/po/idempotency_key or loads.id/load_number/external_id for that DOT/MC."
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "lookup_failed",
      details: err.message
    });
  }
});

// TEMPORARY DEBUG ROUTE
app.get("/api/debug-search", async (req, res) => {
  try {
    const { load, dot } = req.query;

    const [payeesRaw, payablesRaw, loadsRaw] = await Promise.all([
      roadsyncGet("/payees"),
      roadsyncGet("/payables"),
      roadsyncGet("/loads")
    ]);

    const payees = Array.isArray(payeesRaw) ? payeesRaw : [];
    const payables = Array.isArray(payablesRaw) ? payablesRaw : [];
    const loads = Array.isArray(loadsRaw) ? loadsRaw : [];

    const payeesById = new Map(payees.map(p => [String(p.id), p]));
    const targetLoad = normalize(load);
    const targetDot = normalize(dot);

    const payableMatches = payables
      .map(p => {
        const carrier =
          (p?.carrier_payee?.id != null && payeesById.get(String(p.carrier_payee.id))) ||
          (p?.payee?.id != null && payeesById.get(String(p.payee.id))) ||
          null;

        return {
          matchedFields: {
            id: normalize(p?.id) === targetLoad,
            invoice_number: normalize(p?.invoice_number) === targetLoad,
            po_number: normalize(p?.po_number) === targetLoad,
            idempotency_key: normalize(p?.idempotency_key) === targetLoad
          },
          payable: {
            id: p?.id ?? null,
            invoice_number: p?.invoice_number ?? "",
            po_number: p?.po_number ?? "",
            idempotency_key: p?.idempotency_key ?? "",
            status: p?.status ?? "",
            amount: p?.amount ?? "",
            payment_method: p?.payment_method ?? ""
          },
          carrier: getPayeeSummary(carrier),
          dotMatched: carrier ? payeeMatchesDotOrMc(carrier, targetDot) : false
        };
      })
      .filter(x =>
        x.matchedFields.id ||
        x.matchedFields.invoice_number ||
        x.matchedFields.po_number ||
        x.matchedFields.idempotency_key
      )
      .slice(0, 20);

    const loadMatches = loads
      .map(l => {
        const carrier =
          (l?.carrier_payee?.id != null && payeesById.get(String(l.carrier_payee.id))) ||
          (l?.payee?.id != null && payeesById.get(String(l.payee.id))) ||
          l?.carrier_payee ||
          l?.payee ||
          null;

        return {
          matchedFields: {
            id: normalize(l?.id) === targetLoad,
            load_number: normalize(l?.load_number) === targetLoad,
            external_id: normalize(l?.external_id) === targetLoad
          },
          load: {
            id: l?.id ?? null,
            load_number: l?.load_number ?? "",
            external_id: l?.external_id ?? "",
            status: l?.status ?? "",
            amount: l?.amount ?? ""
          },
          carrier: getPayeeSummary(carrier),
          dotMatched: carrier ? payeeMatchesDotOrMc(carrier, targetDot) : false
        };
      })
      .filter(x =>
        x.matchedFields.id ||
        x.matchedFields.load_number ||
        x.matchedFields.external_id
      )
      .slice(0, 20);

    return res.json({
      input: { load, dot },
      summary: {
        payeesCount: payees.length,
        payablesCount: payables.length,
        loadsCount: loads.length
      },
      payableMatches,
      loadMatches
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "debug_lookup_failed",
      details: err.message
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
