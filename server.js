const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname)));
app.use(express.json());

const ROADSYNC_API_KEY = process.env.ROADSYNC_API_KEY;
const ROADSYNC_BROKER_ID = process.env.ROADSYNC_BROKER_ID;
const ADMIN_SYNC_KEY = process.env.ADMIN_SYNC_KEY || "";

const RSPAY_BASE_URL =
  process.env.ROADSYNC_BASE_URL || "https://api.roadsync.app/rspay/v1";

const SEARCH_LIMIT = Number(process.env.ROADSYNC_SEARCH_LIMIT || 150);
const MAX_TRANSACTION_PAGES = Number(process.env.ROADSYNC_MAX_TRANSACTION_PAGES || 15);

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

function maskKey(key) {
  const str = String(key || "");
  if (!str) return "";
  if (str.length <= 8) return "*".repeat(str.length);
  return `${str.slice(0, 4)}...${str.slice(-4)}`;
}

function toArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

async function apiGet(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`RoadSync API error ${res.status}: ${text}`);
    err.status = res.status;
    err.url = url;
    err.responseText = text;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`RoadSync returned non-JSON response: ${text}`);
  }
}

async function rspayGet(endpoint) {
  const url = `${RSPAY_BASE_URL}${endpoint}`;
  console.log("RSPay request URL:", url);

  return apiGet(url, {
    "x-api-key": ROADSYNC_API_KEY,
    "broker-id": String(ROADSYNC_BROKER_ID),
    "Content-Type": "application/json"
  });
}

function summarizePayee(payee) {
  if (!payee) return null;

  return {
    id: payee?.id || "",
    payee_name: payee?.payee_name || "",
    dot_number: payee?.dot_number || "",
    mc_number: payee?.mc_number || "",
    is_verified: payee?.is_verified ?? "",
    is_factoring_company: payee?.is_factoring_company ?? false,
    email_address: payee?.email_address || "",
    phone_number: payee?.phone_number || "",
    address_city: payee?.address_city || payee?.city || "",
    address_state: payee?.address_state || payee?.state || ""
  };
}

