/**
 * Multi-Symbol Swing Trading Scanner & Executor
 *
 * Exchange : Zerodha Kite Connect v3
 * Data     : Kite historical API (Yahoo Finance as fallback)
 * Strategy : EMA Pullback Swing — 9-condition scoring
 * Exits    : GTT stop + target | trail | structure | time
 *
 * Commands:
 *   node bot.js                  — run full scan + exit check + new entries
 *   node bot.js --auth TOKEN     — generate & save access token
 *   node bot.js --positions      — show open positions + live P&L
 *   node bot.js --tax-summary    — trade summary for accountant
 *   node bot.js --sync           — sync positions.json with Kite holdings
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { KiteClient, saveToken, loadStoredToken, isTokenError, toWeekly, daysAgo } from "./kite.js";
import { autoAuth } from "./auto-auth.js";
import { notifyScanSummary, notifyEntry, notifyExit, notifyLossAlert, notifyWeeklyReport, notifyPositionStatus, notifyCircuitBreaker } from "./notify.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  portfolioValue:      parseFloat(process.env.PORTFOLIO_VALUE_INR   || "2000"),
  // No per-trade cap — bot uses available capital across open slots
  maxTradesPerDay:     parseInt(process.env.MAX_TRADES_PER_DAY       || "3"),
  maxActiveTrades:     parseInt(process.env.MAX_ACTIVE_TRADES        || "3"),
  riskPercent:         parseFloat(process.env.RISK_PERCENT           || "0.01"),
  maxStopPct:          parseFloat(process.env.MAX_STOP_PCT           || "0.01"),  // hard 1% stop cap
  trailMode:           process.env.TRAIL_MODE                        || "EMA21",
  maxDaysHeld:         parseInt(process.env.MAX_DAYS_HELD            || "7"),
  paperTrading:        process.env.PAPER_TRADING !== "false",
  // ── Institutional scoring — 7pt weighted scale ───────────────────────────
  // BOS=2, OB=2, FVG=1, accum=1, weekly=1  →  max 7
  // Minimum quality trade = BOS(2)+OB(2) = 4pts
  buyThreshold:        parseInt(process.env.BUY_THRESHOLD            || "4"),   // BUY ≥ 4/8 (BOS+OB minimum)
  strongBuyThreshold:  parseInt(process.env.STRONG_BUY_THRESHOLD     || "6"),   // STRONG BUY ≥ 6/8
  adaptAfterScans:     parseInt(process.env.ADAPT_AFTER_SCANS        || "6"),   // more patient before relaxing
  // ── Risk guards ──────────────────────────────────────────────────────────────
  maxTradesPerWeek:    parseInt(process.env.MAX_TRADES_PER_WEEK      || "10"),  // quality cap — 10 trades/week max
  maxConcentrationPct: parseFloat(process.env.MAX_CONCENTRATION_PCT  || "0.40"), // max 40% portfolio in one position
  dailyLossLimitPct:   parseFloat(process.env.DAILY_LOSS_LIMIT_PCT   || "0.02"), // halt if realised -2% today
  consecutiveLossHalt: parseInt(process.env.CONSECUTIVE_LOSS_HALT    || "3"),   // pause after 3 straight losses
  // ── Scan mode ────────────────────────────────────────────────────────────────
  // "full"   = scan all symbols every run (default, Option C)
  // "tiered" = scan tier1 every run, full list only on Monday 10AM (Option A fallback)
  scanMode:            process.env.SCAN_MODE                         || "full",
  tier1Size:           parseInt(process.env.TIER1_SIZE               || "100"),  // top N stocks for daily scans in tiered mode
};

// ─── Session ID + IST helpers ─────────────────────────────────────────────────

const sessionId = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;

function nowIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}
function toISTStr(d) {
  return new Date(d).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function isMarketOpen() {
  const t = nowIST(), mins = t.getHours() * 60 + t.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 15 * 60 + 30;
}
function isPastPreMarket() {
  const t = nowIST(), mins = t.getHours() * 60 + t.getMinutes();
  return mins >= 9 * 60 + 45;  // no entries before 9:45 AM IST (volatile open)
}

// ─── Kite client ──────────────────────────────────────────────────────────────

function initKite() {
  if (!process.env.KITE_API_KEY || !process.env.KITE_API_SECRET) {
    console.error("⚠️  Missing KITE_API_KEY or KITE_API_SECRET in .env");
    process.exit(1);
  }
  return new KiteClient({
    apiKey:      process.env.KITE_API_KEY,
    apiSecret:   process.env.KITE_API_SECRET,
    accessToken: loadStoredToken(),
  });
}

// ─── Market data (Kite primary, Yahoo fallback) ───────────────────────────────

const YF_SYMBOL_MAP = {
  // Index symbols
  NIFTY50: "^NSEI", NIFTYBANK: "^NSEBANK",
  // Kite symbol → Yahoo Finance symbol (verified working)
  "NAVIN":        "NAVINFLUOR.NS",
  "AARTI":        "AARTIIND.NS",
  "BERGERPAINTS": "BERGEPAINT.NS",
  "METRO":        "METROBRAND.NS",
  "HG":           "HGINFRA.NS",
  "AHLUWALIA":    "AHLUCONT.NS",
  "MCDOWELL-N":   "UNITDSPR.NS",
  "FINOLEX":      "FINCABLES.NS",       // was FINOLEXCAB.NS — fixed
  "LAXMIMACH":    "LMW.NS",
  "VARDHMAN":     "VTL.NS",
  "FINPIPE":      "FINPIPE.NS",
  // Renamed/restructured companies
  "HEXAWARE":     "HEXT.NS",            // relisted as HEXT
  "AMARARAJA":    "ARE&M.NS",           // renamed Amara Raja Energy & Mobility
  "KALPATPOWR":   "KPIL.NS",            // renamed Kalpataru Projects International
  "GMRINFRA":     "GMRAIRPORT.NS",      // renamed GMR Airports
  "ESAB":         "ESABINDIA.NS",
  "MTAR":         "MTARTECH.NS",
  "GVK":          "GVKPIL.NS",
  "INSECTICIDES": "INSECTICID.NS",
  // BSE code fallbacks (Yahoo NS data unavailable)
  "TV18BRDCST":   "532800.BO",
  "ADANITRANS":   "539254.BO",
  // Not on Yahoo Finance (removed/delisted from YF data): TATAMOTORS, ZOMATO, BARBEQUE
};
const YF_INTERVAL_MAP = { "1D": "1d", "1W": "1wk" };
const YF_RANGE_MAP    = { "1D": "1y", "1W": "2y" };

async function fetchCandlesYahoo(symbol, tf = "1D", limit = 250) {
  const ySym = YF_SYMBOL_MAP[symbol] ?? `${decodeURIComponent(symbol)}.NS`;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=${YF_INTERVAL_MAP[tf] || "1d"}&range=${YF_RANGE_MAP[tf] || "1y"}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json   = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp) throw new Error("Yahoo: no data");
  const ts = result.timestamp;
  const q  = result.indicators?.quote?.[0];
  if (!q) throw new Error("Yahoo: no quote data");
  return ts
    .map((t, i) => ({
      time: t * 1000,
      open:   q.open?.[i],  high: q.high?.[i],
      low:    q.low?.[i],   close: q.close?.[i],
      volume: q.volume?.[i] ?? 0,
    }))
    // Filter out any candle where OHLC fields are null/undefined (corrupted Yahoo data)
    .filter((c) => c.close != null && c.open != null && c.high != null && c.low != null)
    .slice(-limit);
}

async function fetchCandles(kite, symbol, tf = "1D", limit = 250) {
  // Swing trading only — always use daily candles
  try {
    const from    = daysAgo(365);
    const to      = new Date();
    const candles = await kite.getHistorical(symbol, "NSE", "day", from, to);
    if (candles.length < 20) throw new Error("insufficient data from Kite");
    return candles.slice(-limit);
  } catch (err) {
    // Only rethrow on true session expiry — 403 on historical = plan restriction, fall back to Yahoo
    if (err.errorType === "TokenException") throw err;
    // Throttle Yahoo fallback — prevent rate-limit 404s when many stocks fall through
    await new Promise((r) => setTimeout(r, 250));
    return fetchCandlesYahoo(symbol, "1D", limit);
  }
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  const ag = g / period, al = l / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
  );
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function avgVol(candles, period = 10) {
  if (candles.length < period + 1) return null;
  return candles.slice(-period - 1, -1).reduce((s, c) => s + c.volume, 0) / period;
}

function hhhl(candles, lookback = 20) {
  if (candles.length < lookback) return false;
  const s   = candles.slice(-lookback);
  const mid = Math.floor(lookback / 2);
  return (
    Math.max(...s.slice(mid).map((c) => c.high))  > Math.max(...s.slice(0, mid).map((c) => c.high)) &&
    Math.min(...s.slice(mid).map((c) => c.low))   < Math.min(...s.slice(0, mid).map((c) => c.low)) * 1 &&
    Math.min(...s.slice(mid).map((c) => c.low))   > Math.min(...s.slice(0, mid).map((c) => c.low)) * 0.98
  );
}

function recentSwingLow(candles, lookback = 10) {
  return Math.min(...candles.slice(-lookback - 1, -1).map((c) => c.low));
}

function bullishCandle(candles) {
  if (candles.length < 2) return false;
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open), range = c.high - c.low;
  return c.close > c.open && c.close > p.close && range > 0 && body / range > 0.5;
}

function nearSupport(price, e21, e20, atrVal) {
  if (!atrVal || !e21 || !e20) return false;
  const zone = Math.min(e21, e20);
  return price >= zone - atrVal * 0.5 && price <= zone + atrVal;
}

// ─── SMC Indicators (ported from tradingSignalsIndicator) ────────────────────

function swingHighsLows(candles, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const slice = candles.slice(i - left, i + right + 1);
    if (candles[i].high === Math.max(...slice.map((c) => c.high))) highs.push(candles[i].high);
    if (candles[i].low  === Math.min(...slice.map((c) => c.low)))  lows.push(candles[i].low);
  }
  return { highs, lows };
}

function detectBOS(candles) {
  const { highs, lows } = swingHighsLows(candles, 5, 5);
  const current = candles[candles.length - 1].close;
  if (highs.length >= 2) {
    const lastHigh = highs[highs.length - 1], prevHigh = highs[highs.length - 2];
    if (current > lastHigh && lastHigh > prevHigh) return "BULLISH";
  }
  if (lows.length >= 2) {
    const lastLow = lows[lows.length - 1], prevLow = lows[lows.length - 2];
    if (current < lastLow && lastLow < prevLow)   return "BEARISH";
  }
  return null;
}

function findBullishOB(candles, lookback = 40) {
  const recent = candles.slice(-(lookback + 3));
  for (let i = recent.length - 4; i >= 2; i--) {
    const c = recent[i];
    if (c.close < c.open) {                                      // bearish candle
      const move = (recent[i + 2].close - c.close) / c.close;
      if (move > 0.012) {                                        // strong bullish follow-through
        const obHigh = Math.max(c.open, c.close);
        const obLow  = Math.min(c.open, c.close);
        if (recent.slice(i + 1).every((x) => x.low > obLow)) {  // unmitigated
          return { high: obHigh, low: obLow };
        }
      }
    }
  }
  return null;
}

function findBullishFVG(candles, lookback = 40) {
  const recent = candles.slice(-(lookback + 2));
  for (let i = recent.length - 2; i >= 1; i--) {
    if (recent[i - 1].high < recent[i + 1].low) {               // gap exists
      const low  = recent[i - 1].high;
      const high = recent[i + 1].low;
      if (recent.slice(i + 1).every((x) => x.low > low)) {      // unfilled
        return { high, low, mid: (high + low) / 2 };
      }
    }
  }
  return null;
}

function volumeAccumulation(candles) {
  if (candles.length < 23) return false;
  const recent3  = candles.slice(-3);
  const avg20vol = candles.slice(-23, -3).reduce((s, c) => s + c.volume, 0) / 20;
  return recent3.every((c) => c.close > c.open && c.volume > avg20vol);
}

function volumePOC(candles, bins = 20) {
  if (candles.length < 20) return null;
  const recent  = candles.slice(-60);
  const lo      = Math.min(...recent.map((c) => c.low));
  const hi      = Math.max(...recent.map((c) => c.high));
  const binSize = (hi - lo) / bins;
  const profile = {};
  for (const c of recent) {
    let lvl = lo;
    while (lvl <= hi) {
      if (c.low <= lvl + binSize && c.high >= lvl) {
        const key = Math.round(lvl * 100) / 100;
        profile[key] = (profile[key] || 0) + c.volume;
      }
      lvl += binSize;
    }
  }
  const sorted = Object.entries(profile).sort((a, b) => b[1] - a[1]);
  return sorted.length ? parseFloat(sorted[0][0]) : null;
}

// ─── SMC Quality Gates (numeric defs — replace subjective "clean OB / messy structure") ──

// OB clean = displacement candle ≥ 1.5×ATR14, OB untested since formation, single-candle origin.
function obQuality(candles, ob, atrV) {
  if (!ob || !atrV) return { clean: false, reason: "no OB or ATR" };
  // Locate OB candle index by matching open/close band.
  let idx = -1;
  for (let i = candles.length - 4; i >= 2; i--) {
    const c = candles[i];
    const hi = Math.max(c.open, c.close), lo = Math.min(c.open, c.close);
    if (Math.abs(hi - ob.high) / ob.high < 0.001 && Math.abs(lo - ob.low) / ob.low < 0.001) {
      idx = i; break;
    }
  }
  if (idx < 0) return { clean: false, reason: "OB candle not found" };
  // Displacement = next 1-2 candles range vs ATR
  const next = candles[idx + 1], next2 = candles[idx + 2];
  if (!next || !next2) return { clean: false, reason: "no displacement window" };
  const displacement = Math.max(next.high, next2.high) - Math.min(next.low, next2.low);
  if (displacement < atrV * 1.5) return { clean: false, reason: `weak displacement ${(displacement/atrV).toFixed(2)}xATR` };
  // Untested since: no candle low has dipped into OB body (already checked in findBullishOB, recheck strict)
  const since = candles.slice(idx + 1);
  const tested = since.some((x) => x.low < ob.high && x.high > ob.low);
  if (tested) return { clean: false, reason: "OB already mitigated" };
  return { clean: true, reason: "" };
}

// Structure clean = last 3 swings show HH+HL sequence, no excessive wick overlap.
function structureClean(candles, lookback = 30) {
  if (candles.length < lookback) return { clean: false, reason: "insufficient candles" };
  const { highs, lows } = swingHighsLows(candles.slice(-lookback), 3, 3);
  if (highs.length < 2 || lows.length < 2) return { clean: false, reason: "too few swings" };
  const hh = highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows[lows.length - 1]  > lows[lows.length - 2];
  if (!hh || !hl) return { clean: false, reason: !hh ? "no HH" : "no HL" };
  // Wick overlap: last 5 candles, count where wick > 50% of range
  const recent5 = candles.slice(-5);
  const choppy  = recent5.filter((c) => {
    const range = c.high - c.low;
    if (range === 0) return false;
    const body = Math.abs(c.close - c.open);
    return (range - body) / range > 0.5;
  }).length;
  if (choppy >= 4) return { clean: false, reason: `${choppy}/5 candles dominated by wicks` };
  return { clean: true, reason: "" };
}

// Extended = 3+ consecutive green candles → already in move, pullback gone.
function isExtended(candles) {
  if (candles.length < 3) return false;
  const last3 = candles.slice(-3);
  return last3.every((c) => c.close > c.open);
}

// Retail trap = entry within 0.3% of obvious 20d swing high.
function nearSwingHigh(price, candles, lookback = 20, pct = 0.003) {
  if (candles.length < lookback) return false;
  const hi = Math.max(...candles.slice(-lookback).map((c) => c.high));
  return Math.abs(price - hi) / hi < pct;
}

// Pullback-into-OB = price within OB body now, after move up to it.
function isPullbackIntoOB(price, ob) {
  if (!ob) return false;
  return price >= ob.low && price <= ob.high * 1.005;
}

// Pullback-into-FVG = price inside FVG band.
function isPullbackIntoFVG(price, fvg) {
  if (!fvg) return false;
  return price >= fvg.low && price <= fvg.high;
}

// Confirmation candle = bullish engulfing OR bullish pin bar on last completed candle.
function confirmationCandle(candles) {
  if (candles.length < 2) return { ok: false, reason: "no candles" };
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const range = c.high - c.low;
  if (range === 0) return { ok: false, reason: "flat candle" };
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  // Bullish engulf: prev bearish, curr bullish, curr body engulfs prev body
  const prevBear = p.close < p.open;
  const currBull = c.close > c.open;
  const engulf   = prevBear && currBull && c.close >= p.open && c.open <= p.close;

  // Pin bar: lower wick ≥ 2× body, body ≤ 30% of range, closes in upper half
  const pin = lowerWick >= body * 2 && body / range <= 0.3 && c.close > (c.high + c.low) / 2;

  if (engulf) return { ok: true, reason: "bullish engulf" };
  if (pin)    return { ok: true, reason: "bullish pin bar" };
  return { ok: false, reason: "no engulf/pin confirmation" };
}

// Weekly regime gate: ADX-lite (trend strength via DM% over weekly candles) OR weekly HH/HL intact.
function weeklyRegimeOk(weeklyCandles) {
  if (weeklyCandles.length < 14) return { ok: false, reason: "weekly history short" };
  // HH/HL on weekly = simplest regime check
  const hh = hhhl(weeklyCandles, 10);
  if (hh) return { ok: true, reason: "weekly HH/HL intact" };
  // ADX-lite: avg directional range over 14 weeks vs avg true range
  const w = weeklyCandles.slice(-14);
  let plusDM = 0, minusDM = 0, trSum = 0;
  for (let i = 1; i < w.length; i++) {
    const up   = w[i].high - w[i - 1].high;
    const down = w[i - 1].low - w[i].low;
    if (up > down && up > 0)   plusDM  += up;
    if (down > up && down > 0) minusDM += down;
    trSum += Math.max(w[i].high - w[i].low, Math.abs(w[i].high - w[i - 1].close), Math.abs(w[i].low - w[i - 1].close));
  }
  if (trSum === 0) return { ok: false, reason: "no range" };
  const dx = Math.abs(plusDM - minusDM) / (plusDM + minusDM || 1) * 100;
  if (dx >= 25 && plusDM > minusDM) return { ok: true, reason: `weekly DX ${dx.toFixed(0)} bullish` };
  return { ok: false, reason: `weekly chop (DX ${dx.toFixed(0)})` };
}

// Friction-aware RR validator. Cost in fraction (e.g. 0.005 = 0.5%).
function rrAfterCost(entry, stop, target, costFrac = 0.005) {
  const risk   = entry - stop;
  const reward = target - entry;
  const cost   = entry * costFrac;
  if (risk <= 0) return { ok: false, rr: 0, reason: "non-positive risk" };
  const rr = (reward - cost) / risk;
  return { ok: rr >= 2, rr: Number(rr.toFixed(2)), reason: rr >= 2 ? "" : `RR ${rr.toFixed(2)} < 2 after cost` };
}

// ─── Institutional scorer — 1 hard block + 5 weighted SMC conditions ─────────
//
//   Max score = 7pts.  BUY ≥ 4  |  STRONG BUY ≥ 6
//   NIFTY index direction NOT scored — pure individual stock SMC analysis.
//   Only hard block: RSI extreme (protects against buying overbought/oversold traps).
//   Minimum quality BUY = BOS(2) + OB(2) = 4pts.
//   NIFTY bias shown in output as market context only — zero scoring impact.

const CONDITIONS = [
  // Hard block — RSI extreme = structurally dangerous, skip always
  { id: "rsi_not_extreme", label: "RSI not extreme (20–78)",                hardBlock: true,  pts: 0 },
  // SMC conditions — weighted by institutional significance (index-independent)
  { id: "daily_bos",       label: "Bullish BOS — structure confirmed",      hardBlock: false, pts: 2 },
  { id: "near_ob",         label: "At unmitigated Bullish Order Block",     hardBlock: false, pts: 2 },
  { id: "near_fvg",        label: "Inside Bullish Fair Value Gap",          hardBlock: false, pts: 1 },
  { id: "accumulation",    label: "3-day volume accumulation",              hardBlock: false, pts: 1 },
  { id: "weekly_trend",    label: "Weekly trend bullish (HH/HL)",           hardBlock: false, pts: 1 },
];

function scoreStock(symbol, daily, indexDaily) {
  if (!daily?.length || !indexDaily?.length) return { symbol, signal: "ERROR", score: 0, price: null, failed: ["no candle data"] };
  const dc = daily.map((c) => c.close);
  const wc = toWeekly(daily).map((c) => c.close);
  const ic = indexDaily.map((c) => c.close);

  const price  = dc[dc.length - 1];
  const iPrice = ic[ic.length - 1];
  const e21    = ema(dc, 21), e20 = ema(dc, 20);
  const r14    = rsi(dc, 14);
  const atrV   = calcATR(daily, 14);
  const iEma20 = ema(ic, 20);
  const wLast  = wc[wc.length - 1], wEma20 = ema(wc, 20);

  // SMC — all institutional analysis happens here silently
  const bos    = detectBOS(daily);
  const ob     = findBullishOB(daily);
  const fvg    = findBullishFVG(daily);
  const nearOB  = ob  ? price >= ob.low  * 0.97 && price <= ob.high  * 1.04 : false;
  const nearFVG = fvg ? price >= fvg.low * 0.97 && price <= fvg.high * 1.04 : false;

  const vals = {
    market_bullish:  iPrice > iEma20 && hhhl(indexDaily, 20),
    rsi_not_extreme: r14 != null && r14 >= 20 && r14 <= 78,
    daily_bos:       bos === "BULLISH",
    near_ob:         nearOB,
    near_fvg:        nearFVG,
    accumulation:    volumeAccumulation(daily),
    weekly_trend:    wLast > wEma20 && hhhl(toWeekly(daily), 20),
  };

  const indicators = { e20, e21, r14, atrV, iPrice, iEma20, wLast, wEma20, bos, ob, fvg };

  for (const { id, label, hardBlock } of CONDITIONS) {
    if (hardBlock && !vals[id]) {
      logReject({ symbol, score: 0, signal: "BLOCKED", gate: "HARD_BLOCK", reason: label, price });
      return { symbol, price, score: 0, maxScore: 7, signal: "BLOCKED", blockedBy: label, vals, indicators };
    }
  }

  // Weighted sum — BOS and OB each count 2
  const score  = CONDITIONS.filter(({ hardBlock }) => !hardBlock)
                           .reduce((s, c) => s + (vals[c.id] ? c.pts : 0), 0);
  const failed = CONDITIONS.filter(({ id, hardBlock }) => !hardBlock && !vals[id]).map(({ label }) => label);
  const signal = score >= CONFIG.strongBuyThreshold ? "STRONG BUY"
               : score >= CONFIG.buyThreshold        ? "BUY"
               : score >= 2                          ? "WATCHLIST"
               : "IGNORE";
  return { symbol, price, score, maxScore: 7, signal, failed, vals, indicators };
}

// ─── Position sizing ──────────────────────────────────────────────────────────

function sizePosition(price, atrVal, portfolio, riskPct, openPos, slotsLeft) {
  // Available capital = total portfolio minus capital locked in open positions
  const usedCapital  = openPos.reduce((s, p) => s + p.entryPrice * (p.remainingQty || p.totalQty || 1), 0);
  const available    = Math.max(0, portfolio - usedCapital);
  const rawCapital   = slotsLeft > 0 ? Math.floor(available / slotsLeft) : available;
  const maxPerTrade  = portfolio * CONFIG.maxConcentrationPct;  // 40% cap per position
  const tradeCapital = Math.min(rawCapital, maxPerTrade);

  // Stop distance: 1.5× ATR but hard-capped at CONFIG.maxStopPct of price (default 1%)
  const atrStop  = (atrVal || price * 0.01) * 1.5;
  const stopDist = Math.min(atrStop, price * CONFIG.maxStopPct);
  const qty      = Math.max(1, Math.floor(tradeCapital / price));
  const riskAmt  = qty * stopDist;

  return { qty, stopDist, stopPrice: price - stopDist, riskAmt, tradeCapital };
}

// ─── Margin check ─────────────────────────────────────────────────────────────

async function checkMargins(kite, symbol, qty, price) {
  try {
    const margins = await kite.checkOrderMargins([{
      exchange: "NSE", tradingsymbol: symbol,
      transaction_type: "BUY", variety: "regular",
      product: "CNC", order_type: "MARKET",
      quantity: qty, price: 0,
    }]);

    const required = Array.isArray(margins) ? margins[0]?.total : margins?.total;
    const available = (await kite.getMargins("equity"))?.available?.live_balance;
    return { required, available, sufficient: !available || available >= required };
  } catch {
    return { required: null, available: null, sufficient: true }; // don't block on margin API failure
  }
}

// ─── GTT helpers ─────────────────────────────────────────────────────────────

async function placeEntryGTT(kite, symbol, entryPrice, stopPrice, targetPrice, qty) {
  // Fetch live LTP — Zerodha requires lastPrice to be strictly between the two trigger values
  let lastPrice = entryPrice;
  try {
    const ltp = await kite.getLTP([`NSE:${symbol}`]);
    lastPrice  = ltp?.[`NSE:${symbol}`]?.last_price || entryPrice;
  } catch { /* fallback to entryPrice */ }

  // Safety: clamp lastPrice to be between stop and target
  if (lastPrice <= stopPrice || lastPrice >= targetPrice) {
    lastPrice = parseFloat(((stopPrice + targetPrice) / 2).toFixed(2));
  }

  // For qty ≤ 2 there is no sensible "half" — exit fully at target instead
  const targetQty = qty <= 2 ? qty : Math.floor(qty / 2);

  const gtt = await kite.placeGTT({
    type:          "two-leg",
    symbol,
    exchange:      "NSE",
    triggerValues: [parseFloat(stopPrice.toFixed(2)), parseFloat(targetPrice.toFixed(2))],
    lastPrice:     parseFloat(lastPrice.toFixed(2)),
    orders: [
      // Leg 0 — stop loss: triggers when price falls to stopPrice → sell all qty at market
      {
        exchange: "NSE", tradingsymbol: symbol,
        transaction_type: "SELL", quantity: qty,
        product: "CNC", order_type: "MARKET", price: 0,
      },
      // Leg 1 — target: triggers when price rises to targetPrice → sell targetQty at limit
      {
        exchange: "NSE", tradingsymbol: symbol,
        transaction_type: "SELL", quantity: targetQty,
        product: "CNC", order_type: "LIMIT", price: parseFloat(targetPrice.toFixed(2)),
      },
    ],
  });

  return gtt?.trigger_id || null;
}

