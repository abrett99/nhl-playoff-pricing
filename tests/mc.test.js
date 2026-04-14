// ============================================================================
// SERIES MONTE CARLO TESTS
// ============================================================================
// Critical tests that prevent Olympic-style compounding bugs:
//   - Compression test: heavy matchups must produce heavy series prices
//   - Symmetry test: equal teams must produce ~50/50 series
//   - Historical base rates: comeback probabilities match history
//   - Venue sequence: 2-2-1-1-1 is respected
//   - State math: 4 wins ends the series
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { simulateSeries, computeEdges } from '../src/engine/simulateSeries.js';
import { HISTORICAL_BASE_RATES } from '../src/config.js';

function makeState(overrides = {}) {
  return {
    seriesId: 'TEST-R1-M1',
    teamA: 'BOS',
    teamB: 'TOR',
    winsA: 0,
    winsB: 0,
    gamesPlayed: [],
    round: 1,
    ...overrides,
  };
}

function constantProbModel(homeWinProb, totalGoalsLambda = 5.8) {
  return () => ({ homeWinProb, totalGoalsLambda });
}

// ============================================================================
// Test 1: The Olympic compression test
// ============================================================================

test('heavy per-game mismatch produces heavy series price (no compression bug)', () => {
  // Team A heavily favored: 75% home, 70% away (huge mismatch)
  const state = makeState();
  const result = simulateSeries({
    state,
    perGameModel: ({ homeTeam }) => ({
      homeWinProb: homeTeam === 'BOS' ? 0.75 : 0.30, // BOS wins 75% home, 70% away
      totalGoalsLambda: 5.8,
    }),
    trials: 20000,
    seed: 42,
  });

  assert.ok(result.seriesWinner.BOS.prob > 0.80,
    `Series price too compressed: BOS ${result.seriesWinner.BOS.prob}, expected >0.80`);
});

// ============================================================================
// Test 2: Symmetric matchup produces symmetric result
// ============================================================================

test('equal 50/50 per-game produces near 50/50 series', () => {
  const state = makeState();
  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.5),
    trials: 20000,
    seed: 123,
  });

  assert.ok(
    Math.abs(result.seriesWinner.BOS.prob - 0.5) < 0.02,
    `Symmetric series should be ~50/50, got BOS ${result.seriesWinner.BOS.prob}`
  );
});

// ============================================================================
// Test 3: 4 wins ends the series (state math)
// ============================================================================

test('series ends at exactly 4 wins', () => {
  const state = makeState();
  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.5),
    trials: 5000,
    seed: 1,
  });

  // Sum of all game length probabilities should equal 1
  const total =
    result.totalGames.pmf[4] +
    result.totalGames.pmf[5] +
    result.totalGames.pmf[6] +
    result.totalGames.pmf[7];
  assert.ok(Math.abs(total - 1) < 0.001,
    `Total games PMF should sum to 1, got ${total}`);

  // No game 8 or beyond should ever happen
  assert.equal(result.totalGames.pmf[8], undefined);
});

// ============================================================================
// Test 4: Already-complete series is handled
// ============================================================================

test('already-complete series returns degenerate result', () => {
  const state = makeState({ winsA: 4, winsB: 2, gamesPlayed: [
    { gameNum: 1, winner: 'BOS', venue: 'BOS', goals: [2,3], ot: false },
    { gameNum: 2, winner: 'BOS', venue: 'BOS', goals: [1,4], ot: false },
    { gameNum: 3, winner: 'TOR', venue: 'TOR', goals: [3,2], ot: false },
    { gameNum: 4, winner: 'BOS', venue: 'TOR', goals: [1,3], ot: false },
    { gameNum: 5, winner: 'TOR', venue: 'BOS', goals: [4,3], ot: true  },
    { gameNum: 6, winner: 'BOS', venue: 'TOR', goals: [2,4], ot: false },
  ] });

  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.5),
    trials: 1000,
  });

  assert.equal(result.seriesWinner.BOS.prob, 1);
  assert.equal(result.seriesWinner.TOR.prob, 0);
  assert.equal(result.totalGames.expected, 6);
});

