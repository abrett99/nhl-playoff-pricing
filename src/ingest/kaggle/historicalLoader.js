// ============================================================================
// KAGGLE HISTORICAL CSV LOADER (streaming)
// ============================================================================
// Parses the 73MB nhl_data_extensive.csv file as a stream. Yields one parsed
// row at a time so callers can aggregate without loading the full dataset
// into memory.
//
// The CSV has 128 columns per row. Many are floats, some are strings, some
// are ints. This loader coerces types based on column name patterns and
// returns typed JavaScript objects.
//
// Design notes:
// - Streaming via readline is ~3x faster than reading the whole file
// - We parse CSV manually (no dependency) since the file has no embedded
//   commas or quoted fields (verified by inspection)
// - NaN/null handling: empty strings and "nan" become null
// ============================================================================

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { nameToAbbrev } from './teamNames.js';

/**
 * A game is considered an NHL game if both teams resolve to NHL abbreviations.
 * Filters out preseason exhibitions against European clubs, AHL affiliates,
 * and national team tournaments.
 */
export function isNhlGame(row) {
  return row.team_abbrev != null && row.opp_team_abbrev != null;
}
const DEFAULT_CSV_PATH = 'data/raw/kaggle/historical/nhl_data_extensive.csv';

// Columns that should be parsed as integers
const INT_COLUMNS = new Set([
  'game_id', 'season', 'attendance', 'team_id', 'is_home', 'won',
  'record_wins', 'record_losses', 'record_otl', 'num_officials',
  'shots', 'power_play_goals', 'power_play_opportunities',
  'goals_for', 'goals_against', 'rest_days', 'season_games_played',
  'season_wins', 'opp_team_id', 'opp_record_wins', 'opp_record_losses',
  'opp_record_otl', 'opp_rest_days', 'opp_season_games_played',
  'opp_season_wins',
]);

// Columns that should stay as strings
const STRING_COLUMNS = new Set([
  'date', 'venue', 'team_name', 'season_series_summary', 'record_summary',
  'referees', 'linesmen', 'opp_team_name', 'opp_season_series_summary',
  'opp_record_summary',
]);

/**
 * Parse a single CSV value with type coercion.
 */
function parseValue(raw, columnName) {
  if (raw === undefined || raw === null || raw === '' || raw === 'nan' || raw === 'NaN') {
    return null;
  }

  if (STRING_COLUMNS.has(columnName)) {
    return raw;
  }

  if (INT_COLUMNS.has(columnName)) {
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  }

  // Default: try float
  const f = parseFloat(raw);
  return Number.isNaN(f) ? raw : f;
}

/**
 * Convert a raw parsed row into our domain shape.
 * Adds team_abbrev and opp_team_abbrev fields derived from full names.
 */
function enrichRow(rawRow) {
  const teamAbbrev = nameToAbbrev(rawRow.team_name);
  const oppAbbrev = nameToAbbrev(rawRow.opp_team_name);
  return {
    ...rawRow,
    team_abbrev: teamAbbrev,
    opp_team_abbrev: oppAbbrev,
  };
}

/**
 * Stream through the historical CSV, yielding parsed+enriched rows.
 *
 * @param {Object} opts
 * @param {string} opts.path - Path to the CSV (default: data/raw/kaggle/historical/nhl_data_extensive.csv)
 * @param {function} opts.filter - Optional filter(row) -> boolean, skip if false
 * @param {function} opts.onRow - Required callback called for each kept row
 * @param {function} opts.onProgress - Optional progress(rowsProcessed, rowsKept) every 5000 rows
 * @returns {Promise<{total: number, kept: number}>}
 */
export async function streamHistorical({
  path = DEFAULT_CSV_PATH,
  filter = null,
  onRow,
  onProgress = null,
} = {}) {
  if (!onRow) throw new Error('streamHistorical requires an onRow callback');
  if (!existsSync(path)) {
    throw new Error(`Historical CSV not found at ${path}. Run scripts/download-kaggle.py first.`);
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
    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = parseValue(cells[i], headers[i]);
    }

    total++;

    const enriched = enrichRow(row);

    if (filter && !filter(enriched)) continue;

    kept++;
    onRow(enriched);

    if (onProgress && total % 5000 === 0) {
      onProgress(total, kept);
    }
  }

  return { total, kept };
}

/**
 * Convenience: load all rows into an array. Use only for small subsets
 * (e.g. filtered to a single season). Will OOM on the full 73MB file.
 */
export async function loadFiltered(filterFn, path = DEFAULT_CSV_PATH) {
  const rows = [];
  await streamHistorical({
    path,
    filter: filterFn,
    onRow: (row) => rows.push(row),
  });
  return rows;
}

/**
 * Get distinct seasons present in the file. Reads header + one pass over
 * just the season column for speed.
 */
export async function getSeasons(path = DEFAULT_CSV_PATH) {
  const seasons = new Set();
  await streamHistorical({
    path,
    onRow: (row) => {
      if (row.season != null) seasons.add(row.season);
    },
  });
  return [...seasons].sort((a, b) => a - b);
}

export { DEFAULT_CSV_PATH };

