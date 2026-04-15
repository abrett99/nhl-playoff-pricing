// ============================================================================
// KAGGLE 2024-25 ADVANCED METRICS LOADER (streaming)
// ============================================================================
// Parses the 2.3MB nhl_dataset.csv file for the current season. Normalizes
// field names to match the historical CSV schema so downstream consumers
// (snapshot builder, model, backtest) can use one consistent row shape.
//
// Schema differences from historical, normalized here:
//   home_away "home"/"away"   -> is_home 1/0
//   score                     -> goals_for
//   opp_score                 -> goals_against
//   cum_wins                  -> season_wins
//   cum_games                 -> season_games_played
//   team_record               -> record_summary
//
// Missing fields (vs historical):
//   pre_game_point_pct - deliberately null, callers should use season_win_pct
//   roll_30_* - 2024-25 only has 3 and 10 game windows
//   derived _diff columns - computed on-the-fly by snapshot builder
//
// New fields in 2024-25:
//   save_pct - per-game team save percentage (useful for goalie baseline)
//   rest_advantage - pre-computed rest differential
//   rolling_pp_efficiency_3/10 - pre-computed PP% rolling windows
// ============================================================================

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { nameToAbbrev } from './teamNames.js';

const DEFAULT_CSV_PATH = 'data/raw/kaggle/2024-25/nhl_dataset.csv';

const INT_COLUMNS = new Set([
  'won', 'game_id', 'season', 'attendance', 'team_id', 'opp_team_id',
  'opp_won', 'score', 'opp_score', 'shots', 'power_play_goals',
  'power_play_opportunities', 'cum_wins', 'cum_games', 'is_home',
]);

const STRING_COLUMNS = new Set([
  'date', 'venue', 'officials', 'season_series', 'team_name',
  'home_away', 'team_record', 'opp_team_name',
]);

function parseValue(raw, columnName) {
  if (raw === undefined || raw === null || raw === '' ||
      raw === 'nan' || raw === 'NaN') {
    return null;
  }
  if (STRING_COLUMNS.has(columnName)) return raw;
  if (INT_COLUMNS.has(columnName)) {
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  }
  const f = parseFloat(raw);
  return Number.isNaN(f) ? raw : f;
}

/**
 * Normalize 2024-25 row to match historical schema. Adds:
 *   - team_abbrev, opp_team_abbrev (from name mapper)
 *   - is_home (coerced from home_away string)
 *   - goals_for, goals_against (renamed from score, opp_score)
 *   - season_wins, season_games_played (renamed)
 *   - record_summary (renamed from team_record)
 */