async function findPayeeByDot(dot) {
  const targetDot = normalizeIdLike(dot);
  const endpoint = `/payees?dot=${encodeURIComponent(targetDot)}`;
  const raw = await rspayGet(endpoint);
  const items = toArray(raw);

  console.log(`Payees returned for DOT ${targetDot}:`, items.length);

  const exactDotMatches = items.filter(
    item => normalizeIdLike(item?.dot_number) === targetDot
  );

  console.log(`Exact DOT matches for ${targetDot}:`, exactDotMatches.length);

  if (exactDotMatches.length === 1) {
    return {
      status: "verified",
      payee: exactDotMatches[0]
    };
  }

  if (exactDotMatches.length > 1) {
    return {
      status: "multiple_matches",
      matches: exactDotMatches.map(summarizePayee)
    };
  }

  return {
    status: "not_found",
    payee: null
  };
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

function compareTransactionToVerifiedPayee(tx, payee) {
  const txPayeeId = String(tx?.payee?.id || tx?.payee_id || "");
  const verifiedPayeeId = String(payee?.id || "");
  const txPayeeName = normalizeName(tx?.payee?.payee_name || "");
  const verifiedPayeeName = normalizeName(payee?.payee_name || "");

  if (txPayeeId && verifiedPayeeId && txPayeeId === verifiedPayeeId) {
    return {
      matched: true,
      reason: "payee_id"
    };
  }

  if (!txPayeeId && txPayeeName && verifiedPayeeName && txPayeeName === verifiedPayeeName) {
    return {
      matched: true,
      reason: "payee_name_fallback"
    };
  }

  return {
    matched: false,
    reason: "mismatch",
    debug: {
      transactionPayeeId: txPayeeId,
      verifiedPayeeId,
      transactionPayeeName: tx?.payee?.payee_name || "",
      verifiedPayeeName: payee?.payee_name || ""
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

async function fetchTransactionsByInvoiceNumber(page, reference) {
  const endpoint = `/transactions?page=${page}&limit=${SEARCH_LIMIT}&invoice_number=${encodeURIComponent(reference)}`;
  const raw = await rspayGet(endpoint);
  const rows = toArray(raw);

  console.log(`Transaction rows returned for invoice_number page ${page}:`, rows.length);
  return rows;
}

async function fetchTransactionsByReferenceId(page, reference) {
  const endpoint = `/transactions?page=${page}&limit=${SEARCH_LIMIT}&reference_id=${encodeURIComponent(reference)}`;
  const raw = await rspayGet(endpoint);
  const rows = toArray(raw);

  console.log(`Transaction rows returned for reference_id page ${page}:`, rows.length);
  return rows;
}

async function fetchTransactionsByLoadNumber(page, reference) {
  const endpoint = `/transactions?page=${page}&limit=${SEARCH_LIMIT}&load_number=${encodeURIComponent(reference)}`;
  const raw = await rspayGet(endpoint);
  const rows = toArray(raw);

  console.log(`Transaction rows returned for load_number page ${page}:`, rows.length);
  return rows;
}

async function fetchRecentTransactionsPage(page) {
  const endpoint = `/transactions?page=${page}&limit=${SEARCH_LIMIT}`;
  const raw = await rspayGet(endpoint);
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

  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page += 1) {
    const rows = await fetchTransactionsByInvoiceNumber(page, reference);
    addRows(rows, `invoice_number_page_${page}`);
    if (rows.length < SEARCH_LIMIT) break;
  }

  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page += 1) {
    const rows = await fetchTransactionsByReferenceId(page, reference);
    addRows(rows, `reference_id_page_${page}`);
    if (rows.length < SEARCH_LIMIT) break;
  }

  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page += 1) {
    const rows = await fetchTransactionsByLoadNumber(page, reference);
    addRows(rows, `load_number_page_${page}`);
    if (rows.length < SEARCH_LIMIT) break;
  }

  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page += 1) {
    const rows = await fetchRecentTransactionsPage(page);
    addRows(rows, `recent_page_${page}`);
    if (rows.length < SEARCH_LIMIT) break;
  }

  const matches = [...deduped.values()]
    .filter(({ tx }) => transactionMatchesReference(tx, reference))
    .map(({ tx, source }) => ({ tx, source }));

  console.log("Exact candidate transaction matches:", matches.length);
  console.log(
    "Match sources:",
    matches.map(m => ({
      source: m.source,
      id: m.tx?.id,
      reference_id: m.tx?.reference_id,
      payee_id: m.tx?.payee?.id || m.tx?.payee_id || ""
    }))
  );

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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    rspayBaseUrl: RSPAY_BASE_URL,
    brokerId: String(ROADSYNC_BROKER_ID),
    searchLimit: SEARCH_LIMIT,
    maxTransactionPages: MAX_TRANSACTION_PAGES,
    apiKeyPresent: Boolean(ROADSYNC_API_KEY),
    apiKeyMasked: maskKey(ROADSYNC_API_KEY)
  });
});

app.get("/api/test-payees", async (req, res) => {
  try {
    const dot = req.query.dot || "2117808";
    const result = await findPayeeByDot(dot);

    res.json({
      ok: true,
      dot: normalizeIdLike(dot),
      result
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      where: "rspay_payees_dot_filter",
      endpoint: err.url || null,
      status: err.status || 500,
      message: err.message,
      responseText: err.responseText || null
    });
  }
});

app.get("/api/test-rspay", async (req, res) => {
  try {
    const reference = req.query.reference || "8a868168";
    const endpoint = `/transactions?page=1&limit=10&invoice_number=${encodeURIComponent(reference)}`;
    const data = await rspayGet(endpoint);

    res.json({
      ok: true,
      endpoint: `${RSPAY_BASE_URL}${endpoint}`,
      count: toArray(data).length,
      sample: toArray(data).slice(0, 2)
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      where: "rspay_transactions",
      endpoint: err.url || null,
      status: err.status || 500,
      message: err.message,
      responseText: err.responseText || null
    });
  }
});

