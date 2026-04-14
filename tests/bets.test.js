// ============================================================================
// BET LOGGER TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import {
  logBet,
  loadBet,
  listAllBets,
  listOpenBets,
  attachClvToBets,
  settleBet,
  summarizeBets,
} from '../src/bets/logger.js';

const ORIGINAL_CWD = process.cwd();
let TEST_DIR;

async function setup() {
  TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'bet-logger-test-'));
  process.chdir(TEST_DIR);
}

async function teardown() {
  process.chdir(ORIGINAL_CWD);
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}

// ============================================================================
// Logging a bet
// ============================================================================

test('logBet persists with placement-time context', async () => {
  await setup();
  try {
    const bet = await logBet({
      seriesId: '2025-R1-M1',
      teamA: 'BOS', teamB: 'TOR',
      market: 'seriesTotalGames',
      side: 'over55',
      book: 'DraftKings',
      odds: -110,
      stake: 125,
      modelProb: 0.614,
      seriesState: {
        teamA: 'BOS', teamB: 'TOR',
        winsA: 2, winsB: 1,
        gamesPlayed: [
          { gameNum: 1, winner: 'BOS', venue: 'BOS' },
          { gameNum: 2, winner: 'TOR', venue: 'BOS' },
          { gameNum: 3, winner: 'BOS', venue: 'TOR' },
        ],
      },
      goalies: { BOS: 'Swayman', TOR: 'Stolarz' },
    });

    // Round-trip check
    const reloaded = await loadBet(bet.betId);
    assert.equal(reloaded.betId, bet.betId);
    assert.equal(reloaded.market, 'seriesTotalGames');
    assert.equal(reloaded.side, 'over55');
    assert.equal(reloaded.stake, 125);
    assert.equal(reloaded.modelProb, 0.614);
    // Edge should be computed
    assert.ok(reloaded.edgeAtPlacement > 0);
    // State summary captured
    assert.equal(reloaded.seriesStateAtPlacement.winsA, 2);
    assert.equal(reloaded.seriesStateAtPlacement.winsB, 1);
    assert.equal(reloaded.seriesStateAtPlacement.lastGameWinner, 'BOS');
    // Pending fields start null
    assert.equal(reloaded.clv, null);
    assert.equal(reloaded.settled, false);
  } finally {
    await teardown();
  }
});

test('listAllBets returns all persisted bets', async () => {
  await setup();
  try {
    await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'seriesWinner', side: 'BOS',
      book: 'DK', odds: -150, stake: 100, modelProb: 0.67,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    await logBet({
      seriesId: 'S2', teamA: 'CAR', teamB: 'NJD',
      market: 'over55', side: 'over55',
      book: 'FD', odds: -110, stake: 50, modelProb: 0.60,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });

    const all = await listAllBets();
    assert.equal(all.length, 2);
  } finally {
    await teardown();
  }
});

// ============================================================================
// CLV attachment
// ============================================================================

test('attachClvToBets computes CLV vs Pinnacle closing', async () => {
  await setup();
  try {
    const bet = await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'seriesTotalGames', side: 'over55',
      book: 'DK', odds: -110, stake: 100, modelProb: 0.60,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });

    // Closing line: -105 (better for us if we're on OVER at -110)
    // impliedProb at -105: 0.5122; at -110: 0.5238
    // CLV: (0.5122 - 0.5238) / 0.5238 = NEGATIVE (we bet worse price)
    // Wait: if closing is -105 and we bet -110, we bet at WORSE price...
    // Actually CLV is (closingImplied - ourImplied) / ourImplied
    // If closing implied < our implied, CLV is negative = we beat closing
    // Hmm, sign convention: we want our bet's implied prob to be LOWER
    // than closing's (meaning closing values our side more). So CLV > 0
    // when closing > our implied.
    //
    // At -110 (us): implied 0.524. At -120 (closing): implied 0.545.
    // CLV = (0.545 - 0.524) / 0.524 = +4% — we got a better price than closing
    const matchCount = await attachClvToBets({
      seriesId: 'S1',
      market: 'seriesTotalGames',
      side: 'over55',
      closingOdds: -120,
      capturedAt: '2026-04-15T00:55:00Z',
      minutesBeforeStart: 5,
    });

    assert.equal(matchCount, 1);
    const reloaded = await loadBet(bet.betId);
    assert.ok(reloaded.clv > 0);
    assert.equal(reloaded.pinnacleClosing.odds, -120);
  } finally {
    await teardown();
  }
});

