// ============================================================================
// SERIES STATE MACHINE TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSeries,
  ingestGameResult,
  updateGoalie,
  remainingVenues,
  nextGameInfo,
  validateState,
} from '../src/state/series.js';

function makeRosterGoalies() {
  return {
    BOS: [
      { playerId: 8475167, name: 'Swayman' },
      { playerId: 8476326, name: 'Korpisalo' },
    ],
    TOR: [
      { playerId: 8477964, name: 'Stolarz' },
      { playerId: 8476412, name: 'Woll' },
    ],
  };
}

function makeSeries() {
  return createSeries({
    seriesId: '2025-R1-M1',
    round: 1,
    matchup: 1,
    teamA: 'BOS',
    teamB: 'TOR',
    rosterGoalies: makeRosterGoalies(),
  });
}

// ============================================================================
// Creation
// ============================================================================

test('createSeries: initializes with 0-0 and active status', () => {
  const s = makeSeries();
  assert.equal(s.winsA, 0);
  assert.equal(s.winsB, 0);
  assert.equal(s.status, 'active');
  assert.equal(s.seriesWinner, null);
  assert.equal(s.gamesPlayed.length, 0);
  assert.equal(s.currentStarters.BOS.name, 'Swayman');
  assert.equal(s.currentStarters.TOR.name, 'Stolarz');
});

test('createSeries: validates input', () => {
  assert.throws(() => createSeries({
    seriesId: 'TEST', round: 1, matchup: 1,
    teamA: 'BOS', teamB: 'BOS',
    rosterGoalies: makeRosterGoalies(),
  }));
});

// ============================================================================
// Game ingestion
// ============================================================================

test('ingestGameResult: advances wins correctly', () => {
  let s = makeSeries();

  // Game 1 at BOS, BOS wins
  s = ingestGameResult(s, {
    gameId: '2025030111',  // 2025-26, playoff, R1, M1, G1
    homeTeam: 'BOS',
    awayTeam: 'TOR',
    winner: 'BOS',
    goals: [2, 3],
    ot: false,
    date: '2026-04-20T19:00:00Z',
  });
  assert.equal(s.winsA, 1);
  assert.equal(s.winsB, 0);
  assert.equal(s.gamesPlayed.length, 1);
  assert.equal(s.status, 'active');
});

test('ingestGameResult: rejects wrong game number', () => {
  const s = makeSeries();
  assert.throws(() => ingestGameResult(s, {
    gameId: '2025030112', // G2 but series hasn't played G1
    homeTeam: 'BOS',
    awayTeam: 'TOR',
    winner: 'BOS',
    goals: [2, 3],
  }));
});

test('ingestGameResult: rejects wrong venue', () => {
  const s = makeSeries();
  // G1 should be at BOS (teamA, has home ice), not TOR
  assert.throws(() => ingestGameResult(s, {
    gameId: '2025030111',
    homeTeam: 'TOR',  // wrong!
    awayTeam: 'BOS',
    winner: 'TOR',
    goals: [3, 2],
  }));
});

test('ingestGameResult: full series to 4-0 sweep', () => {
  let s = makeSeries();

  // G1, G2 at BOS (BOS wins both)
  s = ingestGameResult(s, {
    gameId: '2025030111', homeTeam: 'BOS', awayTeam: 'TOR',
    winner: 'BOS', goals: [2, 4],
  });
  s = ingestGameResult(s, {
    gameId: '2025030112', homeTeam: 'BOS', awayTeam: 'TOR',
    winner: 'BOS', goals: [1, 3],
  });
  // G3, G4 at TOR (BOS wins both)
  s = ingestGameResult(s, {
    gameId: '2025030113', homeTeam: 'TOR', awayTeam: 'BOS',
    winner: 'BOS', goals: [4, 3],
  });
  s = ingestGameResult(s, {
    gameId: '2025030114', homeTeam: 'TOR', awayTeam: 'BOS',
    winner: 'BOS', goals: [5, 2],
  });

  assert.equal(s.status, 'complete');
  assert.equal(s.seriesWinner, 'BOS');
  assert.equal(s.winsA, 4);
  assert.equal(s.winsB, 0);
});