app.get("/api/debug-auth", async (req, res) => {
  const result = {
    ok: true,
    config: {
      rspayBaseUrl: RSPAY_BASE_URL,
      brokerId: String(ROADSYNC_BROKER_ID),
      apiKeyPresent: Boolean(ROADSYNC_API_KEY),
      apiKeyMasked: maskKey(ROADSYNC_API_KEY)
    },
    tests: {}
  };

  try {
    const dot = req.query.dot || "2117808";
    result.tests.payees = await findPayeeByDot(dot);
  } catch (err) {
    result.ok = false;
    result.tests.payees = {
      ok: false,
      status: err.status || 500,
      endpoint: err.url || null,
      message: err.message,
      responseText: err.responseText || null
    };
  }

  try {
    const reference = req.query.reference || "8a868168";
    const matches = await findCandidateTransactions(reference);
    result.tests.transactions = {
      ok: true,
      count: matches.length,
      sources: matches.map(m => m.source),
      sample: matches.slice(0, 3).map(m => summarizeTransaction(m.tx))
    };
  } catch (err) {
    result.ok = false;
    result.tests.transactions = {
      ok: false,
      status: err.status || 500,
      endpoint: err.url || null,
      message: err.message,
      responseText: err.responseText || null
    };
  }

  res.status(result.ok ? 200 : 500).json(result);
});

app.get("/api/admin/test-sync-key", (req, res) => {
  if (!ADMIN_SYNC_KEY) {
    return res.json({
      ok: true,
      configured: false
    });
  }

  return res.json({
    ok: true,
    configured: true,
    matched: req.query.key === ADMIN_SYNC_KEY
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

    console.log("=== /api/search request ===");
    console.log("RSPAY_BASE_URL:", RSPAY_BASE_URL);
    console.log("BROKER_ID:", String(ROADSYNC_BROKER_ID));
    console.log("API KEY MASKED:", maskKey(ROADSYNC_API_KEY));
    console.log("DOT:", dot);
    console.log("REFERENCE:", reference);

    const payeeLookup = await findPayeeByDot(dot);

    if (payeeLookup.status === "not_found") {
      return res.json({
        outcome: "dot_not_found",
        message: "Your DOT number was not found in RoadSync."
      });
    }

    if (payeeLookup.status === "multiple_matches") {
      return res.json({
        outcome: "multiple_dot_matches",
        message: "Multiple payees were returned for this DOT number. Payment details cannot be displayed until the match is uniquely verified."
      });
    }

    const verifiedPayee = payeeLookup.payee;

    if (!verifiedPayee) {
      return res.json({
        outcome: "dot_verification_unavailable",
        message: "We could not verify the DOT number at this time."
      });
    }

    const candidates = await findCandidateTransactions(reference);

    if (!candidates.length) {
      return res.json({
        outcome: "not_found",
        carrier: {
          searchedDot: normalizeIdLike(dot),
          verifiedPayee: summarizePayee(verifiedPayee)
        },
        debug: {
          message: "No payment matched the entered reference after nested-field scan."
        }
      });
    }

    const exactVerifiedMatch = candidates.find(({ tx }) =>
      compareTransactionToVerifiedPayee(tx, verifiedPayee).matched
    );

    if (exactVerifiedMatch) {
      const tx = exactVerifiedMatch.tx;
      const comparison = compareTransactionToVerifiedPayee(tx, verifiedPayee);

      console.log("Matched transaction:", JSON.stringify(summarizeTransaction(tx), null, 2));
      console.log("Matched payee:", JSON.stringify(summarizePayee(verifiedPayee), null, 2));

      return res.json({
        outcome: "payment_found",
        carrier: {
          name: verifiedPayee.payee_name || tx?.payee?.payee_name || "",
          dot: verifiedPayee.dot_number || "",
          mc: verifiedPayee.mc_number || "",
          verified: verifiedPayee.is_verified ?? "",
          isFactoringCompany: verifiedPayee.is_factoring_company ?? false,
          matchedBy: comparison.reason
        },
        payment: buildPaymentResponse(tx, reference)
      });
    }

    const firstReferenceMatch = candidates[0]?.tx || null;

    if (firstReferenceMatch) {
      const comparison = compareTransactionToVerifiedPayee(firstReferenceMatch, verifiedPayee);

      return res.json({
        outcome: "reference_found_dot_mismatch",
        carrier: {
          searchedDot: normalizeIdLike(dot),
          verifiedPayee: summarizePayee(verifiedPayee)
        },
        payment: {
          transactionPayee: {
            id: firstReferenceMatch?.payee?.id || firstReferenceMatch?.payee_id || "",
            name: firstReferenceMatch?.payee?.payee_name || ""
          }
        },
        debug: comparison.debug,
        message: "We found a payment reference, but it does not match the verified DOT number entered."
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
    return res.status(err.status || 500).json({
      error: "search_failed",
      details: err.message,
      where: err.url || null,
      status: err.status || 500,
      responseText: err.responseText || null
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