async function placeTrailGTT(kite, symbol, stopPrice, qty) {
  // Single-leg trailing stop GTT — placed after partial profit or stop trail
  let lastPrice = stopPrice * 1.05; // safe fallback
  try {
    const ltp = await kite.getLTP([`NSE:${symbol}`]);
    lastPrice  = ltp?.[`NSE:${symbol}`]?.last_price || lastPrice;
  } catch { /* use fallback */ }

  // lastPrice must be strictly above the trigger for a sell-stop GTT
  if (lastPrice <= stopPrice) lastPrice = stopPrice * 1.02;

  const gtt = await kite.placeGTT({
    type:          "single",
    symbol,
    exchange:      "NSE",
    triggerValues: [parseFloat(stopPrice.toFixed(2))],
    lastPrice:     parseFloat(lastPrice.toFixed(2)),
    orders: [{
      exchange: "NSE", tradingsymbol: symbol,
      transaction_type: "SELL", quantity: qty,
      product: "CNC", order_type: "MARKET", price: 0,
    }],
  });

  return gtt?.trigger_id || null;
}

async function safeDeleteGTT(kite, gttId) {
  if (!gttId || CONFIG.paperTrading) return;
  try { await kite.deleteGTT(gttId); } catch { /* already triggered or deleted */ }
}

