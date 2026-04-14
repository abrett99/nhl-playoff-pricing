# NHL Playoff Series Pricing Model

A calibration-first Stanley Cup playoff series pricing system. Prices series winners, total games O/U, goes-7, exact length, and correct score. Live-updating state machine, in-browser hypothetical engine, Telegram alerts, and full point-in-time auditability.

Extension of an existing NHL regular-season model (~8% ROI, walk-forward validated, Pinnacle CLV confirmed).

---

## Architecture

Three systems, one engine:

```
   Regular-season seeding sim        Playoff state machine        Hypothetical engine
   (daily cron, GitHub Actions)      (15-min cron)                (in-browser, instant)
          │                                  │                             │
          └─────────────────────┬────────────┴─────────────────────────────┘
                                │
                         simulateSeries()  ← pure function, seeded RNG
                                │
                       perGameModel()  ← all Phase-3 gap fixes:
                                        round/G7 HIA, PP+/PK+, zig-zag,
                                        elimination boost, travel, OT 5v5
                                │
                       buildFeaturesAsOf()  ← point-in-time, leakage-safe
                                │
                       Timestamped data store  ← append-only, audit trail
                                │
                       4-layer sanity checks  ← fetch → parse → semantic → drift
```

### Guiding principles

1. **Calibration > accuracy.** A model that's systematically 3% off is worse than one that's 58% accurate but perfectly calibrated. Every ROI dollar comes from calibration.
2. **Point-in-time or it's leaking.** No season-to-date stats predicting mid-season games. Every feature must be reproducible from snapshots timestamped before the game started.
3. **Per-market ROI always.** Aggregate ROI masks underperforming markets. Every backtest breaks down per-market with bootstrap CI.
4. **Old data is better than corrupt data.** The 4-layer sanity check framework gates every commit. Failures go to `quarantined/`, never to `raw/`.
5. **Pinnacle is ground truth.** CLV vs Pinnacle closing is the primary predictor of long-run ROI.

---

## Setup