test('attachClvToBets only matches bets on same series+market+side', async () => {
  await setup();
  try {
    await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'over55', side: 'over55',
      book: 'DK', odds: -110, stake: 100, modelProb: 0.60,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'over55', side: 'under55',  // different side
      book: 'DK', odds: -110, stake: 100, modelProb: 0.40,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });

    const matched = await attachClvToBets({
      seriesId: 'S1', market: 'over55', side: 'over55',
      closingOdds: -108, capturedAt: '2026-04-15T00:55:00Z',
      minutesBeforeStart: 5,
    });
    assert.equal(matched, 1);
  } finally {
    await teardown();
  }
});

// ============================================================================
// Settlement
// ============================================================================

test('settleBet computes pnl correctly for a win', async () => {
  await setup();
  try {
    const bet = await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'seriesWinner', side: 'BOS',
      book: 'DK', odds: +120, stake: 100, modelProb: 0.55,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });

    const settled = await settleBet({
      betId: bet.betId,
      outcome: 'won',
      actualResult: { winner: 'BOS', totalGames: 6 },
    });

    // +120 means profit = 1.20 * stake
    assert.ok(Math.abs(settled.pnl - 120) < 0.01);
    assert.equal(settled.outcome, 'won');
    assert.equal(settled.settled, true);
    assert.equal(settled.actualResult.winner, 'BOS');
  } finally {
    await teardown();
  }
});

test('settleBet computes pnl = -stake for a loss', async () => {
  await setup();
  try {
    const bet = await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'seriesWinner', side: 'TOR',
      book: 'DK', odds: +150, stake: 100, modelProb: 0.45,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    const settled = await settleBet({
      betId: bet.betId, outcome: 'lost',
      actualResult: { winner: 'BOS', totalGames: 5 },
    });
    assert.equal(settled.pnl, -100);
    assert.equal(settled.outcome, 'lost');
  } finally {
    await teardown();
  }
});

test('settleBet void has pnl = 0', async () => {
  await setup();
  try {
    const bet = await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'over55', side: 'over55',
      book: 'DK', odds: -110, stake: 100, modelProb: 0.60,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    const settled = await settleBet({ betId: bet.betId, outcome: 'void' });
    assert.equal(settled.pnl, 0);
  } finally {
    await teardown();
  }
});

// ============================================================================
// Aggregate stats
// ============================================================================

test('summarizeBets aggregates pnl, hit rate, avg CLV', async () => {
  await setup();
  try {
    // Win at -110 stake 100 → +90.91
    const b1 = await logBet({
      seriesId: 'S1', teamA: 'BOS', teamB: 'TOR',
      market: 'over55', side: 'over55',
      book: 'DK', odds: -110, stake: 100, modelProb: 0.60,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    // In production, CLV is attached BEFORE game concludes; settlement after
    await attachClvToBets({
      seriesId: 'S1', market: 'over55', side: 'over55',
      closingOdds: -120, capturedAt: '...', minutesBeforeStart: 5,
    });
    await settleBet({ betId: b1.betId, outcome: 'won' });

    // Loss at +150 stake 50 → -50
    const b2 = await logBet({
      seriesId: 'S2', teamA: 'CAR', teamB: 'NJD',
      market: 'goesSevenYes', side: 'yes',
      book: 'FD', odds: +150, stake: 50, modelProb: 0.45,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    await settleBet({ betId: b2.betId, outcome: 'lost' });

    const summary = await summarizeBets();
    assert.equal(summary.total, 2);
    assert.equal(summary.settled, 2);
    assert.equal(summary.hitRate, 0.5);
    // ROI = pnl / stake. pnl: +90.91 - 50 = +40.91. stake: 150.
    assert.ok(Math.abs(summary.roi - 40.91 / 150) < 0.01);
    assert.ok(summary.avgClv > 0);
    assert.equal(summary.clvSampleSize, 1);
  } finally {
    await teardown();
  }
});

test('listOpenBets returns only unsettled', async () => {
  await setup();
  try {
    const b1 = await logBet({
      seriesId: 'S1', teamA: 'A', teamB: 'B',
      market: 'seriesWinner', side: 'A',
      book: 'DK', odds: -110, stake: 100, modelProb: 0.55,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    await logBet({
      seriesId: 'S2', teamA: 'C', teamB: 'D',
      market: 'over55', side: 'over55',
      book: 'DK', odds: -110, stake: 100, modelProb: 0.60,
      seriesState: { winsA: 0, winsB: 0, gamesPlayed: [] },
    });
    await settleBet({ betId: b1.betId, outcome: 'won' });

    const open = await listOpenBets();
    assert.equal(open.length, 1);
    assert.equal(open[0].seriesId, 'S2');
  } finally {
    await teardown();
  }
});