// ─── GTT status sync ──────────────────────────────────────────────────────────

async function syncGTTStatuses(kite, openPos) {
  if (CONFIG.paperTrading || openPos.length === 0) return;
  const synced = [];

  for (const pos of openPos) {
    if (!pos.gtt_id) continue;
    try {
      const gtt = await kite.getGTT(pos.gtt_id);

      if (gtt.status === "triggered") {
        const orders = gtt.orders || [];
        const stopFired   = orders.some((o) => o.result?.status === "COMPLETE" && o.order_type === "MARKET");
        const targetFired = orders.some((o) => o.result?.status === "COMPLETE" && o.order_type === "LIMIT");

        if (stopFired) {
          const closePrice = orders.find((o) => o.order_type === "MARKET")?.result?.average_price || pos.stopLoss;
          updatePosition(pos.id, { status: "CLOSED", closedAt: new Date().toISOString(), closePrice, closeReason: "GTT stop triggered" });
          logGTTExit(pos, closePrice, "FULL EXIT", "GTT stop loss triggered at exchange");
          synced.push({ symbol: pos.symbol, action: "CLOSED via GTT stop" });
          console.log(`  🛑 ${pos.symbol} — GTT stop triggered @ ₹${closePrice?.toFixed(2)}`);
        } else if (targetFired) {
          const fillPrice   = orders.find((o) => o.order_type === "LIMIT")?.result?.average_price || pos.target1;
          const soldQty     = orders.find((o) => o.order_type === "LIMIT")?.quantity ||
            (pos.remainingQty <= 2 ? pos.remainingQty : Math.floor(pos.remainingQty / 2));
          const newQty      = pos.remainingQty - soldQty;
          const breakEvenSL = pos.entryPrice;
          updatePosition(pos.id, {
            status: "PARTIAL", target1Hit: true, breakEvenSet: true,
            stopLoss: breakEvenSL, remainingQty: newQty, gtt_id: null,
          });
          logGTTExit(pos, fillPrice, "PARTIAL EXIT", `GTT target hit @ ₹${fillPrice?.toFixed(2)}, ${soldQty} sold`);
          synced.push({ symbol: pos.symbol, action: "PARTIAL via GTT target" });
          console.log(`  🎯 ${pos.symbol} — GTT target hit @ ₹${fillPrice?.toFixed(2)}, ${soldQty} qty sold`);
          console.log(`     Stop moved to break-even ₹${breakEvenSL.toFixed(2)}, ${newQty} qty remaining`);

          // Place trail GTT for remaining qty
          if (!CONFIG.paperTrading && newQty > 0) {
            try {
              const trailId = await placeTrailGTT(kite, pos.symbol, breakEvenSL, newQty);
              updatePosition(pos.id, { gtt_trail_id: trailId });
            } catch { /* non-critical */ }
          }
        }
      } else if (["expired", "deleted", "cancelled"].includes(gtt.status)) {
        updatePosition(pos.id, { gtt_id: null });
      }
    } catch { /* GTT fetch failed — non-critical */ }
  }

  return synced;
}

// ─── Reconciliation (broker state vs local positions) ───────────────────────
// Runs on every scan start. Detects:
//   - Local OPEN position with no live GTT at broker → flag, try to recreate trail GTT
//   - Live GTT at broker not tied to any local position → log warning (manual review)
async function reconcilePositions(kite, openPos) {
  if (CONFIG.paperTrading || openPos.length === 0) return;
  const warnings = [];
  let liveGTTs   = [];
  try {
    liveGTTs = await kite.listGTTs?.() || [];
  } catch { return; /* GTT list API failure → skip silently */ }

  const liveById     = new Map(liveGTTs.filter((g) => g.status === "active").map((g) => [g.id, g]));
  const localGttIds  = new Set(openPos.flatMap((p) => [p.gtt_id, p.gtt_trail_id]).filter(Boolean));

  // Local position → no matching live GTT
  for (const pos of openPos) {
    const ids = [pos.gtt_id, pos.gtt_trail_id].filter(Boolean);
    const anyLive = ids.some((id) => liveById.has(id));
    if (!anyLive && ids.length) {
      warnings.push(`${pos.symbol}: GTT ${ids.join("/")} missing at broker`);
      // Try to recreate stop GTT for remaining qty
      try {
        const newId = await placeTrailGTT(kite, pos.symbol, pos.stopLoss, pos.remainingQty);
        updatePosition(pos.id, { gtt_id: newId, gtt_trail_id: null });
        warnings.push(`  → recreated GTT ${newId} @ ₹${pos.stopLoss.toFixed(2)}`);
      } catch (err) {
        warnings.push(`  → GTT recreate failed: ${err.message}`);
      }
    }
  }

  // Live GTT at broker → no matching local position
  for (const g of liveGTTs) {
    if (g.status === "active" && !localGttIds.has(g.id)) {
      warnings.push(`Orphan GTT ${g.id} at broker — manual review`);
    }
  }

  if (warnings.length) {
    console.log("── Reconciliation Warnings ───────────────────────────────");
    warnings.forEach((w) => console.log(`  ⚠️  ${w}`));
    console.log("");
  }
}

// ─── Exit evaluation ──────────────────────────────────────────────────────────

function evaluateExit(pos, candles) {
  const closes   = candles.map((c) => c.close);
  const price    = closes[closes.length - 1];
  const openP    = candles[candles.length - 1].open;
  const atrV     = calcATR(candles, 14);
  const av       = avgVol(candles, 10);
  const cv       = candles[candles.length - 1].volume;
  const e9       = ema(closes, 9), e21 = ema(closes, 21);
  const trailEma = pos.trailMode === "EMA9" ? e9 : e21;
  const swingLow = recentSwingLow(candles, 10);
  const daysHeld = Math.floor((Date.now() - new Date(pos.entryDate).getTime()) / 86400000);
  const profitATR = atrV ? (price - pos.entryPrice) / atrV : 0;
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const highVolBear = c.close < c.open &&
    Math.abs(c.close - c.open) / (c.high - c.low || 1) > 0.6 &&
    cv > (av || 0) * 1.5 && price < pos.entryPrice;

  // Priority order
  if (openP < pos.stopLoss)
    return { action: "FULL EXIT", reason: "⚡ Gap-down below stop — emergency exit", price };
  if (price <= pos.stopLoss)
    return { action: "FULL EXIT", reason: `🛑 Stop loss hit ₹${price.toFixed(2)} (${pnlPct(price, pos.entryPrice)}%)`, price };
  if (price < swingLow && !hhhl(candles, 20))
    return { action: "FULL EXIT", reason: `📉 Swing low broken ₹${swingLow.toFixed(2)} — structure failed`, price };
  if (highVolBear)
    return { action: "FULL EXIT", reason: "🔴 Strong bearish candle + high volume", price };

  if (!pos.target1Hit && price >= pos.target1)
    return { action: "PARTIAL EXIT", reason: `🎯 1:2 target ₹${pos.target1.toFixed(2)} hit`, price };

  if (pos.target1Hit && trailEma && price < trailEma)
    return { action: "FULL EXIT", reason: `📍 Close below ${pos.trailMode} ₹${trailEma?.toFixed(2)} — trail violated (${pnlPct(price, pos.entryPrice)}%)`, price };

  let newStop = pos.stopLoss;
  if (profitATR >= 2.5 && atrV) newStop = Math.max(pos.stopLoss, price - atrV * 0.5);
  else if (pos.target1Hit && trailEma) newStop = Math.max(pos.stopLoss, trailEma);

  // Stagnation stop — replaces hard time stop. If price hasn't moved > 0.5×ATR over last
  // STAGNATION_BARS sessions AND held ≥ STAGNATION_BARS days → exit (capital efficiency).
  const STAGNATION_BARS = 10;
  if (atrV && daysHeld >= STAGNATION_BARS && candles.length >= STAGNATION_BARS) {
    const window  = candles.slice(-STAGNATION_BARS);
    const range   = Math.max(...window.map((c) => c.high)) - Math.min(...window.map((c) => c.low));
    if (range < atrV * 0.5)
      return { action: "FULL EXIT", reason: `🐌 Stagnation — ${STAGNATION_BARS} sessions range ${range.toFixed(2)} < 0.5×ATR ${(atrV*0.5).toFixed(2)}`, price };
  }

  return { action: "HOLD", price, newStop, trailEma, daysHeld, profitPct: pnlPct(price, pos.entryPrice) };
}

