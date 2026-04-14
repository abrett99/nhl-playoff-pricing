// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
// Single source of truth for all magic numbers, thresholds, API endpoints,
// and team lists. If you find yourself hardcoding something anywhere else,
// it belongs here instead.
// ============================================================================

export const SEASON = {
  CURRENT: '20252026',
  CURRENT_START_YEAR: 2025,
};

export const GAME_TYPE = {
  PRESEASON: 1,
  REGULAR: 2,
  PLAYOFF: 3,
};

// Known NHL team abbrevs. Used in identity sanity checks.
export const NHL_TEAMS = [
  'ANA','BOS','BUF','CAR','CBJ','CGY','CHI','COL','DAL','DET',
  'EDM','FLA','LAK','MIN','MTL','NJD','NSH','NYI','NYR','OTT',
  'PHI','PIT','SEA','SJS','STL','TBL','TOR','UTA','VAN','VGK',
  'WPG','WSH',
];

// 2-2-1-1-1 venue sequence from higher-seed perspective (has home ice)
// 'A' = team with home ice, 'B' = opponent
export const VENUE_SEQUENCE = ['A', 'A', 'B', 'B', 'A', 'B', 'A'];

// ============================================================================
// SEMANTIC RANGES — Layer 3 sanity checks
// Any value outside these bands is flagged as likely corrupt/parsed-wrong
// ============================================================================

export const SEMANTIC_RANGES = {
  team_xgf_per_60:       [1.5, 4.5],
  team_xga_per_60:       [1.5, 4.5],
  team_cf_pct:           [35, 65],
  team_gf_per_60:        [1.5, 5.0],
  team_ga_per_60:        [1.5, 5.0],
  team_pp_pct:           [5, 45],
  team_pk_pct:           [65, 95],
  team_games_played:     [0, 82],
  team_wins:             [0, 82],
  team_points:           [0, 164],
  goalie_gsax_per_60:    [-1.5, 1.5],
  goalie_save_pct:       [0.85, 0.95],
  goalie_games_played:   [0, 82],
  ml_american_odds:      [-10000, 10000],
  total_line:            [4.5, 8.0],
  series_total_line:     [4.5, 6.5],
  implied_prob:          [0.01, 0.99],
  vig:                   [0.01, 0.15],
  player_ice_time:       [0, 8000], // seconds
};

// ============================================================================
// BASE RATES — for validation of MC output
// If our series MC disagrees wildly with these, something's wrong
// ============================================================================

export const HISTORICAL_BASE_RATES = {
  home_team_reg_season_win_pct: 0.545,
  home_team_playoff_win_pct: 0.555,
  game7_home_win_pct: 0.581,
  game7_first_goal_win_pct: 0.75,
  playoff_first_goal_win_pct: 0.70,
  comeback_from_3_0_pct: 0.021,  // 4/~190 series
  comeback_from_3_1_pct: 0.185,
  series_reaches_game_7_pct: 0.26,
  playoff_scoring_dampener: 0.956, // multiplier vs reg season (~4.4% drop)
  single_game_accuracy_ceiling: 0.62,
  series_accuracy_ceiling: 0.75,
};

// ============================================================================
// NHL API ENDPOINTS
// ============================================================================

export const NHL_API = {
  BASE: 'https://api-web.nhle.com/v1',
  STATS_BASE: 'https://api.nhle.com/stats/rest/en',
  endpoints: {
    schedule: (date) => `https://api-web.nhle.com/v1/schedule/${date}`,
    standings: () => `https://api-web.nhle.com/v1/standings/now`,
    playoffBracket: (year) => `https://api-web.nhle.com/v1/playoff-bracket/${year}`,
    playoffCarousel: (season) => `https://api-web.nhle.com/v1/playoff-series/carousel/${season}`,
    playoffSeries: (season, letter) => `https://api-web.nhle.com/v1/schedule/playoff-series/${season}/${letter}`,
    boxscore: (gameId) => `https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`,
    playByPlay: (gameId) => `https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`,
    gameLanding: (gameId) => `https://api-web.nhle.com/v1/gamecenter/${gameId}/landing`,
  },
};

