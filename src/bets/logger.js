// ============================================================================
// BET LOGGER
// ============================================================================
// Persists every bet placed with full context at placement time. CLV is
// automatically attached later by the CLV capture cron when it records
// the Pinnacle closing line for that game. Settlement (W/L) is attached
// when the game/series concludes.
//
// Design: one JSON file per bet at data/derived/bets/<betId>.json.
// Append-only by default; updates only add settlement + CLV fields.
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { isoTimestamp } from '../engine/util.js';
import { americanToProb, edge, kellyStake } from '../engine/odds.js';

const BETS_SUBPATH = ['data', 'derived', 'bets'];
const betsDir = () => path.resolve(process.cwd(), ...BETS_SUBPATH);

// ============================================================================
// Shape of a bet record
// ============================================================================
/*
{
  "betId": "2026-04-14T17-30-00Z_CARNJD_over55",
  "placedAt": "2026-04-14T17:30:00Z",
  "seriesId": "2025-R1-M1",
  "teamA": "CAR",
  "teamB": "NJD",
  "market": "seriesTotalGames",    // seriesWinner, seriesTotalGames, goesSeven, etc.
  "side": "over55",                // team abbrev or O/U descriptor
  "book": "DraftKings",
  "odds": -110,
  "stake": 125,
  "impliedProb": 0.524,
  "modelProb": 0.614,              // snapshot at placement time
  "edgeAtPlacement": 0.082,
  "kellyFractionUsed": 0.25,
  "seriesStateAtPlacement": {
    "winsA": 2, "winsB": 1,
    "gamesPlayed": 3,
    "lastGameWinner": "NJD"
  },
  "goalieAtPlacement": {
    "CAR": "Andersen", "NJD": "Markstrom"
  },

  // --- Filled in later by CLV capture ---
  "pinnacleClosing": {
    "odds": -108,
    "impliedProb": 0.519,
    "capturedAt": "2026-04-15T00:55:00Z",
    "minutesBeforeStart": 5
  },
  "clv": 0.010,                    // beat closing by 1.0%

  // --- Filled in later by settlement ---
  "settled": true,
  "settledAt": "2026-04-21T03:30:00Z",
  "outcome": "won",                // "won" | "lost" | "void"
  "pnl": 113.64,
  "actualResult": {
    "winner": "CAR",
    "totalGames": 6
  }
}
*/

// ============================================================================
// Create a new bet
// ============================================================================

/**
 * Log a new bet. Synchronous in the sense that it only stamps placement-time
 * context — CLV and settlement are filled in later by background jobs.
 *
 * @param {Object} params
 * @param {string} params.seriesId
 * @param {string} params.teamA
 * @param {string} params.teamB
 * @param {string} params.market
 * @param {string} params.side
 * @param {string} params.book
 * @param {number} params.odds       - American odds at placement
 * @param {number} params.stake
 * @param {number} params.modelProb
 * @param {Object} params.seriesState
 * @param {Object} [params.goalies]
 * @param {number} [params.kellyFraction]
 * @returns {Promise<Object>} the bet record
 */
export async function logBet(params) {
  const placedAt = isoTimestamp();
  const betId = makeBetId(placedAt, params);

  const impliedProb = americanToProb(params.odds);
  const edgeAtPlacement = edge(params.modelProb, params.odds);
  const kellyFraction = params.kellyFraction ?? 0.25;
  const kelly = kellyStake(params.modelProb, params.odds, 1, kellyFraction);

  const bet = {
    betId,
    placedAt,
    seriesId: params.seriesId,
    teamA: params.teamA,
    teamB: params.teamB,
    market: params.market,
    side: params.side,
    book: params.book,
    odds: params.odds,
    stake: params.stake,
    impliedProb,
    modelProb: params.modelProb,
    edgeAtPlacement,
    kellyFractionUsed: kellyFraction,
    kellyRecommendedPct: kelly.fractionalKellyPct,
    seriesStateAtPlacement: summarizeSeriesState(params.seriesState),
    goalieAtPlacement: params.goalies ?? null,

    // Pending fields
    pinnacleClosing: null,
    clv: null,
    settled: false,
    settledAt: null,
    outcome: null,
    pnl: null,
    actualResult: null,
  };

  await fs.mkdir(betsDir(), { recursive: true });
  await fs.writeFile(
    path.join(betsDir(), `${betId}.json`),
    JSON.stringify(bet, null, 2)
  );

  return bet;
}

function summarizeSeriesState(state) {
  if (!state) return null;
  const lastGame = state.gamesPlayed?.[state.gamesPlayed.length - 1];
  return {
    winsA: state.winsA,
    winsB: state.winsB,
    gamesPlayed: state.gamesPlayed?.length || 0,
    lastGameWinner: lastGame?.winner ?? null,
  };
}