test('ingestGameResult: refuses to add game after completion', () => {
  let s = makeSeries();
  for (let g = 1; g <= 4; g++) {
    s = ingestGameResult(s, {
      gameId: `202503011${g}`,
      homeTeam: g <= 2 ? 'BOS' : 'TOR',
      awayTeam: g <= 2 ? 'TOR' : 'BOS',
      winner: 'BOS',
      goals: [1, 3],
    });
  }
  assert.equal(s.status, 'complete');
  assert.throws(() => ingestGameResult(s, {
    gameId: '2025030115',
    homeTeam: 'BOS', awayTeam: 'TOR',
    winner: 'BOS', goals: [2, 3],
  }));
});

// ============================================================================
// Goalie updates
// ============================================================================

test('updateGoalie: changes starter mid-series', () => {
  let s = makeSeries();
  s = ingestGameResult(s, {
    gameId: '2025030111', homeTeam: 'BOS', awayTeam: 'TOR',
    winner: 'TOR', goals: [5, 1],
  });
  s = updateGoalie(s, 'BOS', {
    playerId: 8476326,
    name: 'Korpisalo',
    confirmed: true,
  });
  assert.equal(s.currentStarters.BOS.name, 'Korpisalo');
  assert.equal(s.currentStarters.BOS.since, 'G2');
  assert.equal(s.currentStarters.BOS.confirmed, true);
});

// ============================================================================
// Venue sequence
// ============================================================================

test('remainingVenues: respects 2-2-1-1-1 from current state', () => {
  let s = makeSeries();

  // Fresh series: all 7 games remaining
  assert.deepEqual(remainingVenues(s),
    ['BOS', 'BOS', 'TOR', 'TOR', 'BOS', 'TOR', 'BOS']);

  // After 2 games at BOS
  s = ingestGameResult(s, {
    gameId: '2025030111', homeTeam: 'BOS', awayTeam: 'TOR',
    winner: 'BOS', goals: [2, 3],
  });
  s = ingestGameResult(s, {
    gameId: '2025030112', homeTeam: 'BOS', awayTeam: 'TOR',
    winner: 'TOR', goals: [3, 2],
  });
  // Remaining: TOR, TOR, BOS, TOR, BOS
  assert.deepEqual(remainingVenues(s), ['TOR', 'TOR', 'BOS', 'TOR', 'BOS']);
});

test('nextGameInfo: returns correct next game during active series', () => {
  const s = makeSeries();
  const next = nextGameInfo(s);
  assert.equal(next.gameNum, 1);
  assert.equal(next.homeTeam, 'BOS');
  assert.equal(next.awayTeam, 'TOR');
  assert.equal(next.venueLetter, 'A');
});

test('nextGameInfo: returns null for completed series', () => {
  let s = makeSeries();
  for (let g = 1; g <= 4; g++) {
    s = ingestGameResult(s, {
      gameId: `202503011${g}`,
      homeTeam: g <= 2 ? 'BOS' : 'TOR',
      awayTeam: g <= 2 ? 'TOR' : 'BOS',
      winner: 'BOS',
      goals: [1, 3],
    });
  }
  assert.equal(nextGameInfo(s), null);
});

// ============================================================================
// State validation
// ============================================================================

test('validateState: catches wins that exceed gamesPlayed', () => {
  assert.throws(() => validateState({
    seriesId: 'T', teamA: 'BOS', teamB: 'TOR',
    winsA: 2, winsB: 1, gamesPlayed: [],
    status: 'active',
  }));
});

test('validateState: complete status requires winner', () => {
  assert.throws(() => validateState({
    seriesId: 'T', teamA: 'BOS', teamB: 'TOR',
    winsA: 4, winsB: 0,
    gamesPlayed: [
      { gameNum: 1, winner: 'BOS', venue: 'BOS', goals: [1, 3] },
      { gameNum: 2, winner: 'BOS', venue: 'BOS', goals: [1, 3] },
      { gameNum: 3, winner: 'BOS', venue: 'TOR', goals: [2, 3] },
      { gameNum: 4, winner: 'BOS', venue: 'TOR', goals: [2, 3] },
    ],
    status: 'complete',
    // missing seriesWinner
  }));
});
