// ============================================================================
// POINT-IN-TIME FEATURE BUILDER
// ============================================================================
// Core invariant: if you call buildFeaturesAsOf(gameDate) for any historical
// game, you must get the features as they would have looked on gameDate.
// Never use data timestamped AFTER gameDate. Never use season-to-date stats
// that include games played on or after gameDate.
//
// If you can't reproduce a feature value historically, it's leaky.
// ============================================================================

import { getSnapshotAsOf } from '../ingest/store.js';
import { isBefore, hoursBetween } from '../engine/util.js';

// ============================================================================
// Core: build features for a specific game
// ============================================================================

/**
 * Build the full feature vector for a single playoff game, using only data
 * available BEFORE the game's start time.
 *
 * @param {object} params
 * @param {string} params.gameId
 * @param {string} params.homeTeam       - e.g. "BOS"
 * @param {string} params.awayTeam       - e.g. "TOR"
 * @param {Date|string} params.gameStartTime
 * @param {object} params.seriesState    - current series state (winsA, winsB, etc.)
 * @param {string} params.homeGoalieId   - confirmed starter or best guess
 * @param {string} params.awayGoalieId
 * @returns {Promise<object>} feature object with .asOf metadata
 */
export async function buildFeaturesAsOf(params) {
  const {
    gameId,
    homeTeam,
    awayTeam,
    gameStartTime,
    seriesState = null,
    homeGoalieId = null,
    awayGoalieId = null,
  } = params;

  const asOf = gameStartTime instanceof Date ? gameStartTime : new Date(gameStartTime);

  // Every snapshot we read must be from BEFORE asOf
  const snapshots = await Promise.all([
    getSnapshotAsOf('nst_team_sva', asOf),
    getSnapshotAsOf('nst_team_pp', asOf),
    getSnapshotAsOf('nst_team_pk', asOf),
    getSnapshotAsOf('nst_goalies', asOf),
    getSnapshotAsOf('moneypuck_teams', asOf),
    getSnapshotAsOf('moneypuck_goalies', asOf),
    getSnapshotAsOf('nhl_schedule', asOf),
  ]);

  const [
    nstTeamSva,
    nstTeamPP,
    nstTeamPK,
    nstGoalies,
    mpTeams,
    mpGoalies,
    nhlSchedule,
  ] = snapshots;

  // Parse the CSVs/JSON into row arrays keyed by team/player
  const teamRows = parseTeamSnapshot(nstTeamSva, mpTeams);
  const goalieRows = parseGoalieSnapshot(nstGoalies, mpGoalies);

  const homeTeamRow = teamRows[homeTeam] || null;
  const awayTeamRow = teamRows[awayTeam] || null;

  const features = {
    // ─ Identity ─
    gameId,
    homeTeam,
    awayTeam,
    gameStartTime: asOf.toISOString(),

    // ─ Team-level (5v5, score+venue adjusted) ─
    home_xgf_per_60: homeTeamRow?.xgf_per_60 ?? null,
    home_xga_per_60: homeTeamRow?.xga_per_60 ?? null,
    home_cf_pct: homeTeamRow?.cf_pct ?? null,
    away_xgf_per_60: awayTeamRow?.xgf_per_60 ?? null,
    away_xga_per_60: awayTeamRow?.xga_per_60 ?? null,
    away_cf_pct: awayTeamRow?.cf_pct ?? null,

    // ─ Special teams ─
    home_pp_pct: extractSpecialTeams(nstTeamPP, homeTeam, 'pp_pct'),
    home_pk_pct: extractSpecialTeams(nstTeamPK, homeTeam, 'pk_pct'),
    away_pp_pct: extractSpecialTeams(nstTeamPP, awayTeam, 'pp_pct'),
    away_pk_pct: extractSpecialTeams(nstTeamPK, awayTeam, 'pk_pct'),

    // ─ Goalies (CONFIRMED STARTERS — mandatory for playoffs) ─
    home_goalie_id: homeGoalieId,
    home_goalie_gsax_per_60: goalieRows[homeGoalieId]?.gsax_per_60 ?? null,
    home_goalie_save_pct: goalieRows[homeGoalieId]?.save_pct ?? null,
    home_goalie_confirmed: Boolean(homeGoalieId),
    away_goalie_id: awayGoalieId,
    away_goalie_gsax_per_60: goalieRows[awayGoalieId]?.gsax_per_60 ?? null,
    away_goalie_save_pct: goalieRows[awayGoalieId]?.save_pct ?? null,
    away_goalie_confirmed: Boolean(awayGoalieId),

    // ─ Series-state features (for bounceback / zig-zag signal) ─
    ...deriveSeriesStateFeatures(seriesState, homeTeam, awayTeam),

    // ─ Provenance (CRITICAL for leakage debugging) ─
    asOf: {
      requestedTime: asOf.toISOString(),
      snapshots: {
        nst_team_sva: snapshotInfo(nstTeamSva),
        nst_team_pp: snapshotInfo(nstTeamPP),
        nst_team_pk: snapshotInfo(nstTeamPK),
        nst_goalies: snapshotInfo(nstGoalies),
        moneypuck_teams: snapshotInfo(mpTeams),
        moneypuck_goalies: snapshotInfo(mpGoalies),
        nhl_schedule: snapshotInfo(nhlSchedule),
      },
    },
  };

  return features;
}