function makeBetId(placedAt, params) {
  // Stable ID from timestamp + series + market + side
  const ts = placedAt.replace(/[:.]/g, '-').replace('Z', 'Z');
  const slug = `${params.teamA}${params.teamB}_${params.market}_${String(params.side).replace(/\s+/g, '')}`;
  return `${ts}_${slug}`;
}

// ============================================================================
// Read / list bets
// ============================================================================

export async function loadBet(betId) {
  const filePath = path.join(betsDir(), `${betId}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function listAllBets() {
  try {
    const files = await fs.readdir(betsDir());
    const bets = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          try {
            return JSON.parse(await fs.readFile(path.join(betsDir(), f), 'utf-8'));
          } catch {
            return null;
          }
        })
    );
    return bets.filter(Boolean).sort((a, b) =>
      new Date(b.placedAt) - new Date(a.placedAt)
    );
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export async function listOpenBets() {
  const all = await listAllBets();
  return all.filter(b => !b.settled);
}

export async function listBetsNeedingClv() {
  const all = await listAllBets();
  return all.filter(b => !b.clv && !b.settled);
}

// ============================================================================
// Attach CLV from a captured Pinnacle closing
// ============================================================================

/**
 * After CLV capture cron records Pinnacle closing for a game, attach the
 * relevant CLV value to any open bets on that series.
 *
 * @param {Object} params
 * @param {string} params.seriesId
 * @param {string} params.market    - same as bet.market
 * @param {string} params.side      - same as bet.side
 * @param {number} params.closingOdds - American odds at closing
 * @param {string} params.capturedAt
 * @param {number} params.minutesBeforeStart
 */
export async function attachClvToBets(params) {
  const bets = await listBetsNeedingClv();
  const matching = bets.filter(b =>
    b.seriesId === params.seriesId &&
    b.market === params.market &&
    b.side === params.side
  );

  for (const bet of matching) {
    const closingProb = americanToProb(params.closingOdds);
    const ourProb = bet.impliedProb;
    const clv = (closingProb - ourProb) / ourProb;

    const updated = {
      ...bet,
      pinnacleClosing: {
        odds: params.closingOdds,
        impliedProb: closingProb,
        capturedAt: params.capturedAt,
        minutesBeforeStart: params.minutesBeforeStart,
      },
      clv,
    };
    await fs.writeFile(
      path.join(betsDir(), `${bet.betId}.json`),
      JSON.stringify(updated, null, 2)
    );
  }

  return matching.length;
}

// ============================================================================
// Settle a bet when the outcome is known
// ============================================================================

/**
 * Called from update-series-state when series completes (for series-level
 * bets) or game completes (for per-game bets).
 *
 * @param {Object} params
 * @param {string} params.betId
 * @param {string} params.outcome   - "won" | "lost" | "void"
 * @param {Object} params.actualResult - { winner, totalGames, ... }
 */
export async function settleBet(params) {
  const bet = await loadBet(params.betId);
  if (!bet) throw new Error(`Bet not found: ${params.betId}`);
  if (bet.settled) return bet;

  let pnl = 0;
  if (params.outcome === 'won') {
    const decimal = bet.odds < 0 ? 1 + (100 / -bet.odds) : 1 + (bet.odds / 100);
    pnl = bet.stake * (decimal - 1);
  } else if (params.outcome === 'lost') {
    pnl = -bet.stake;
  }
  // void: pnl = 0

  const updated = {
    ...bet,
    settled: true,
    settledAt: isoTimestamp(),
    outcome: params.outcome,
    pnl,
    actualResult: params.actualResult ?? null,
  };

  await fs.writeFile(
    path.join(betsDir(), `${bet.betId}.json`),
    JSON.stringify(updated, null, 2)
  );

  return updated;
}

// ============================================================================
// Summary stats
// ============================================================================

export async function summarizeBets(filter = () => true) {
  const all = (await listAllBets()).filter(filter);
  const settled = all.filter(b => b.settled);
  const won = settled.filter(b => b.outcome === 'won');

  const totalStake = settled.reduce((s, b) => s + b.stake, 0);
  const totalPnl = settled.reduce((s, b) => s + (b.pnl || 0), 0);
  const clvs = all.map(b => b.clv).filter(c => c !== null && c !== undefined);

  return {
    total: all.length,
    settled: settled.length,
    open: all.length - settled.length,
    hitRate: settled.length ? won.length / settled.length : null,
    totalStake,
    totalPnl,
    roi: totalStake > 0 ? totalPnl / totalStake : null,
    avgClv: clvs.length ? clvs.reduce((s, c) => s + c, 0) / clvs.length : null,
    clvSampleSize: clvs.length,
  };
}
