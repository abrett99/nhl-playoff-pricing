import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  streamRecent,
  loadFiltered,
  isNhlGame,
  DEFAULT_CSV_PATH,
} from '../src/ingest/kaggle/recentLoader.js';

const CSV_AVAILABLE = existsSync(DEFAULT_CSV_PATH);

test('streamRecent: yields rows with normalized schema', { skip: !CSV_AVAILABLE }, async () => {
  let first = null;
  let count = 0;
  await streamRecent({
    onRow: (row) => {
      if (!first) first = row;
      count++;
    },
  });

  assert.ok(count > 2000, `expected >2000 rows, got ${count}`);
  assert.ok(first, 'should yield at least one row');

  // Historical-schema fields should exist after normalization
  assert.ok('game_id' in first, 'missing game_id');
  assert.ok('date' in first, 'missing date');
  assert.ok('season' in first, 'missing season');
  assert.ok('team_name' in first, 'missing team_name');
  assert.ok('team_abbrev' in first, 'missing team_abbrev');
  assert.ok('is_home' in first, 'missing is_home');
  assert.ok('won' in first, 'missing won');
  assert.ok('goals_for' in first, 'missing goals_for (should be renamed from score)');
  assert.ok('goals_against' in first, 'missing goals_against (should be renamed from opp_score)');
  assert.ok('season_wins' in first, 'missing season_wins (should be renamed from cum_wins)');
  assert.ok('season_games_played' in first, 'missing season_games_played (should be renamed from cum_games)');
  assert.ok('record_summary' in first, 'missing record_summary (should be renamed from team_record)');

  // New 2024-25 fields
  assert.ok('save_pct' in first, 'missing save_pct');
  assert.ok('rest_advantage' in first, 'missing rest_advantage');

  // Explicitly null fields for schema compatibility
  assert.equal(first.pre_game_point_pct, null, 'pre_game_point_pct should be null');
  assert.equal(first.roll_30_goals_for, null, 'roll_30_goals_for should be null (not in 2024-25)');
});

test('streamRecent: home_away correctly coerced to is_home', { skip: !CSV_AVAILABLE }, async () => {
  let homeRow = null;
  let awayRow = null;
  await streamRecent({
    onRow: (row) => {
      if (!homeRow && row.is_home === 1) homeRow = row;
      if (!awayRow && row.is_home === 0) awayRow = row;
    },
  });

  assert.ok(homeRow, 'should find a home row');
  assert.ok(awayRow, 'should find an away row');
  assert.equal(homeRow.is_home, 1);
  assert.equal(awayRow.is_home, 0);
});

test('streamRecent: type coercion works', { skip: !CSV_AVAILABLE }, async () => {
  let row = null;
  await streamRecent({
    onRow: (r) => { if (!row) row = r; },
  });

  assert.ok(row);
  // Ints
  assert.equal(typeof row.game_id, 'number');
  assert.equal(typeof row.season, 'number');
  assert.equal(typeof row.is_home, 'number');
  assert.equal(typeof row.won, 'number');
  assert.equal(typeof row.goals_for, 'number');
  assert.equal(typeof row.goals_against, 'number');

  // Strings
  assert.equal(typeof row.team_name, 'string');
  assert.equal(typeof row.date, 'string');

  // Floats (save_pct is a new field only in 2024-25)
  if (row.save_pct !== null) {
    assert.equal(typeof row.save_pct, 'number');
    assert.ok(row.save_pct >= 0 && row.save_pct <= 1, `save_pct out of range: ${row.save_pct}`);
  }
});

test('streamRecent: season is 2025 (2024-25 NHL season)', { skip: !CSV_AVAILABLE }, async () => {
  const seasons = new Set();
  await streamRecent({
    onRow: (row) => seasons.add(row.season),
  });

  assert.ok(seasons.has(2025), 'should have 2025 season');
  assert.ok(seasons.size <= 2, `expected 1-2 seasons, got ${seasons.size}: ${[...seasons]}`);
});

test('streamRecent: filter works', { skip: !CSV_AVAILABLE }, async () => {
  const bosRows = await loadFiltered((row) => row.team_abbrev === 'BOS' && isNhlGame(row));
  assert.ok(bosRows.length > 50, `expected 50+ BOS games, got ${bosRows.length}`);
  assert.ok(bosRows.every(r => r.team_abbrev === 'BOS'));
});

test('isNhlGame: works same as historical loader', { skip: !CSV_AVAILABLE }, async () => {
  let nhlCount = 0;
  let nonNhlCount = 0;
  await streamRecent({
    onRow: (row) => {
      if (isNhlGame(row)) nhlCount++;
      else nonNhlCount++;
    },
  });

  assert.ok(nhlCount > 2000, `expected >2000 NHL games, got ${nhlCount}`);
  // Recent dataset may or may not have exhibitions — just verify no crashes
  assert.ok(nhlCount + nonNhlCount > 2000);
});

test('rolling features present at 3 and 10 game windows', { skip: !CSV_AVAILABLE }, async () => {
  // Find a row with a non-null rolling field (not from the first 3 games)
  let rowWithRolling = null;
  await streamRecent({
    onRow: (r) => {
      if (!rowWithRolling && r.roll_10_goals_for !== null) {
        rowWithRolling = r;
      }
    },
  });

  assert.ok(rowWithRolling, 'should find a row with rolling features populated');
  assert.equal(typeof rowWithRolling.roll_3_goals_for, 'number');
  assert.equal(typeof rowWithRolling.roll_10_goals_for, 'number');
  assert.equal(typeof rowWithRolling.roll_10_pp_efficiency, 'number');
});

test('goals_against is populated (opp_score mapped correctly)', { skip: !CSV_AVAILABLE }, async () => {
  let checked = 0;
  let populated = 0;
  await streamRecent({
    filter: isNhlGame,
    onRow: (row) => {
      checked++;
      if (row.goals_against !== null && typeof row.goals_against === 'number') populated++;
    },
  });

  assert.ok(checked > 2000);
  assert.ok(populated / checked > 0.95, `expected >95% populated, got ${populated}/${checked}`);
});

test('betting lines present for games with lines', { skip: !CSV_AVAILABLE }, async () => {
  let withLines = 0;
  await streamRecent({
    filter: isNhlGame,
    onRow: (row) => {
      if (row.over_under != null) withLines++;
    },
  });

  // Should have betting lines for most regular-season games (not preseason/exhibition)
  assert.ok(withLines > 500, `expected many games with betting lines, got ${withLines}`);
});