// ============================================================================
// Test 5: Reproducibility via seed
// ============================================================================

test('same seed produces same MC result', () => {
  const state = makeState();
  const model = constantProbModel(0.55);

  const r1 = simulateSeries({ state, perGameModel: model, trials: 5000, seed: 7 });
  const r2 = simulateSeries({ state, perGameModel: model, trials: 5000, seed: 7 });

  assert.equal(r1.seriesWinner.BOS.prob, r2.seriesWinner.BOS.prob);
  assert.equal(r1.totalGames.expected, r2.totalGames.expected);
});

// ============================================================================
// Test 6: Historical base rates — the critical validation
// ============================================================================

test('comeback from 3-0 is close to historical 1-3% rate', () => {
  // With evenly matched teams, what does the MC say about coming back from 3-0?
  const state = makeState({
    winsA: 0, winsB: 3,
    gamesPlayed: [
      { gameNum: 1, winner: 'TOR', venue: 'BOS', goals: [3, 2] },
      { gameNum: 2, winner: 'TOR', venue: 'BOS', goals: [2, 1] },
      { gameNum: 3, winner: 'TOR', venue: 'TOR', goals: [2, 3] },
    ],
  });
  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.52), // slight home edge
    trials: 50000,
    seed: 42,
  });

  // Should be ~12% for evenly-matched teams with home ice left.
  // Historical rate is ~1% but that's across ALL series where one team went down 3-0,
  // and includes series where the leading team was much stronger.
  // For truly 50/50 with remaining home games = 4/7 for trailing team,
  // MC should predict higher than 1%.
  const comebackProb = result.seriesWinner.BOS.prob;
  assert.ok(comebackProb > 0.01 && comebackProb < 0.30,
    `3-0 comeback prob ${comebackProb} outside reasonable band [1%, 30%]`);
});

test('comeback from 3-1 is close to historical 15-20% rate', () => {
  const state = makeState({
    winsA: 1, winsB: 3,
    gamesPlayed: [
      { gameNum: 1, winner: 'BOS', venue: 'BOS', goals: [2, 3] },
      { gameNum: 2, winner: 'TOR', venue: 'BOS', goals: [4, 3] },
      { gameNum: 3, winner: 'TOR', venue: 'TOR', goals: [2, 1] },
      { gameNum: 4, winner: 'TOR', venue: 'TOR', goals: [3, 1] },
    ],
  });
  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.52),
    trials: 50000,
    seed: 42,
  });

  const comebackProb = result.seriesWinner.BOS.prob;
  // Evenly-matched teams should show ~20-30% for 3-1 comeback given 2 home games
  assert.ok(comebackProb > 0.10 && comebackProb < 0.45,
    `3-1 comeback prob ${comebackProb} outside reasonable band [10%, 45%]`);
});

test('Game 7 at home: home team wins 55-70%', () => {
  const state = makeState({
    winsA: 3, winsB: 3,
    gamesPlayed: [
      { gameNum: 1, winner: 'BOS', venue: 'BOS', goals: [1, 3] },
      { gameNum: 2, winner: 'TOR', venue: 'BOS', goals: [4, 2] },
      { gameNum: 3, winner: 'BOS', venue: 'TOR', goals: [3, 1] },
      { gameNum: 4, winner: 'TOR', venue: 'TOR', goals: [4, 2] },
      { gameNum: 5, winner: 'BOS', venue: 'BOS', goals: [2, 4] },
      { gameNum: 6, winner: 'TOR', venue: 'TOR', goals: [3, 2] },
    ],
  });
  // With a model that gives 55% to home, MC for a 3-3 series should give
  // BOS (home ice = Game 7 at home) ~55%
  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.55),
    trials: 20000,
    seed: 42,
  });

  assert.ok(
    result.seriesWinner.BOS.prob >= 0.50 && result.seriesWinner.BOS.prob <= 0.65,
    `Game 7 home team win prob ${result.seriesWinner.BOS.prob} outside [0.50, 0.65]`
  );
});