// ============================================================================
// Helpers
// ============================================================================

function snapshotInfo(snap) {
  if (!snap) return { status: 'missing' };
  return {
    status: 'ok',
    timestamp: snap.timestamp,
    ageHoursBeforeGame: Math.round(snap.ageMs / (1000 * 60 * 60) * 10) / 10,
    filename: snap.filename,
  };
}

/**
 * Parse NST team table CSV (tab-separated) and MoneyPuck team CSV into a
 * unified team-keyed object. NST is primary; MoneyPuck is fallback/cross-check.
 */
function parseTeamSnapshot(nstSnap, mpSnap) {
  const result = {};

  if (nstSnap?.body) {
    const text = typeof nstSnap.body === 'string'
      ? nstSnap.body
      : nstSnap.body.toString('utf-8');
    const rows = parseCsv(text);
    for (const row of rows) {
      const team = normalizeTeam(row.Team || row.team);
      if (!team) continue;
      result[team] = {
        xgf_per_60: num(row['xGF/60'] ?? row.xgf_per_60),
        xga_per_60: num(row['xGA/60'] ?? row.xga_per_60),
        cf_pct: num(row['CF%'] ?? row.cf_pct),
        gf_per_60: num(row['GF/60'] ?? row.gf_per_60),
        ga_per_60: num(row['GA/60'] ?? row.ga_per_60),
        sv_pct: num(row['SV%'] ?? row.sv_pct),
        pdo: num(row.PDO ?? row.pdo),
        source: 'nst',
      };
    }
  }

  // MoneyPuck fallback for teams missing from NST (shouldn't happen normally)
  if (mpSnap?.body) {
    // Parse but only use for teams we don't have
    const text = typeof mpSnap.body === 'string'
      ? mpSnap.body
      : mpSnap.body.toString('utf-8');
    const rows = parseCsv(text);
    for (const row of rows) {
      const team = normalizeTeam(row.team);
      if (team && !result[team]) {
        result[team] = {
          xgf_per_60: num(row.xGoalsFor),
          xga_per_60: num(row.xGoalsAgainst),
          source: 'moneypuck_fallback',
        };
      }
    }
  }

  return result;
}

function parseGoalieSnapshot(nstSnap, mpSnap) {
  const result = {};

  if (nstSnap?.body) {
    const text = typeof nstSnap.body === 'string'
      ? nstSnap.body
      : nstSnap.body.toString('utf-8');
    const rows = parseCsv(text);
    for (const row of rows) {
      const id = row.playerId || row.Player || row.name;
      if (!id) continue;
      result[id] = {
        gsax_per_60: num(row['GSAx/60'] ?? row.gsax_per_60),
        save_pct: num(row['SV%'] ?? row.save_pct),
        games_played: num(row.GP ?? row.games_played),
        source: 'nst',
      };
    }
  }

  if (mpSnap?.body) {
    const text = typeof mpSnap.body === 'string'
      ? mpSnap.body
      : mpSnap.body.toString('utf-8');
    const rows = parseCsv(text);
    for (const row of rows) {
      const id = row.playerId || row.name;
      if (id && !result[id]) {
        result[id] = {
          gsax_per_60: num(row.goalsSavedAboveExpected),
          source: 'moneypuck_fallback',
        };
      }
    }
  }

  return result;
}

