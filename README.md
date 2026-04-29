# NSE Swing Trading Bot — SMC + Quality Gates

Automated daily-timeframe swing trader for Indian equities (NIFTY 500 universe). Pure Smart Money Concepts entries, multi-gate quality filters, friction-aware risk/reward, and full reject-audit logging.

Runs on Zerodha Kite Connect v3. Deploys to Railway. Posts every action to Telegram.

---

## What It Does

1. **Scans 350+ NSE stocks** on daily candles, once per session (15:35 IST, post-close).
2. **Scores each stock** on a weighted SMC rubric — Break of Structure, Order Block, Fair Value Gap, volume accumulation, weekly trend.
3. **Filters survivors through 11 quality gates** — only setups passing every gate become trades.
4. **Sizes positions** at 1% risk per trade, max 40% concentration, max 3 concurrent, max 2 per sector.
5. **Executes** as paper trade or live two-leg GTT (stop + target) on Kite.
6. **Manages exits** via stop, structure break, gap-down emergency, EMA21 trail, stagnation stop.
7. **Logs everything** — trades to `trades.csv`, rejections to `rejects.csv`, scans to `safety-check-log.json`.
8. **Notifies via Telegram** — scan summary, entry, exit, loss alerts, weekly report.

---

## Tech Stack

| Layer | Tool |
|-------|------|
| Exchange | Zerodha Kite Connect v3 |
| Data | Kite historical (Yahoo Finance fallback) |
| Runtime | Node.js ≥ 18, ES modules |
| Deploy | Railway cron (1× weekday EOD) |
| Alerts | Telegram bot |
| Auth | Auto-TOTP refresh via `auto-auth.js` |

---

## Strategy — Pure SMC, Index-Independent

NIFTY direction is shown for context only. Zero weight in entries or exits. Each stock decided on its own structure.

### Scoring (max 7 pts)

| Condition | Points |
|-----------|--------|
| Bullish Break of Structure on daily | 2 |
| Price at unmitigated Order Block | 2 |
| Inside Bullish Fair Value Gap | 1 |
| 3-day volume accumulation | 1 |
| Weekly trend bullish (HH/HL) | 1 |

- **Hard block**: RSI(14) outside 20–78 → discard immediately
- **BUY** ≥ 4 pts (BOS + OB minimum)
- **STRONG BUY** ≥ 6 pts

### Quality Gates (all must pass)

| Gate | Rule | Reject key |
|------|------|------------|
| RSI extreme | RSI 20–78 | `HARD_BLOCK` |
| OB quality | Displacement ≥ 1.5×ATR + untested | `OB_QUALITY` |
| Structure clean | HH/HL last 2 swings + < 4/5 chop wicks | `STRUCTURE` |
| Pullback only | Price inside OB or FVG body | `PULLBACK_ONLY` |
| Not extended | < 3 consecutive green candles | `EXTENDED` |
| No retail trap | > 0.3% from 20d swing high | `RETAIL_TRAP` |
| Confirmation | Bullish engulf or pin bar on last candle | `CONFIRMATION` |
| Weekly regime | Weekly HH/HL OR DX ≥ 25 bullish | `REGIME` |
| Sector cap | Max 2 open per sector | `SECTOR_CAP` |
| Friction RR | (reward − 0.5%) / risk ≥ 2 | `RR_AFTER_COST` |
| Price band | ≤ ₹5000 | `PRICE_LIMIT` |

Every reject logged to `rejects.csv` with gate, reason, score, price, session.

---

## Exit Logic

Priority order in `evaluateExit`:

1. **Gap-down below stop** → emergency exit at open
2. **Stop loss hit** → full exit
3. **Swing low broken + structure failed** → full exit
4. **High-volume bearish candle at loss** → full exit
5. **1:2 target hit** → partial exit (½), stop moved to break-even
6. **Close below EMA21 trail (after target1)** → full exit
7. **Stagnation** — 10 sessions, range < 0.5×ATR → full exit
8. Otherwise **HOLD**, optionally raise trail stop

No hard time stop. Stagnation replaces it (capital efficiency, structure-aware).

---

## Risk Guards

| Guard | Default | Env var |
|-------|---------|---------|
| Risk per trade | 1% portfolio | `RISK_PERCENT=0.01` |
| Concentration | 40% per stock | `MAX_CONCENTRATION_PCT=0.40` |
| Concurrent positions | 3 | `MAX_ACTIVE_TRADES=3` |
| Max trades / day | 3 | `MAX_TRADES_PER_DAY=3` |
| Max trades / week | 10 | `MAX_TRADES_PER_WEEK=10` |
| Daily loss circuit | −2% | `DAILY_LOSS_LIMIT_PCT=0.02` |
| Consecutive loss halt | 3 losses | `CONSECUTIVE_LOSS_HALT=3` |
| Sector cap | 2 per sector | `MAX_PER_SECTOR=2` |
| Friction cost | 0.5% | `FRICTION_COST_FRAC=0.005` |
| Pre-market buffer | 9:45 AM IST entries | hardcoded |

