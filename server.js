const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());

const ROADSYNC_API_KEY = process.env.ROADSYNC_API_KEY;
const ROADSYNC_BROKER_ID = process.env.ROADSYNC_BROKER_ID;

const RSPAY_BASE_URL =
  process.env.ROADSYNC_BASE_URL || "https://api.roadsync.app/rspay/v1";

const ADVANCE_BASE_URL =
  process.env.ROADSYNC_ADVANCE_BASE_URL || "https://advance.roadsync.app/v1";

const SEARCH_LIMIT = Number(process.env.ROADSYNC_SEARCH_LIMIT || 150);
const MAX_TRANSACTION_PAGES = Number(process.env.ROADSYNC_MAX_TRANSACTION_PAGES || 5);

if (!ROADSYNC_API_KEY) throw new Error("Missing ROADSYNC_API_KEY");
if (!ROADSYNC_BROKER_ID) throw new Error("Missing ROADSYNC_BROKER_ID");

function normalizeIdLike(value) {
  return String(value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function money(value) {
  return value === null || value === undefined || value === ""
    ? ""
    : Number(value).toFixed(2);
}

async function apiGet(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`RoadSync API error ${res.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`RoadSync returned non-JSON response: ${text}`);
  }
}

async function rsPayGet(endpoint) {
  const url = `${RSPAY_BASE_URL}${endpoint}`;
  console.log("RSPay request URL:", url);

  return apiGet(url, {
    "x-api-key": ROADSYNC_API_KEY,
    "Content-Type": "application/json",
    "broker-id": String(ROADSYNC_BROKER_ID)
  });
}

async function advanceGet(endpoint) {
  const url = `${ADVANCE_BASE_URL}${endpoint}`;
  console.log("Advance request URL:", url);

  return apiGet(url, {
    "x-api-key": ROADSYNC_API_KEY,
    "Content-Type": "application/json"
  });
}

function toArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function getTransactionReferenceCandidates(tx) {
  const values = [
    tx?.id,
    tx?.reference_id,
    tx?.external_id
  ];

  for (const p of Array.isArray(tx?.payables) ? tx.payables : []) {
    values.push(
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
    );
  }

  return [...new Set(values.map(normalizeIdLike).filter(Boolean))];
}

function transactionMatchesReference(tx, reference) {
  const target = normalizeIdLike(reference);
  return getTransactionReferenceCandidates(tx).includes(target);
}

function compareTransactionToDotPayee(tx, payee) {
  const txPayeeId = String(tx?.payee?.id || tx?.payee_id || "");
  const dotPayeeId = String(payee?.oid || "");
  const txPayeeName = normalizeName(tx?.payee?.payee_name || "");
  const dotPayeeName = normalizeName(payee?.payee_name || "");

  if (txPayeeId && dotPayeeId && txPayeeId === dotPayeeId) {
    return {
      matched: true,
      reason: "payee_id"
    };
  }

  if (txPayeeName && dotPayeeName && txPayeeName === dotPayeeName) {
    return {
      matched: true,
      reason: "payee_name"
    };
  }

  return {
    matched: false,
    reason: "mismatch",
    debug: {
      transactionPayeeId: txPayeeId,
      dotPayeeId: dotPayeeId,
      transactionPayeeName: tx?.payee?.payee_name || "",
      dotPayeeName: payee?.payee_name || ""
    }
  };
}

function summarizeTransaction(tx) {
  return {
    id: tx?.id,
    reference_id: tx?.reference_id,
    external_id: tx?.external_id,
    status: tx?.status,
    payee_id: tx?.payee?.id || tx?.payee_id,
    payee_name: tx?.payee?.payee_name || "",
    invoice_numbers: Array.isArray(tx?.payables)
      ? tx.payables.map(p => p?.invoice_number).filter(Boolean)
      : [],
    load_numbers: Array.isArray(tx?.payables)
      ? tx.payables.map(p => p?.load?.load_number).filter(Boolean)
      : []
  };
}

function summarizePayee(payee) {
  return {
    oid: payee?.oid,
    external_id: payee?.external_id,
    company_id: payee?.company_id,
    payee_name: payee?.payee_name,
    dot_number: payee?.dot_number,
    mc_number: payee?.mc_number,
    funding_source_id: payee?.funding_source_id,
    is_factoring_company: payee?.is_factoring_company,
    available_payment_types: payee?.available_payment_types || [],
    is_verified: payee?.is_verified ?? "",
    city: payee?.city,
    state: payee?.state
  };
}

async function findPayeeByDot(dot) {
  const endpoint = `/payee?page=1&search=${encodeURIComponent(dot)}`;
  const raw = await advanceGet(endpoint);
  const items = toArray(raw);

  console.log("Payee rows returned:", items.length);

  const targetDot = normalizeIdLike(dot);

  const exactDotMatches = items.filter(item =>
    normalizeIdLike(item?.dot_number) === targetDot
  );

  console.log("Exact DOT payee matches:", exactDotMatches.length);

  return exactDotMatches[0] || null;
}

async function fetchTransactionsPage(page, reference) {
  const endpoint = `/transactions?page=${page}&limit=${SEARCH_LIMIT}&invoice_number=${encodeURIComponent(reference)}`;
  const raw = await rsPayGet(endpoint);
  const rows = toArray(raw);

  console.log(`Transaction rows returned for invoice_number page ${page}:`, rows.length);
  return rows;
}

async function fetchRecentTransactionsPage(page) {
  const endpoint = `/transactions?page=${page}&limit=${SEARCH_LIMIT}`;
  const raw = await rsPayGet(endpoint);
  const rows = toArray(raw);

  console.log(`Recent transaction rows returned for page ${page}:`, rows.length);
  return rows;
}

async function findCandidateTransactions(reference) {
  const deduped = new Map();

  const addRows = (rows, source) => {
    for (const tx of rows) {
      const key = String(tx?.id || `${tx?.reference_id || ""}|${tx?.external_id || ""}`);
      if (!deduped.has(key)) {
        deduped.set(key, { tx, source });
      }
    }
  };

  // First try the direct invoice_number search.
  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page += 1) {
    const rows = await fetchTransactionsPage(page, reference);
    addRows(rows, `invoice_number_page_${page}`);
    if (rows.length < SEARCH_LIMIT) break;
  }

  // Then scan recent transactions because RoadSync can return the match only in nested fields.
  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page += 1) {
    const rows = await fetchRecentTransactionsPage(page);
    addRows(rows, `recent_page_${page}`);
    if (rows.length < SEARCH_LIMIT) break;
  }

  const matches = [...deduped.values()]
    .filter(({ tx }) => transactionMatchesReference(tx, reference))
    .map(({ tx, source }) => ({ tx, source }));

  console.log("Exact candidate transaction matches:", matches.length);
  return matches;
}

function buildPaymentResponse(tx, reference) {
  const payables = Array.isArray(tx?.payables) ? tx.payables : [];
  const firstPayable = payables[0] || null;

  return {
    transactionId: tx?.id || "",
    referenceId: tx?.reference_id || reference || firstPayable?.invoice_number || "",
    externalId: tx?.external_id || firstPayable?.load?.external_id || "",
    transactionStatus: String(tx?.status || "").toUpperCase(),
    amount: money(tx?.amount),
    invoiceAmount: money(tx?.invoice_amount),
    fee: money(tx?.fee),
    paymentMethod: tx?.payment_method_v2 || tx?.payment_method?.code || tx?.payment_method || "",
    eta: tx?.eta || "",
    createdDatetime: tx?.created_datetime || "",
    updatedDatetime: tx?.updated_datetime || "",
    payeeId: tx?.payee?.id || tx?.payee_id || "",
    payeeName: tx?.payee?.payee_name || "",
    payables: payables.map(p => ({
      payableId: p?.id || "",
      payableStatus: String(p?.status || tx?.status || "").toUpperCase(),
      invoiceNumber: p?.invoice_number || reference || "",
      poNumber: p?.po_number || "",
      loadId: p?.load_id || p?.load?.id || "",
      loadNumber: p?.load?.load_number || p?.invoice_number || reference || "",
      loadExternalId: p?.load?.external_id || "",
      scheduledForDate: p?.scheduled_for_date || "",
      amount: money(p?.amount)
    }))
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/search", async (req, res) => {
  try {
    const { dot, reference } = req.query;

    if (!dot || !reference) {
      return res.status(400).json({
        error: "dot_and_reference_required"
      });
    }

    console.log("=== /api/search request ===");
    console.log("RSPAY_BASE_URL:", RSPAY_BASE_URL);
    console.log("ADVANCE_BASE_URL:", ADVANCE_BASE_URL);
    console.log("BROKER_ID:", String(ROADSYNC_BROKER_ID));
    console.log("DOT:", dot);
    console.log("REFERENCE:", reference);

    const payeeByDot = await findPayeeByDot(dot);
    const candidates = await findCandidateTransactions(reference);

    if (!candidates.length) {
      return res.json({
        outcome: "not_found",
        carrier: payeeByDot
          ? {
              searchedDot: dot,
              dotLookupPayee: summarizePayee(payeeByDot)
            }
          : null,
        debug: {
          message: "No payment matched the entered reference after nested-field scan."
        }
      });
    }

    const exactDotMatch = payeeByDot
      ? candidates.find(({ tx }) => compareTransactionToDotPayee(tx, payeeByDot).matched)
      : null;

    if (exactDotMatch && payeeByDot) {
      const tx = exactDotMatch.tx;
      console.log("Matched transaction:", JSON.stringify(summarizeTransaction(tx), null, 2));
      console.log("Matched DOT payee:", JSON.stringify(summarizePayee(payeeByDot), null, 2));

      const comparison = compareTransactionToDotPayee(tx, payeeByDot);

      return res.json({
        outcome: "payment_found",
        carrier: {
          name: payeeByDot.payee_name || tx?.payee?.payee_name || "",
          dot: payeeByDot.dot_number || "",
          mc: payeeByDot.mc_number || "",
          verified: payeeByDot.is_verified ?? "",
          isFactoringCompany: payeeByDot.is_factoring_company ?? false,
          payment_types: payeeByDot.available_payment_types || [],
          matchedBy: comparison.reason
        },
        payment: buildPaymentResponse(tx, reference)
      });
    }

    const firstReferenceMatch = candidates[0]?.tx || null;

    if (firstReferenceMatch && !payeeByDot) {
      return res.json({
        outcome: "dot_not_found",
        carrier: null,
        payment: buildPaymentResponse(firstReferenceMatch, reference),
        debug: {
          message: "A payment matched the reference, but the DOT number was not found in the payee directory."
        }
      });
    }

    if (firstReferenceMatch && payeeByDot) {
      const comparison = compareTransactionToDotPayee(firstReferenceMatch, payeeByDot);

      return res.json({
        outcome: "reference_found_dot_mismatch",
        carrier: {
          searchedDot: dot,
          dotLookupPayee: summarizePayee(payeeByDot)
        },
        payment: {
          ...buildPaymentResponse(firstReferenceMatch, reference),
          transactionPayee: {
            id: firstReferenceMatch?.payee?.id || firstReferenceMatch?.payee_id || "",
            name: firstReferenceMatch?.payee?.payee_name || ""
          }
        },
        debug: comparison.debug
      });
    }

    return res.json({
      outcome: "not_found",
      carrier: null,
      debug: {
        message: "No payment matched the entered reference."
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
    rspayBaseUrl: RSPAY_BASE_URL,
    advanceBaseUrl: ADVANCE_BASE_URL,
    brokerId: String(ROADSYNC_BROKER_ID),
    searchLimit: SEARCH_LIMIT,
    maxTransactionPages: MAX_TRANSACTION_PAGES
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
