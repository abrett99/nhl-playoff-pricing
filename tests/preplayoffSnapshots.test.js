import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  buildHistoricalSnapshots,
  buildRecentSnapshots,
  isRegularSeasonDate,
  extractSnapshot,
  enrichWithSpecialTeams,
} from '../src/features/preplayoffSnapshots.js';
import { DEFAULT_CSV_PATH as HISTORICAL_PATH }
  from '../src/ingest/kaggle/historicalLoader.js';
import { DEFAULT_CSV_PATH as RECENT_PATH }
  from '../src/ingest/kaggle/recentLoader.js';

const HISTORICAL_AVAILABLE = existsSync(HISTORICAL_PATH);
const RECENT_AVAILABLE = existsSync(RECENT_PATH);

// ---------------------------------------------------------------------------
// Pure function tests (no CSV dependency)
// ---------------------------------------------------------------------------

test('isRegularSeasonDate: accepts dates before April 5', () => {
  assert.equal(isRegularSeasonDate('2023-01-15 00:00:00+00:00'), true);
  assert.equal(isRegularSeasonDate('2023-03-30 19:00:00+00:00'), true);
  assert.equal(isRegularSeasonDate('2023-04-01 00:00:00+00:00'), true);
  assert.equal(isRegularSeasonDate('2023-04-05 23:00:00+00:00'), true);
});

test('isRegularSeasonDate: rejects dates April 6 and later', () => {
  assert.equal(isRegularSeasonDate('2023-04-06 00:00:00+00:00'), false);
  assert.equal(isRegularSeasonDate('2023-04-19 00:00:00+00:00'), false);
  assert.equal(isRegularSeasonDate('2023-05-15 00:00:00+00:00'), false);
  assert.equal(isRegularSeasonDate('2023-06-01 00:00:00+00:00'), false);
});

test('isRegularSeasonDate: handles malformed input', () => {
  assert.equal(isRegularSeasonDate(null), false);
  assert.equal(isRegularSeasonDate(undefined), false);
  assert.equal(isRegularSeasonDate(''), false);
  assert.equal(isRegularSeasonDate('not a date'), false);
});

test('extractSnapshot: uses roll_30 when available', () => {
  const row = {
    season: 2023,
    team_abbrev: 'BOS',
    team_name: 'Boston Bruins',
    date: '2023-04-02 00:00:00+00:00',
    game_id: 12345,
    roll_30_goals_for: 3.5,
    roll_10_goals_for: 2.8,
    roll_30_goals_against: 2.2,
    roll_10_goals_against: 2.5,
    pre_game_point_pct: 0.81,
  };
  const snapshot = extractSnapshot(row);
  assert.equal(snapshot.window, 30);
  assert.equal(snapshot.goals_for_per_game, 3.5);
  assert.equal(snapshot.goals_against_per_game, 2.2);
});

test('extractSnapshot: falls back to roll_10 when roll_30 unavailable', () => {
  const row = {
    season: 2025,
    team_abbrev: 'BOS',
    team_name: 'Boston Bruins',
    date: '2025-04-01 00:00:00+00:00',
    game_id: 54321,
    roll_30_goals_for: null,
    roll_10_goals_for: 2.8,
    roll_30_goals_against: null,
    roll_10_goals_against: 2.5,
  };
  const snapshot = extractSnapshot(row);
  assert.equal(snapshot.window, 10);
  assert.equal(snapshot.goals_for_per_game, 2.8);
  assert.equal(snapshot.goals_against_per_game, 2.5);
});

test('enrichWithSpecialTeams: computes pp_pct correctly', () => {
  const snapshot = {
    pp_goals_per_game: 0.5,
    pp_opps_per_game: 3.0,
  };
  const enriched = enrichWithSpecialTeams(snapshot);
  assert.ok(Math.abs(enriched.pp_pct - 0.1667) < 0.001);
});

test('enrichWithSpecialTeams: handles zero PP opps', () => {
  const snapshot = { pp_goals_per_game: 0, pp_opps_per_game: 0 };
  const enriched = enrichWithSpecialTeams(snapshot);
  assert.equal(enriched.pp_pct, null);
});

test('enrichWithSpecialTeams: handles null PP opps', () => {
  const snapshot = { pp_goals_per_game: null, pp_opps_per_game: null };
  const enriched = enrichWithSpecialTeams(snapshot);
  assert.equal(enriched.pp_pct, null);
});

// ---------------------------------------------------------------------------
// CSV-dependent tests (historical)
// ---------------------------------------------------------------------------