// ============================================================================
// NATURAL STAT TRICK URL BUILDER
// ============================================================================

export function nstTeamUrl({ fromSeason, thruSeason, situation = 'sva', stype = 3, gpf = 410 }) {
  return `https://www.naturalstattrick.com/teamtable.php?` +
    `fromseason=${fromSeason}&thruseason=${thruSeason}&stype=${stype}` +
    `&sit=${situation}&score=all&rate=y&team=all&loc=B&gpf=${gpf}&fd=&td=`;
}

export function nstGoalieUrl({ fromSeason, thruSeason, stype = 3 }) {
  return `https://www.naturalstattrick.com/playerteams.php?` +
    `fromseason=${fromSeason}&thruseason=${thruSeason}&stype=${stype}` +
    `&sit=all&score=all&stdoi=std&rate=n&team=ALL&pos=G&loc=B&toi=0` +
    `&gpfilt=none&fd=&td=&tgp=410&lines=single&draftteam=ALL`;
}

// ============================================================================
// MONEYPUCK ENDPOINTS
// ============================================================================

export const MONEYPUCK = {
  allTeamsByGame: 'https://moneypuck.com/moneypuck/playerData/careers/gameByGame/all_teams.csv',
  playoffsSkaters: (year) => `https://moneypuck.com/moneypuck/playerData/seasonSummary/${year}/playoffs/skaters.csv`,
  playoffsGoalies: (year) => `https://moneypuck.com/moneypuck/playerData/seasonSummary/${year}/playoffs/goalies.csv`,
  playoffsTeams: (year) => `https://moneypuck.com/moneypuck/playerData/seasonSummary/${year}/playoffs/teams.csv`,
  shotZip: (year) => `https://peter-tanner.com/moneypuck/downloads/shots_${year}.zip`,
};

// ============================================================================
// ODDS API
// ============================================================================

export const ODDS_API = {
  base: 'https://api.the-odds-api.com/v4',
  sport: 'icehockey_nhl',
  h2hTotalsSpreads: (key) => `https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds/?apiKey=${key}&regions=us&markets=h2h,totals,spreads&bookmakers=draftkings,fanduel,betmgm,caesars`,
  pinnacle: (key) => `https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds/?apiKey=${key}&regions=eu&markets=h2h,totals&bookmakers=pinnacle`,
  outrights: (key) => `https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds/?apiKey=${key}&regions=us&markets=outrights&bookmakers=draftkings,fanduel,betmgm,caesars,pinnacle`,
};

// ============================================================================
// ALERT THRESHOLDS
// ============================================================================

export const ALERT_THRESHOLDS = {
  MIN_EDGE_PCT_FOR_ALERT: 0.05,
  EDGE_CHANGE_PCT_FOR_RE_ALERT: 0.02,
  RE_ALERT_COOLDOWN_MINUTES: 30,
  CLV_CAPTURE_MINUTES_BEFORE_GAME: 5,
};

// ============================================================================
// BET SIZING
// ============================================================================

export const BET_SIZING = {
  KELLY_FRACTION: 0.25,
  MAX_BET_PCT_OF_BANKROLL: 0.02,
  MIN_BET_STAKE: 10,
};

// ============================================================================
// MODEL PARAMETERS
// ============================================================================

export const MODEL = {
  MC_TRIALS: 50000,
  MC_DROPOUT_SAMPLES: 10,
  BOOTSTRAP_RESAMPLES: 1000,
  MIN_GAMES_FOR_CALIBRATION: 100,
  EDGE_PROBABILITY_FLOOR: 0.05,
  EDGE_PROBABILITY_CEILING: 0.95,
};
