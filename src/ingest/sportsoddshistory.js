// ============================================================================
// HISTORICAL ODDS BACKFILL (sportsoddshistory.com)
// ============================================================================
// For backtests older than our live capture window, we need historical
// closing lines. sportsoddshistory.com has hockey playoff odds back to
// ~2009. Their page format is consistent: one table per series round,
// with columns for series price, total games O/U, and sometimes correct
// score.
//
// This is NOT Pinnacle-quality data (sportsoddshistory aggregates from
// various US sportsbooks) but it's sufficient as a historical proxy for
// validating calibration on old series.
//
// For anything AFTER our live capture starts (April 2026), use the
// Pinnacle snapshots in data/derived/clv/ — that's the primary truth.
// ============================================================================

const SOH_BASE = 'https://www.sportsoddshistory.com/nhl-event/';

// ============================================================================
// Parse a single sportsoddshistory.com playoff page
// ============================================================================

/**
 * @param {string} html - raw HTML from SOH
 * @returns {Array<{ teamA, teamB, seriesPrice, totalGames, date }>}
 */
export function parseSohPlayoffs(html) {
  if (!html || typeof html !== 'string') return [];

  // SOH structure: one <table> per round, each row is a series
  const tables = extractTables(html);
  const series = [];

  for (const tableHtml of tables) {
    const rows = extractRows(tableHtml);
    for (const row of rows) {
      const cells = row.map(stripHtml);
      if (cells.length < 3) continue;

      // Skip header rows
      const first = (cells[0] || '').toLowerCase();
      if (first.includes('date') || first.includes('round') || first === '') continue;

      const parsed = parseSohRow(cells);
      if (parsed) series.push(parsed);
    }
  }

  return series;
}

function parseSohRow(cells) {
  // Typical SOH row: [Date, Matchup, SeriesPrice-Fav, SeriesPrice-Dog, TotalLine, Over, Under]
  // But the format varies; we parse defensively

  const dateMatch = cells.find(c => /\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d+/.test(c));
  const matchup = cells.find(c => / @ | at | vs\.? /i.test(c));
  if (!matchup) return null;

  const teams = matchup.split(/\s+(?:@|at|vs\.?)\s+/i);
  if (teams.length !== 2) return null;

  // Find numeric cells that look like American odds or totals
  const numericCells = cells.filter(c => /^[-+]?\d+(\.\d+)?$/.test(c.trim()));

  return {
    date: normalizeDate(dateMatch),
    teamA: teams[0].trim(),
    teamB: teams[1].trim(),
    rawCells: cells,
    numericValues: numericCells.map(Number),
  };
}

// ============================================================================
// HTML helpers
// ============================================================================

function extractTables(html) {
  const tables = [];
  const re = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) tables.push(m[1]);
  return tables;
}

function extractRows(tableHtml) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellM;
    while ((cellM = cellRe.exec(m[1])) !== null) cells.push(cellM[1]);
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(raw) {
  if (!raw) return null;
  const iso = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // "April 20, 2024" etc.
  const longFmt = raw.match(/([A-Z][a-z]+)\s+(\d+),?\s*(\d{4})/);
  if (longFmt) {
    const months = { January: '01', February: '02', March: '03', April: '04',
                     May: '05', June: '06', July: '07', August: '08',
                     September: '09', October: '10', November: '11', December: '12' };
    const mm = months[longFmt[1]];
    if (mm) return `${longFmt[3]}-${mm}-${longFmt[2].padStart(2, '0')}`;
  }
  return raw;
}

// ============================================================================
// Fetch helper
// ============================================================================

/**
 * Fetch a sportsoddshistory playoff page for a given year.
 * @param {number} year - e.g. 2019 for 2018-19 playoffs
 * @param {Function} [fetchImpl] - for testing
 */
export async function fetchSohPlayoffs(year, fetchImpl = fetch) {
  const url = `${SOH_BASE}${year}-stanley-cup-playoffs`;
  const resp = await fetchImpl(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!resp.ok) throw new Error(`SOH fetch failed for ${year}: ${resp.status}`);
  const html = await resp.text();
  return parseSohPlayoffs(html);
}

// ============================================================================
// Team name normalizer (SOH uses full names; we want abbrevs)
// ============================================================================

export function normalizeSohTeam(name) {
  if (!name) return null;
  const clean = name.trim();
  const map = {
    'Anaheim Ducks': 'ANA', 'Arizona Coyotes': 'UTA', 'Boston Bruins': 'BOS',
    'Buffalo Sabres': 'BUF', 'Calgary Flames': 'CGY', 'Carolina Hurricanes': 'CAR',
    'Chicago Blackhawks': 'CHI', 'Colorado Avalanche': 'COL',
    'Columbus Blue Jackets': 'CBJ', 'Dallas Stars': 'DAL',
    'Detroit Red Wings': 'DET', 'Edmonton Oilers': 'EDM',
    'Florida Panthers': 'FLA', 'Los Angeles Kings': 'LAK',
    'Minnesota Wild': 'MIN', 'Montreal Canadiens': 'MTL',
    'Nashville Predators': 'NSH', 'New Jersey Devils': 'NJD',
    'New York Islanders': 'NYI', 'New York Rangers': 'NYR',
    'Ottawa Senators': 'OTT', 'Philadelphia Flyers': 'PHI',
    'Phoenix Coyotes': 'UTA', 'Pittsburgh Penguins': 'PIT',
    'San Jose Sharks': 'SJS', 'Seattle Kraken': 'SEA',
    'St. Louis Blues': 'STL', 'St Louis Blues': 'STL',
    'Tampa Bay Lightning': 'TBL', 'Toronto Maple Leafs': 'TOR',
    'Utah Hockey Club': 'UTA', 'Utah Mammoth': 'UTA',
    'Vancouver Canucks': 'VAN', 'Vegas Golden Knights': 'VGK',
    'Washington Capitals': 'WSH', 'Winnipeg Jets': 'WPG',
  };
  if (map[clean]) return map[clean];
  if (clean.length === 3) return clean.toUpperCase();
  return null;
}
