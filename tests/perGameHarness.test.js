// ============================================================================
// PER-GAME BACKTEST HARNESS TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runPerGameBacktest,
  flattenSeriesToGames,
} from '../src/backtest/perGameHarness.js';

// Deterministic model factory
function fixedProbModel(prob) {
  return () => () => ({ homeWinProb: prob, totalGoalsLambda: 5.8 });
}

function makeGame(overrides = {}) {
  return {
    gameId: '2025030111',
    seriesId: '2025-R1-M1',
    gameNum: 1,
    homeTeam: 'BOS',
    awayTeam: 'TOR',
    winner: 'BOS',
    homeGoals: 3,
    awayGoals: 2,
    asOfDate: '2026-04-20T19:00:00Z',
    seriesState: { teamA: 'BOS', teamB: 'TOR', winsA: 0, winsB: 0, round: 1, gamesPlayed: [] },
    features: {},
    ...overrides,
  };
}

// ============================================================================
// Accuracy
// ============================================================================

test('per-game backtest: tracks accuracy across games', () => {
  const games = Array.from({ length: 100 }, (_, i) => makeGame({
    gameId: `g${i}`,
    winner: i % 2 === 0 ? 'BOS' : 'TOR',
  }));

  const result = runPerGameBacktest({
    games,
    modelFactory: fixedProbModel(0.55), // always favor home (BOS)
    config: { bootstrapResamples: 50 },
  });

  // Model favors BOS every time; BOS wins 50 of 100
  assert.equal(result.accuracy, 0.5);
  assert.equal(result.sampleSize, 100);
});

// ============================================================================
// Red flags
// ============================================================================

test('per-game backtest: red flag fires when accuracy exceeds 62% ceiling', () => {
  // Force a leaky model that cheats: returns 0.99 when home actually won
  const games = Array.from({ length: 50 }, (_, i) => makeGame({
    gameId: `g${i}`,
    winner: i < 45 ? 'BOS' : 'TOR', // 90% home wins
    features: { didHomeWin: i < 45 },
  }));

  const modelFactory = (features) => () => ({
    homeWinProb: features.didHomeWin ? 0.95 : 0.05,
    totalGoalsLambda: 5.8,
  });

  const result = runPerGameBacktest({
    games, modelFactory, config: { bootstrapResamples: 50 },
  });

  assert.ok(result.accuracy > 0.62);
  assert.ok(result.redFlags.some(f => f.type === 'per_game_accuracy_ceiling_exceeded'));
});

// ============================================================================
// Calibration
// ============================================================================

test('per-game backtest: Brier score near 0.25 for coin-flip model', () => {
  const games = Array.from({ length: 200 }, (_, i) => makeGame({
    gameId: `g${i}`,
    winner: i % 2 === 0 ? 'BOS' : 'TOR',
  }));

  const result = runPerGameBacktest({
    games,
    modelFactory: fixedProbModel(0.5),
    config: { bootstrapResamples: 50 },
  });

  // Brier for prob=0.5 against 50/50 outcomes is exactly 0.25
  assert.ok(Math.abs(result.calibration.brierScore - 0.25) < 0.01);
});

test('per-game backtest: Brier lower for well-calibrated predictions', () => {
  // Model predicts 0.7 when home wins, 0.3 when road wins (perfect confidence)
  const games = Array.from({ length: 200 }, (_, i) => makeGame({
    gameId: `g${i}`,
    winner: i < 140 ? 'BOS' : 'TOR', // home wins 70% of the time
    features: { homeShouldWin: i < 140 },
  }));
  const modelFactory = (features) => () => ({
    homeWinProb: features.homeShouldWin ? 0.7 : 0.3,
    totalGoalsLambda: 5.8,
  });

  const result = runPerGameBacktest({
    games, modelFactory, config: { bootstrapResamples: 50 },
  });

  // Well-calibrated predictions → lower Brier than coin-flip (0.25)
  assert.ok(result.calibration.brierScore < 0.23);
  // (Extremely low Brier would trigger our "suspiciously good" red flag,
  // which is desirable behavior — NHL single-game Brier has a floor ~0.21)
  assert.ok(result.redFlags.some(f => f.type === 'suspiciously_good_calibration'));
});