function pnlPct(price, entry) { return ((price - entry) / entry * 100).toFixed(2); }

// ─── Exit runner ──────────────────────────────────────────────────────────────

async function checkAndExecuteExits(kite, openPos) {
  if (openPos.length === 0) return;
  console.log("── Open Positions ────────────────────────────────────────\n");

  // First sync any GTT triggers that fired since last scan
  await syncGTTStatuses(kite, openPos);

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < openPos.length; i++) {
    const pos = openPos[i];
    // Reload in case GTT sync changed status
    const fresh = loadPositions().find((p) => p.id === pos.id);
    if (!fresh || fresh.status === "CLOSED") continue;

    try {
      const candles  = await fetchCandles(kite, pos.symbol, "1D", 100);
      const decision = evaluateExit(fresh, candles);
      const sign     = decision.price >= fresh.entryPrice ? "+" : "";
      const daysHeld = Math.floor((Date.now() - new Date(fresh.entryDate).getTime()) / 86400000);

      console.log(`  ${pad(fresh.symbol, 14)} Entry ₹${fresh.entryPrice.toFixed(2)}  Now ₹${decision.price.toFixed(2)}  (${sign}${pnlPct(decision.price, fresh.entryPrice)}%)`);
      console.log(`  ${"".padEnd(14)} SL ₹${fresh.stopLoss.toFixed(2)}  Target ₹${fresh.target1.toFixed(2)}  ${fresh.trailMode}  Day ${daysHeld}${fresh.target1Hit ? "  [partial booked]" : ""}`);

      if (decision.action === "HOLD") {
        if (decision.newStop > fresh.stopLoss) {
          // Trail: delete old GTT and recreate with raised stop — more reliable than modifyGTT
          if (!CONFIG.paperTrading && fresh.gtt_id) {
            try {
              await safeDeleteGTT(kite, fresh.gtt_id);
              const newGttId = await placeTrailGTT(kite, fresh.symbol, decision.newStop, fresh.remainingQty);
              updatePosition(fresh.id, { stopLoss: decision.newStop, gtt_id: newGttId });
              console.log(`  ${"".padEnd(14)} 📈 HOLD — Stop trailed ₹${fresh.stopLoss.toFixed(2)} → ₹${decision.newStop.toFixed(2)} | GTT recreated\n`);
            } catch (gttErr) {
              // GTT update failed — update stop in positions.json anyway
              updatePosition(fresh.id, { stopLoss: decision.newStop });
              console.log(`  ${"".padEnd(14)} 📈 HOLD — Stop raised to ₹${decision.newStop.toFixed(2)} (GTT update failed: ${gttErr.message})\n`);
            }
          } else {
            updatePosition(fresh.id, { stopLoss: decision.newStop });
            console.log(`  ${"".padEnd(14)} 📈 HOLD — Stop raised to ₹${decision.newStop.toFixed(2)} (trail: ₹${decision.trailEma?.toFixed(2)})\n`);
          }
        } else {
          console.log(`  ${"".padEnd(14)} ✅ HOLD\n`);
        }
      } else {
        console.log(`  ${"".padEnd(14)} ${decision.action === "PARTIAL EXIT" ? "💰" : "🔴"} ${decision.action}: ${decision.reason}\n`);
        await executeExit(kite, fresh, decision);
      }
    } catch (err) {
      if (isTokenError(err)) throw err;
      console.log(`  ${pad(fresh.symbol, 14)} ❌ ${err.message}\n`);
    }

    if ((i + 1) % 3 === 0) await delay(400);
  }
}

async function executeExit(kite, pos, decision) {
  const price     = decision.price;
  const isPartial = decision.action === "PARTIAL EXIT";
  // For qty ≤ 2 there is no meaningful "half" — treat as full exit to avoid leaving 0 or 1 share behind
  const sellQty   = isPartial && pos.remainingQty > 2
    ? Math.floor(pos.remainingQty / 2)
    : pos.remainingQty;
  const totalINR  = sellQty * price;
  const fee       = totalINR * 0.0003;
  let orderId     = "", mode = CONFIG.paperTrading ? "PAPER" : "LIVE";

  // Cancel existing GTT before placing sell order (avoid double-sell)
  await safeDeleteGTT(kite, pos.gtt_id);
  await safeDeleteGTT(kite, pos.gtt_trail_id);

  if (!CONFIG.paperTrading) {
    try {
      const order = await kite.placeOrder("regular", {
        tradingsymbol: pos.symbol, exchange: "NSE",
        transaction_type: "SELL", order_type: "MARKET",
        quantity: sellQty, product: "CNC",
        tag: "SwingBot",
      });
      orderId = order?.order_id || "";
    } catch (err) {
      mode = "ERROR";
      console.log(`  ❌ Sell failed: ${err.message}`);
    }
  } else {
    orderId = `PAPER-SELL-${Date.now()}`;
  }

  const pnl = (price - pos.entryPrice) * sellQty;

  if (isPartial) {
    const newQty  = pos.remainingQty - sellQty;
    const newStop = pos.entryPrice; // break-even
    updatePosition(pos.id, { status: "PARTIAL", target1Hit: true, breakEvenSet: true, stopLoss: newStop, remainingQty: newQty, gtt_id: null, gtt_trail_id: null });
    console.log(`  💰 PARTIAL SELL ${sellQty} qty @ ₹${price.toFixed(2)}  P&L ₹${pnl.toFixed(2)}  Remaining ${newQty} qty @ break-even`);

    // Place new trail GTT for remaining qty
    if (!CONFIG.paperTrading && newQty > 0) {
      try {
        const trailId = await placeTrailGTT(kite, pos.symbol, newStop, newQty);
        updatePosition(pos.id, { gtt_trail_id: trailId });
        console.log(`     Trail GTT set @ ₹${newStop.toFixed(2)}`);
      } catch { /* non-critical */ }
    }
  } else {
    updatePosition(pos.id, { status: "CLOSED", closedAt: new Date().toISOString(), closePrice: price, closeReason: decision.reason });
    unlockSymbol(pos.symbol);
    console.log(`  🔴 FULL SELL ${sellQty} qty @ ₹${price.toFixed(2)}  P&L ₹${pnl.toFixed(2)} (${pnlPct(price, pos.entryPrice)}%)`);
  }

  logTrade({
    timestamp: new Date().toISOString(),
    symbol: pos.symbol, side: "SELL",
    qty: sellQty, price, totalINR,
    stopPrice: pos.stopLoss, fee, netAmount: totalINR - fee,
    orderId, mode, score: pos.score,
    signal: isPartial ? "PARTIAL EXIT" : "FULL EXIT",
    notes: decision.reason,
  });

  await notifyExit({ symbol: displaySym(pos.symbol), qty: sellQty, price, entryPrice: pos.entryPrice, reason: decision.reason, isPartial });
}

// ─── Position tracker ─────────────────────────────────────────────────────────

const POSITIONS_FILE = "positions.json";

function loadPositions()     { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, "utf8")) : []; }
function savePositions(all)  { writeFileSync(POSITIONS_FILE, JSON.stringify(all, null, 2)); }
function openPositions(all)  { return all.filter((p) => ["OPEN", "PARTIAL"].includes(p.status)); }
function addPosition(pos)    { const all = loadPositions(); all.push(pos); savePositions(all); }
function updatePosition(id, changes) {
  const all = loadPositions();
  const i   = all.findIndex((p) => p.id === id);
  if (i !== -1) Object.assign(all[i], changes);
  savePositions(all);
}

// ─── CSV logging ──────────────────────────────────────────────────────────────

const CSV_FILE    = "trades.csv";
const CSV_HEADERS = ["Date","Time (UTC)","Exchange","Symbol","Side","Qty","Price (INR)","Total INR","Stop Price","Fee (est.)","Net Amount","Order ID","Mode","Score","Signal","Notes","Time (IST)","Session"].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,,,,,,"Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
  }
}

function logTrade(t) {
  const d = new Date(t.timestamp);
  const istStr = toISTStr(t.timestamp).replace(/,/g, " ");
  const row = [d.toISOString().slice(0,10), d.toISOString().slice(11,19), "Zerodha Kite", t.symbol,
    t.side || "BUY", t.qty, t.price?.toFixed(2), t.totalINR?.toFixed(2), t.stopPrice?.toFixed(2),
    t.fee?.toFixed(4), t.netAmount?.toFixed(2), t.orderId || "", t.mode,
    t.score, t.signal, `"${t.notes || ""}"`, `"${istStr}"`, sessionId,
  ].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
}

function logGTTExit(pos, price, signal, notes) {
  const qty      = pos.remainingQty;
  const totalINR = qty * price;
  logTrade({
    timestamp: new Date().toISOString(), symbol: pos.symbol, side: "SELL",
    qty, price, totalINR, stopPrice: pos.stopLoss,
    fee: totalINR * 0.0003, netAmount: totalINR * 0.9997,
    orderId: "GTT", mode: "LIVE", score: pos.score, signal, notes,
  });
}

function taxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv yet."); return; }
  const rows  = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const live  = rows.filter((r) => r[12] === "LIVE");
  const paper = rows.filter((r) => r[12] === "PAPER");
  const buys  = live.filter((r) => r[4] === "BUY");
  const sells = live.filter((r) => r[4] === "SELL");
  const vol   = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const fees  = live.reduce((s, r) => s + parseFloat(r[9] || 0), 0);
  console.log(`\n── Tax Summary ──\n  Live buys: ${buys.length}  Live sells: ${sells.length}  Paper: ${paper.length}\n  Volume: ₹${vol.toFixed(2)}  Fees: ₹${fees.toFixed(4)}\n  File: ${CSV_FILE}\n`);
}

// ─── Reject logging ───────────────────────────────────────────────────────────
// Every gate that filters a candidate trade writes a row here.
// Audit after N scans: if one gate dominates, calibrate. If all balanced, edge clean.

const REJECTS_FILE    = "rejects.csv";
const REJECTS_HEADERS = ["Date","Time (IST)","Symbol","Score","Signal","Gate","Reason","Price","Session"].join(",");

function initRejectsCsv() {
  if (!existsSync(REJECTS_FILE)) writeFileSync(REJECTS_FILE, REJECTS_HEADERS + "\n");
}

