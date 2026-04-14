// ============================================================================
// BACKTEST HARNESS TESTS
// ============================================================================
// Verifies the backtest framework catches its own failure modes before we
// trust it with real data.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBacktest, runWalkForward } from '../src/backtest/harness.js';
import { HISTORICAL_BASE_RATES } from '../src/config.js';

// Simple model factory: always returns the same constant per-game probability
function constantModelFactory(homeWinProb) {
  return () => () => ({ homeWinProb, totalGoalsLambda: 5.8 });
}

function makeSeries({ n = 10, startDate = '2024-04-01', bookAmerican = -110 }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i * 14);
    out.push({
      seriesId: `TEST-${i}`,
      teamA: 'BOS',
      teamB: 'TOR',
      round: 1,
      actualWinner: i % 2 === 0 ? 'BOS' : 'TOR',
      actualTotalGames: 5 + (i % 3),
      asOfDate: date.toISOString(),
      bookPrices: {
        seriesWinner: { BOS: -120, TOR: +100 },
        over55: bookAmerican,
        under55: bookAmerican,
      },
      features: { homeXg: 2.8 + i * 0.01 },
    });
  }
  return out;
}

// ============================================================================
// Test 1: Red-flag triggers on impossible accuracy
// ============================================================================

test('red flag triggers when series accuracy exceeds theoretical ceiling', () => {
  const series = makeSeries({ n: 20 });
  // Inject the actualWinner into features so the "leaky" model can cheat
  for (const s of series) s.features = { leakyActualWinner: s.actualWinner };
  // Model that cheats using the leaked label
  const modelFactory = (features) => () => ({
    homeWinProb: features.leakyActualWinner === 'BOS' ? 0.99 : 0.01,
    totalGoalsLambda: 5.8,
  });

  const result = runBacktest({ series, modelFactory, config: { bootstrapResamples: 50 } });

  // Series accuracy should be far above the 75% ceiling
  assert.ok(result.accuracy.series > HISTORICAL_BASE_RATES.series_accuracy_ceiling,
    `Expected leaky series accuracy, got ${result.accuracy.series}`);
  // Red flag should fire
  const flag = result.redFlags.find(f => f.type === 'series_accuracy_ceiling_exceeded');
  assert.ok(flag, 'Expected series accuracy red flag to fire');
});

// ============================================================================
// Test 2: No red flag for realistic accuracy
// ============================================================================

test('no red flag when accuracy is below theoretical ceiling', () => {
  const series = makeSeries({ n: 20 });
  // Coin-flip model → series accuracy ~50%
  const modelFactory = constantModelFactory(0.5);

  const result = runBacktest({ series, modelFactory, config: { bootstrapResamples: 50 } });
  assert.ok(result.accuracy.series < HISTORICAL_BASE_RATES.series_accuracy_ceiling);
  assert.equal(result.redFlags.filter(f => f.type === 'series_accuracy_ceiling_exceeded').length, 0);
});

// ============================================================================
// Test 3: Per-market breakdown present
// ============================================================================

test('per-market breakdown includes all markets that had bets', () => {
  const series = makeSeries({ n: 15 });
  // Model that disagrees a lot with the book → bets triggered
  const modelFactory = constantModelFactory(0.70);
  const result = runBacktest({ series, modelFactory, config: { bootstrapResamples: 50 } });

  assert.ok('seriesWinner' in result.byMarket);
  assert.ok('over55' in result.byMarket);
  assert.ok('under55' in result.byMarket);
  // At least one of them should have some bets
  const totalBets = Object.values(result.byMarket).reduce((s, m) => s + (m.n || 0), 0);
  assert.ok(totalBets > 0, 'Expected at least some bets across markets');
});

// ============================================================================
// Test 4: Bootstrap CI structure
// ============================================================================

test('bootstrap CI contains required fields', () => {
  const series = makeSeries({ n: 20 });
  const modelFactory = constantModelFactory(0.65);
  const result = runBacktest({ series, modelFactory, config: { bootstrapResamples: 100 } });

  // Find a market with bets
  for (const [market, summary] of Object.entries(result.byMarket)) {
    if (summary.n > 0 && summary.ci95) {
      assert.ok('lower' in summary.ci95);
      assert.ok('upper' in summary.ci95);
      assert.ok('median' in summary.ci95);
      assert.ok(summary.ci95.lower <= summary.ci95.upper);
      return;
    }
  }
  // If no market had bets, that's also fine for this test's purpose
});

// ============================================================================
// Test 5: Walk-forward chronological respect
// ============================================================================

test('walk-forward produces windows in chronological order', () => {
  // Spread series across multiple years so windows can form
  const series = [];
  for (let i = 0; i < 60; i++) {
    const date = new Date('2020-01-01');
    date.setMonth(date.getMonth() + i);
    series.push({
      seriesId: `T-${i}`,
      teamA: 'BOS', teamB: 'TOR', round: 1,
      actualWinner: i % 2 === 0 ? 'BOS' : 'TOR',
      actualTotalGames: 5 + (i % 3),
      asOfDate: date.toISOString(),
      bookPrices: { over55: -110, under55: -110 },
      features: {},
    });
  }

  // fitModel(train) must return a modelFactory with signature (features) => modelFn
  const fitModel = () => () => () => ({ homeWinProb: 0.55, totalGoalsLambda: 5.8 });
  const result = runWalkForward({
    series,
    fitModel,
    windowMonths: 6,
    minTrainingSize: 12,
    config: { bootstrapResamples: 20 },
  });

  assert.ok(result.windows.length > 0, 'expected at least one window');
  for (let i = 1; i < result.windows.length; i++) {
    const prev = new Date(result.windows[i - 1].testEnd);
    const curr = new Date(result.windows[i].testEnd);
    assert.ok(curr > prev, 'windows should be chronologically ordered');
  }

  // Consistency object should exist if 2+ windows
  if (result.windows.length >= 2) {
    assert.ok(result.consistency !== null);
  }
});

// ============================================================================
// Test 6: Min-edge filter works
// ============================================================================

test('minEdgePct filter excludes low-edge bets', () => {
  const series = makeSeries({ n: 20 });
  // Very weak edge model
  const modelFactory = constantModelFactory(0.51);

  const loose = runBacktest({ series, modelFactory, config: { minEdgePct: 0.01, bootstrapResamples: 20 } });
  const strict = runBacktest({ series, modelFactory, config: { minEdgePct: 0.20, bootstrapResamples: 20 } });

  const looseBets = Object.values(loose.byMarket).reduce((s, m) => s + m.n, 0);
  const strictBets = Object.values(strict.byMarket).reduce((s, m) => s + m.n, 0);
  assert.ok(strictBets <= looseBets, 'stricter filter should produce fewer bets');
});
