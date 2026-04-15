// ============================================================================
// PRE-PLAYOFF SNAPSHOT BUILDER
// ============================================================================
// Produces one feature vector per (season, team) capturing their strength
// at the END of the regular season (i.e., entering playoffs).
//
// Design: Option A from our decision — use the dataset's roll_30_* columns
// from each team's LAST regular-season game. That grabs a 30-game rolling
// window at end of season, which is exactly pre-playoff strength.
//
// For 2024-25 (and any future Kaggle recent dataset), we fall back to
// roll_10_* since the recent loader doesn't have roll_30.
//
// Leakage safety: roll_30_* is computed with closed='left' by the dataset
// author, meaning it only uses games up to N-1 when placed on game N.
// Using the LAST game's roll_30 is equivalent to "state after last game,"
// which is point-in-time correct for "entering playoffs."
//
// Excluded seasons: 2004 lockout year, post-lockout 2005 (fewer games and
// structurally different). Default buildAllSnapshots() starts at 2006.
//
// KNOWN DATA QUIRKS (Kaggle historical dataset):
// - season_games_played, season_wins, season_win_pct, season_goals_for,
//   season_goals_against, season_goal_diff are CUMULATIVE ACROSS MULTIPLE
//   SEASONS, not single-season totals. DO NOT use for per-season analysis.
//   Use pre_game_point_pct and roll_30_* fields instead, which are
//   single-season correct via the dataset author's leak-safe aggregation.
// ============================================================================

import { streamHistorical, isNhlGame as isHistoricalNhl }
  from '../ingest/kaggle/historicalLoader.js';
import { streamRecent, isNhlGame as isRecentNhl }
  from '../ingest/kaggle/recentLoader.js';

// NHL regular season ends in mid-April (usually April 8-15 depending on year).
// To avoid accidentally picking up playoff games as "last regular season game,"
// we use April 5 as the cutoff. This means we might miss the absolute last
// 2-3 regular-season games for some teams, but the roll_30 smoothing means
// this has negligible effect on the snapshot.
const REGULAR_SEASON_END_CUTOFF_MONTH_DAY = [4, 5];

function isRegularSeasonDate(dateString) {
  if (!dateString || typeof dateString !== 'string') return false;
  // Parse date: "2023-04-07 00:00:00+00:00" -> month = 4, day = 7
  const match = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return false;
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const [cutoffMonth, cutoffDay] = REGULAR_SEASON_END_CUTOFF_MONTH_DAY;
  // Regular season: anything before the cutoff month/day
  if (month < cutoffMonth) return true;
  if (month === cutoffMonth && day <= cutoffDay) return true;
  return false;
}

/**
 * Extract pre-playoff feature vector from a row that represents a team's
 * last regular-season game. Uses roll_30_* when available (historical),
 * falls back to roll_10_* when not (recent dataset).
 */
function extractSnapshot(row) {
  const usesThirty = row.roll_30_goals_for != null;

  const pick = (thirty, ten) => {
    if (usesThirty && row[thirty] != null) return row[thirty];
    return row[ten];
  };

  return {
    season: row.season,
    team_abbrev: row.team_abbrev,
    team_name: row.team_name,

    // Snapshot metadata
    last_game_date: row.date,
    last_game_id: row.game_id,
    window: usesThirty ? 30 : 10,

    // KNOWN UNRELIABLE — cumulative across seasons, not single-season.
    // Kept for completeness but DO NOT use for modeling.
    season_games_played: row.season_games_played,
    season_wins: row.season_wins,
    season_win_pct: row.season_win_pct,
    season_goals_for: row.season_goals_for ?? null,
    season_goals_against: row.season_goals_against ?? null,
    season_goal_diff: row.season_goal_diff ?? null,

    // Point-in-time team strength (roll_30 or roll_10)
    goals_for_per_game: pick('roll_30_goals_for', 'roll_10_goals_for'),
    shots_per_game: pick('roll_30_shots', 'roll_10_shots'),
    pp_goals_per_game: pick('roll_30_power_play_goals', 'roll_10_power_play_goals'),
    pp_opps_per_game: pick('roll_30_power_play_opportunities', 'roll_10_power_play_opportunities'),
    faceoff_win_pct: pick('roll_30_faceoff_win_pct', 'roll_10_faceoff_win_pct'),
    hits_per_game: pick('roll_30_hits', 'roll_10_hits'),
    blocked_shots_per_game: pick('roll_30_blocked_shots', 'roll_10_blocked_shots'),
    pim_per_game: pick('roll_30_pim', 'roll_10_pim'),
    giveaways_per_game: pick('roll_30_giveaways', 'roll_10_giveaways'),
    takeaways_per_game: pick('roll_30_takeaways', 'roll_10_takeaways'),
    goals_against_per_game: pick('roll_30_goals_against', 'roll_10_goals_against'),

    // Leakage-safe point-in-time strength (historical only)
    pre_game_point_pct: row.pre_game_point_pct ?? null,

    // Save percentage (only in recent dataset; null for historical)
    save_pct: row.save_pct ?? null,
  };
}