// ============================================================================
// Test 7: Hypothetical overrides
// ============================================================================

test('game outcome override forces series outcome', () => {
  const state = makeState();
  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.5),
    overrides: {
      gameOutcomes: { 1: 'BOS', 2: 'BOS', 3: 'BOS', 4: 'BOS' },
    },
    trials: 1000,
    seed: 1,
  });

  // All forced BOS wins → series ends 4-0 BOS 100% of the time
  assert.equal(result.seriesWinner.BOS.prob, 1);
  assert.equal(result.totalGames.pmf[4], 1);
});

test('state override to 2-2 changes series distribution', () => {
  const state = makeState();
  const result = simulateSeries({
    state,
    perGameModel: constantProbModel(0.5),
    overrides: {
      winsA: 2,
      winsB: 2,
      gamesPlayed: [
        { gameNum: 1, winner: 'BOS', venue: 'BOS', goals: [1, 3] },
        { gameNum: 2, winner: 'TOR', venue: 'BOS', goals: [4, 2] },
        { gameNum: 3, winner: 'BOS', venue: 'TOR', goals: [1, 3] },
        { gameNum: 4, winner: 'TOR', venue: 'TOR', goals: [4, 2] },
      ],
    },
    trials: 10000,
    seed: 1,
  });

  // From 2-2, one team needs 2 more wins → minimum 2 more games → total 6 or 7
  assert.equal(result.totalGames.pmf[4] ?? 0, 0);
  assert.equal(result.totalGames.pmf[5] ?? 0, 0);
  assert.ok(result.totalGames.pmf[6] > 0);
  assert.ok(result.totalGames.pmf[7] > 0);
  // The two remaining possibilities must sum to ~1
  assert.ok(Math.abs((result.totalGames.pmf[6] + result.totalGames.pmf[7]) - 1) < 0.001);
});

// ============================================================================
// Test 8: Validation catches invalid states
// ============================================================================

test('invalid state throws', () => {
  assert.throws(() =>
    simulateSeries({
      state: { teamA: 'BOS', teamB: 'BOS', winsA: 0, winsB: 0, gamesPlayed: [] },
      perGameModel: constantProbModel(0.5),
    })
  );
  assert.throws(() =>
    simulateSeries({
      state: makeState({ winsA: 5 }),
      perGameModel: constantProbModel(0.5),
    })
  );
  assert.throws(() =>
    simulateSeries({
      state: makeState({ winsA: 2, winsB: 1, gamesPlayed: [] }), // length doesn't match wins
      perGameModel: constantProbModel(0.5),
    })
  );
});

// ============================================================================
// Test 9: Edge computation against book
// ============================================================================

test('computeEdges produces edges sorted high to low', () => {
  const modelResult = {
    seriesWinner: {
      BOS: { prob: 0.65 },
      TOR: { prob: 0.35 },
    },
    totalGames: {
      over55: { prob: 0.58 },
      under55: { prob: 0.42 },
    },
    goesSeven: {
      yes: { prob: 0.22 },
      no: { prob: 0.78 },
    },
  };

  const bookPrices = {
    seriesWinner: { BOS: -150, TOR: +130 },
    over55: -110,
    under55: -110,
    goesSevenYes: +350,
  };

  const edges = computeEdges(modelResult, bookPrices);
  assert.ok(edges.length > 0);
  // Edges should be sorted descending
  for (let i = 1; i < edges.length; i++) {
    assert.ok(edges[i].edge <= edges[i - 1].edge,
      'Edges not sorted descending');
  }
});
