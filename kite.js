/**
 * Zerodha Kite Connect v3 — Full API Client
 *
 * Covers: auth, orders, GTT, portfolio, market data,
 *         historical candles, margins, instruments, quotes
 */

import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

const BASE_URL            = "https://api.kite.trade";
const INSTRUMENTS_CACHE   = "instruments-cache.json";
const TOKEN_FILE          = ".kite-access-token";

// Hardcoded tokens for NSE indices (stable, don't change)
const INDEX_TOKENS = {
  "NIFTY 50":   256265,
  "NIFTY50":    256265,
  "NIFTY BANK": 260105,
  "NIFTYBANK":  260105,
  "SENSEX":     265,
};

// ─── KiteClient ───────────────────────────────────────────────────────────────

export class KiteClient {
  constructor({ apiKey, apiSecret, accessToken = null }) {
    this.apiKey      = apiKey;
    this.apiSecret   = apiSecret;
    this.accessToken = accessToken || loadStoredToken();
  }

  // ── Request helpers ─────────────────────────────────────────────────────────

  _headers(jsonBody = false) {
    return {
      "X-Kite-Version": "3",
      "Authorization":  `token ${this.apiKey}:${this.accessToken}`,
      "Content-Type":   jsonBody ? "application/json" : "application/x-www-form-urlencoded",
    };
  }

  async _request(method, path, params = null, jsonBody = false) {
    let url  = BASE_URL + path;
    let body = null;

    if (params && (method === "GET" || method === "DELETE")) {
      url += "?" + new URLSearchParams(params).toString();
    } else if (params) {
      body = jsonBody ? JSON.stringify(params) : new URLSearchParams(params).toString();
    }

    const res = await fetch(url, { method, headers: this._headers(jsonBody), body });

    // CSV responses (instruments list)
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/csv") || ct.includes("text/plain")) {
      if (!res.ok) throw kiteError(`HTTP ${res.status}`, "NetworkException", res.status);
      return res.text();
    }

    const json = await res.json();

    if (!res.ok || json.status === "error") {
      throw kiteError(json.message || `HTTP ${res.status}`, json.error_type || "GeneralException", res.status);
    }

