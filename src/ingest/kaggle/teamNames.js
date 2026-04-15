// ============================================================================
// KAGGLE TEAM NAME MAPPER
// ============================================================================
// Maps full team names (as they appear in Kaggle CSVs) to our 3-letter
// abbreviations. Handles historical relocations across the 2004-2024 window.
//
// Design notes:
// - Kaggle uses full franchise names: "Toronto Maple Leafs"
// - Our codebase uses 3-letter abbreviations: "TOR"
// - Franchise relocations need era-aware mapping (Atlanta -> Winnipeg 2011,
//   Phoenix -> Arizona 2014, Arizona -> Utah 2024)
// - We normalize to the CURRENT franchise abbreviation so historical data
//   from Atlanta Thrashers rolls forward as "WPG" for continuity
// ============================================================================

// Direct name -> abbrev map. Covers all teams that have existed 2004-present.
const TEAM_NAME_TO_ABBREV = Object.freeze({
  // Current teams (active as of 2025-26)
  'Anaheim Ducks': 'ANA',
  'Anaheim Mighty Ducks': 'ANA',
  'Boston Bruins': 'BOS',
  'Buffalo Sabres': 'BUF',
  'Calgary Flames': 'CGY',
  'Carolina Hurricanes': 'CAR',
  'Chicago Blackhawks': 'CHI',
  'Colorado Avalanche': 'COL',
  'Columbus Blue Jackets': 'CBJ',
  'Dallas Stars': 'DAL',
  'Detroit Red Wings': 'DET',
  'Edmonton Oilers': 'EDM',
  'Florida Panthers': 'FLA',
  'Los Angeles Kings': 'LAK',
  'Minnesota Wild': 'MIN',
  'Montreal Canadiens': 'MTL',
  'Montréal Canadiens': 'MTL', // accented variant
  'Nashville Predators': 'NSH',
  'New Jersey Devils': 'NJD',
  'New York Islanders': 'NYI',
  'New York Rangers': 'NYR',
  'Ottawa Senators': 'OTT',
  'Philadelphia Flyers': 'PHI',
  'Pittsburgh Penguins': 'PIT',
  'San Jose Sharks': 'SJS',
  'Seattle Kraken': 'SEA',
  'St. Louis Blues': 'STL',
  'St Louis Blues': 'STL', // no-period variant
  'Tampa Bay Lightning': 'TBL',
  'Toronto Maple Leafs': 'TOR',
  'Vancouver Canucks': 'VAN',
  'Vegas Golden Knights': 'VGK',
  'Washington Capitals': 'WSH',
  'Winnipeg Jets': 'WPG',

  // Relocated/renamed teams - map to CURRENT franchise abbrev for continuity
  'Atlanta Thrashers': 'WPG',   // 1999-2011, moved to Winnipeg
  'Phoenix Coyotes': 'ARI',     // 1996-2014, renamed Arizona
  'Arizona Coyotes': 'UTA',     // 2014-2024, moved to Utah
  'Utah Hockey Club': 'UTA',    // 2024-present
  'Utah Mammoth': 'UTA',        // possible future rename
});

// Reverse lookup for tests and diagnostics
const ABBREV_TO_CANONICAL_NAME = Object.freeze({
  ANA: 'Anaheim Ducks',
  BOS: 'Boston Bruins',
  BUF: 'Buffalo Sabres',
  CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes',
  CHI: 'Chicago Blackhawks',
  COL: 'Colorado Avalanche',
  CBJ: 'Columbus Blue Jackets',
  DAL: 'Dallas Stars',
  DET: 'Detroit Red Wings',
  EDM: 'Edmonton Oilers',
  FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings',
  MIN: 'Minnesota Wild',
  MTL: 'Montreal Canadiens',
  NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils',
  NYI: 'New York Islanders',
  NYR: 'New York Rangers',
  OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers',
  PIT: 'Pittsburgh Penguins',
  SJS: 'San Jose Sharks',
  SEA: 'Seattle Kraken',
  STL: 'St. Louis Blues',
  TBL: 'Tampa Bay Lightning',
  TOR: 'Toronto Maple Leafs',
  VAN: 'Vancouver Canucks',
  VGK: 'Vegas Golden Knights',
  WSH: 'Washington Capitals',
  WPG: 'Winnipeg Jets',
  ARI: 'Arizona Coyotes',     // kept for historical lookup
  UTA: 'Utah Hockey Club',
});

/**
 * Map a full team name to its current franchise abbreviation.
 * Returns null for unknown teams (caller must handle).
 *
 * @param {string} fullName - Full team name like "Toronto Maple Leafs"
 * @returns {string|null} Three-letter abbreviation or null
 */
export function nameToAbbrev(fullName) {
  if (!fullName || typeof fullName !== 'string') return null;
  const trimmed = fullName.trim();
  return TEAM_NAME_TO_ABBREV[trimmed] ?? null;
}

/**
 * Map an abbreviation to a canonical full name (for display).
 * Returns null for unknown abbrevs.
 */
export function abbrevToName(abbrev) {
  if (!abbrev || typeof abbrev !== 'string') return null;
  return ABBREV_TO_CANONICAL_NAME[abbrev.toUpperCase()] ?? null;
}

/**
 * Era-aware mapping: given a team name and a season year, returns the
 * abbreviation that was ACTIVE at that time. Useful when historical analysis
 * needs the team-as-it-was rather than the current franchise.
 *
 * Example:
 *   historicalAbbrev('Atlanta Thrashers', 2010) -> 'ATL' (active at the time)
 *   historicalAbbrev('Atlanta Thrashers', 2012) -> 'WPG' (franchise moved)
 *
 * Our model default uses nameToAbbrev() which always maps to current franchise.
 * Use this only when you explicitly want period-correct abbrevs.
 */
export function historicalAbbrev(fullName, season) {
  if (!fullName || !season) return null;
  const trimmed = fullName.trim();

  if (trimmed === 'Atlanta Thrashers' && season < 2012) return 'ATL';
  if (trimmed === 'Phoenix Coyotes' && season < 2015) return 'PHX';
  if (trimmed === 'Arizona Coyotes' && season < 2025) return 'ARI';

  return nameToAbbrev(trimmed);
}

/**
 * List of all abbreviations in the current era (30 current + ARI for history).
 */
export const ALL_ABBREVS = Object.freeze([
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET',
  'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD', 'NYI', 'NYR', 'OTT',
  'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'VAN', 'VGK', 'WSH',
  'WPG', 'UTA', 'ARI',
]);

export { TEAM_NAME_TO_ABBREV, ABBREV_TO_CANONICAL_NAME };

