import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPerGameModelGoals,
  poissonPmf,
  homeWinProbabilityFromLambdas,
  computeRoundHomeIceAdvantage,
  computeZigZagAdjustment,
  computeEliminationBoost,
  computeSpecialTeamsMultiplier,
  LEAGUE_AVG_GA_PER_GAME,
  LEAGUE_AVG_PP_PCT,
} from '../src/engine/perGameModelGoals.js';

// ---------------------------------------------------------------------------
// Pure math tests
// ---------------------------------------------------------------------------

test('poissonPmf: P(0 | lambda=0) = 1', () => {
  assert.equal(poissonPmf(0, 0), 1);
});

test('poissonPmf: P(k>0 | lambda=0) = 0', () => {
  assert.equal(poissonPmf(3, 0), 0);
});

test('poissonPmf: sums to ~1 over reasonable grid', () => {
  let sum = 0;
  for (let k = 0; k <= 20; k++) sum += poissonPmf(k, 3.0);
  assert.ok(Math.abs(sum - 1.0) < 0.01, `sum was ${sum}`);
});

test('poissonPmf: peaks near lambda', () => {
  // For lambda=3, mode should be at k=2 or k=3
  const p2 = poissonPmf(2, 3);
  const p3 = poissonPmf(3, 3);
  const p0 = poissonPmf(0, 3);
  const p6 = poissonPmf(6, 3);
  assert.ok(p2 > p0);
  assert.ok(p3 > p6);
});

test('homeWinProbabilityFromLambdas: equal lambdas give ~50%', () => {
  const p = homeWinProbabilityFromLambdas(3.0, 3.0, 0);
  assert.ok(Math.abs(p - 0.5) < 0.02, `expected ~0.50, got ${p}`);
});

test('homeWinProbabilityFromLambdas: higher home lambda gives home advantage', () => {
  const p = homeWinProbabilityFromLambdas(3.5, 2.5, 0);
  assert.ok(p > 0.55, `expected home favorite, got ${p}`);
  assert.ok(p < 0.75, `sanity upper bound, got ${p}`);
});

test('homeWinProbabilityFromLambdas: OT edge shifts ties toward home', () => {
  const pNoEdge = homeWinProbabilityFromLambdas(3.0, 3.0, 0);
  const pWithEdge = homeWinProbabilityFromLambdas(3.0, 3.0, 0.05);
  assert.ok(pWithEdge > pNoEdge, 'OT edge should lift home prob');
});

test('homeWinProbabilityFromLambdas: clamped to [0.05, 0.95]', () => {
  // Extreme case: very high away lambda
  const pLow = homeWinProbabilityFromLambdas(0.5, 10, 0);
  assert.ok(pLow >= 0.05);
  const pHigh = homeWinProbabilityFromLambdas(10, 0.5, 0);
  assert.ok(pHigh <= 0.95);
});

// ---------------------------------------------------------------------------
// Adjustment function tests
// ---------------------------------------------------------------------------

test('computeRoundHomeIceAdvantage: G7 has strongest boost', () => {
  const r1g1 = computeRoundHomeIceAdvantage({ round: 1 }, 1);
  const r1g7 = computeRoundHomeIceAdvantage({ round: 1 }, 7);
  const r2g4 = computeRoundHomeIceAdvantage({ round: 2 }, 4);
  assert.ok(r1g7.homeLambdaBoost > r1g1.homeLambdaBoost);
  assert.ok(r1g7.homeLambdaBoost > r2g4.homeLambdaBoost);
});

test('computeRoundHomeIceAdvantage: R1 > R2 non-G7', () => {
  const r1 = computeRoundHomeIceAdvantage({ round: 1 }, 3);
  const r2 = computeRoundHomeIceAdvantage({ round: 2 }, 3);
  assert.ok(r1.homeLambdaBoost > r2.homeLambdaBoost);
});

test('computeZigZagAdjustment: team coming off loss gets boost', () => {
  const state = {
    gamesPlayed: [{ gameNum: 3, winner: 'TOR', venue: 'TOR' }],
  };
  const adj = computeZigZagAdjustment('BOS', 'TOR', state);
  assert.ok(adj.homeBoost > 0, 'BOS just lost, should get boost');
  assert.equal(adj.awayBoost, 0, 'TOR just won, no boost');
});