test('buildHistoricalSnapshots: produces one snapshot per NHL team per season',
  { skip: !HISTORICAL_AVAILABLE }, async () => {
  const snapshots = await buildHistoricalSnapshots({ startSeason: 2023, endSeason: 2023 });
  assert.ok(snapshots.length >= 30, `expected 30+ teams, got ${snapshots.length}`);
  assert.ok(snapshots.length <= 33, `expected <=33 teams, got ${snapshots.length}`);

  const uniqueTeams = new Set(snapshots.map(s => s.team_abbrev));
  assert.equal(uniqueTeams.size, snapshots.length, 'no duplicate teams per season');
});

test('buildHistoricalSnapshots: snapshot dates are in early April or earlier',
  { skip: !HISTORICAL_AVAILABLE }, async () => {
  const snapshots = await buildHistoricalSnapshots({ startSeason: 2023, endSeason: 2023 });
  for (const s of snapshots) {
    const dateStr = s.last_game_date;
    assert.ok(isRegularSeasonDate(dateStr),
      `${s.team_abbrev} last_game_date ${dateStr} is not regular season`);
  }
});

test('buildHistoricalSnapshots: BOS 2023 has reasonable feature values',
  { skip: !HISTORICAL_AVAILABLE }, async () => {
  const snapshots = await buildHistoricalSnapshots({ startSeason: 2023, endSeason: 2023 });
  const bos = snapshots.find(s => s.team_abbrev === 'BOS');
  assert.ok(bos, 'BOS snapshot should exist');

  // BOS 2023 was an all-time great team
  assert.ok(bos.goals_for_per_game > 3.0 && bos.goals_for_per_game < 4.5,
    `goals_for ${bos.goals_for_per_game} out of plausible range`);
  assert.ok(bos.goals_against_per_game > 1.5 && bos.goals_against_per_game < 3.0,
    `goals_against ${bos.goals_against_per_game} out of plausible range`);
  assert.ok(bos.pre_game_point_pct > 0.75 && bos.pre_game_point_pct < 0.90,
    `point_pct ${bos.pre_game_point_pct} not in BOS 2023 range`);
  assert.ok(bos.pp_pct > 0.10 && bos.pp_pct < 0.30,
    `pp_pct ${bos.pp_pct} out of plausible range`);
});

test('buildHistoricalSnapshots: uses roll_30 window for historical data',
  { skip: !HISTORICAL_AVAILABLE }, async () => {
  const snapshots = await buildHistoricalSnapshots({ startSeason: 2023, endSeason: 2023 });
  for (const s of snapshots) {
    assert.equal(s.window, 30, `${s.team_abbrev} should use 30-game window`);
  }
});

test('buildHistoricalSnapshots: respects season range', { skip: !HISTORICAL_AVAILABLE }, async () => {
  const snapshots = await buildHistoricalSnapshots({ startSeason: 2020, endSeason: 2022 });
  for (const s of snapshots) {
    assert.ok(s.season >= 2020 && s.season <= 2022,
      `season ${s.season} outside requested range`);
  }
  // 3 seasons * ~30 teams = ~90 snapshots
  assert.ok(snapshots.length >= 80 && snapshots.length <= 100,
    `expected ~90 snapshots for 3 seasons, got ${snapshots.length}`);
});

// ---------------------------------------------------------------------------
// CSV-dependent tests (recent)
// ---------------------------------------------------------------------------

test('buildRecentSnapshots: produces one snapshot per NHL team',
  { skip: !RECENT_AVAILABLE }, async () => {
  const snapshots = await buildRecentSnapshots();
  assert.ok(snapshots.length >= 30, `expected 30+ teams, got ${snapshots.length}`);
  assert.ok(snapshots.length <= 33, `expected <=33 teams, got ${snapshots.length}`);
});

test('buildRecentSnapshots: uses roll_10 window (no roll_30 in 2024-25)',
  { skip: !RECENT_AVAILABLE }, async () => {
  const snapshots = await buildRecentSnapshots();
  for (const s of snapshots) {
    assert.equal(s.window, 10, `${s.team_abbrev} should use 10-game window`);
  }
});

test('buildRecentSnapshots: includes save_pct (unique to recent dataset)',
  { skip: !RECENT_AVAILABLE }, async () => {
  const snapshots = await buildRecentSnapshots();
  // At least some teams should have save_pct (not all rows may have it populated)
  const withSavePct = snapshots.filter(s => s.save_pct !== null);
  assert.ok(withSavePct.length > 0,
    `expected at least some teams with save_pct, got ${withSavePct.length}`);
});