---

## Setup

### 1. Clone + install
```bash
git clone https://github.com/quantifybeats/trading-bot.git
cd trading-bot
npm install
```

### 2. Environment
Create `.env`:
```
KITE_API_KEY=your_kite_api_key
KITE_API_SECRET=your_kite_api_secret
KITE_USER_ID=ABC123
KITE_PASSWORD=your_password
KITE_TOTP_SECRET=BASE32_TOTP_SECRET

PORTFOLIO_VALUE_INR=200000
PAPER_TRADING=true

TELEGRAM_BOT_TOKEN=optional
TELEGRAM_CHAT_ID=optional
```

### 3. First auth
```bash
# Open https://kite.zerodha.com/connect/login?api_key=YOUR_KEY
# Login, copy request_token from redirect URL, run:
node bot.js --auth REQUEST_TOKEN
```
After this, `KITE_TOTP_SECRET` enables auto-refresh on subsequent runs.

### 4. Run
```bash
node bot.js                  # full scan + exit check + entries
node bot.js --positions      # show open positions + live P&L
node bot.js --tax-summary    # trade summary for accountant
node bot.js --sync           # sync positions.json with Kite holdings
```

---

## Files

| File | Purpose |
|------|---------|
| `bot.js` | Main scanner, scorer, executor |
| `kite.js` | Kite Connect v3 wrapper |
| `auto-auth.js` | TOTP-based session refresh |
| `notify.js` | Telegram alerts |
| `watchlist.json` | NIFTY 500 universe + price limit |
| `sectors.json` | Symbol → sector mapping (extend as needed) |
| `positions.json` | Open + closed position state (auto-managed) |
| `safety-check-log.json` | Per-scan decision log |
| `trades.csv` | Tax-ready trade ledger |
| `rejects.csv` | Every gate rejection (audit trail) |
| `railway.json` | Deployment cron config |

---

## Deployment (Railway)

`railway.json` cron: `5 10 * * 1-5` UTC = **15:35 IST, Mon–Fri**.

Single end-of-day scan. No intraday duplicates.

```bash
railway up
railway variables set KITE_API_KEY=...
# etc
```

Logs streamed to Railway dashboard. Telegram delivers per-scan summary.

---

## Reject Audit (the feedback loop)

After 60+ paper trades, audit `rejects.csv`:

```bash
awk -F, 'NR>1{print $6}' rejects.csv | sort | uniq -c | sort -rn
```

If one gate dominates (> 70% of rejects), it's mis-calibrated. Loosen or replace.
If gates balanced, edge is clean.

Bucket trade outcomes by entry score (4 vs 5 vs 6+):
```bash
# Pseudo: filter trades.csv by Score column, compute win rate per bucket
```
If 4/7 win rate trails 5/7 by > 10%, raise `BUY_THRESHOLD=5`.

---

## Reconciliation

Every scan-start, `reconcilePositions` checks broker GTT state vs `positions.json`:

- Local OPEN position with no live GTT → recreate trail GTT at current stop
- Live GTT at broker not tied to local position → log warning (manual review)

Survives bot crash mid-leg.

---

## Position Sizing

```
available  = portfolio − capital_locked_in_open_positions
slot_share = available / slots_remaining
qty        = min(slot_share / price, risk_amount / risk_distance)
risk_amount = portfolio × RISK_PERCENT
risk_distance = entry − stop, capped at 1% × entry
```

Hard 1% stop cap protects against wide stops in volatile names.

---

## Notes

- **Paper mode default.** Flip `PAPER_TRADING=false` only after 60+ paper trades validate edge.
- **GTT is two-leg native** on Kite (stop + target). Modify uses delete-then-recreate for reliability.
- **Yahoo fallback** kicks in when Kite historical returns plan-restricted 403. Three symbols permanently broken on Yahoo: TATAMOTORS, ZOMATO, BARBEQUE — these run Kite-only.
- **Confirmation candle** evaluated on last completed daily candle. EOD scan timing (15:35 IST) ensures candle is closed.
- **Sector mapping** is partial. Symbols absent from `sectors.json` treated as `Unknown` and exempt from sector cap. Extend file as needed.

---

## License

MIT.