### Prerequisites
- Node.js 20+
- Telegram account (for alerts)
- Odds API key ([the-odds-api.com](https://the-odds-api.com))

### Install

```bash
git clone <your-repo-url>
cd nhl-playoff-pricing
npm install
npm test        # should show 52/52 passing
```

### Environment variables

Create `.env` locally (never commit):

```bash
ODDS_API_KEY=your_key_here
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

For GitHub Actions, add the same as repository secrets:
- `Settings → Secrets and variables → Actions → New repository secret`

### Telegram setup (5 min)

1. Open Telegram, search `@BotFather`, `/newbot`, pick a name → get bot token
2. Start a chat with your new bot, send any message
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
4. Find `chat.id` in the response (it'll be a number, possibly negative)
5. Test with `node scripts/test-telegram.js`

---

## Running things

```bash
# Demo the MC engine end-to-end with synthetic data
node scripts/simulate-series.js
node scripts/simulate-series.js --state 2-1 --round 1 --trials 50000

# Ingest once (uses ODDS_API_KEY from env)
node scripts/ingest-nhl-schedule.js
node scripts/ingest-odds.js
node scripts/ingest-moneypuck.js
node scripts/ingest-draftkings.js
node scripts/ingest-lwl.js

# NST (requires Playwright setup: npx playwright install chromium)
node scripts/ingest-nst.js

# Historical backtest dataset
node scripts/ingest-historical.js --start 2015 --end 2024
# or smoke-test with synthetic data
node scripts/seed-synthetic-historical.js --series 150

# Build features for all active series's next games
node scripts/build-features.js

# Update state from completed games, fire alerts
node scripts/update-series-state.js
node scripts/detect-goalie-changes.js

# Verify readiness before playoffs start
node scripts/pre-playoff-check.js

# Bootstrap the 8 R1 series state files (2026 bracket)
node scripts/bootstrap-2026-r1.js
node scripts/bootstrap-2026-r1.js --dry-run       # preview only
node scripts/bootstrap-2026-r1.js --force         # overwrite existing

# After each R1 round completes, auto-create R2 series
node scripts/advance-bracket.js
node scripts/advance-bracket.js --dry-run

# Settle bets when games complete
node scripts/settle-bets.js

# CLV capture (T-5min before games)
node scripts/capture-clv.js

# Project playoff seeding during regular season
node scripts/simulate-regular-season.js --trials=5000

# Run the backtest
node scripts/run-backtest.js --min-edge 0.03 --kelly 0.25

# Check data source freshness
node scripts/health-check.js

# Send test alerts (all 6 types)
node scripts/test-telegram.js

# UI (static HTML, in-browser MC)
open src/ui/index.html
# or serve with `npx serve src/ui`
```

---

## Repo layout

```
src/
├── config.js                 ← constants, URL builders, SEMANTIC_RANGES
├── engine/
│   ├── odds.js               ← American↔decimal↔prob, de-vig, Kelly
│   ├── util.js               ← game ID parsing, seeded RNG, Poisson
│   ├── simulateSeries.js     ← pure MC, 50k trials in ~700ms
│   └── perGameModel.js       ← playoff-adjusted with all gap fixes
├── sanity/checks.js          ← 4-layer framework
├── ingest/store.js           ← append-only timestamped store
├── features/pointInTime.js   ← buildFeaturesAsOf() with provenance
├── state/series.js           ← state machine, goalie updates
├── alerts/telegram.js        ← 5 alert formatters, dedup
├── backtest/harness.js       ← walk-forward + bootstrap CI + red flags
└── ui/index.html             ← iPhone-optimized in-browser dashboard

scripts/
├── ingest-nhl-schedule.js    ← NHL API schedule + completed games
├── ingest-odds.js            ← The Odds API (US books + Pinnacle)
├── ingest-moneypuck.js       ← MoneyPuck CSVs
├── build-features.js         ← point-in-time feature builder
├── simulate-series.js        ← demo runner
├── simulate-regular-season.js← seeding projection
├── update-series-state.js    ← state machine advancer
├── health-check.js           ← freshness monitor
└── test-telegram.js          ← alert integration tester

tests/
├── leakage.test.js           ← proves point-in-time is leak-free
├── sanity.test.js            ← all 4 layers of checks
├── mc.test.js                ← Olympic compression + base rates
├── state.test.js             ← state machine invariants
└── backtest.test.js          ← red flags + walk-forward + CI

.github/workflows/
├── odds-snapshot.yml         ← every 15min during game windows
├── playoff-results.yml       ← state machine updates
├── data-refresh.yml          ← daily MoneyPuck + rebuild
└── regular-season-sim.yml    ← daily seeding projection

data/                         ← committed (audit trail)
├── raw/                      ← append-only immutable snapshots
│   ├── nhl_schedule/<timestamp>.json
│   ├── odds_us_books/<timestamp>.json
│   ├── odds_pinnacle/<timestamp>.json
│   ├── moneypuck_teams_*/<timestamp>.csv
│   └── ...
├── quarantined/              ← failed sanity checks
├── derived/                  ← state + features + projections
└── manifest/store.json       ← pointer to latest good pull per source
```

---

## The 4-layer sanity check framework

Every data pull runs through four gates. Failures at ANY layer block the commit.

| Layer | Name | Catches |
|---|---|---|
| 1 | **Fetch** | HTTP errors, tiny responses (CAPTCHA pages), wrong content-type, bot-challenge markers |
| 2 | **Parse** | Wrong row count (e.g. NHL has 32 teams), missing required columns |
| 3 | **Semantic** | Values outside plausible ranges (xGF/60 > 4.5, unknown team abbrevs, vig > 15%) |
| 4 | **Drift** | Stale timestamps, row count shrinkage >20%, impossible field jumps |

Implementation: `src/sanity/checks.js`. Tests: `tests/sanity.test.js`.

---

## Point-in-time guarantee

`buildFeaturesAsOf(gameStartTime)` reads snapshots whose timestamp is strictly BEFORE `gameStartTime`. This is enforced at the storage layer (`getSnapshotAsOf` in `src/ingest/store.js`), not the query layer.

**Critical test:** `tests/leakage.test.js` commits v1, records a query timestamp, then commits v2 AFTER that timestamp. Asking "what were the features at the query timestamp?" must return v1, not v2. If this test ever starts failing, the whole system is untrustworthy.

Every call to `buildFeaturesAsOf` produces an `asOf` metadata block showing exactly which snapshot was used for each source and how old it was at game time. This is the audit trail.

---

## Phase-3 gap fixes (all in `src/engine/perGameModel.js`)

| Gap | Implementation |
|---|---|
| 1.1 | **62% / 75% accuracy ceiling** red flag in backtest harness |
| 1.2 | **Zig-zag bounceback** — ±1.5% shift based on previous game winner |
| 1.3 | **Round/Game-7 adjusted HIA** — base 3.0% + round1 1.0% + round4 0.8% + game7 2.0% |
| 1.4 | First-goal tracking in state; not yet fed to MC (Phase 4 in-game signal) |
| 1.5 | **PP+/PK+ composite** weighted 15% into lambda adjustments |
| 1.6 | **Comeback probability validation** in `tests/mc.test.js` |
| 1.7 | **First-goal** captured per game in state machine (ready for live pricing) |
| 1.8 | Historical base rates in `config.js`, validated in tests |
| 1.9 | Top seed prior capped (built into league-relative formulation) |
| 1.10 | **Playoff 5v5 OT** allocated in proportion to λ ratio (not coin flip) |
| 1.11 | Matchup familiarity — deferred to Phase 3 (needs 4x H2H regular season data) |
| 1.12 | Uncertainty inflation flag exposed on model output |
| 1.13 | Hits / size — low priority, not yet wired |

---

## Alert behavior

| Alert | Priority | Dedup |
|---|---|---|
| Edge >5%, goalie change, saved scenario triggers | High (sound) | 30min cooldown unless edge moves >2% |
| Bet logged confirmation | Medium (silent) | None |
| Routine updates | Medium (silent) | None |
| Pipeline health warnings | Low (silent) | 30min cooldown |

State persisted at `data/derived/alert_log.json`. Alerts never crash the pipeline — `sendTelegram()` wraps everything in try/catch and logs failures.

---

## Philosophy I'm not budging on

1. **Never trust an uncalibrated ROI number.** Walk-forward validation or it didn't happen.
2. **Every model change runs the full backtest before going live.** No exceptions.
3. **No bet sizing above 25% Kelly, ever.** Even with edge >10%, the variance is murder over 150-series samples.
4. **CLV vs Pinnacle is the truth. ROI is the noise.** A model that consistently beats Pinnacle closing by 2% will make money even with a negative sample ROI.
5. **If a feature can't be reproduced historically at the game's start time, it's leaking.** No exceptions, no "it's close enough."

---

## Status

- ✅ **156/156 tests passing**
- ✅ End-to-end MC demo runs in < 1s
- ✅ Timestamped store with proven leak-free guarantee
- ✅ Point-in-time feature builder with provenance metadata
- ✅ State machine with venue / game-number validation + metadata field
- ✅ Playoff-adjusted per-game model with all gap fixes:
  round/G7 HIA, PP+/PK+, zig-zag, elimination, travel, playoff OT,
  Kopitar retirement bump (LAK only, elimination-only)
- ✅ Backtest harness (series + per-game) with walk-forward + bootstrap CI + red flags
- ✅ Telegram alerts (5 formatters, dedup, rate-limited)
- ✅ iPhone-optimized UI with hypothetical engine, bet logger, saved scenarios
- ✅ Historical series loader (10-year dataset from NHL API)
- ✅ CLV capture (T-5min Pinnacle closing line snapshots)
- ✅ LeftWingLock line change parser (ES + PP unit changes)
- ✅ Goalie change detector (NHL gameLanding endpoint)
- ✅ DraftKings series props scraper (eventgroup 42133)
- ✅ NST scraper scaffold (Playwright-based)
- ✅ sportsoddshistory.com historical odds backfill
- ✅ Runnable end-to-end backtest (synthetic + real-data ready)
- ✅ Berkeley PP+/PK+ composite builder (wired into perGameModel)
- ✅ Saved scenarios with auto-expire on state contradiction
- ✅ Bet logger with settlement runner
- ✅ VGK Tortorella coaching-change blend module
- ✅ LAK Kopitar retirement intangible (elimination-only +1.5%)
- ✅ **Bracket progression**: R1→R2→CF→SCF auto-advance when parents complete
- ✅ **Pre-playoff readiness check**: 7-section verification with exit codes
- ✅ 2026 R1 bracket bootstrap script (8 series locked)
- ✅ GitHub Pages deployment workflow
- ✅ 7 GitHub Actions workflows

## The 2026 R1 bracket (as of April 13 — seeding fluid in Pacific)

```
EAST
  A1  BUF   vs   BOS   WC1
  A2  TBL   vs   MTL   A3
  M1  CAR   vs   OTT   WC2
  M2  PIT   vs   PHI   M3

WEST
  C1  COL   vs   LAK   WC2    (Presidents' Trophy winner)
  C2  DAL   vs   MIN   C3
  P1  VGK   vs   UTA   WC1    (Tortorella hired 3/30, 5-0-1 since)
  P2  EDM   vs   ANA   P3     (Ducks' first playoff since 2018)
```

Bootstrap: `node scripts/bootstrap-2026-r1.js`

---

## License

Private. Not for redistribution.
