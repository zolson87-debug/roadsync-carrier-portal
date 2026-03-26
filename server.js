const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");
const { Pool } = require("pg");

const app = express();

app.use(express.static(path.join(__dirname)));
app.use(express.json());

const ROADSYNC_API_KEY = process.env.ROADSYNC_API_KEY;
const ROADSYNC_BROKER_ID = process.env.ROADSYNC_BROKER_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_SYNC_KEY = process.env.ADMIN_SYNC_KEY;

const RSPAY_BASE_URL =
  process.env.ROADSYNC_BASE_URL || "https://api.roadsync.app/rspay/v1";

const SEARCH_LIMIT = Number(process.env.ROADSYNC_SEARCH_LIMIT || 150);
const MAX_TRANSACTION_PAGES = Number(process.env.ROADSYNC_MAX_TRANSACTION_PAGES || 5);
const MAX_PAYEE_SYNC_PAGES = Number(process.env.ROADSYNC_MAX_PAYEE_SYNC_PAGES || 100);

if (!ROADSYNC_API_KEY) throw new Error("Missing ROADSYNC_API_KEY");
if (!ROADSYNC_BROKER_ID) throw new Error("Missing ROADSYNC_BROKER_ID");
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!ADMIN_SYNC_KEY) throw new Error("Missing ADMIN_SYNC_KEY");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

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

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payees (
      payee_id TEXT PRIMARY KEY,
      dot_number TEXT NOT NULL,
      payee_name TEXT,
      mc_number TEXT,
      is_verified BOOLEAN,
      is_factoring_company BOOLEAN,
      email_address TEXT,
      phone_number TEXT,
      address_city TEXT,
      address_state TEXT,
      raw_payload JSONB,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payees_dot
    ON payees(dot_number);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payees_name
    ON payees(payee_name);
  `);
}

async function upsertPayee(payee) {
  await pool.query(
    `
    INSERT INTO payees (
      payee_id,
      dot_number,
      payee_name,
      mc_number,
      is_verified,
      is_factoring_company,
      email_address,
      phone_number,
      address_city,
      address_state,
      raw_payload,
      last_synced_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (payee_id)
    DO UPDATE SET
      dot_number = EXCLUDED.dot_number,
      payee_name = EXCLUDED.payee_name,
      mc_number = EXCLUDED.mc_number,
      is_verified = EXCLUDED.is_verified,
      is_factoring_company = EXCLUDED.is_factoring_company,
      email_address = EXCLUDED.email_address,
      phone_number = EXCLUDED.phone_number,
      address_city = EXCLUDED.address_city,
      address_state = EXCLUDED.address_state,
      raw_payload = EXCLUDED.raw_payload,
      last_synced_at = NOW()
    `,
    [
      String(payee?.id || ""),
      normalizeIdLike(payee?.dot_number || ""),
      payee?.payee_name || "",
      payee?.mc_number || "",
      Boolean(payee?.is_verified),
      Boolean(payee?.is_factoring_company),
      payee?.email_address || "",
      payee?.phone_number || "",
      payee?.address_city || payee?.city || "",
      payee?.address_state || payee?.state || "",
      JSON.stringify(payee || {})
    ]
  );
}

async function getPayeeByDot(dot) {
  const result = await pool.query(
    `SELECT * FROM payees WHERE dot_number = $1 LIMIT 1`,
    [normalizeIdLike(dot)]
  );
  return result.rows[0] || null;
}

function summarizeStoredPayee(payee) {
  if (!payee) return null;

  return {
    payee_id: payee.payee_id,
    dot_number: payee.dot_number,
    payee_name: payee.payee_name,
    mc_number: payee.mc_number,
    is_verified: payee.is_verified,
    is_factoring_company: payee.is_factoring_company,
    email_address: payee.email_address,
    phone_number: payee.phone_number,
    address_city: payee.address_city,
    address_state: payee.address_state,
    last_synced_at: payee.last_synced_at
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

function compareTransactionToVerifiedPayee(tx, storedPayee) {
  const txPayeeId = String(tx?.payee?.id || tx?.payee_id || "");
  const verifiedPayeeId = String(storedPayee?.payee_id || "");
  const txPayeeName = normalizeName(tx?.payee?.payee_name || "");
  const storedPayeeName = normalizeName(storedPayee?.payee_name || "");

  if (txPayeeId && verifiedPayeeId && txPayeeId === verifiedPayeeId) {
    return {
      matched: true,
      reason: "payee_id"
    };
  }

  if (!txPayeeId && txPayeeName && storedPayeeName && txPayeeName === storedPayeeName) {
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
      verifiedPayeeName: storedPayee?.payee_name || ""
    }
  };
}

async function fetchTransactionsPage(page, reference) {
  const endpoint = `/transactions?page=${page}&limit=${SEARCH_LIMIT}&invoice_number=${encodeURIComponent(reference)}`;
  const raw = await rspayGet(endpoint);
  const rows = toArray(raw);

  console.log(`Transaction rows returned for invoice_number page ${page}:`, rows.length);
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
    const rows = await fetchTransactionsPage(page, reference);
    addRows(rows, `invoice_number_page_${page}`);
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

app.get("/api/health", async (req, res) => {
  try {
    res.json({
      ok: true,
      rspayBaseUrl: RSPAY_BASE_URL,
      brokerId: String(ROADSYNC_BROKER_ID),
      searchLimit: SEARCH_LIMIT,
      maxTransactionPages: MAX_TRANSACTION_PAGES,
      maxPayeeSyncPages: MAX_PAYEE_SYNC_PAGES,
      apiKeyPresent: Boolean(ROADSYNC_API_KEY),
      apiKeyMasked: maskKey(ROADSYNC_API_KEY),
      databaseConfigured: Boolean(DATABASE_URL)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/api/db-health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    const count = await pool.query("SELECT COUNT(*)::int AS count FROM payees");

    res.json({
      ok: true,
      now: result.rows[0].now,
      payeeCount: count.rows[0].count
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/api/admin/sync-payees", async (req, res) => {
  try {
    if (req.query.key !== ADMIN_SYNC_KEY) {
      return res.status(403).json({ error: "forbidden" });
    }

    let page = 1;
    let saved = 0;

    while (page <= MAX_PAYEE_SYNC_PAGES) {
      const raw = await rspayGet(`/payees?page=${page}`);
      const rows = toArray(raw);

      console.log(`Payees page ${page} returned:`, rows.length);

      if (!rows.length) break;

      for (const payee of rows) {
        await upsertPayee(payee);
        saved += 1;
      }

      if (rows.length < SEARCH_LIMIT) break;
      page += 1;
    }

    const count = await pool.query("SELECT COUNT(*)::int AS count FROM payees");

    res.json({
      ok: true,
      pagesProcessed: page,
      saved,
      payeeCount: count.rows[0].count
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      status: err.status || 500,
      message: err.message,
      endpoint: err.url || null,
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

app.get("/api/test-payee-cache", async (req, res) => {
  try {
    const dot = req.query.dot || "2117808";
    const payee = await getPayeeByDot(dot);

    res.json({
      ok: true,
      dot: normalizeIdLike(dot),
      found: Boolean(payee),
      payee: summarizeStoredPayee(payee)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: err.message
    });
  }
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

    const verifiedPayee = await getPayeeByDot(dot);

    if (!verifiedPayee) {
      return res.json({
        outcome: "dot_not_found",
        message: "Your DOT number was not found in the verified payee database."
      });
    }

    const candidates = await findCandidateTransactions(reference);

    if (!candidates.length) {
      return res.json({
        outcome: "not_found",
        carrier: {
          searchedDot: normalizeIdLike(dot),
          verifiedPayee: summarizeStoredPayee(verifiedPayee)
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
          verifiedPayee: summarizeStoredPayee(verifiedPayee)
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

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
