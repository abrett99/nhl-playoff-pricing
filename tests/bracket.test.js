// ============================================================================
// BRACKET PROGRESSION TESTS
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Pre-create a temp directory to isolate state files for this test run
const ORIGINAL_CWD = process.cwd();
let TEMP_DIR;

before(async () => {
  TEMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'bracket-test-'));
  await fs.mkdir(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true });
  process.chdir(TEMP_DIR);
});

after(async () => {
  process.chdir(ORIGINAL_CWD);
  await fs.rm(TEMP_DIR, { recursive: true, force: true });
});

// Lazy imports so they pick up the new cwd
let findReadyAdvancements, createNextRoundSeries, summarizeBracket, BRACKET_2026;
let saveState, loadState;

async function importModules() {
  ({ findReadyAdvancements, createNextRoundSeries, summarizeBracket, BRACKET_2026 } =
    await import('../src/state/bracket.js?v=' + Date.now()));
  ({ saveState, loadState } =
    await import('../src/state/series.js?v=' + Date.now()));
}

// ============================================================================
// Helpers
// ============================================================================

function mockCompleteSeries({ seriesId, teamA, teamB, winner, round = 1, seedPoints = {} }) {
  return {
    seriesId,
    round,
    teamA,
    teamB,
    winsA: winner === teamA ? 4 : 0,
    winsB: winner === teamB ? 4 : 0,
    status: 'complete',
    seriesWinner: winner,
    currentStarters: {
      [teamA]: { playerId: 1001, name: `${teamA} Goalie`, confirmed: true, since: 'G1' },
      [teamB]: { playerId: 1002, name: `${teamB} Goalie`, confirmed: true, since: 'G1' },
    },
    gamesPlayed: [
      { gameNum: 1, winner, venue: teamA, goals: [4, 1] },
      { gameNum: 2, winner, venue: teamA, goals: [3, 2] },
      { gameNum: 3, winner, venue: teamB, goals: [2, 1] },
      { gameNum: 4, winner, venue: teamB, goals: [5, 2] },
    ],
    metadata: { seedPoints },
    createdAt: '2026-04-18T00:00:00Z',
    lastUpdated: '2026-04-25T00:00:00Z',
  };
}

// ============================================================================
// Tests
// ============================================================================

test('findReadyAdvancements: returns empty when no R1 series complete', async () => {
  await importModules();
  const ready = await findReadyAdvancements();
  assert.equal(ready.length, 0);
});

test('findReadyAdvancements: returns empty when only one parent complete', async () => {
  await importModules();
  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-E1', teamA: 'BUF', teamB: 'BOS', winner: 'BUF',
  }));
  const ready = await findReadyAdvancements();
  assert.equal(ready.length, 0);
});

test('findReadyAdvancements: returns advancement when both parents complete', async () => {
  await importModules();
  // Clean start
  await fs.rm(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true, force: true });
  await fs.mkdir(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true });

  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-E1', teamA: 'BUF', teamB: 'BOS', winner: 'BUF',
    seedPoints: { BUF: 108, BOS: 98 },
  }));
  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-E2', teamA: 'TBL', teamB: 'MTL', winner: 'TBL',
    seedPoints: { TBL: 97, MTL: 95 },
  }));

  const ready = await findReadyAdvancements();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].childId, '2025-R2-E1');
  // BUF has 108 points, TBL has 97 → BUF gets home ice
  assert.equal(ready[0].proposedTeamA, 'BUF');
  assert.equal(ready[0].proposedTeamB, 'TBL');
});

test('findReadyAdvancements: home-ice determination via seed points', async () => {
  await importModules();
  await fs.rm(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true, force: true });
  await fs.mkdir(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true });

  // Lower-seeded team wins R1 but has fewer points than the other R1 winner
  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-W3', teamA: 'VGK', teamB: 'UTA', winner: 'UTA',
    seedPoints: { VGK: 91, UTA: 90 },
  }));
  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-W4', teamA: 'EDM', teamB: 'ANA', winner: 'EDM',
    seedPoints: { EDM: 91, ANA: 90 },
  }));

  const ready = await findReadyAdvancements();
  assert.equal(ready.length, 1);
  // EDM (91) > UTA (90) → EDM gets home ice
  assert.equal(ready[0].proposedTeamA, 'EDM');
  assert.equal(ready[0].proposedTeamB, 'UTA');
});

test('createNextRoundSeries: produces valid R2 state with parent metadata', async () => {
  await importModules();
  await fs.rm(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true, force: true });
  await fs.mkdir(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true });

  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-M1', teamA: 'COL', teamB: 'LAK', winner: 'COL',
    seedPoints: { COL: 115, LAK: 89 },
  }));
  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-M2', teamA: 'DAL', teamB: 'MIN', winner: 'DAL',
    seedPoints: { DAL: 105, MIN: 95 },
  }));

  // Register a temporary bracket that uses these parents
  const bracket = {
    '2025-R2-W1': {
      parents: ['2025-R1-M1', '2025-R1-M2'],
      conference: 'WEST', round: 2, label: 'Central R2',
    },
  };

  const ready = await findReadyAdvancements(bracket);
  assert.equal(ready.length, 1);

  const newState = await createNextRoundSeries(ready[0]);
  assert.equal(newState.seriesId, '2025-R2-W1');
  assert.equal(newState.teamA, 'COL');  // COL has more points (115 vs 105)
  assert.equal(newState.teamB, 'DAL');
  assert.equal(newState.round, 2);
  assert.equal(newState.metadata.conference, 'WEST');
  assert.deepEqual(newState.metadata.parents, ['2025-R1-M1', '2025-R1-M2']);
  // Winning goalies from parents should be preserved
  assert.ok(newState.currentStarters.COL);
  assert.ok(newState.currentStarters.DAL);

  // Subsequent findReady should not re-produce this advancement
  const again = await findReadyAdvancements(bracket);
  assert.equal(again.length, 0);
});

test('summarizeBracket: reports per-round counts and pending list', async () => {
  await importModules();
  await fs.rm(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true, force: true });
  await fs.mkdir(path.join(TEMP_DIR, 'data', 'derived', 'series_state'), { recursive: true });

  await saveState(mockCompleteSeries({
    seriesId: '2025-R1-E1', teamA: 'BUF', teamB: 'BOS', winner: 'BUF',
  }));

  const summary = await summarizeBracket();
  assert.equal(summary.byRound[1].length, 1);
  // E1 is done but E2 isn't, so R2-E1 is pending with only 1 parent complete
  const r2e1 = summary.pending.find(p => p.childId === '2025-R2-E1');
  assert.ok(r2e1);
  assert.equal(r2e1.readyToCreate, false);
  assert.deepEqual(r2e1.parentsComplete, [true, false]);
});

test('BRACKET_2026 topology: SCF parents are both CF series', async () => {
  await importModules();
  const scf = BRACKET_2026['2025-R4-1'];
  assert.deepEqual(scf.parents, ['2025-R3-E1', '2025-R3-W1']);
  assert.equal(scf.round, 4);
});
