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

const REQUEST_TIMEOUT_MS = Number(process.env.ROADSYNC_REQUEST_TIMEOUT_MS || 12000);

if (!ROADSYNC_API_KEY) throw new Error("Missing ROADSYNC_API_KEY");
if (!ROADSYNC_BROKER_ID) throw new Error("Missing ROADSYNC_BROKER_ID");

function normalizeIdLike(value) {
  return String(value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal
    });

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
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`RoadSync API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutErr.status = 504;
      timeoutErr.url = url;
      timeoutErr.responseText = "";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
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
    mc_number: payee?.mc_number || "",
    dot_number: payee?.dot_number || "",
    is_verified: payee?.is_verified ?? false,
    is_factoring_company: payee?.is_factoring_company ?? false,
    available_payment_types: payee?.available_payment_types || []
  };
}

function summarizeLoad(load) {
  if (!load) return null;

  return {
    id: load?.id || "",
    amount: load?.amount ?? "",
    status: load?.status || "",
    created_datetime: load?.created_datetime || "",
    updated_datetime: load?.updated_datetime || "",
    payee: summarizePayee(load?.payee),
    carrier_payee: load?.carrier_payee
      ? {
          id: load.carrier_payee.id || "",
          payee_name: load.carrier_payee.payee_name || "",
          is_verified: load.carrier_payee.is_verified ?? false
        }
      : null,
    payable: load?.payable
      ? {
          id: load.payable.id || "",
          amount: load.payable.amount ?? "",
          status: load.payable.status || "",
          payment_method: load.payable.payment_method || "",
          transaction: load.payable.transaction
            ? {
                id: load.payable.transaction.id || "",
                status: load.payable.transaction.status || "",
                payment_method: load.payable.transaction.payment_method || ""
              }
            : null
        }
      : null
  };
}

async function findLoadByNumber(loadNumber) {
  const target = String(loadNumber || "").trim();
  const endpoint = `/loads?load_number=${encodeURIComponent(target)}`;
  const raw = await rspayGet(endpoint);
  const items = toArray(raw);

  console.log(`Loads returned for load_number ${target}:`, items.length);

  const exactMatches = items.filter(
    item => String(item?.load_number || "").trim() === target
  );

  console.log(`Exact load_number matches for ${target}:`, exactMatches.length);

  if (exactMatches.length === 1) {
    return {
      status: "verified",
      load: exactMatches[0]
    };
  }

  if (exactMatches.length > 1) {
    return {
      status: "multiple_matches",
      matches: exactMatches.map(summarizeLoad)
    };
  }

  return {
    status: "not_found",
    load: null
  };
}

function dotMatchesLoad(dot, load) {
  const enteredDot = normalizeIdLike(dot);
  const loadDot = normalizeIdLike(load?.payee?.dot_number);

  return enteredDot && loadDot && enteredDot === loadDot;
}

function buildPortalResponse(load) {
  return {
    loadId: load?.id || "",
    loadNumber: load?.load_number || "",
    externalId: load?.external_id || "",
    amount: money(load?.amount),
    loadStatus: String(load?.status || "").toUpperCase(),
    createdDatetime: load?.created_datetime || "",
    updatedDatetime: load?.updated_datetime || "",
    payee: {
      id: load?.payee?.id || "",
      name: load?.payee?.payee_name || "",
      mcNumber: load?.payee?.mc_number || "",
      dotNumber: load?.payee?.dot_number || "",
      isVerified: load?.payee?.is_verified ?? false,
      isFactoringCompany: load?.payee?.is_factoring_company ?? false,
      availablePaymentTypes: load?.payee?.available_payment_types || []
    },
    carrierPayee: load?.carrier_payee
      ? {
          id: load.carrier_payee.id || "",
          name: load.carrier_payee.payee_name || "",
          isVerified: load.carrier_payee.is_verified ?? false
        }
      : null,
    payable: load?.payable
      ? {
          id: load.payable.id || "",
          amount: money(load.payable.amount),
          status: String(load.payable.status || "").toUpperCase(),
          paymentMethod: load.payable.payment_method || "",
          transaction: load.payable.transaction
            ? {
                id: load.payable.transaction.id || "",
                status: String(load.payable.transaction.status || "").toUpperCase(),
                paymentMethod: load.payable.transaction.payment_method || ""
              }
            : null
        }
      : null
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
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    apiKeyPresent: Boolean(ROADSYNC_API_KEY),
    apiKeyMasked: maskKey(ROADSYNC_API_KEY)
  });
});

app.get("/api/test-loads", async (req, res) => {
  try {
    const loadNumber = req.query.load_number || "8a868168";
    const result = await findLoadByNumber(loadNumber);

    res.json({
      ok: true,
      load_number: String(loadNumber),
      result
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      where: "rspay_loads_load_number_filter",
      endpoint: err.url || null,
      status: err.status || 500,
      message: err.message,
      responseText: err.responseText || null
    });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const { dot, reference, load_number } = req.query;
    const loadNumber = load_number || reference;

    if (!dot || !loadNumber) {
      return res.status(400).json({
        error: "dot_and_load_number_required"
      });
    }

    console.log("=== /api/search request ===");
    console.log("RSPAY_BASE_URL:", RSPAY_BASE_URL);
    console.log("BROKER_ID:", String(ROADSYNC_BROKER_ID));
    console.log("API KEY MASKED:", maskKey(ROADSYNC_API_KEY));
    console.log("DOT:", dot);
    console.log("LOAD NUMBER:", loadNumber);

    const loadLookup = await findLoadByNumber(loadNumber);

    if (loadLookup.status === "not_found") {
      return res.json({
        outcome: "not_found",
        message: "We could not find a matching load number."
      });
    }

    if (loadLookup.status === "multiple_matches") {
      return res.json({
        outcome: "multiple_load_matches",
        message: "Multiple loads were returned for this load number. Payment details cannot be displayed until the match is uniquely verified."
      });
    }

    const load = loadLookup.load;

    if (!load) {
      return res.json({
        outcome: "load_lookup_unavailable",
        message: "We could not retrieve the load at this time."
      });
    }

    if (!dotMatchesLoad(dot, load)) {
      return res.json({
        outcome: "load_found_dot_mismatch",
        message: "We found the load, but the DOT number entered does not match the payee on the load.",
        carrier: {
          searchedDot: normalizeIdLike(dot),
          loadPayee: summarizePayee(load.payee)
        }
      });
    }

    return res.json({
      outcome: "payment_found",
      carrier: {
        searchedDot: normalizeIdLike(dot),
        matchedBy: "load.payee.dot_number",
        payee: summarizePayee(load.payee)
      },
      payment: buildPortalResponse(load)
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
