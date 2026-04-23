/**
 * Telegram notification helper.
 * All functions are silent no-ops if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */

const TG = "https://api.telegram.org";

async function send(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`${TG}/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch { /* non-critical — never block the bot */ }
}

function istTime() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true,
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function sign(n) { return n >= 0 ? "+" : ""; }

// ── Scan summary (sent after every scan) ──────────────────────────────────────

export async function notifyScanSummary({ mktBull, niftyPrice, actionable, executed, openCount, unrealisedPnl, guards }) {
  const bias   = mktBull ? "🟢 BULLISH" : "🔴 BEARISH";
  const setups = actionable.length
    ? actionable.slice(0, 5).map((r) => `  • ${r.symbol} — ${r.signal} (${r.score}/7)`).join("\n")
    : "  None";

  const entries = executed.length
    ? executed.map((e) => `  ✅ ${e.symbol} ${e.qty} qty @ ₹${e.price?.toFixed(2)}`).join("\n")
    : "  None";

  const pnlLine = unrealisedPnl !== null
    ? `\nUnrealised P&L : <b>${sign(unrealisedPnl)}₹${Math.abs(unrealisedPnl).toFixed(0)}</b>`
    : "";

  const guardsLine = guards ? `\n${guards}` : "";

  await send(
    `🔍 <b>Scan — ${istTime()}</b>\n` +
    `Market : ${bias} (NIFTY ₹${niftyPrice?.toFixed(0)})\n` +
    `Setups : ${actionable.length}\n${setups}\n\n` +
    `New entries:\n${entries}\n` +
    `Open positions : ${openCount}${pnlLine}${guardsLine}`
  );
}

// ── Trade entry ───────────────────────────────────────────────────────────────

export async function notifyEntry({ symbol, qty, price, stopPrice, target1, score, mode }) {
  await send(
    `✅ <b>NEW TRADE — ${symbol}</b>\n` +
    `BUY ${qty} qty @ ₹${price?.toFixed(2)}\n` +
    `Stop   : ₹${stopPrice?.toFixed(2)}\n` +
    `Target : ₹${target1?.toFixed(2)} (1:2 R/R)\n` +
    `Score  : ${score}/7 | Mode: ${mode}`
  );
}

// ── Trade exit ────────────────────────────────────────────────────────────────

export async function notifyExit({ symbol, qty, price, entryPrice, reason, isPartial }) {
  const pnl    = (price - entryPrice) * qty;
  const pct    = ((price - entryPrice) / entryPrice * 100).toFixed(2);
  const icon   = pnl >= 0 ? "💰" : "🔴";
  const type   = isPartial ? "PARTIAL EXIT" : "FULL EXIT";

  await send(
    `${icon} <b>${type} — ${symbol}</b>\n` +
    `SELL ${qty} qty @ ₹${price?.toFixed(2)}\n` +
    `P&amp;L : <b>${sign(pnl)}₹${Math.abs(pnl).toFixed(0)} (${sign(pct)}${pct}%)</b>\n` +
    `Reason : ${reason}`
  );
}

// ── Loss spike alert ──────────────────────────────────────────────────────────

export async function notifyLossAlert({ totalPnl, portfolioValue, positions }) {
  const pct     = (totalPnl / portfolioValue * 100).toFixed(2);
  const worst   = positions.reduce((a, b) => (a.pnl < b.pnl ? a : b), positions[0] || {});

  await send(
    `⚠️ <b>LOSS ALERT — WSH764</b>\n` +
    `Total unrealised P&amp;L : <b>₹${totalPnl.toFixed(0)} (${pct}%)</b>\n` +
    `Open positions : ${positions.length}\n` +
    (worst?.symbol ? `Biggest loser  : ${worst.symbol} ₹${worst.pnl?.toFixed(0)}\n` : "") +
    `\nRun <code>node bot.js --positions</code> to review.`
  );
}

// ── Weekly report ─────────────────────────────────────────────────────────────

export async function notifyWeeklyReport({ from, to, trades, openPositions, unrealisedPnl }) {
  const live   = trades.filter((t) => t.mode === "LIVE");
  const paper  = trades.filter((t) => t.mode === "PAPER");
  const sells  = live.filter((t) => t.side === "SELL");
  const wins   = sells.filter((t) => t.pnl >= 0);
  const losses = sells.filter((t) => t.pnl < 0);
  const gross  = sells.reduce((s, t) => s + t.pnl, 0);
  const fees   = live.reduce((s, t) => s + t.fee, 0);
  const best   = sells.reduce((a, b) => (a.pnl > b.pnl ? a : b), sells[0] || {});
  const worst  = sells.reduce((a, b) => (a.pnl < b.pnl ? a : b), sells[0] || {});
  const winRate = sells.length ? (wins.length / sells.length * 100).toFixed(0) : "—";

  await send(
    `📊 <b>WEEKLY REPORT</b>\n` +
    `${from} → ${to}\n\n` +
    `Closed trades  : ${sells.length} (${wins.length}W / ${losses.length}L)\n` +
    `Win rate       : ${winRate}%\n` +
    `Gross P&amp;L  : <b>${sign(gross)}₹${Math.abs(gross).toFixed(0)}</b>\n` +
    `Fees           : ₹${fees.toFixed(0)}\n` +
    `Net P&amp;L    : <b>${sign(gross - fees)}₹${Math.abs(gross - fees).toFixed(0)}</b>\n` +
    (best?.symbol  ? `\nBest trade     : ${best.symbol}  ${sign(best.pnl)}₹${Math.abs(best.pnl)?.toFixed(0)}\n` : "") +
    (worst?.symbol ? `Worst trade    : ${worst.symbol}  ${sign(worst.pnl)}₹${Math.abs(worst.pnl)?.toFixed(0)}\n` : "") +
    `\nOpen positions : ${openPositions}\n` +
    `Unrealised P&amp;L : ${sign(unrealisedPnl)}₹${Math.abs(unrealisedPnl).toFixed(0)}\n` +
    (paper.length  ? `\nPaper trades   : ${paper.length} (not counted above)` : "")
  );
}

// ── Position status (sent every scan when positions are open) ─────────────────

export async function notifyPositionStatus({ positions, unrealisedPnl, sessionId }) {
  if (!positions?.length) return;
  let msg = `📍 <b>Positions — ${istTime()}</b>\n\n`;
  for (const p of positions) {
    const icon = p.pnl >= 0 ? "📈" : "📉";
    const s    = p.pnl >= 0 ? "+" : "";
    msg += `${icon} <b>${p.symbol?.replace(/%/g, "")}</b>  ₹${p.entryPrice?.toFixed(0)} → ₹${p.ltp?.toFixed(0)}  <b>${s}₹${p.pnl?.toFixed(0)}</b> (${s}${p.pct}%)\n`;
    msg += `   SL ₹${p.stopLoss?.toFixed(0)}  T1 ₹${p.target1?.toFixed(0)}  Day ${p.daysHeld}  ${p.status}\n`;
  }
  const us = unrealisedPnl >= 0 ? "+" : "";
  msg += `\n💼 Total unrealised : <b>${us}₹${Math.abs(unrealisedPnl).toFixed(0)}</b>`;
  await send(msg);
}

// ── Circuit breaker alert ─────────────────────────────────────────────────────

export async function notifyCircuitBreaker({ reason, details }) {
  await send(
    `🚨 <b>CIRCUIT BREAKER — ${istTime()}</b>\n\n` +
    `${reason}\n${details}\n\n` +
    `No new entries until tomorrow.`
  );
}
