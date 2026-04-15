import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  streamHistorical,
  loadFiltered,
  getSeasons,
  isNhlGame,
  DEFAULT_CSV_PATH,
} from '../src/ingest/kaggle/historicalLoader.js';

// All tests below require the Kaggle CSV to be present. If not, skip.
const CSV_AVAILABLE = existsSync(DEFAULT_CSV_PATH);

test('streamHistorical: yields rows with expected shape', { skip: !CSV_AVAILABLE }, async () => {
  let first = null;
  let count = 0;
  await streamHistorical({
    onRow: (row) => {
      if (!first) first = row;
      count++;
    },
  });

  assert.ok(count > 50000, `expected >50000 rows, got ${count}`);
  assert.ok(first, 'should yield at least one row');

  // Core columns present
  assert.ok('game_id' in first, 'missing game_id');
  assert.ok('date' in first, 'missing date');
  assert.ok('season' in first, 'missing season');
  assert.ok('team_name' in first, 'missing team_name');
  assert.ok('is_home' in first, 'missing is_home');
  assert.ok('won' in first, 'missing won');
  assert.ok('goals_for' in first, 'missing goals_for');
  assert.ok('goals_against' in first, 'missing goals_against');
  assert.ok('pre_game_point_pct' in first, 'missing pre_game_point_pct');

  // Derived columns added by enrichRow
  assert.ok('team_abbrev' in first, 'missing team_abbrev');
  assert.ok('opp_team_abbrev' in first, 'missing opp_team_abbrev');
});

test('streamHistorical: type coercion works correctly', { skip: !CSV_AVAILABLE }, async () => {
  let row = null;
  await streamHistorical({
    filter: (r) => r.season === 2023 && row === null,
    onRow: (r) => { if (!row) row = r; },
  });

  assert.ok(row, 'should find at least one 2023 row');

  // Ints
  assert.equal(typeof row.game_id, 'number');
  assert.equal(typeof row.season, 'number');
  assert.equal(typeof row.is_home, 'number');
  assert.equal(typeof row.won, 'number');
  assert.equal(typeof row.goals_for, 'number');

  // Floats
  assert.equal(typeof row.pre_game_point_pct, 'number');

  // Strings
  assert.equal(typeof row.team_name, 'string');
  assert.equal(typeof row.date, 'string');

  // Team abbrev was derived (NHL teams only)
  assert.equal(typeof row.team_abbrev, 'string');
  assert.equal(row.team_abbrev.length, 3);
});

test('streamHistorical: filter skips unwanted rows', { skip: !CSV_AVAILABLE }, async () => {
  let count = 0;
  await streamHistorical({
    filter: (row) => row.season === 2022 && isNhlGame(row),
    onRow: () => count++,
  });

  assert.ok(count > 2000, `expected >2000 NHL rows for 2022, got ${count}`);
  assert.ok(count < 3500, `expected <3500 NHL rows for 2022, got ${count}`);
});

test('streamHistorical: returns accurate counts', { skip: !CSV_AVAILABLE }, async () => {
  const result = await streamHistorical({
    filter: (row) => row.season === 2023 && isNhlGame(row),
    onRow: () => {},
  });

  assert.ok(result.total > 50000, 'total should be full dataset size');
  assert.ok(result.kept > 2000, 'kept should be ~1 NHL season worth');
  assert.ok(result.kept < result.total, 'kept must be < total with filter');
});

test('loadFiltered: returns array of matching rows', { skip: !CSV_AVAILABLE }, async () => {
  const rows = await loadFiltered(
    (row) => row.season === 2023 && row.team_abbrev === 'BOS' && isNhlGame(row)
  );
  assert.ok(rows.length >= 80, `expected ~82 BOS games in 2023, got ${rows.length}`);
  assert.ok(rows.every(r => r.team_abbrev === 'BOS'));
  assert.ok(rows.every(r => r.season === 2023));
});

test('getSeasons: returns ordered list of seasons', { skip: !CSV_AVAILABLE }, async () => {
  const seasons = await getSeasons();
  assert.ok(seasons.length >= 18, `expected 18+ seasons, got ${seasons.length}`);
  assert.equal(seasons[0], Math.min(...seasons), 'first should be min');
  assert.ok(seasons.includes(2023), 'should include 2023');
});

test('isNhlGame: distinguishes NHL from exhibition games', { skip: !CSV_AVAILABLE }, async () => {
  let nhlCount = 0;
  let exhibitionCount = 0;
  const exhibitionExamples = new Set();

  await streamHistorical({
    onRow: (row) => {
      if (isNhlGame(row)) {
        nhlCount++;
      } else {
        exhibitionCount++;
        if (row.team_name && !row.team_abbrev) exhibitionExamples.add(row.team_name);
        if (row.opp_team_name && !row.opp_team_abbrev) exhibitionExamples.add(row.opp_team_name);
      }
    },
  });

  // Dataset should be overwhelmingly NHL
  assert.ok(nhlCount > 50000, `expected >50000 NHL rows, got ${nhlCount}`);
  // Non-NHL should exist but be a small fraction
  assert.ok(exhibitionCount > 0, 'expected to find some non-NHL games');
  assert.ok(exhibitionCount < nhlCount * 0.05, 'non-NHL should be <5% of dataset');

  // Sanity: some expected non-NHL teams should appear
  const exhibitionTeamsList = [...exhibitionExamples].join(',');
  assert.ok(
    /Berlin|Davos|Jokerit|Canada|USA|Mannheim|Frolunda/.test(exhibitionTeamsList),
    `expected European/national team names in exhibitions, got: ${exhibitionTeamsList.slice(0, 200)}`
  );
});

test('NHL rows have valid team abbrevs in correct format', { skip: !CSV_AVAILABLE }, async () => {
  let checked = 0;
  let violations = 0;
  await streamHistorical({
    filter: isNhlGame,
    onRow: (row) => {
      checked++;
      if (!row.team_abbrev || row.team_abbrev.length !== 3) violations++;
      if (!row.opp_team_abbrev || row.opp_team_abbrev.length !== 3) violations++;
    },
  });

  assert.ok(checked > 50000, `sanity check: checked ${checked} NHL rows`);
  assert.equal(violations, 0, `${violations} NHL rows had invalid team abbrevs`);
});

test('Anaheim Mighty Ducks resolves to ANA', { skip: !CSV_AVAILABLE }, async () => {
  let found = false;
  await streamHistorical({
    filter: (row) => row.team_name === 'Anaheim Mighty Ducks' && !found,
    onRow: (row) => {
      found = true;
      assert.equal(row.team_abbrev, 'ANA', 'Mighty Ducks should map to ANA');
    },
  });
  assert.ok(found, 'dataset should contain at least one Mighty Ducks row');
});