function logReject({ symbol, score = "", signal = "", gate, reason, price = "" }) {
  initRejectsCsv();
  const now = new Date();
  const row = [
    now.toISOString().slice(0, 10),
    `"${toISTStr(now).replace(/,/g, " ")}"`,
    symbol,
    score,
    signal,
    gate,
    `"${(reason || "").replace(/"/g, "'")}"`,
    price === "" ? "" : Number(price).toFixed(2),
    sessionId,
  ].join(",");
  appendFileSync(REJECTS_FILE, row + "\n");
}

// ─── Scan log ─────────────────────────────────────────────────────────────────

const LOG_FILE = "safety-check-log.json";

function loadLog() {
  if (!existsSync(LOG_FILE)) return { scans: [] };
  const d = JSON.parse(readFileSync(LOG_FILE, "utf8"));
  if (!Array.isArray(d.scans)) d.scans = [];
  return d;
}

function saveLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }

function tradesToday(log) {
  const today = new Date().toISOString().slice(0, 10);
  return (log.scans || []).flatMap((s) => s.executed || []).filter((t) => t.timestamp?.startsWith(today)).length;
}

// ─── Trade lock ───────────────────────────────────────────────────────────────
// Prevents re-entering the same symbol while a position is open or within maxDaysHeld.

const TRADE_LOCK_FILE = "trade-lock.json";
function loadTradeLocks() { return existsSync(TRADE_LOCK_FILE) ? JSON.parse(readFileSync(TRADE_LOCK_FILE, "utf8")) : {}; }
function saveTradeLocks(l) { writeFileSync(TRADE_LOCK_FILE, JSON.stringify(l, null, 2)); }
function isSymbolLocked(symbol) {
  const locks = loadTradeLocks(), lock = locks[symbol];
  if (!lock) return false;
  const expires = new Date(lock.lockedAt);
  expires.setDate(expires.getDate() + CONFIG.maxDaysHeld);
  if (new Date() > expires) { delete locks[symbol]; saveTradeLocks(locks); return false; }
  return true;
}
function lockSymbol(symbol) {
  const locks = loadTradeLocks();
  locks[symbol] = { lockedAt: new Date().toISOString(), sessionId };
  saveTradeLocks(locks);
}
function unlockSymbol(symbol) {
  const locks = loadTradeLocks();
  delete locks[symbol];
  saveTradeLocks(locks);
}

// ─── Risk guard helpers ───────────────────────────────────────────────────────

function getDailyRealizedPnl() {
  const todayIST = nowIST().toISOString().slice(0, 10);
  return loadPositions()
    .filter((p) => p.closedAt?.slice(0, 10) === todayIST && p.closePrice)
    .reduce((s, p) => s + (p.closePrice - p.entryPrice) * ((p.totalQty || 1) - (p.remainingQty || 0)), 0);
}

function getConsecutiveLosses() {
  const closed = loadPositions()
    .filter((p) => p.status === "CLOSED" && p.closePrice)
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  let count = 0;
  for (const p of closed) { if (p.closePrice < p.entryPrice) count++; else break; }
  return count;
}

function tradesThisWeek(log) {
  const now = nowIST();
  const dow = now.getDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - daysBack);
  weekStart.setHours(0, 0, 0, 0);
  return (log.scans || []).flatMap((s) => s.executed || []).filter((t) => new Date(t.timestamp) >= weekStart).length;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SIG_ICON = { "STRONG BUY": "🔥", BUY: "✅", WATCHLIST: "👀", IGNORE: "–", BLOCKED: "🚫", ERROR: "❌" };
function pad(str, n) { return String(str).padEnd(n); }
function displaySym(sym) { return decodeURIComponent(sym); }

// ─── --auth command ───────────────────────────────────────────────────────────

async function runAuth(requestToken) {
  console.log("\n── Generating Kite access token ──────────────────────────\n");
  try {
    const token = await KiteClient.generateAccessToken({
      apiKey:       process.env.KITE_API_KEY,
      apiSecret:    process.env.KITE_API_SECRET,
      requestToken,
    });

    saveToken(token);
    console.log(`✅ Access token generated and saved to .kite-access-token`);
    console.log(`   Token: ${token.slice(0, 8)}...${token.slice(-8)}\n`);

    // Also update Railway if CLI is available
    try {
      const { execSync } = await import("child_process");
      execSync(`railway variable set KITE_ACCESS_TOKEN=${token}`, { stdio: "pipe" });
      console.log("✅ Railway KITE_ACCESS_TOKEN updated");
    } catch {
      console.log("ℹ️  To update Railway, run:");
      console.log(`   railway variable set KITE_ACCESS_TOKEN=${token}\n`);
    }

    // Verify with profile
    const kite    = new KiteClient({ apiKey: process.env.KITE_API_KEY, apiSecret: process.env.KITE_API_SECRET, accessToken: token });
    const profile = await kite.getProfile();
    console.log(`✅ Logged in as: ${profile.user_name} (${profile.user_id})`);
    console.log(`   Broker: ${profile.broker}  |  Email: ${profile.email}\n`);
  } catch (err) {
    console.error(`❌ Token generation failed: ${err.message}`);
    console.log("\nMake sure your request_token is fresh (< 5 min old).");
    console.log(`Get one at: https://kite.zerodha.com/connect/login?api_key=${process.env.KITE_API_KEY}\n`);
    process.exit(1);
  }
}

// ─── --positions command ──────────────────────────────────────────────────────

async function showPositions(kite) {
  const all  = loadPositions();
  const open = openPositions(all);

  console.log("\n── Positions ─────────────────────────────────────────────\n");

  if (open.length === 0) {
    console.log("  No open positions.\n"); return;
  }

  // Get live prices from Kite
  let livePrices = {};
  try {
    const instruments = open.map((p) => `NSE:${displaySym(p.symbol)}`);
    const ltp = await kite.getLTP(instruments);
    livePrices = Object.fromEntries(
      Object.entries(ltp).map(([k, v]) => [k.replace("NSE:", ""), v.last_price])
    );
  } catch { /* use entry price as fallback */ }

  console.log(`  ${"Symbol".padEnd(14)} ${"Entry".padEnd(10)} ${"Current".padEnd(10)} ${"P&L%".padEnd(8)} ${"SL".padEnd(10)} ${"Target".padEnd(10)} ${"Trail".padEnd(8)} Status`);
  console.log(`  ${"─".repeat(80)}`);

  for (const p of open) {
    const price  = livePrices[displaySym(p.symbol)] || p.entryPrice;
    const pct    = pnlPct(price, p.entryPrice);
    const sign   = price >= p.entryPrice ? "+" : "";
    const days   = Math.floor((Date.now() - new Date(p.entryDate).getTime()) / 86400000);
    console.log(`  ${pad(displaySym(p.symbol), 14)} ₹${pad(p.entryPrice.toFixed(2), 9)} ₹${pad(price.toFixed(2), 9)} ${sign}${pad(pct + "%", 8)} ₹${pad(p.stopLoss.toFixed(2), 9)} ₹${pad(p.target1.toFixed(2), 9)} ${pad(p.trailMode, 8)} ${p.status} (day ${days})`);
  }
  console.log();
}

// ─── --sync command ───────────────────────────────────────────────────────────