    return json.data;
  }

  // ── Authentication ───────────────────────────────────────────────────────────

  static async generateAccessToken({ apiKey, apiSecret, requestToken }) {
    const checksum = crypto
      .createHash("sha256")
      .update(apiKey + requestToken + apiSecret)
      .digest("hex");

    const res = await fetch(`${BASE_URL}/session/token`, {
      method:  "POST",
      headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
    });

    const json = await res.json();
    if (json.status !== "success") throw kiteError(json.message, "TokenException", 403);
    return json.data.access_token;
  }

  invalidateToken() {
    return this._request("DELETE", "/session/token", { api_key: this.apiKey, access_token: this.accessToken });
  }

  // ── User ────────────────────────────────────────────────────────────────────

  getProfile() {
    return this._request("GET", "/user/profile");
  }

  getMargins(segment = null) {
    return this._request("GET", segment ? `/user/margins/${segment}` : "/user/margins");
  }

  // ── Instruments & token lookup ───────────────────────────────────────────────

  async getInstrumentToken(symbol, exchange = "NSE") {
    // Check hardcoded index tokens first
    if (INDEX_TOKENS[symbol]) return INDEX_TOKENS[symbol];

    const cache = await this._loadInstrumentsCache();
    return cache[`${exchange}:${symbol}`] || null;
  }

  async _loadInstrumentsCache() {
    if (existsSync(INSTRUMENTS_CACHE)) {
      const cached = JSON.parse(readFileSync(INSTRUMENTS_CACHE, "utf8"));
      const ageHours = (Date.now() - cached.timestamp) / 3600000;
      if (ageHours < 18) return cached.tokens;
    }

    process.stdout.write("  Refreshing instrument token cache from Kite... ");
    const csv   = await this._request("GET", "/instruments/NSE");
    const lines = csv.trim().split("\n");
    const hdr   = lines[0].split(",");
    const iToken   = hdr.indexOf("instrument_token");
    const iSymbol  = hdr.indexOf("tradingsymbol");
    const iExchange = hdr.indexOf("exchange");
    const iType    = hdr.indexOf("instrument_type");

    const tokens = { ...INDEX_TOKENS };
    let count = 0;

    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const type = cols[iType]?.trim();
      if (type !== "EQ") continue; // only equity instruments
      const ex  = cols[iExchange]?.trim();
      const sym = cols[iSymbol]?.trim();
      const tok = parseInt(cols[iToken]);
      if (ex && sym && tok) { tokens[`${ex}:${sym}`] = tok; count++; }
    }

    writeFileSync(INSTRUMENTS_CACHE, JSON.stringify({ timestamp: Date.now(), tokens }));
    console.log(`✅ ${count} NSE equity tokens cached`);
    return tokens;
  }

  // ── Historical candle data ───────────────────────────────────────────────────

  async getHistorical(symbol, exchange = "NSE", interval = "day", fromDate, toDate) {
    const token = await this.getInstrumentToken(symbol, exchange);
    if (!token) throw new Error(`No instrument token for ${exchange}:${symbol}`);

    const from = kiteDate(fromDate);
    const to   = kiteDate(toDate);

    const data = await this._request(
      "GET",
      `/instruments/historical/${token}/${interval}`,
      { from, to }
    );

    return (data.candles || []).map(([time, open, high, low, close, volume, oi]) => ({
      time:   new Date(time).getTime(),
      open, high, low, close,
      volume: volume || 0,
      oi:     oi     || 0,
    }));
  }

  // ── Quotes & LTP ────────────────────────────────────────────────────────────

  getLTP(instruments) {
    // instruments: ["NSE:RELIANCE", "NSE:TCS"]
    const params = new URLSearchParams();
    instruments.forEach((i) => params.append("i", i));
    return this._request("GET", `/quote/ltp?${params}`);
  }

  getOHLC(instruments) {
    const params = new URLSearchParams();
    instruments.forEach((i) => params.append("i", i));
    return this._request("GET", `/quote/ohlc?${params}`);
  }

  getQuote(instruments) {
    const params = new URLSearchParams();
    instruments.forEach((i) => params.append("i", i));
    return this._request("GET", `/quote?${params}`);
  }

  // ── Orders ──────────────────────────────────────────────────────────────────

  placeOrder(variety = "regular", params) {
    return this._request("POST", `/orders/${variety}`, params);
  }

  modifyOrder(variety, orderId, params) {
    return this._request("PUT", `/orders/${variety}/${orderId}`, params);
  }

  cancelOrder(variety, orderId) {
    return this._request("DELETE", `/orders/${variety}/${orderId}`);
  }

  getOrders() {
    return this._request("GET", "/orders");
  }

  getOrderHistory(orderId) {
    return this._request("GET", `/orders/${orderId}`);
  }

  getOrderTrades(orderId) {
    return this._request("GET", `/orders/${orderId}/trades`);
  }

  getTrades() {
    return this._request("GET", "/trades");
  }

  // ── Margins ──────────────────────────────────────────────────────────────────

  checkOrderMargins(orders) {
    // orders: array of order objects
    return this._request("POST", "/margins/orders", orders, true);
  }

  checkBasketMargins(orders, considerPositions = true) {
    return this._request(
      "POST",
      `/margins/basket?consider_positions=${considerPositions}`,
      orders,
      true
    );
  }

  getCharges(orders) {
    return this._request("POST", "/charges/orders", orders, true);
  }

  // ── GTT (Good Till Triggered) ────────────────────────────────────────────────

  placeGTT({ type, symbol, exchange = "NSE", triggerValues, lastPrice, orders }) {
    // condition and orders must be JSON strings in form-encoded body
    return this._request("POST", "/gtt/triggers", {
      type,
      condition: JSON.stringify({
        exchange,
        tradingsymbol: symbol,
        trigger_values: triggerValues,
        last_price:     lastPrice,
      }),
      orders: JSON.stringify(orders),
    });
  }

  modifyGTT(id, { type, symbol, exchange = "NSE", triggerValues, lastPrice, orders }) {
    return this._request("PUT", `/gtt/triggers/${id}`, {
      type,
      condition: JSON.stringify({ exchange, tradingsymbol: symbol, trigger_values: triggerValues, last_price: lastPrice }),
      orders:    JSON.stringify(orders),
    });
  }

  getGTT(id) {
    return this._request("GET", `/gtt/triggers/${id}`);
  }

  listGTTs() {
    return this._request("GET", "/gtt/triggers");
  }

  deleteGTT(id) {
    return this._request("DELETE", `/gtt/triggers/${id}`);
  }

  // ── Portfolio ────────────────────────────────────────────────────────────────

  getHoldings() {
    return this._request("GET", "/portfolio/holdings");
  }

  getPositions() {
    return this._request("GET", "/portfolio/positions");
  }

  convertPosition(params) {
    return this._request("PUT", "/portfolio/positions", params);
  }

  // ── Mutual Funds ─────────────────────────────────────────────────────────────

  getMFOrders()      { return this._request("GET", "/mf/orders"); }
  getMFSIPs()        { return this._request("GET", "/mf/sips"); }
  getMFHoldings()    { return this._request("GET", "/mf/holdings"); }
  getMFInstruments() { return this._request("GET", "/mf/instruments"); }
}

// ─── Token file helpers ───────────────────────────────────────────────────────

export function saveToken(token) {
  writeFileSync(TOKEN_FILE, token, "utf8");
}

export function loadStoredToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  return process.env.KITE_ACCESS_TOKEN || null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function kiteError(message, type, status) {
  const err    = new Error(message);
  err.errorType = type;
  err.status   = status;
  return err;
}

export function isTokenError(err) {
  return err.status === 403 || err.errorType === "TokenException";
}

// Format date for Kite API: "yyyy-mm-dd hh:mm:ss"
export function kiteDate(d) {
  return (d instanceof Date ? d : new Date(d))
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

// Historical date helpers
export function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

// Resample daily candles → weekly (Kite doesn't have a week interval)
export function toWeekly(dailyCandles) {
  const weeks = [];
  let bucket  = [];

  for (const c of dailyCandles) {
    bucket.push(c);
    const dow = new Date(c.time).getDay(); // 5 = Friday
    if (dow === 5 || c === dailyCandles[dailyCandles.length - 1]) {
      if (bucket.length) {
        weeks.push({
          time:   bucket[0].time,
          open:   bucket[0].open,
          high:   Math.max(...bucket.map((x) => x.high)),
          low:    Math.min(...bucket.map((x) => x.low)),
          close:  bucket[bucket.length - 1].close,
          volume: bucket.reduce((s, x) => s + x.volume, 0),
        });
        bucket = [];
      }
    }
  }

  return weeks;
}
