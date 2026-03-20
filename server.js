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

const LOAD_SEARCH_TEMPLATE =
  process.env.ROADSYNC_LOAD_SEARCH_TEMPLATE ||
  "/loads?load_number={{reference_id}}";

if (!API_KEY) throw new Error("Missing ROADSYNC_API_KEY");
if (!BROKER_ID) throw new Error("Missing ROADSYNC_BROKER_ID");

function normalizeIdLike(value) {
  return String(value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function buildTemplatePath(template, referenceId) {
  return template.replace("{{reference_id}}", encodeURIComponent(referenceId));
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

function extractDotAndMc(obj, found = []) {
  if (!obj || typeof obj !== "object") return found;

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = String(key).toLowerCase();

    if (
      keyLower.includes("dot") ||
      keyLower.includes("usdot") ||
      keyLower === "mc" ||
      keyLower.includes("mc_number") ||
      keyLower.includes("mcnumber")
    ) {
      const cleaned = normalizeIdLike(value);
      if (cleaned) found.push(cleaned);
    }

    if (value && typeof value === "object") {
      extractDotAndMc(value, found);
    }
  }

  return [...new Set(found)];
}

function dotOrMcMatches(obj, userValue) {
  const target = normalizeIdLike(userValue);
  if (!target) return false;

  const candidates = extractDotAndMc(obj);
  return candidates.includes(target);
}

function transactionMatchesReference(tx, reference) {
  const target = normalizeIdLike(reference);

  const topLevelCandidates = [
    tx?.id,
    tx?.reference_id,
    tx?.external_id
  ].map(normalizeIdLike).filter(Boolean);

  if (topLevelCandidates.includes(target)) return true;

  for (const p of Array.isArray(tx?.payables) ? tx.payables : []) {
    const payableCandidates = [
      p?.id,
      p?.invoice_number,
      p?.po_number,
      p?.load_id,
      p?.reference_id,
      p?.external_id,
      p?.load?.id,
      p?.load?.load_number,
      p?.load?.external_id,
      p?.load?.reference_id
    ].map(normalizeIdLike).filter(Boolean);

    if (payableCandidates.includes(target)) return true;
  }

  return false;
}

function loadMatchesReference(loadObj, reference) {
  const target = normalizeIdLike(reference);

  const candidates = [
    loadObj?.id,
    loadObj?.load_number,
    loadObj?.external_id,
    loadObj?.reference_id,
    loadObj?.payable?.id,
    loadObj?.payable?.reference_id,
    loadObj?.payable?.external_id,
    loadObj?.payable?.transaction?.id,
    loadObj?.payable?.transaction?.reference_id,
    loadObj?.payable?.transaction?.external_id
  ].map(normalizeIdLike).filter(Boolean);

  return candidates.includes(target);
}

async function loadCandidatePayeesFromTransaction(tx) {
  const candidates = [];
  const seen = new Set();

  for (const p of Array.isArray(tx.payables) ? tx.payables : []) {
    const carrierPayeeId = p?.carrier_payee?.id;

    if (carrierPayeeId && !seen.has(`id:${carrierPayeeId}`)) {
      seen.add(`id:${carrierPayeeId}`);
      try {
        const fullPayee = await roadsyncGet(`/payees/${carrierPayeeId}`, true);
        candidates.push({
          source: "payables[].carrier_payee",
          payee: fullPayee,
          lookupError: null
        });
      } catch (e) {
        candidates.push({
          source: "payables[].carrier_payee_lookup_failed",
          payee: { id: carrierPayeeId },
          lookupError: e.message
        });
      }
    }

    if (
      p?.carrier_payee &&
      !seen.has(`inline-carrier:${p.carrier_payee.id || p.carrier_payee.payee_name}`)
    ) {
      seen.add(`inline-carrier:${p.carrier_payee.id || p.carrier_payee.payee_name}`);
      candidates.push({
        source: "payables[].carrier_payee_inline",
        payee: p.carrier_payee,
        lookupError: null
      });
    }
  }

  const topLevelPayeeId = tx?.payee_id || tx?.payee?.id;

  if (topLevelPayeeId && !seen.has(`id:${topLevelPayeeId}`)) {
    seen.add(`id:${topLevelPayeeId}`);
    try {
      const fullPayee = await roadsyncGet(`/payees/${topLevelPayeeId}`, true);
      candidates.push({
        source: "transaction.payee_id",
        payee: fullPayee,
        lookupError: null
      });
    } catch (e) {
      candidates.push({
        source: "transaction.payee_id_lookup_failed",
        payee: { id: topLevelPayeeId },
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

async function loadCandidatePayeesFromLoad(loadObj) {
  const candidates = [];
  const seen = new Set();

  const idsToTry = [
    loadObj?.carrier_payee?.id,
    loadObj?.payee?.id
  ].filter(Boolean);

  for (const id of idsToTry) {
    if (seen.has(`id:${id}`)) continue;
    seen.add(`id:${id}`);

    try {
      const fullPayee = await roadsyncGet(`/payees/${id}`, true);
      candidates.push({
        source: `load.payee_id:${id}`,
        payee: fullPayee,
        lookupError: null
      });
    } catch (e) {
      candidates.push({
        source: `load.payee_id_lookup_failed:${id}`,
        payee: { id },
        lookupError: e.message
      });
    }
  }

  if (
    loadObj?.carrier_payee &&
    !seen.has(`inline-carrier:${loadObj.carrier_payee.id || loadObj.carrier_payee.payee_name}`)
  ) {
    seen.add(`inline-carrier:${loadObj.carrier_payee.id || loadObj.carrier_payee.payee_name}`);
    candidates.push({
      source: "load.carrier_payee_inline",
      payee: loadObj.carrier_payee,
      lookupError: null
    });
  }

  if (loadObj?.payee && !seen.has(`inline-payee:${loadObj.payee.id || loadObj.payee.payee_name}`)) {
    seen.add(`inline-payee:${loadObj.payee.id || loadObj.payee.payee_name}`);
    candidates.push({
      source: "load.payee_inline",
      payee: loadObj.payee,
      lookupError: null
    });
  }

  return candidates;
}

function summarizeCandidate(candidate) {
  return {
    source: candidate.source,
    payeeId: candidate.payee?.id || "",
    payeeName: candidate.payee?.payee_name || candidate.payee?.name || "",
    extractedDotMcValues: extractDotAndMc(candidate.payee),
    lookupError: candidate.lookupError || null
  };
}

function firstMatchingCandidate(candidates, dot) {
  for (const candidate of candidates) {
    if (dotOrMcMatches(candidate.payee, dot)) {
      return candidate;
    }
  }
  return null;
}

app.get("/api/search", async (req, res) => {
  try {
    const { dot, reference } = req.query;

    if (!dot || !reference) {
      return res.status(400).json({
        error: "dot_and_reference_required"
      });
    }

    const normalizedDot = normalizeIdLike(dot);
    const normalizedReference = normalizeIdLike(reference);

    console.log("=== /api/search request ===");
    console.log("DOT:", dot, "=>", normalizedDot);
    console.log("REFERENCE:", reference, "=>", normalizedReference);

    let foundReferenceButDotMismatch = null;
    let foundReferenceSomewhere = false;

    // Search transactions first
    const txPath = buildTemplatePath(TRANSACTION_SEARCH_TEMPLATE, reference);
    console.log("Transaction search path:", txPath);

    const transactionsRaw = await roadsyncGet(txPath, true);
    const transactions = toArray(transactionsRaw);

    console.log("Transactions returned:", transactions.length);
    console.log(
      "Transaction sample:",
      JSON.stringify(
        transactions.slice(0, 3).map(tx => ({
          id: tx?.id,
          reference_id: tx?.reference_id,
          external_id: tx?.external_id,
          status: tx?.status,
          payables: Array.isArray(tx?.payables)
            ? tx.payables.slice(0, 3).map(p => ({
                id: p?.id,
                invoice_number: p?.invoice_number,
                po_number: p?.po_number,
                load_id: p?.load_id,
                reference_id: p?.reference_id,
                external_id: p?.external_id,
                load: p?.load
                  ? {
                      id: p?.load?.id,
                      load_number: p?.load?.load_number,
                      external_id: p?.load?.external_id,
                      reference_id: p?.load?.reference_id
                    }
                  : null
              }))
            : []
        })),
        null,
        2
      )
    );

    const exactTransactionMatches = transactions.filter(tx =>
      transactionMatchesReference(tx, reference)
    );

    console.log("Exact transaction matches:", exactTransactionMatches.length);

    for (const tx of exactTransactionMatches) {
      const candidatePayees = await loadCandidatePayeesFromTransaction(tx);

      console.log(
        "Transaction candidate payees:",
        JSON.stringify(candidatePayees.map(summarizeCandidate), null, 2)
      );

      const matchedCandidate = firstMatchingCandidate(candidatePayees, dot);

      if (!matchedCandidate) {
        foundReferenceButDotMismatch = {
          scope: "transaction",
          transactionId: tx.id || "",
          referenceId: tx.reference_id || reference || "",
          searchedDot: normalizedDot,
          checkedPayeeSources: candidatePayees.map(summarizeCandidate)
        };
        continue;
      }

      const payee = matchedCandidate.payee;
      const payables = Array.isArray(tx.payables) ? tx.payables : [];
      const firstPayable = payables[0] || null;

      return res.json({
        outcome: "payment_found",
        carrier: {
          name: payee.payee_name || payee.name || "",
          dot: payee.dot_number || payee.usdot || "",
          mc: payee.mc_number || payee.mc || "",
          verified: payee.is_verified ?? "",
          isFactoringCompany: payee.is_factoring_company ?? false,
          payment_types: payee.available_payment_types || []
        },
        payment: {
          transactionId: tx.id || "",
          referenceId: tx.reference_id || reference || firstPayable?.invoice_number || "",
          externalId: tx.external_id || firstPayable?.load?.external_id || "",
          transactionStatus: String(tx.status || "").toUpperCase(),
          amount: tx.amount || "",
          paymentMethod: tx.payment_method_v2 || tx?.payment_method?.code || tx?.payment_method || "",
          eta: tx.eta || "",
          createdDatetime: tx.created_datetime || "",
          updatedDatetime: tx.updated_datetime || "",
          matchedPayeeSource: matchedCandidate.source,
          payables: payables.map(p => ({
            payableId: p.id || "",
            payableStatus: String(p.status || tx.status || "").toUpperCase(),
            invoiceNumber: p.invoice_number || reference || "",
            poNumber: p.po_number || "",
            loadId: p.load_id || "",
            loadNumber: p?.load?.load_number || p.invoice_number || reference || "",
            loadExternalId: p?.load?.external_id || "",
            scheduledForDate: p.scheduled_for_date || "",
            amount: p.amount || ""
          }))
        }
      });
    }

    // Search loads second
    const loadPath = buildTemplatePath(LOAD_SEARCH_TEMPLATE, reference);
    console.log("Load search path:", loadPath);

    const loadsRaw = await roadsyncGet(loadPath, true);
    const loads = toArray(loadsRaw);

    console.log("Loads returned:", loads.length);
    console.log(
      "Load sample:",
      JSON.stringify(
        loads.slice(0, 3).map(loadObj => ({
          id: loadObj?.id,
          load_number: loadObj?.load_number,
          external_id: loadObj?.external_id,
          reference_id: loadObj?.reference_id,
          status: loadObj?.status,
          payable: loadObj?.payable
            ? {
                id: loadObj?.payable?.id,
                reference_id: loadObj?.payable?.reference_id,
                external_id: loadObj?.payable?.external_id,
                status: loadObj?.payable?.status,
                payment_method: loadObj?.payable?.payment_method,
                transaction: loadObj?.payable?.transaction
                  ? {
                      id: loadObj?.payable?.transaction?.id,
                      reference_id: loadObj?.payable?.transaction?.reference_id,
                      external_id: loadObj?.payable?.transaction?.external_id,
                      status: loadObj?.payable?.transaction?.status
                    }
                  : null
              }
            : null
        })),
        null,
        2
      )
    );

    const exactLoadMatches = loads.filter(loadObj =>
      loadMatchesReference(loadObj, reference)
    );

    console.log("Exact load matches:", exactLoadMatches.length);

    for (const loadObj of exactLoadMatches) {
      const candidatePayees = await loadCandidatePayeesFromLoad(loadObj);

      console.log(
        "Load candidate payees:",
        JSON.stringify(candidatePayees.map(summarizeCandidate), null, 2)
      );

      const matchedCandidate = firstMatchingCandidate(candidatePayees, dot);

      if (!matchedCandidate) {
        foundReferenceButDotMismatch = {
          scope: "load",
          loadId: loadObj.id || "",
          loadNumber: loadObj.load_number || reference || "",
          searchedDot: normalizedDot,
          checkedPayeeSources: candidatePayees.map(summarizeCandidate)
        };
        continue;
      }

      const payee = matchedCandidate.payee;

      return res.json({
        outcome: "load_found_no_payment",
        carrier: {
          name: payee.payee_name || payee.name || "",
          dot: payee.dot_number || payee.usdot || "",
          mc: payee.mc_number || payee.mc || "",
          verified: payee.is_verified ?? "",
          isFactoringCompany: payee.is_factoring_company ?? false,
          payment_types: payee.available_payment_types || []
        },
        load: {
          loadId: loadObj.id || "",
          loadNumber: loadObj.load_number || reference || "",
          externalId: loadObj.external_id || "",
          loadStatus: String(loadObj.status || "").toUpperCase(),
          amount: loadObj.amount || loadObj?.payable?.amount || "",
          payableId: loadObj?.payable?.id || "",
          payableStatus: String(loadObj?.payable?.status || "").toUpperCase(),
          transactionId: loadObj?.payable?.transaction?.id || "",
          transactionStatus: String(loadObj?.payable?.transaction?.status || "").toUpperCase(),
          paymentMethod: loadObj?.payable?.payment_method || loadObj?.payable?.transaction?.payment_method || "",
          matchedPayeeSource: matchedCandidate.source
        },
        message: "Load found, but no payment transaction was matched."
      });
    }

    if (foundReferenceButDotMismatch) {
      console.log(
        "Reference found but DOT mismatch:",
        JSON.stringify(foundReferenceButDotMismatch, null, 2)
      );

      return res.json({
        outcome: "reference_found_dot_mismatch",
        carrier: null,
        debug: foundReferenceButDotMismatch
      });
    }

    if (foundReferenceSomewhere) {
      console.log("Reference found, but lookup incomplete.");

      return res.json({
        outcome: "reference_found_lookup_incomplete",
        carrier: null,
        debug: {
          message: "RoadSync returned records for this reference, but the portal could not complete a reliable carrier match."
        }
      });
    }

    return res.json({
      outcome: "not_found",
      carrier: null,
      debug: {
        message: "No load or payment matched that DOT/MC and reference."
      }
    });
  } catch (err) {
    console.error("Search failed:", err);
    return res.status(500).json({
      error: "search_failed",
      details: err.message
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    transactionSearchTemplate: TRANSACTION_SEARCH_TEMPLATE,
    loadSearchTemplate: LOAD_SEARCH_TEMPLATE
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