async function syncWithKite(kite) {
  console.log("\n── Syncing positions with Kite holdings ──────────────────\n");
  try {
    const [holdings, kitePos] = await Promise.all([kite.getHoldings(), kite.getPositions()]);
    const held = new Set([
      ...holdings.map((h) => h.tradingsymbol),
      ...kitePos.net.filter((p) => p.quantity > 0).map((p) => p.tradingsymbol),
    ]);

    const all  = loadPositions();
    let changed = 0;

    for (const pos of all) {
      if (!["OPEN", "PARTIAL"].includes(pos.status)) continue;
      const sym = displaySym(pos.symbol);
      if (!held.has(sym)) {
        updatePosition(pos.id, { status: "CLOSED", closeReason: "Not found in Kite holdings — synced closed", closedAt: new Date().toISOString() });
        console.log(`  🔄 ${sym} — marked CLOSED (not in Kite holdings)`);
        changed++;
      }
    }

    if (changed === 0) console.log("  ✅ All positions match Kite holdings — no sync needed");
    console.log(`\n  Kite holdings: ${holdings.length} stocks`);
    holdings.forEach((h) => console.log(`    ${pad(h.tradingsymbol, 16)} qty ${h.quantity}  avg ₹${h.average_price?.toFixed(2)}  P&L ₹${h.pnl?.toFixed(2)}`));
    console.log();
  } catch (err) {
    if (isTokenError(err)) {
      console.log("❌ Session expired. Run: node bot.js --auth YOUR_REQUEST_TOKEN");
    } else {
      console.log(`❌ Sync failed: ${err.message}`);
    }
  }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function scan() {
  initCsv();
  initRejectsCsv();
  const kite = initKite();

  // ── Header: profile + margins ───────────────────────────────────────────────

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Multi-Symbol Swing Trading Scanner");
  console.log(`  ${new Date().toISOString()}`);

  try {
    const [profile, margins] = await Promise.all([kite.getProfile(), kite.getMargins("equity")]);
    const balance = margins?.available?.live_balance;
    console.log(`  Account  : ${profile.user_name} (${profile.user_id}) — ${profile.broker}`);
    console.log(`  Available: ₹${balance ? balance.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "n/a"}`);
  } catch (err) {
    if (isTokenError(err)) {
      if (process.env.KITE_TOTP_SECRET) {
        console.log("  Session expired — auto-refreshing token...");
        try {
          const newToken = await autoAuth();
          kite.accessToken = newToken;
          const [profile, margins] = await Promise.all([kite.getProfile(), kite.getMargins("equity")]);
          const balance = margins?.available?.live_balance;
          console.log(`  Account  : ${profile.user_name} (${profile.user_id}) — ${profile.broker}`);
          console.log(`  Available: ₹${balance ? balance.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "n/a"}`);
        } catch (authErr) {
          console.log(`  ❌ Auto-auth failed: ${authErr.message}`);
          process.exit(1);
        }
      } else {
        console.log("\n❌ Session expired. Regenerate your access token:");
        console.log(`   1. Open: https://kite.zerodha.com/connect/login?api_key=${process.env.KITE_API_KEY}`);
        console.log("   2. Log in and copy the request_token from the redirect URL");
        console.log("   3. Run: node bot.js --auth YOUR_REQUEST_TOKEN\n");
        process.exit(1);
      }
    } else {
      console.log(`  Account  : (profile unavailable — ${err.message})`);
    }
  }

  console.log(`  Portfolio: ₹${CONFIG.portfolioValue.toLocaleString()} | Risk: ${(CONFIG.riskPercent * 100).toFixed(1)}%/trade | Trail: ${CONFIG.trailMode}`);
  console.log(`  Mode     : ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const { symbols: allSymbols, priceLimit = 500 } = JSON.parse(readFileSync("watchlist.json", "utf8"));

  // ── Scan mode: full (all 356) vs tiered (top N daily, full only on Monday) ──
  let symbols = allSymbols;
  let scanLabel = `full (${allSymbols.length})`;
  if (CONFIG.scanMode === "tiered") {
    const ist       = nowIST();
    const isMonday  = ist.getDay() === 1;
    const isMorning = ist.getHours() < 12;
    if (isMonday && isMorning) {
      // Monday morning: full discovery scan
      scanLabel = `full discovery (${allSymbols.length}) — Monday`;
    } else {
      // All other scans: Tier 1 only (first N by market cap / list order)
      symbols   = allSymbols.slice(0, CONFIG.tier1Size);
      scanLabel = `tier1 only (${symbols.length}/${allSymbols.length})`;
    }
  }
  const log            = loadLog();
  const usedToday      = tradesToday(log);
  const remaining      = CONFIG.maxTradesPerDay - usedToday;
  const usedThisWeek   = tradesThisWeek(log);
  const weeklyLeft     = CONFIG.maxTradesPerWeek - usedThisWeek;

  // ── Market hours check ──────────────────────────────────────────────────────
  const marketOpen     = isMarketOpen();
  const preMarketDone  = isPastPreMarket();
  const istNowStr      = nowIST().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  console.log(`Watchlist: ${scanLabel} | Trades today: ${usedToday}/${CONFIG.maxTradesPerDay} | Week: ${usedThisWeek}/${CONFIG.maxTradesPerWeek} | Session: ${sessionId}\n`);

  if (!marketOpen) {
    console.log(`⏸  MARKET CLOSED (${istNowStr} IST) — exits still evaluated, no new entries.\n`);
  } else if (!preMarketDone) {
    console.log(`⏸  PRE-MARKET BUFFER (${istNowStr} IST) — waiting until 9:45 AM (volatile open). No entries yet.\n`);
  }

  // ── Index data ──────────────────────────────────────────────────────────────

  process.stdout.write("Fetching NIFTY50 daily candles... ");
  let indexDaily;
  try {
    indexDaily = await fetchCandles(kite, "NIFTY50", "1D", 250);
    console.log(`✅ ${indexDaily.length} candles\n`);
  } catch (err) {
    if (isTokenError(err)) throw err;
    console.log(`❌ ${err.message}`); return;
  }

  // ── Market bias ─────────────────────────────────────────────────────────────

  const ic      = indexDaily.map((c) => c.close);
  const iPrice  = ic[ic.length - 1];
  const iEma20  = ema(ic, 20), iEma50 = ema(ic, 50);
  const iHhHl   = hhhl(indexDaily, 20);
  const mktBull = iPrice > iEma20 && iHhHl;

  console.log("── Market Bias ───────────────────────────────────────────\n");
  console.log(`  NIFTY50 : ₹${iPrice?.toFixed(2)}  EMA20: ${iEma20?.toFixed(2)}  EMA50: ${iEma50?.toFixed(2)}`);
  console.log(`  HH/HL   : ${iHhHl ? "✅ Yes" : "🚫 No"}`);
  console.log(`  Bias    : ${mktBull ? "🟢 BULLISH" : "🔴 BEARISH/NEUTRAL"}\n`);

  // ── Auto-adapt rules if no signals for too long ──────────────────────────────

  const dryScanStreak = (log.scans || []).slice(-CONFIG.adaptAfterScans).filter((s) => !s.executed?.length && !s.strongBuys?.length && !s.buys?.length).length;

  if (dryScanStreak >= CONFIG.adaptAfterScans) {
    const isAlreadyRelaxed = CONFIG.buyThreshold <= 3;
    if (!isAlreadyRelaxed) {
      CONFIG.buyThreshold = 3; CONFIG.strongBuyThreshold = 4;
      console.log("🔄 Auto-adapt: threshold relaxed (BUY≥3/7) after no signals\n");
      await (await import("./notify.js")).sendTelegram ? null : null; // lazy import already done
      const { notifyScanSummary: _ , ...notifyMod } = await import("./notify.js").catch(() => ({}));
      try {
        const { default: nd } = await import("./notify.js").catch(() => ({ default: null }));
      } catch {}
      // send direct telegram for adaptation notice
      const tok = process.env.TELEGRAM_BOT_TOKEN, cid = process.env.TELEGRAM_CHAT_ID;
      if (tok && cid) {
        await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cid, parse_mode: "HTML",
            text: `🔄 <b>Rules Auto-Relaxed</b>\n\nNo signals for ${dryScanStreak} scans.\n\nNew: BUY threshold lowered to 3/7.\nBOS + OB still required for any trade.\n\nRe-scanning now...` }),
        }).catch(() => {});
      }
    }
  }

  console.log(`Strategy: BUY≥${CONFIG.buyThreshold}/7 | STRONG BUY≥${CONFIG.strongBuyThreshold}/7 | scoring: BOS×2, OB×2, FVG×1, accum×1, weekly×1 | NIFTY = context only\n`);

  // ── EXIT CHECK ──────────────────────────────────────────────────────────────

  const positions = loadPositions();
  const openPos   = openPositions(positions);
  await reconcilePositions(kite, openPos);
  await checkAndExecuteExits(kite, openPos);

  // ── ENTRY SCAN ──────────────────────────────────────────────────────────────

  console.log("── Scanning ──────────────────────────────────────────────\n");

  const delay   = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    process.stdout.write(`  ${pad(displaySym(sym), 16)}`);
    try {
      const daily = await fetchCandles(kite, sym, "1D", 250);
      const r     = scoreStock(sym, daily, indexDaily);
      results.push({ ...r, daily });
      const scoreStr = r.signal === "BLOCKED"
        ? `BLOCKED (${r.blockedBy?.split(" ")[0]}...)`
        : `${r.signal} (${r.score}/${r.maxScore})`;
      console.log(`${SIG_ICON[r.signal] || "–"} ${scoreStr}`);
    } catch (err) {
      if (isTokenError(err)) throw err;
      results.push({ symbol: sym, score: -1, signal: "ERROR", error: err.message });
      console.log(`❌ ${err.message}`);
    }
    if ((i + 1) % 3 === 0) await delay(350); // respect 3 req/sec Kite limit
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  const actionable  = results.filter((r) => r.score >= CONFIG.buyThreshold && !["BLOCKED","ERROR","IGNORE"].includes(r.signal)).sort((a, b) => b.score - a.score);
  const blockedList = results.filter((r) => r.signal === "BLOCKED");
  const ignoredList = results.filter((r) => r.score >= 0 && r.score < CONFIG.buyThreshold && !["BLOCKED","ERROR"].includes(r.signal));

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("══════════════════════════════════════════════════════════\n");

  if (actionable.length === 0) {
    console.log(`  No setups found (score ≥ ${CONFIG.buyThreshold}).\n`);
  } else {
    const maxScore = 7;
    console.log(`  ${"Symbol".padEnd(16)} ${"Signal".padEnd(14)} ${"Score".padEnd(8)} ${"Price".padEnd(12)} Missing`);
    console.log(`  ${"─".repeat(72)}`);
    for (const r of actionable) {
      const missing = r.failed?.length ? r.failed.map((f) => f.split(" ")[0]).join(", ") : "—";
      console.log(`  ${SIG_ICON[r.signal] || " "} ${pad(displaySym(r.symbol), 14)} ${pad(r.signal, 14)} ${pad(`${r.score}/${maxScore}`, 8)} ${pad(`₹${r.price?.toFixed(2)}`, 12)} ${missing}`);
    }
  }

  const sbList = actionable.filter((r) => r.signal === "STRONG BUY");
  const buyList  = actionable.filter((r) => r.signal === "BUY");
  const watchList = actionable.filter((r) => r.signal === "WATCHLIST");

  console.log(`\n  🔥 STRONG BUY : ${sbList.length}   ✅ BUY : ${buyList.length}   👀 WATCHLIST : ${watchList.length}`);
  console.log(`  🚫 Hard-blocked : ${blockedList.length}   – Ignored : ${ignoredList.length}`);

  if (blockedList.length > 0)
    console.log(`\n  Blocked: ${blockedList.map((r) => displaySym(r.symbol)).join(", ")}`);

  // Show which conditions are most commonly failing (helps understand why no trades)
  const failCounts = {};
  results.filter((r) => r.failed?.length).forEach((r) => r.failed.forEach((f) => { failCounts[f] = (failCounts[f] || 0) + 1; }));
  const topFails = Object.entries(failCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topFails.length) {
    console.log(`\n  📋 Most failed conditions (why trades aren't firing):`);
    topFails.forEach(([cond, count]) => console.log(`     ${count}x — ${cond}`));
  }

  // ── New entries ─────────────────────────────────────────────────────────────

  console.log("\n── New Entries ───────────────────────────────────────────\n");

  // Risk guard evaluation
  const dailyRealizedPnl  = getDailyRealizedPnl();
  const dailyLossLimit    = -(CONFIG.portfolioValue * CONFIG.dailyLossLimitPct);
  const consecLosses      = getConsecutiveLosses();
  const circuitTripped    = dailyRealizedPnl <= dailyLossLimit;
  const consecHaltTripped = consecLosses >= CONFIG.consecutiveLossHalt;
  const weeklyCapHit      = weeklyLeft <= 0;

  const heldSymbols = new Set(openPositions(loadPositions()).map((p) => p.symbol));
  const slotsLeft   = CONFIG.maxActiveTrades - openPositions(loadPositions()).length;

  // NIFTY direction no longer gates entries — individual stock SMC structure decides
  const canEnterNew = remaining > 0 && slotsLeft > 0
    && marketOpen && preMarketDone
    && !circuitTripped && !consecHaltTripped && !weeklyCapHit;

  // ── Quality gate: only candidates passing numeric SMC checks reach entry ────
  const COST_FRAC = parseFloat(process.env.FRICTION_COST_FRAC || "0.005");

  const candidates = canEnterNew
    ? [...sbList, ...buyList].filter((r) => !heldSymbols.has(r.symbol) && !isSymbolLocked(r.symbol))
    : [];

  // Sector data (optional file). Map: symbol → sector. Missing → "Unknown" (uncapped).
  const SECTORS = existsSync("sectors.json") ? JSON.parse(readFileSync("sectors.json", "utf8")) : {};
  const MAX_PER_SECTOR = parseInt(process.env.MAX_PER_SECTOR || "2");
  const openSectorCount = openPositions(loadPositions()).reduce((m, p) => {
    const s = SECTORS[p.symbol] || "Unknown";
    m[s] = (m[s] || 0) + 1;
    return m;
  }, {});

  const tradeable = [];
  for (const r of candidates) {
    const { ob, fvg, atrV } = r.indicators;
    const dailyCandles = r.daily;
    const weeklyCandles = toWeekly(dailyCandles);

    // Gate A — OB quality (only enforced if OB is contributing to score)
    if (r.vals?.near_ob) {
      const q = obQuality(dailyCandles, ob, atrV);
      if (!q.clean) {
        logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "OB_QUALITY", reason: q.reason, price: r.price });
        continue;
      }
    }

    // Gate B — Structure clean
    const s = structureClean(dailyCandles);
    if (!s.clean) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "STRUCTURE", reason: s.reason, price: r.price });
      continue;
    }

    // Gate C — Pullback-only: must be inside OB or FVG (no breakout chasing)
    if (!isPullbackIntoOB(r.price, ob) && !isPullbackIntoFVG(r.price, fvg)) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "PULLBACK_ONLY", reason: "price not inside OB/FVG", price: r.price });
      continue;
    }

    // Gate D — Not extended (3+ consecutive green = chase)
    if (isExtended(dailyCandles)) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "EXTENDED", reason: "3+ consecutive green candles", price: r.price });
      continue;
    }

    // Gate E — Retail trap: entry within 0.3% of 20d swing high
    if (nearSwingHigh(r.price, dailyCandles)) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "RETAIL_TRAP", reason: "within 0.3% of 20d high", price: r.price });
      continue;
    }

    // Gate F — Confirmation candle (bullish engulf / pin) at OB tap
    const confirm = confirmationCandle(dailyCandles);
    if (!confirm.ok) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "CONFIRMATION", reason: confirm.reason, price: r.price });
      continue;
    }

    // Gate G — Weekly regime (HH/HL intact OR weekly DX bullish)
    const regime = weeklyRegimeOk(weeklyCandles);
    if (!regime.ok) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "REGIME", reason: regime.reason, price: r.price });
      continue;
    }

    // Gate H — Sector concentration cap
    const sector = SECTORS[r.symbol] || "Unknown";
    if (sector !== "Unknown" && (openSectorCount[sector] || 0) >= MAX_PER_SECTOR) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "SECTOR_CAP", reason: `${sector} already has ${openSectorCount[sector]}/${MAX_PER_SECTOR}`, price: r.price });
      continue;
    }

    tradeable.push(r);
    openSectorCount[sector] = (openSectorCount[sector] || 0) + 1;
    if (tradeable.length >= Math.min(remaining, slotsLeft, weeklyLeft)) break;
  }

  const executed = [];

  // Guard reason messages
  if (!marketOpen)            console.log(`  ⏸  Market closed (${istNowStr} IST) — no entries.\n`);
  else if (!preMarketDone)    console.log("  ⏸  Pre-market buffer (before 9:45 AM) — no entries.\n");
  else if (circuitTripped)    console.log(`  🚨 Daily loss circuit breaker — realised P&L ₹${dailyRealizedPnl.toFixed(0)} hit -${(CONFIG.dailyLossLimitPct*100).toFixed(0)}% limit. No entries today.\n`);
  else if (consecHaltTripped) console.log(`  🚨 ${consecLosses} consecutive losses — entries paused for the day. Review setups.\n`);
  else if (weeklyCapHit)      console.log(`  ⏸  Weekly trade cap (${CONFIG.maxTradesPerWeek}) reached.\n`);
  else if (remaining <= 0)    console.log("  ⏸  Daily limit reached.\n");
  else if (slotsLeft <= 0)    console.log(`  ⏸  Max active trades (${CONFIG.maxActiveTrades}) reached.\n`);
  else if (tradeable.length === 0) console.log("  No STRONG BUY or BUY setups available.\n");
  else {
    for (const r of tradeable) {
      const { atrV } = r.indicators;
      const currentOpen = openPositions(loadPositions());
      const { qty, stopPrice, riskAmt, tradeCapital } = sizePosition(
        r.price, atrV, CONFIG.portfolioValue, CONFIG.riskPercent, currentOpen, slotsLeft
      );
      const riskDist  = r.price - stopPrice;
      const target1   = r.price + riskDist * 2;
      const totalINR  = qty * r.price;
      const fee       = totalINR * 0.0003;

      // ── Friction-aware RR gate ────────────────────────────────────────────────
      const rrCheck = rrAfterCost(r.price, stopPrice, target1, COST_FRAC);
      if (!rrCheck.ok) {
        logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "RR_AFTER_COST", reason: rrCheck.reason, price: r.price });
        console.log(`  ⚠️  ${displaySym(r.symbol)} skipped — ${rrCheck.reason}`);
        continue;
      }

      // ── Price filter ──────────────────────────────────────────────────────────
    if (r.price > priceLimit) {
      logReject({ symbol: r.symbol, score: r.score, signal: r.signal, gate: "PRICE_LIMIT", reason: `₹${r.price?.toFixed(0)} > ₹${priceLimit}`, price: r.price });
      console.log(`  ⚠️  ${displaySym(r.symbol)} skipped — ₹${r.price?.toFixed(0)} > ₹${priceLimit} limit`);
      if (r.signal === "STRONG BUY") {
        const tok = process.env.TELEGRAM_BOT_TOKEN, cid = process.env.TELEGRAM_CHAT_ID;
        if (tok && cid) {
          await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: cid, parse_mode: "HTML",
              text: `📢 <b>FYI — ${displaySym(r.symbol)}</b>\n\nScore: ${r.score}/7 — <b>STRONG BUY</b>\nPrice: ₹${r.price?.toFixed(0)} (above your ₹${priceLimit} limit)\n\nNot trading it — just keeping you informed.\nIf you ever increase your budget, this one qualifies.` }),
          }).catch(() => {});
        }
      }
      continue;
    }

    console.log(`  ${SIG_ICON[r.signal]} ${displaySym(r.symbol)} — BUY ${qty} qty @ ₹${r.price?.toFixed(2)}  [${r.score}/7]`);
      console.log(`     Stop   : ₹${stopPrice.toFixed(2)} | Risk   : ₹${riskAmt.toFixed(2)} | Total  : ₹${totalINR.toFixed(2)}`);
      console.log(`     Target : ₹${target1.toFixed(2)} (1:2 R/R) | GTT   : stop + partial target`);

      // Check margins before committing
      const marginCheck = await checkMargins(kite, displaySym(r.symbol), qty, r.price);
      if (!marginCheck.sufficient) {
        console.log(`     ⚠️  Insufficient margin (need ₹${marginCheck.required?.toFixed(2)}, have ₹${marginCheck.available?.toFixed(2)}) — skipping\n`);
        continue;
      }
      if (marginCheck.required) {
        console.log(`     Margin : ₹${marginCheck.required.toFixed(2)} required / ₹${marginCheck.available?.toFixed(2)} available`);
      }

      const posId  = `${r.symbol}-${Date.now()}`;
      let orderId  = "", gttId = null, mode = CONFIG.paperTrading ? "PAPER" : "LIVE";
      let notes    = `${r.score}/7 conditions met`;

      if (CONFIG.paperTrading) {
        orderId = `PAPER-${Date.now()}`;
        gttId   = `PAPER-GTT-${Date.now()}`;
        console.log(`     📋 Paper trade logged`);
        console.log(`     📌 GTT (paper): stop ₹${stopPrice.toFixed(2)} | target ₹${target1.toFixed(2)}\n`);
      } else {
        // Place buy order
        try {
          const order = await kite.placeOrder("regular", {
            tradingsymbol: displaySym(r.symbol), exchange: "NSE",
            transaction_type: "BUY", order_type: "MARKET",
            quantity: qty, product: "CNC", tag: "SwingBot",
          });
          orderId = order?.order_id || "";
          console.log(`     ✅ BUY ORDER PLACED — ${orderId}`);
        } catch (err) {
          mode = "ERROR"; notes = `Order failed: ${err.message}`;
          console.log(`     ❌ ORDER FAILED — ${err.message}\n`);
          continue;
        }

        // Place GTT: stop loss + partial target
        try {
          gttId = await placeEntryGTT(kite, displaySym(r.symbol), r.price, stopPrice, target1, qty);
          console.log(`     📌 GTT placed — stop ₹${stopPrice.toFixed(2)} | target ₹${target1.toFixed(2)} (id: ${gttId})\n`);
        } catch (err) {
          console.log(`     ⚠️  GTT placement failed: ${err.message} — manual stop required\n`);
        }
      }

      addPosition({
        id: posId, symbol: r.symbol,
        entryDate: new Date().toISOString(), entryDateIST: toISTStr(new Date()),
        entryPrice: r.price, totalQty: qty, remainingQty: qty,
        stopLoss: stopPrice, target1, target1Hit: false, breakEvenSet: false,
        trailMode: CONFIG.trailMode, entryRisk: riskDist,
        maxDaysHeld: CONFIG.maxDaysHeld,
        score: r.score, signal: r.signal,
        orderId, gtt_id: gttId, gtt_trail_id: null,
        status: "OPEN", sessionId,
      });
      lockSymbol(r.symbol);

      await notifyEntry({ symbol: displaySym(r.symbol), qty, price: r.price, stopPrice, target1, score: r.score, mode });

      logTrade({
        timestamp: new Date().toISOString(), symbol: r.symbol, side: "BUY",
        qty, price: r.price, totalINR, stopPrice, fee,
        netAmount: totalINR + fee, orderId, mode,
        score: r.score, signal: r.signal, notes,
      });

      executed.push({ symbol: r.symbol, qty, price: r.price, score: r.score, signal: r.signal, timestamp: new Date().toISOString() });
    }
  }

  // ── Active positions summary ─────────────────────────────────────────────────

  const allPos   = loadPositions();
  const stillOpen = openPositions(allPos);

  if (stillOpen.length > 0) {
    console.log("── Active Positions ──────────────────────────────────────\n");
    console.log(`  ${"Symbol".padEnd(14)} ${"Entry".padEnd(10)} ${"SL".padEnd(10)} ${"Target".padEnd(10)} ${"Trail".padEnd(8)} ${"GTT".padEnd(8)} Days`);
    console.log(`  ${"─".repeat(68)}`);
    for (const p of stillOpen) {
      const days = Math.floor((Date.now() - new Date(p.entryDate).getTime()) / 86400000);
      const gttStatus = p.gtt_id ? (CONFIG.paperTrading ? "PAPER" : p.gtt_id.toString().slice(0, 6)) : "none";
      console.log(`  ${pad(displaySym(p.symbol), 14)} ₹${pad(p.entryPrice.toFixed(2), 9)} ₹${pad(p.stopLoss.toFixed(2), 9)} ₹${pad(p.target1.toFixed(2), 9)} ${pad(p.trailMode, 8)} ${pad(gttStatus, 8)} ${days}`);
    }
    console.log();
  }

  // ── Telegram: scan summary + loss alert ─────────────────────────────────────

  const freshOpen = openPositions(loadPositions());
  let unrealisedPnl = 0;
  if (freshOpen.length > 0) {
    try {
      // Try Kite LTP first — fall back to Yahoo Finance (works even when token expired)
      let livePrices = {};
      try {
        const ltpData = await kite.getLTP(freshOpen.map((p) => `NSE:${displaySym(p.symbol)}`));
        livePrices = Object.fromEntries(
          Object.entries(ltpData).map(([k, v]) => [k.replace("NSE:", ""), v.last_price])
        );
      } catch {
        for (const pos of freshOpen) {
          try {
            const candles = await fetchCandlesYahoo(displaySym(pos.symbol), "1D", 5);
            if (candles.length) livePrices[displaySym(pos.symbol)] = candles[candles.length - 1].close;
          } catch { /* skip — use entry price */ }
        }
      }

      const posWithPnl = freshOpen.map((p) => {
        const ltp  = livePrices[displaySym(p.symbol)] || p.entryPrice;
        const pnl  = (ltp - p.entryPrice) * p.remainingQty;
        const pct  = ((ltp - p.entryPrice) / p.entryPrice * 100).toFixed(2);
        const days = Math.floor((Date.now() - new Date(p.entryDate).getTime()) / 86400000);
        return { ...p, ltp, pnl, pct, daysHeld: days };
      });
      unrealisedPnl = posWithPnl.reduce((s, p) => s + p.pnl, 0);

      // Log each position P&L to console
      if (posWithPnl.length) {
        posWithPnl.forEach((p) => {
          const s = p.pnl >= 0 ? "+" : "";
          console.log(`  📍 ${pad(displaySym(p.symbol), 14)} Entry ₹${p.entryPrice.toFixed(2)} → ₹${p.ltp.toFixed(2)}  P&L ${s}₹${p.pnl.toFixed(2)} (${s}${p.pct}%)  Day ${p.daysHeld}`);
        });
        console.log(`  Unrealised total: ${unrealisedPnl >= 0 ? "+" : ""}₹${unrealisedPnl.toFixed(2)}\n`);
      }

      // Send Telegram position status every scan
      await notifyPositionStatus({ positions: posWithPnl, unrealisedPnl, sessionId });

      const lossThreshold = -(CONFIG.portfolioValue * 0.03);
      if (unrealisedPnl < lossThreshold) {
        await notifyLossAlert({ totalPnl: unrealisedPnl, portfolioValue: CONFIG.portfolioValue, positions: posWithPnl });
      }
    } catch { /* non-critical */ }
  }

  // ── Circuit breaker Telegram alert ──────────────────────────────────────────
  if (circuitTripped) {
    await notifyCircuitBreaker({ reason: `Daily loss limit hit`, details: `Realised P&L today: ₹${dailyRealizedPnl.toFixed(0)} (limit: ₹${dailyLossLimit.toFixed(0)})` });
  } else if (consecHaltTripped) {
    await notifyCircuitBreaker({ reason: `${consecLosses} consecutive losing trades`, details: `Entries paused for the rest of the day.` });
  }

  await notifyScanSummary({
    mktBull, niftyPrice: iPrice,
    actionable, executed,
    openCount: freshOpen.length,
    unrealisedPnl: freshOpen.length > 0 ? unrealisedPnl : null,
    guards: circuitTripped ? `🚨 Circuit breaker active` : consecHaltTripped ? `🚨 Consec loss halt` : weeklyCapHit ? `⏸ Weekly cap hit` : null,
  });

  // ── Auto weekly report on Apr 26 after 3:30 PM IST ───────────────────────────

  const now = new Date();
  const istDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  if (istDate.getMonth() === 3 && istDate.getDate() === 26 && istDate.getHours() >= 15) {
    await generateWeeklyReport(kite, "20 Apr", "26 Apr");
  }

  // ── Save log ─────────────────────────────────────────────────────────────────

  log.scans.push({
    timestamp:      new Date().toISOString(),
    timestampIST:   toISTStr(new Date()),
    sessionId,
    symbolsScanned: symbols.length,
    marketBullish:  mktBull,
    marketOpen,
    strongBuys:     sbList.map((r) => r.symbol),
    buys:           buyList.map((r) => r.symbol),
    watchlist:      watchList.map((r) => r.symbol),
    executed,
    buyThreshold:   CONFIG.buyThreshold,
    guards: { circuitTripped, consecHaltTripped, weeklyCapHit, dailyRealizedPnl: dailyRealizedPnl.toFixed(0), consecLosses },
    results: results.map(({ symbol, score, signal, failed, error }) => ({ symbol, score, signal, failed, error })),
  });
  saveLog(log);

  // ── Reject audit summary (this session only) ───────────────────────────────
  if (existsSync(REJECTS_FILE)) {
    const rows = readFileSync(REJECTS_FILE, "utf8").trim().split("\n").slice(1)
                  .map((l) => l.split(",")).filter((r) => r[r.length - 1] === sessionId);
    if (rows.length) {
      const byGate = rows.reduce((m, r) => { const g = r[5]; m[g] = (m[g] || 0) + 1; return m; }, {});
      console.log("\n── Reject Audit (this session) ─────────────────────────");
      Object.entries(byGate).sort((a, b) => b[1] - a[1])
        .forEach(([g, n]) => console.log(`  ${pad(g, 18)} ${n}`));
      console.log(`  → ${REJECTS_FILE}\n`);
    }
  }

  console.log(`Decision log → ${LOG_FILE} | Positions → ${POSITIONS_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── End-of-day P&L summary (runs when bot fires at 3:30 PM IST) ─────────────
  const istNow   = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const istHour  = istNow.getHours(), istMin = istNow.getMinutes();
  const isEOD    = (istHour === 15 && istMin >= 30) || istHour === 16;

  if (isEOD) {
    await sendEODSummary(kite);
  }
}

async function sendEODSummary(kite) {
  console.log("\n── End-of-Day Summary ────────────────────────────────────\n");

  const allPos   = loadPositions();
  const openPos  = openPositions(allPos);
  const closedToday = allPos.filter((p) => p.closedAt?.startsWith(new Date().toISOString().slice(0, 10)));

  // Get live prices for open positions
  let livePrices = {};
  if (openPos.length > 0) {
    try {
      const ltp = await kite.getLTP(openPos.map((p) => `NSE:${displaySym(p.symbol)}`));
      livePrices = Object.fromEntries(Object.entries(ltp).map(([k, v]) => [k.replace("NSE:", ""), v.last_price]));
    } catch { /* fallback to entry price */ }
  }

  const posWithPnl = openPos.map((p) => {
    const price = livePrices[displaySym(p.symbol)] || p.entryPrice;
    const pnl   = (price - p.entryPrice) * p.remainingQty;
    const pct   = ((price - p.entryPrice) / p.entryPrice * 100).toFixed(2);
    return { ...p, livePrice: price, pnl, pct };
  });

  const unrealised    = posWithPnl.reduce((s, p) => s + p.pnl, 0);
  const realisedToday = closedToday.reduce((s, p) => s + ((p.closePrice - p.entryPrice) * (p.totalQty - (p.remainingQty || 0))), 0);
  const totalPnl      = unrealised + realisedToday;

  // Console output
  if (posWithPnl.length > 0) {
    posWithPnl.forEach((p) => {
      const sign = p.pnl >= 0 ? "+" : "";
      console.log(`  ${pad(displaySym(p.symbol), 14)} Entry ₹${p.entryPrice.toFixed(2)} → ₹${p.livePrice.toFixed(2)}  P&L ${sign}₹${p.pnl.toFixed(2)} (${sign}${p.pct}%)`);
    });
  } else {
    console.log("  No open positions.");
  }
  console.log(`\n  Unrealised : ${unrealised >= 0 ? "+" : ""}₹${unrealised.toFixed(2)}`);
  console.log(`  Realised   : ${realisedToday >= 0 ? "+" : ""}₹${realisedToday.toFixed(2)} today`);
  console.log(`  Total P&L  : ${totalPnl >= 0 ? "+" : ""}₹${totalPnl.toFixed(2)}\n`);

  // Telegram
  const tok = process.env.TELEGRAM_BOT_TOKEN, cid = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !cid) return;

  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  let msg = `🌆 <b>End-of-Day — ${ist}</b>\n\n`;

  if (posWithPnl.length > 0) {
    msg += `<b>Open Positions:</b>\n`;
    posWithPnl.forEach((p) => {
      const s = p.pnl >= 0 ? "📈" : "📉";
      msg += `${s} ${displaySym(p.symbol)}  ₹${p.entryPrice.toFixed(0)}→₹${p.livePrice.toFixed(0)}  <b>${p.pnl >= 0 ? "+" : ""}₹${p.pnl.toFixed(0)}</b> (${p.pnl >= 0 ? "+" : ""}${p.pct}%)\n`;
      msg += `   SL ₹${p.stopLoss.toFixed(0)}  Target ₹${p.target1.toFixed(0)}\n`;
    });
    msg += "\n";
  } else {
    msg += "No open positions.\n\n";
  }

  if (closedToday.length > 0) {
    msg += `<b>Closed today:</b> ${closedToday.length} trade(s)\n`;
    closedToday.forEach((p) => msg += `  ${displaySym(p.symbol)} — ${p.closeReason || "closed"}\n`);
    msg += "\n";
  }

  const sign = totalPnl >= 0 ? "+" : "";
  msg += `📊 Unrealised : <b>${sign}₹${unrealised.toFixed(0)}</b>\n`;
  msg += `💰 Realised today : <b>${realisedToday >= 0 ? "+" : ""}₹${realisedToday.toFixed(0)}</b>\n`;
  msg += `\n<b>Total Day P&amp;L : ${sign}₹${totalPnl.toFixed(0)}</b>\n`;
  msg += `\nMarkets closed. Next scan: 9:30 AM IST tomorrow.`;

  await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: cid, text: msg, parse_mode: "HTML" }),
  }).catch(() => {});
}

// ─── Weekly report ────────────────────────────────────────────────────────────

async function generateWeeklyReport(kite, fromLabel = "20 Apr", toLabel = "26 Apr") {
  console.log("\n── Weekly Report ─────────────────────────────────────────\n");

  const from = "2026-04-20", to = "2026-04-26";

  // Parse trades.csv
  let trades = [];
  if (existsSync(CSV_FILE)) {
    const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(2); // skip header + easter egg
    trades = lines.map((l) => {
      const cols = l.split(",");
      return {
        date: cols[0], symbol: cols[3], side: cols[4],
        qty: parseFloat(cols[5]), price: parseFloat(cols[6]),
        totalINR: parseFloat(cols[7]), stopPrice: parseFloat(cols[8]),
        fee: parseFloat(cols[9]), netAmount: parseFloat(cols[10]),
        mode: cols[12], score: cols[13], signal: cols[14],
      };
    }).filter((t) => t.date >= from && t.date <= to);
  }

  // Compute P&L per closed round-trip
  const buys  = trades.filter((t) => t.side === "BUY");
  const sells = trades.filter((t) => t.side === "SELL");
  const tradesWithPnl = sells.map((s) => {
    const buy = buys.find((b) => b.symbol === s.symbol);
    return { ...s, pnl: buy ? (s.price - buy.price) * s.qty : 0 };
  });

  // Live unrealised P&L
  const openPos = openPositions(loadPositions());
  let unrealisedPnl = 0;
  try {
    if (openPos.length > 0 && kite) {
      const ltpData = await kite.getLTP(openPos.map((p) => `NSE:${displaySym(p.symbol)}`));
      unrealisedPnl = openPos.reduce((s, p) => {
        const ltp = ltpData[`NSE:${displaySym(p.symbol)}`]?.last_price || p.entryPrice;
        return s + (ltp - p.entryPrice) * p.remainingQty;
      }, 0);
    }
  } catch { /* non-critical */ }

  const gross   = tradesWithPnl.reduce((s, t) => s + t.pnl, 0);
  const fees    = trades.reduce((s, t) => s + (t.fee || 0), 0);
  const wins    = tradesWithPnl.filter((t) => t.pnl >= 0);
  const losses  = tradesWithPnl.filter((t) => t.pnl < 0);
  const winRate = tradesWithPnl.length ? (wins.length / tradesWithPnl.length * 100).toFixed(0) : 0;
  const best    = tradesWithPnl.reduce((a, b) => (a.pnl > b.pnl ? a : b), tradesWithPnl[0] || {});
  const worst   = tradesWithPnl.reduce((a, b) => (a.pnl < b.pnl ? a : b), tradesWithPnl[0] || {});

  console.log(`  Period      : ${fromLabel} → ${toLabel}`);
  console.log(`  Trades      : ${tradesWithPnl.length} closed  (${wins.length}W / ${losses.length}L)  Win rate ${winRate}%`);
  console.log(`  Gross P&L   : ₹${gross.toFixed(2)}`);
  console.log(`  Fees        : ₹${fees.toFixed(2)}`);
  console.log(`  Net P&L     : ₹${(gross - fees).toFixed(2)}`);
  if (best?.symbol)  console.log(`  Best trade  : ${best.symbol}  ₹${best.pnl?.toFixed(2)}`);
  if (worst?.symbol) console.log(`  Worst trade : ${worst.symbol}  ₹${worst.pnl?.toFixed(2)}`);
  console.log(`  Open pos    : ${openPos.length}  Unrealised ₹${unrealisedPnl.toFixed(2)}`);
  console.log(`  Paper trades: ${trades.filter((t) => t.mode === "PAPER").length}\n`);

  await notifyWeeklyReport({
    from: fromLabel, to: toLabel,
    trades: tradesWithPnl, openPositions: openPos.length, unrealisedPnl,
  });

  console.log("  ✅ Weekly report sent to Telegram\n");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === "--weekly-report") {
  const kite = initKite();
  generateWeeklyReport(kite).catch(console.error);
} else if (arg === "--auto-auth") {
  autoAuth()
    .then(() => console.log("\n✅ Done — token refreshed automatically\n"))
    .catch((err) => { console.error(`❌ ${err.message}`); process.exit(1); });
} else if (arg === "--auth") {
  const token = process.argv[3];
  if (!token) {
    console.log("\nUsage: node bot.js --auth YOUR_REQUEST_TOKEN\n");
    console.log(`Get your request_token by visiting:`);
    console.log(`https://kite.zerodha.com/connect/login?api_key=${process.env.KITE_API_KEY}\n`);
    process.exit(1);
  }
  runAuth(token).catch(console.error);
} else if (arg === "--positions") {
  const kite = initKite();
  showPositions(kite).catch(console.error);
} else if (arg === "--sync") {
  const kite = initKite();
  syncWithKite(kite).catch(console.error);
} else if (arg === "--tax-summary") {
  taxSummary();
} else {
  scan().catch((err) => {
    if (isTokenError(err)) {
      console.error("\n❌ Session expired. Run: node bot.js --auth YOUR_REQUEST_TOKEN\n");
    } else {
      console.error("Scanner error:", err.message);
    }
    process.exit(1);
  });
}