test('per-game backtest: reliability bins show predicted vs actual', () => {
  const games = Array.from({ length: 300 }, (_, i) => makeGame({
    gameId: `g${i}`,
    winner: i % 2 === 0 ? 'BOS' : 'TOR',
  }));
  const result = runPerGameBacktest({
    games, modelFactory: fixedProbModel(0.55),
    config: { bootstrapResamples: 50, calibrationBins: 10 },
  });

  assert.equal(result.calibration.bins.length, 10);
  // With constant prediction 0.55, one bin should have all predictions
  const bin55 = result.calibration.bins.find(b => b.range[0] <= 0.55 && b.range[1] > 0.55);
  assert.ok(bin55.n === 300);
  assert.ok(Math.abs(bin55.avgPredicted - 0.55) < 0.001);
});

// ============================================================================
// Betting markets
// ============================================================================

test('per-game backtest: evaluates moneyline bets when book prices present', () => {
  const games = Array.from({ length: 50 }, (_, i) => makeGame({
    gameId: `g${i}`,
    winner: i < 35 ? 'BOS' : 'TOR',  // BOS wins 70%
    bookPrices: { homeML: +120, awayML: -140 }, // book has BOS at ~45%
  }));

  // Model thinks BOS is ~70% — big edge on homeML
  const result = runPerGameBacktest({
    games,
    modelFactory: fixedProbModel(0.70),
    config: { bootstrapResamples: 50, minEdgePct: 0.01 },
  });

  assert.ok(result.markets.homeML.n > 0);
  assert.ok(result.markets.homeML.roi > 0);
});

test('per-game backtest: totals bets use Poisson tail probabilities', () => {
  const games = Array.from({ length: 50 }, (_, i) => makeGame({
    gameId: `g${i}`,
    homeGoals: 3,
    awayGoals: 3, // total = 6 → OVER 5.5
    winner: 'BOS',
    bookPrices: { over55: -110, under55: -110 },
  }));

  // λ = 7.0 → P(over 5.5) ~= 75%
  const modelFactory = () => () => ({ homeWinProb: 0.55, totalGoalsLambda: 7.0 });
  const result = runPerGameBacktest({
    games, modelFactory, config: { bootstrapResamples: 50, minEdgePct: 0.01 },
  });

  // Over 5.5 should fire and win most of them
  assert.ok(result.markets.over55.n > 0);
  assert.ok(result.markets.over55.hitRate === 1); // all games are over 5.5
});

// ============================================================================
// flattenSeriesToGames
// ============================================================================

test('flattenSeriesToGames: builds correct running seriesState per game', () => {
  const series = [{
    seriesId: '2025-R1-M1',
    teamA: 'BOS', teamB: 'TOR', round: 1,
    features: {},
    games: [
      { gameId: 'g1', gameNum: 1, homeTeam: 'BOS', awayTeam: 'TOR',
        winner: 'BOS', homeGoals: 3, awayGoals: 2, startTime: '2024-04-20T23:00:00Z' },
      { gameId: 'g2', gameNum: 2, homeTeam: 'BOS', awayTeam: 'TOR',
        winner: 'TOR', homeGoals: 1, awayGoals: 4, startTime: '2024-04-22T23:00:00Z' },
      { gameId: 'g3', gameNum: 3, homeTeam: 'TOR', awayTeam: 'BOS',
        winner: 'BOS', homeGoals: 2, awayGoals: 5, startTime: '2024-04-24T23:00:00Z' },
    ],
  }];

  const games = flattenSeriesToGames(series);
  assert.equal(games.length, 3);

  // G1 state: 0-0
  assert.equal(games[0].seriesState.winsA, 0);
  assert.equal(games[0].seriesState.winsB, 0);

  // G2 state: 1-0 (BOS won G1)
  assert.equal(games[1].seriesState.winsA, 1);
  assert.equal(games[1].seriesState.winsB, 0);

  // G3 state: 1-1 (TOR won G2)
  assert.equal(games[2].seriesState.winsA, 1);
  assert.equal(games[2].seriesState.winsB, 1);

  // G3's seriesState should include prior games
  assert.equal(games[2].seriesState.gamesPlayed.length, 2);
  assert.equal(games[2].seriesState.gamesPlayed[0].winner, 'BOS');
  assert.equal(games[2].seriesState.gamesPlayed[1].winner, 'TOR');
});

test('flattenSeriesToGames: each game knows its gameNum and venue', () => {
  const series = [{
    seriesId: '2025-R1-M1', teamA: 'BOS', teamB: 'TOR', round: 1, features: {},
    games: [
      { gameId: 'g1', gameNum: 1, homeTeam: 'BOS', awayTeam: 'TOR',
        winner: 'BOS', homeGoals: 2, awayGoals: 1, startTime: '2024-04-20T23:00:00Z' },
    ],
  }];
  const games = flattenSeriesToGames(series);
  assert.equal(games[0].gameNum, 1);
  assert.equal(games[0].homeTeam, 'BOS');
});