function normalizeRow(rawRow) {
  const teamAbbrev = nameToAbbrev(rawRow.team_name);
  const oppAbbrev = nameToAbbrev(rawRow.opp_team_name);

  return {
    // Historical-schema compatible fields
    game_id: rawRow.game_id,
    date: rawRow.date,
    season: rawRow.season,
    venue: rawRow.venue,
    attendance: rawRow.attendance,
    team_id: rawRow.team_id,
    team_name: rawRow.team_name,
    team_abbrev: teamAbbrev,
    is_home: rawRow.home_away === 'home' ? 1 : (rawRow.home_away === 'away' ? 0 : null),
    won: rawRow.won,
    goals_for: rawRow.score,
    goals_against: rawRow.opp_score,
    shots: rawRow.shots,
    power_play_goals: rawRow.power_play_goals,
    power_play_opportunities: rawRow.power_play_opportunities,
    faceoff_win_pct: rawRow.faceoff_win_pct,
    hits: rawRow.hits,
    blocked_shots: rawRow.blocked_shots,
    pim: rawRow.pim,
    giveaways: rawRow.giveaways,
    takeaways: rawRow.takeaways,
    rest_days: rawRow.rest_days,
    opp_team_id: rawRow.opp_team_id,
    opp_team_name: rawRow.opp_team_name,
    opp_team_abbrev: oppAbbrev,
    opp_rest_days: rawRow.opp_rest_days,

    // Renamed aggregate fields
    season_games_played: rawRow.cum_games,
    season_wins: rawRow.cum_wins,
    season_win_pct: rawRow.season_win_pct,
    record_summary: rawRow.team_record,

    // Missing in historical but present here (keep for callers who need them)
    save_pct: rawRow.save_pct,
    rest_advantage: rawRow.rest_advantage,

    // Betting lines
    spread: rawRow.spread,
    over_under: rawRow.over_under,
    favorite_moneyline: rawRow.favorite_moneyline,

    // Rolling features (3 and 10 game windows only - no 30)
    roll_3_shots: rawRow.rolling_shots_3,
    roll_3_power_play_goals: rawRow.rolling_power_play_goals_3,
    roll_3_power_play_opportunities: rawRow.rolling_power_play_opportunities_3,
    roll_3_faceoff_win_pct: rawRow.rolling_faceoff_win_pct_3,
    roll_3_hits: rawRow.rolling_hits_3,
    roll_3_blocked_shots: rawRow.rolling_blocked_shots_3,
    roll_3_pim: rawRow.rolling_pim_3,
roll_3_giveaways: rawRow.rolling_giveaways_3,
    roll_3_takeaways: rawRow.rolling_takeaways_3,
    roll_3_goals_for: rawRow.rolling_score_3,
    roll_3_pp_efficiency: rawRow.rolling_pp_efficiency_3,

    roll_10_shots: rawRow.rolling_shots_10,
    roll_10_power_play_goals: rawRow.rolling_power_play_goals_10,
    roll_10_power_play_opportunities: rawRow.rolling_power_play_opportunities_10,
    roll_10_faceoff_win_pct: rawRow.rolling_faceoff_win_pct_10,
    roll_10_hits: rawRow.rolling_hits_10,
    roll_10_blocked_shots: rawRow.rolling_blocked_shots_10,
    roll_10_pim: rawRow.rolling_pim_10,
    roll_10_giveaways: rawRow.rolling_giveaways_10,
    roll_10_takeaways: rawRow.rolling_takeaways_10,
    roll_10_goals_for: rawRow.rolling_score_10,
    roll_10_pp_efficiency: rawRow.rolling_pp_efficiency_10,

    // Opponent rolling features
    opp_roll_3_goals_for: rawRow.opp_rolling_score_3,
    opp_roll_10_goals_for: rawRow.opp_rolling_score_10,
    opp_roll_3_power_play_goals: rawRow.opp_rolling_power_play_goals_3,
    opp_roll_10_power_play_goals: rawRow.opp_rolling_power_play_goals_10,
    opp_roll_3_shots: rawRow.opp_rolling_shots_3,
    opp_roll_10_shots: rawRow.opp_rolling_shots_10,

    // Explicitly null for schema compatibility (not present in 2024-25)
    pre_game_point_pct: null,
    roll_30_goals_for: null,
    roll_30_goals_against: null,
  };
}

/**
 * Same as isNhlGame in historicalLoader — duplicated here to avoid tight
 * coupling across the two loaders.
 */
export function isNhlGame(row) {
  return row.team_abbrev != null && row.opp_team_abbrev != null;
}

/**
 * Stream through the 2024-25 CSV, yielding normalized+enriched rows.
 */
export async function streamRecent({
  path = DEFAULT_CSV_PATH,
  filter = null,
  onRow,
  onProgress = null,
} = {}) {
  if (!onRow) throw new Error('streamRecent requires an onRow callback');
  if (!existsSync(path)) {
    throw new Error(`Recent CSV not found at ${path}. Run scripts/download-kaggle.py first.`);
  }

  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  let total = 0;
  let kept = 0;

  for await (const line of rl) {
    if (!line) continue;

    if (!headers) {
      headers = line.split(',').map(h => h.trim());
      continue;
    }

    const cells = line.split(',');
    const rawRow = {};
    for (let i = 0; i < headers.length; i++) {
      rawRow[headers[i]] = parseValue(cells[i], headers[i]);
    }

    total++;

    const normalized = normalizeRow(rawRow);

    if (filter && !filter(normalized)) continue;

    kept++;
    onRow(normalized);

    if (onProgress && total % 500 === 0) {
      onProgress(total, kept);
    }
  }

  return { total, kept };
}

/**
 * Load all rows matching a filter into an array. Safe here because the
 * 2024-25 file is only 2.3MB.
 */
export async function loadFiltered(filterFn, path = DEFAULT_CSV_PATH) {
  const rows = [];
  await streamRecent({
    path,
    filter: filterFn,
    onRow: (row) => rows.push(row),
  });
  return rows;
}

export { DEFAULT_CSV_PATH };
