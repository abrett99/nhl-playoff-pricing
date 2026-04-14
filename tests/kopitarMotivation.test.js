// ============================================================================
// KOPITAR MOTIVATION TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  kopitarMotivationAdjustment,
  isKopitarAdjustmentActive,
  ELIMINATION_BUMP,
} from '../src/features/kopitarMotivation.js';

// ============================================================================
// Adjustment
// ============================================================================

test('kopitarMotivation: no adjustment when LAK not in series', () => {
  const adj = kopitarMotivationAdjustment({
    homeTeam: 'EDM', awayTeam: 'ANA',
    seriesState: { teamA: 'EDM', teamB: 'ANA', winsA: 0, winsB: 3 },
  });
  assert.equal(adj, 0);
});

test('kopitarMotivation: no adjustment when LAK is winning', () => {
  const adj = kopitarMotivationAdjustment({
    homeTeam: 'LAK', awayTeam: 'COL',
    seriesState: { teamA: 'COL', teamB: 'LAK', winsA: 0, winsB: 3 },
  });
  assert.equal(adj, 0);
});

test('kopitarMotivation: no adjustment when series is even', () => {
  const adj = kopitarMotivationAdjustment({
    homeTeam: 'LAK', awayTeam: 'COL',
    seriesState: { teamA: 'COL', teamB: 'LAK', winsA: 2, winsB: 2 },
  });
  assert.equal(adj, 0);
});

test('kopitarMotivation: LAK home, facing elimination → +bump', () => {
  const adj = kopitarMotivationAdjustment({
    homeTeam: 'LAK', awayTeam: 'COL',
    seriesState: { teamA: 'COL', teamB: 'LAK', winsA: 3, winsB: 2 },
  });
  assert.equal(adj, ELIMINATION_BUMP);
});

test('kopitarMotivation: LAK away, facing elimination → -bump (lowers opponent home-win-prob)', () => {
  const adj = kopitarMotivationAdjustment({
    homeTeam: 'COL', awayTeam: 'LAK',
    seriesState: { teamA: 'COL', teamB: 'LAK', winsA: 3, winsB: 2 },
  });
  assert.equal(adj, -ELIMINATION_BUMP);
});

test('kopitarMotivation: LAK as teamA (top seed role) also gets adjustment', () => {
  const adj = kopitarMotivationAdjustment({
    homeTeam: 'LAK', awayTeam: 'VGK',
    seriesState: { teamA: 'LAK', teamB: 'VGK', winsA: 0, winsB: 3 },
  });
  assert.equal(adj, ELIMINATION_BUMP);
});

test('kopitarMotivation: no bump when both teams at 3 wins (someone loses in G7 anyway)', () => {
  const adj = kopitarMotivationAdjustment({
    homeTeam: 'LAK', awayTeam: 'COL',
    seriesState: { teamA: 'COL', teamB: 'LAK', winsA: 3, winsB: 3 },
  });
  assert.equal(adj, 0);
});

// ============================================================================
// isKopitarAdjustmentActive
// ============================================================================

test('isKopitarAdjustmentActive: false when no LAK in series', () => {
  assert.equal(isKopitarAdjustmentActive({ teamA: 'EDM', teamB: 'ANA', winsA: 0, winsB: 3 }), false);
});

test('isKopitarAdjustmentActive: true when LAK facing elimination', () => {
  assert.equal(isKopitarAdjustmentActive({ teamA: 'COL', teamB: 'LAK', winsA: 3, winsB: 1 }), true);
});

test('isKopitarAdjustmentActive: handles null state', () => {
  assert.equal(isKopitarAdjustmentActive(null), false);
  assert.equal(isKopitarAdjustmentActive(undefined), false);
});