function extractSpecialTeams(snap, team, field) {
  if (!snap?.body) return null;
  const text = typeof snap.body === 'string' ? snap.body : snap.body.toString('utf-8');
  const rows = parseCsv(text);
  const row = rows.find(r => normalizeTeam(r.Team || r.team) === team);
  return row ? num(row['PP%'] ?? row['PK%'] ?? row[field]) : null;
}

/**
 * Derive series-state features used by the zig-zag bounceback adjustment.
 */
function deriveSeriesStateFeatures(series, homeTeam, awayTeam) {
  if (!series) {
    return {
      series_wins_home: 0,
      series_wins_away: 0,
      series_game_num: 1,
      home_team_prev_game_won: null,
      away_team_prev_game_won: null,
      is_elimination_game_for_home: false,
      is_elimination_game_for_away: false,
      series_round: null,
    };
  }

  const lastGame = series.gamesPlayed?.[series.gamesPlayed.length - 1];
  const homeIsTeamA = homeTeam === series.teamA;

  const winsHome = homeIsTeamA ? series.winsA : series.winsB;
  const winsAway = homeIsTeamA ? series.winsB : series.winsA;

  return {
    series_wins_home: winsHome,
    series_wins_away: winsAway,
    series_game_num: (series.gamesPlayed?.length || 0) + 1,
    home_team_prev_game_won: lastGame ? lastGame.winner === homeTeam : null,
    away_team_prev_game_won: lastGame ? lastGame.winner === awayTeam : null,
    is_elimination_game_for_home: winsHome === 3 && winsAway !== 3,
    is_elimination_game_for_away: winsAway === 3 && winsHome !== 3,
    series_round: series.round ?? null,
  };
}

// ============================================================================
// Tiny CSV parser (no dependencies)
// Handles both comma- and tab-separated; detects automatically
// ============================================================================

function parseCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  // NST exports are tab-separated; MoneyPuck is comma
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delim);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i], delim);
    if (values.length !== headers.length) continue; // malformed row, skip
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line, delim) {
  // Handles quoted fields with embedded delimiters
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === delim && !inQuote) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function normalizeTeam(raw) {
  if (!raw) return null;
  // NST uses full team names; MoneyPuck uses abbrevs; NHL API uses abbrevs
  const s = String(raw).trim();
  const map = {
    'Anaheim Ducks': 'ANA', 'Boston Bruins': 'BOS', 'Buffalo Sabres': 'BUF',
    'Carolina Hurricanes': 'CAR', 'Columbus Blue Jackets': 'CBJ',
    'Calgary Flames': 'CGY', 'Chicago Blackhawks': 'CHI', 'Colorado Avalanche': 'COL',
    'Dallas Stars': 'DAL', 'Detroit Red Wings': 'DET', 'Edmonton Oilers': 'EDM',
    'Florida Panthers': 'FLA', 'Los Angeles Kings': 'LAK', 'Minnesota Wild': 'MIN',
    'Montreal Canadiens': 'MTL', 'New Jersey Devils': 'NJD', 'Nashville Predators': 'NSH',
    'New York Islanders': 'NYI', 'New York Rangers': 'NYR', 'Ottawa Senators': 'OTT',
    'Philadelphia Flyers': 'PHI', 'Pittsburgh Penguins': 'PIT', 'Seattle Kraken': 'SEA',
    'San Jose Sharks': 'SJS', 'St Louis Blues': 'STL', 'St. Louis Blues': 'STL',
    'Tampa Bay Lightning': 'TBL', 'Toronto Maple Leafs': 'TOR', 'Utah Hockey Club': 'UTA',
    'Vancouver Canucks': 'VAN', 'Vegas Golden Knights': 'VGK',
    'Washington Capitals': 'WSH', 'Winnipeg Jets': 'WPG',
  };
  if (map[s]) return map[s];
  if (s.length === 3) return s.toUpperCase();
  return null;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}