/**
 * Derive PP% and PK% from PP goals/opps. Stored on each snapshot for
 * convenience. PK% is 1 - (pp_goals_allowed / pp_opps_against), but we
 * don't have that data directly — compute from opponent's pp_goals and
 * your pp_opps_against. For now, approximate PK% from snapshots by
 * assuming a team's PK% inversely tracks their allowed goals per game.
 * This is imperfect but workable.
 */
function enrichWithSpecialTeams(snapshot) {
  const ppPct = (snapshot.pp_opps_per_game && snapshot.pp_opps_per_game > 0)
    ? snapshot.pp_goals_per_game / snapshot.pp_opps_per_game
    : null;
  return { ...snapshot, pp_pct: ppPct };
}

/**
 * Build pre-playoff snapshots from the historical dataset.
 *
 * Walks the CSV twice:
 *   1. Find each (season, team)'s last regular-season game date
 *   2. Extract the snapshot row for that game
 *
 * @param {Object} opts
 * @param {number} opts.startSeason - earliest season to include (default 2006)
 * @param {number} opts.endSeason - latest season to include (default 2023)
 * @returns {Promise<Array<Snapshot>>}
 */
export async function buildHistoricalSnapshots({
  startSeason = 2006,
  endSeason = 2023,
} = {}) {
  // Pass 1: find last regular-season game per (season, team)
  const lastGameByKey = new Map(); // key = "season::abbrev", value = { date, gameId }

  await streamHistorical({
    filter: (row) => (
      isHistoricalNhl(row) &&
      row.season >= startSeason &&
      row.season <= endSeason &&
      isRegularSeasonDate(row.date)
    ),
    onRow: (row) => {
      const key = `${row.season}::${row.team_abbrev}`;
      const existing = lastGameByKey.get(key);
      if (!existing || row.date > existing.date) {
        lastGameByKey.set(key, { date: row.date, gameId: row.game_id });
      }
    },
  });

  // Pass 2: extract snapshots using the identified last-game rows
  const snapshots = [];

  await streamHistorical({
    filter: (row) => {
      if (!isHistoricalNhl(row)) return false;
      if (row.season < startSeason || row.season > endSeason) return false;
      const key = `${row.season}::${row.team_abbrev}`;
      const target = lastGameByKey.get(key);
      if (!target) return false;
      return row.date === target.date && row.game_id === target.gameId;
    },
    onRow: (row) => {
      snapshots.push(enrichWithSpecialTeams(extractSnapshot(row)));
    },
  });

  return snapshots;
}

/**
 * Build pre-playoff snapshot from the 2024-25 recent dataset.
 * Uses the team's most recent regular-season game in the file.
 */
export async function buildRecentSnapshots() {
  const lastGameByKey = new Map();

  await streamRecent({
    filter: (row) => isRecentNhl(row) && isRegularSeasonDate(row.date),
    onRow: (row) => {
      const key = `${row.season}::${row.team_abbrev}`;
      const existing = lastGameByKey.get(key);
      if (!existing || row.date > existing.date) {
        lastGameByKey.set(key, { date: row.date, gameId: row.game_id });
      }
    },
  });

  const snapshots = [];

  await streamRecent({
    filter: (row) => {
      if (!isRecentNhl(row)) return false;
      const key = `${row.season}::${row.team_abbrev}`;
      const target = lastGameByKey.get(key);
      if (!target) return false;
      return row.date === target.date && row.game_id === target.gameId;
    },
    onRow: (row) => {
      snapshots.push(enrichWithSpecialTeams(extractSnapshot(row)));
    },
  });

  return snapshots;
}

/**
 * Build all snapshots (historical + recent) combined into one dataset,
 * indexed by season.
 *
 * @returns {Promise<Array<Snapshot>>}
 */
export async function buildAllSnapshots() {
  const [historical, recent] = await Promise.all([
    buildHistoricalSnapshots(),
    buildRecentSnapshots(),
  ]);
  return [...historical, ...recent];
}

export { extractSnapshot, enrichWithSpecialTeams, isRegularSeasonDate };