test('computeZigZagAdjustment: no games played, no boost', () => {
  const adj = computeZigZagAdjustment('BOS', 'TOR', { gamesPlayed: [] });
  assert.equal(adj.homeBoost, 0);
  assert.equal(adj.awayBoost, 0);
});

test('computeEliminationBoost: team at 3 wins against gets boost', () => {
  const state = { teamA: 'BOS', teamB: 'TOR', winsA: 3, winsB: 2 };
  const adj = computeEliminationBoost('TOR', 'BOS', state);
  assert.ok(adj.homeBoost > 0, 'TOR facing elim at home should get boost');
});

test('computeEliminationBoost: no boost if neither team at 3', () => {
  const state = { teamA: 'BOS', teamB: 'TOR', winsA: 2, winsB: 1 };
  const adj = computeEliminationBoost('TOR', 'BOS', state);
  assert.equal(adj.homeBoost, 0);
  assert.equal(adj.awayBoost, 0);
});

test('computeSpecialTeamsMultiplier: league average teams return ~1.0', () => {
  const team = { pp_pct: LEAGUE_AVG_PP_PCT };
  const opp = { pp_pct: LEAGUE_AVG_PP_PCT };
  const mult = computeSpecialTeamsMultiplier(team, opp);
  assert.ok(Math.abs(mult - 1.0) < 0.005);
});

test('computeSpecialTeamsMultiplier: elite PP team scores more', () => {
  const team = { pp_pct: 0.28 }; // well above average
  const opp = { pp_pct: 0.205 };
  const mult = computeSpecialTeamsMultiplier(team, opp);
  assert.ok(mult > 1.01, `elite PP should boost lambda, got ${mult}`);
});

test('computeSpecialTeamsMultiplier: null PP falls back to league avg', () => {
  const team = { pp_pct: null };
  const opp = { pp_pct: null };
  const mult = computeSpecialTeamsMultiplier(team, opp);
  assert.ok(Math.abs(mult - 1.0) < 0.005);
});

// ---------------------------------------------------------------------------
// Integration tests: build a model and run predictions
// ---------------------------------------------------------------------------

test('buildPerGameModelGoals: produces valid prediction for mid-season', () => {
  const features = {
    BOS: {
      goals_for_per_game: 3.8, goals_against_per_game: 2.2,
      pp_pct: 0.21, default_goalie_id: 'G-BOS',
    },
    TOR: {
      goals_for_per_game: 3.4, goals_against_per_game: 2.7,
      pp_pct: 0.24, default_goalie_id: 'G-TOR',
    },
  };
  const model = buildPerGameModelGoals({ teamFeatures: features });
  const out = model({
    homeTeam: 'BOS', awayTeam: 'TOR', gameNum: 3,
    seriesState: { teamA: 'BOS', teamB: 'TOR', winsA: 1, winsB: 1, round: 1,
      gamesPlayed: [{ gameNum: 2, winner: 'TOR', venue: 'BOS' }] },
  });

  assert.ok(out.homeWinProb > 0.05 && out.homeWinProb < 0.95);
  assert.equal(out.modelVariant, 'goals');
  assert.ok(out.expectedTotalGoals > 3.0 && out.expectedTotalGoals < 9.0,
    `expected 3-9 goals, got ${out.expectedTotalGoals}`);
  assert.ok(out.homeLambda > 0);
  assert.ok(out.awayLambda > 0);
});

test('buildPerGameModelGoals: BOS strong home favorite vs weak away', () => {
  const features = {
    BOS: {
      goals_for_per_game: 4.2, goals_against_per_game: 1.8,
      pp_pct: 0.26, default_goalie_id: 'G-BOS',
    },
    TOR: {
      goals_for_per_game: 2.6, goals_against_per_game: 3.4,
      pp_pct: 0.18, default_goalie_id: 'G-TOR',
    },
  };
  const model = buildPerGameModelGoals({ teamFeatures: features });
  const out = model({
    homeTeam: 'BOS', awayTeam: 'TOR', gameNum: 1,
    seriesState: { teamA: 'BOS', teamB: 'TOR', winsA: 0, winsB: 0, round: 1,
      gamesPlayed: [] },
  });
  assert.ok(out.homeWinProb > 0.65, `strong BOS home favorite, got ${out.homeWinProb}`);
});

