// ============================================================================
// SAVED SCENARIOS TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createScenario,
  checkExpiration,
  evaluateScenario,
} from '../src/scenarios/savedScenarios.js';

// ============================================================================
// createScenario
// ============================================================================

test('createScenario: populates defaults and generates ID if not provided', () => {
  const s = createScenario({
    label: 'If Woll starts G4',
    seriesId: '2025-R1-M1',
    overrides: { goalieOverrides: { perTeam: { TOR: 8476412 } } },
  });
  assert.ok(s.scenarioId);
  assert.equal(s.label, 'If Woll starts G4');
  assert.equal(s.status, 'active');
  assert.equal(s.triggerEdgeMin, 0.05);
  assert.deepEqual(s.history, []);
});

test('createScenario: slug in ID is URL-safe', () => {
  const s = createScenario({
    label: 'Oilers "dominate" Round 1!',
    seriesId: 'T',
  });
  assert.ok(!/[^a-zA-Z0-9_\-:Z]/.test(s.scenarioId.slice(22))); // Everything after timestamp
});

// ============================================================================
// checkExpiration
// ============================================================================

test('checkExpiration: series complete → expired', () => {
  const scenario = createScenario({ label: 'X', seriesId: 'T' });
  const state = {
    status: 'complete',
    seriesWinner: 'BOS',
    gamesPlayed: [],
  };
  const result = checkExpiration(scenario, state);
  assert.equal(result.expired, true);
  assert.ok(result.reason.includes('Series ended'));
});

test('checkExpiration: gameOutcomes override contradicted by actual result', () => {
  const scenario = createScenario({
    label: 'G3 TOR wins',
    seriesId: 'T',
    overrides: { gameOutcomes: { 3: 'TOR' } },
  });
  const state = {
    status: 'active',
    gamesPlayed: [
      { gameNum: 1, winner: 'BOS' },
      { gameNum: 2, winner: 'TOR' },
      { gameNum: 3, winner: 'BOS' }, // scenario required TOR here
    ],
  };
  const result = checkExpiration(scenario, state);
  assert.equal(result.expired, true);
  assert.ok(result.reason.includes('G3'));
});

test('checkExpiration: gameOutcomes override not yet contradicted', () => {
  const scenario = createScenario({
    label: 'G4 TOR wins',
    seriesId: 'T',
    overrides: { gameOutcomes: { 4: 'TOR' } },
  });
  const state = {
    status: 'active',
    gamesPlayed: [
      { gameNum: 1, winner: 'BOS' },
    ],
  };
  assert.equal(checkExpiration(scenario, state).expired, false);
});

test('checkExpiration: skip overrides do not cause false expiration', () => {
  const scenario = createScenario({
    label: 'G3 anything',
    seriesId: 'T',
    overrides: { gameOutcomes: { 3: 'skip' } },
  });
  const state = {
    status: 'active',
    gamesPlayed: [
      { gameNum: 1, winner: 'BOS' },
      { gameNum: 2, winner: 'TOR' },
      { gameNum: 3, winner: 'BOS' },
    ],
  };
  assert.equal(checkExpiration(scenario, state).expired, false);
});

test('checkExpiration: no state means no expiration', () => {
  const scenario = createScenario({ label: 'X', seriesId: 'T' });
  assert.equal(checkExpiration(scenario, null).expired, false);
});

// ============================================================================
// evaluateScenario
// ============================================================================

test('evaluateScenario: fires alert when edge crosses threshold', () => {
  const scenario = createScenario({
    label: 'Hot goalie scenario',
    seriesId: 'T',
    triggerMarket: 'seriesWinner',
    triggerSide: 'TOR',
    triggerEdgeMin: 0.05,
  });
  const seriesState = { status: 'active', gamesPlayed: [], teamA: 'BOS', teamB: 'TOR' };
  // Simulated MC: model thinks TOR has 40% chance to win
  const simulateFn = () => ({
    seriesWinner: { BOS: { prob: 0.60 }, TOR: { prob: 0.40 } },
  });
  // Book offers TOR at +200 → implied 33.3%, model says 40% → edge = 40/33.3 - 1 ≈ 20%
  const bookPrices = { seriesWinner: { BOS: -200, TOR: +200 } };

  const result = evaluateScenario({ scenario, seriesState, simulateFn, bookPrices });
  assert.equal(result.shouldAlert, true);
  assert.ok(result.edge > 0.1);
  assert.equal(result.scenario.status, 'triggered');
  assert.ok(result.scenario.triggeredAt);
});

test('evaluateScenario: does not fire when edge below threshold', () => {
  const scenario = createScenario({
    label: 'Small edge',
    seriesId: 'T',
    triggerMarket: 'over55',
    triggerEdgeMin: 0.10,
  });
  const simulateFn = () => ({
    totalGames: { over55: { prob: 0.52 } },
  });
  const bookPrices = { over55: -110 }; // implied 52.4%, model 52% → barely negative edge
  const result = evaluateScenario({
    scenario,
    seriesState: { status: 'active', gamesPlayed: [] },
    simulateFn,
    bookPrices,
  });
  assert.equal(result.shouldAlert, false);
  assert.equal(result.scenario.status, 'active');
});

test('evaluateScenario: expired scenario stops evaluating', () => {
  const scenario = createScenario({
    label: 'G3 TOR',
    seriesId: 'T',
    overrides: { gameOutcomes: { 3: 'TOR' } },
    triggerMarket: 'seriesWinner',
    triggerSide: 'TOR',
  });
  const seriesState = {
    status: 'active',
    gamesPlayed: [
      { gameNum: 1, winner: 'BOS' },
      { gameNum: 2, winner: 'BOS' },
      { gameNum: 3, winner: 'BOS' }, // scenario required TOR
    ],
  };
  const simulateFn = () => { throw new Error('Should not be called'); };
  const result = evaluateScenario({
    scenario,
    seriesState,
    simulateFn,
    bookPrices: {},
  });
  assert.equal(result.scenario.status, 'expired');
  assert.equal(result.shouldAlert, false);
});

test('evaluateScenario: records history of evaluations', () => {
  const scenario = createScenario({
    label: 'Track me',
    seriesId: 'T',
    triggerMarket: 'over55',
    triggerEdgeMin: 0.99, // never fires
  });
  const simulateFn = () => ({ totalGames: { over55: { prob: 0.55 } } });
  const bookPrices = { over55: -110 };
  const seriesState = { status: 'active', gamesPlayed: [] };

  let s = scenario;
  for (let i = 0; i < 3; i++) {
    const r = evaluateScenario({ scenario: s, seriesState, simulateFn, bookPrices });
    s = r.scenario;
  }
  assert.equal(s.history.length, 3);
  assert.ok(s.history.every(h => typeof h.edge === 'number'));
});

test('evaluateScenario: already-triggered scenario does not re-trigger', () => {
  const scenario = {
    ...createScenario({
      label: 'One-shot',
      seriesId: 'T',
      triggerMarket: 'over55',
      triggerEdgeMin: 0.05,
    }),
    status: 'triggered',
    triggeredAt: '2026-04-14T00:00:00Z',
  };
  const simulateFn = () => ({ totalGames: { over55: { prob: 0.80 } } });
  const bookPrices = { over55: -110 };

  const result = evaluateScenario({
    scenario,
    seriesState: { status: 'active', gamesPlayed: [] },
    simulateFn,
    bookPrices,
  });
  assert.equal(result.shouldAlert, false);
  assert.equal(result.scenario.status, 'triggered'); // remains triggered
});