test('buildPerGameModelGoals: elimination boost visible', () => {
  const features = {
    LAK: {
      goals_for_per_game: 3.0, goals_against_per_game: 2.8,
      pp_pct: 0.20, default_goalie_id: 'G-LAK',
    },
    COL: {
      goals_for_per_game: 3.5, goals_against_per_game: 2.5,
      pp_pct: 0.23, default_goalie_id: 'G-COL',
    },
  };
  const model = buildPerGameModelGoals({ teamFeatures: features });

  // LAK home facing elimination
  const p1 = model({
    homeTeam: 'LAK', awayTeam: 'COL', gameNum: 6,
    seriesState: { teamA: 'COL', teamB: 'LAK', winsA: 3, winsB: 2, round: 1,
      gamesPlayed: [{ gameNum: 5, winner: 'COL', venue: 'COL' }] },
  });
  // LAK home tied 1-1
  const p2 = model({
    homeTeam: 'LAK', awayTeam: 'COL', gameNum: 3,
    seriesState: { teamA: 'COL', teamB: 'LAK', winsA: 1, winsB: 1, round: 1,
      gamesPlayed: [{ gameNum: 2, winner: 'COL', venue: 'COL' }] },
  });

  assert.ok(p1.homeWinProb > p2.homeWinProb,
    `elimination boost should lift LAK home prob: p1=${p1.homeWinProb} p2=${p2.homeWinProb}`);
});

test('buildPerGameModelGoals: goalie quality multiplier works', () => {
  const features = {
    BOS: {
      goals_for_per_game: 3.0, goals_against_per_game: 3.0,
      pp_pct: 0.205, default_goalie_id: 'G-BOS',
    },
    TOR: {
      goals_for_per_game: 3.0, goals_against_per_game: 3.0,
      pp_pct: 0.205, default_goalie_id: 'G-TOR',
    },
  };
  // Equal teams, equal goalies -> ~50% (slight HIA + travel)
  const modelEqual = buildPerGameModelGoals({ teamFeatures: features });
  const pEqual = modelEqual({
    homeTeam: 'BOS', awayTeam: 'TOR', gameNum: 1,
    seriesState: { teamA: 'BOS', teamB: 'TOR', winsA: 0, winsB: 0, round: 1,
      gamesPlayed: [] },
  });

  // Give BOS an elite goalie: higher quality = lower opposing lambda = higher BOS win prob
  const modelEliteBosGoalie = buildPerGameModelGoals({
    teamFeatures: features,
    goalieFeatures: { 'G-BOS': { quality: 1.15 } },
  });
  const pBosElite = modelEliteBosGoalie({
    homeTeam: 'BOS', awayTeam: 'TOR', gameNum: 1,
    seriesState: { teamA: 'BOS', teamB: 'TOR', winsA: 0, winsB: 0, round: 1,
      gamesPlayed: [] },
  });

  assert.ok(pBosElite.homeWinProb > pEqual.homeWinProb,
    `elite goalie should boost BOS: elite=${pBosElite.homeWinProb} equal=${pEqual.homeWinProb}`);
});

test('buildPerGameModelGoals: throws on missing team features', () => {
  const features = { BOS: { goals_for_per_game: 3.0, goals_against_per_game: 3.0, pp_pct: 0.2 } };
  const model = buildPerGameModelGoals({ teamFeatures: features });
  assert.throws(() => {
    model({
      homeTeam: 'BOS', awayTeam: 'NONEXISTENT', gameNum: 1,
      seriesState: { teamA: 'BOS', teamB: 'NONEXISTENT', winsA: 0, winsB: 0, round: 1,
        gamesPlayed: [] },
    });
  }, /No features for/);
});

test('buildPerGameModelGoals: throws when no teamFeatures provided', () => {
  assert.throws(() => buildPerGameModelGoals({}), /requires teamFeatures/);
});
