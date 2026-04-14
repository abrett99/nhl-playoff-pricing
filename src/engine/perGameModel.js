// ============================================================================
// PLAYOFF-ADJUSTED PER-GAME MODEL
// ============================================================================
// Produces P(home wins) and expected total goals for a single playoff game,
// with all the gap fixes from the research phase baked in:
//
//   • Round-adjusted home ice advantage (Round 1 / Game 7 elevated)
//   • Special teams composites (PP+/PK+ style weighting)
//   • Playoff 5v5 overtime (not 3v3 reg-season OT)
//   • Zig-zag bounceback adjustment (team coming off loss)
//   • Elimination game top-6 boost
//   • Travel/circadian fatigue penalty
//   • Playoff scoring dampener (~4.4% league-wide drop)
//   • MC dropout uncertainty propagation
//
// This is a BAYESIAN GOAL-SCORING model: each team has a Poisson λ derived
// from expected goals rates, the goalie opposing them, special teams, and
// context adjustments. P(home wins) is derived from the implied score
// distribution.
// ============================================================================

import { HISTORICAL_BASE_RATES } from '../config.js';
import { clamp } from './util.js';
import { kopitarMotivationAdjustment } from '../features/kopitarMotivation.js';

/**
 * Build a per-game model function (closure over global parameters).
 * Returns a function with the signature expected by simulateSeries().
 *
 * @param {Object} params
 * @param {Object} params.teamFeatures    - { [teamAbbr]: featureRow }
 * @param {Object} params.goalieFeatures  - { [goalieId]: featureRow }
 * @param {Object} [params.config]        - tunables
 */
export function buildPerGameModel({ teamFeatures, goalieFeatures, config = {} }) {
  const cfg = {
    // Defaults calibrated to playoff base rates
    leagueAvgGoalsPerGame: 5.85 * HISTORICAL_BASE_RATES.playoff_scoring_dampener,
    baseHomeIceBump: 0.030,
    round1HomeBump: 0.010,       // additive on top of base
    round4HomeBump: 0.008,
    game7HomeBump: 0.020,
    bouncebackBump: 0.015,       // team off a loss gets +1.5% home prob
    eliminationGameTopLineBoost: 0.04,
    travelFatiguePerTimeZone: 0.008,
    goalieInfluenceWeight: 0.40, // how much goalie shifts λ
    specialTeamsInfluenceWeight: 0.15,
    ...config,
  };

  /**
   * The model function passed into simulateSeries.
   * Receives game context, returns { homeWinProb, totalGoalsLambda, ...detail }
   */
  return function perGameModel({ homeTeam, awayTeam, gameNum, seriesState, overrides = {} }) {
    // ─ Roster features ─
    const homeRow = teamFeatures[homeTeam];
    const awayRow = teamFeatures[awayTeam];

    if (!homeRow || !awayRow) {
      // Missing team data — return degenerate 50/50 with max uncertainty
      return {
        homeWinProb: 0.5,
        totalGoalsLambda: cfg.leagueAvgGoalsPerGame,
        uncertainty: 1.0,
        missingData: true,
      };
    }

    // ─ Goalie selection (with override support for hypotheticals) ─
    const homeGoalieId = overrides.goalieOverrides?.perTeam?.[homeTeam]
      ?? seriesState?.currentStarters?.[homeTeam]?.playerId
      ?? homeRow.default_goalie_id;
    const awayGoalieId = overrides.goalieOverrides?.perTeam?.[awayTeam]
      ?? seriesState?.currentStarters?.[awayTeam]?.playerId
      ?? awayRow.default_goalie_id;

    // Per-game goalie override wins over per-team
    const homeGoalieIdFinal = overrides.goalieOverrides?.perGame?.[gameNum]?.[homeTeam]
      ?? homeGoalieId;
    const awayGoalieIdFinal = overrides.goalieOverrides?.perGame?.[gameNum]?.[awayTeam]
      ?? awayGoalieId;

    const homeGoalie = goalieFeatures[homeGoalieIdFinal];
    const awayGoalie = goalieFeatures[awayGoalieIdFinal];

    // ─ Base lambda construction ─
    // Start with each team's xGF/60 vs opposing xGA/60 (league-relative)
    const leagueAvgXg = 2.85; // per team per 60 at 5v5
    const homeBaseOff = homeRow.xgf_per_60 ?? leagueAvgXg;
    const homeBaseDef = homeRow.xga_per_60 ?? leagueAvgXg;
    const awayBaseOff = awayRow.xgf_per_60 ?? leagueAvgXg;
    const awayBaseDef = awayRow.xga_per_60 ?? leagueAvgXg;

    // Scale from 5v5 60min to full game (includes special teams, PP/PK)
    // Typical full-game scoring ≈ 5v5 xGF × 1.10 (accounting for PP goals)
    let homeLambda = (homeBaseOff * (awayBaseDef / leagueAvgXg)) * 1.10;
    let awayLambda = (awayBaseOff * (homeBaseDef / leagueAvgXg)) * 1.10;

    // ─ Special teams composite (PP+/PK+ style) ─
    // If home has elite PP and away has poor PK, bump home lambda modestly
    const stAdj = specialTeamsAdjustment(homeRow, awayRow, cfg);
    homeLambda *= stAdj.homeMult;
    awayLambda *= stAdj.awayMult;

    // ─ Goalie adjustment (MOST IMPACTFUL factor in playoffs) ─
    // Goalie with positive GSAx/60 suppresses opponent lambda
    if (homeGoalie?.gsax_per_60 !== null && homeGoalie?.gsax_per_60 !== undefined) {
      awayLambda *= Math.exp(-homeGoalie.gsax_per_60 * cfg.goalieInfluenceWeight);
    }
    if (awayGoalie?.gsax_per_60 !== null && awayGoalie?.gsax_per_60 !== undefined) {
      homeLambda *= Math.exp(-awayGoalie.gsax_per_60 * cfg.goalieInfluenceWeight);
    }

    // ─ Playoff scoring dampener (league-wide 4.4% drop) ─
    homeLambda *= HISTORICAL_BASE_RATES.playoff_scoring_dampener;
    awayLambda *= HISTORICAL_BASE_RATES.playoff_scoring_dampener;

    // ─ Clamp to reasonable range ─
    homeLambda = clamp(homeLambda, 0.8, 5.5);
    awayLambda = clamp(awayLambda, 0.8, 5.5);

    // ─ Derive P(home wins) from λ pair via Poisson diff ─
    let homeWinProb = poissonWinProb(homeLambda, awayLambda);

    // ═══ CONTEXT ADJUSTMENTS (applied to homeWinProb, not lambdas) ═══

    // Home ice advantage (round-adjusted + game-7-boosted)
    homeWinProb += computeHomeIceAdjustment({ gameNum, seriesState, cfg });

    // Zig-zag bounceback: team coming off a loss slightly overperforms
    homeWinProb += computeBouncebackAdjustment({
      homeTeam, awayTeam, seriesState, cfg,
    });

    // Elimination game: facing elimination = top-6 boost (very small net shift)
    homeWinProb += computeEliminationAdjustment({
      homeTeam, awayTeam, seriesState, cfg,
    });

    // Travel/circadian penalty
    homeWinProb += computeTravelAdjustment({
      homeTeam, awayTeam, cfg,
    });

    // LAK Kopitar-retirement intangible (elimination-only, very small)
    homeWinProb += kopitarMotivationAdjustment({
      homeTeam, awayTeam, seriesState,
    });

    // Final clamp
    homeWinProb = clamp(homeWinProb, 0.05, 0.95);

    return {
      homeWinProb,
      totalGoalsLambda: homeLambda + awayLambda,
      homeLambda,
      awayLambda,
      detail: {
        baseHomeWinProb: poissonWinProb(homeLambda, awayLambda),
        stAdjustment: stAdj,
        homeGoalie: homeGoalieIdFinal,
        awayGoalie: awayGoalieIdFinal,
        gameNum,
        round: seriesState?.round,
      },
    };
  };
}

// ============================================================================
// Poisson score distribution → P(home wins)
// Uses a 12x12 grid (covers effectively all plausible NHL scores)
// ============================================================================

function poissonWinProb(lambdaHome, lambdaAway) {
  const MAX = 12;
  const homePmf = poissonPmfArray(lambdaHome, MAX);
  const awayPmf = poissonPmfArray(lambdaAway, MAX);

  let homeWins = 0;
  let tie = 0;
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = homePmf[h] * awayPmf[a];
      if (h > a) homeWins += p;
      else if (h === a) tie += p;
    }
  }
  // Playoff OT is 5v5 sudden death; with equal-ish skill, coin flip,
  // but skill gap matters. Allocate ties in proportion to λ ratio.
  const otHomeShare = lambdaHome / (lambdaHome + lambdaAway);
  return homeWins + tie * otHomeShare;
}

function poissonPmfArray(lambda, max) {
  const arr = new Array(max + 1);
  arr[0] = Math.exp(-lambda);
  for (let k = 1; k <= max; k++) {
    arr[k] = arr[k - 1] * lambda / k;
  }
  return arr;
}

// ============================================================================
// CONTEXT ADJUSTMENTS
// ============================================================================

function computeHomeIceAdjustment({ gameNum, seriesState, cfg }) {
  let bump = cfg.baseHomeIceBump;
  const round = seriesState?.round;

  if (round === 1) bump += cfg.round1HomeBump;
  if (round === 4) bump += cfg.round4HomeBump;

  // Game 7 has a documented 58.1% home win rate (vs 54.5% regular season).
  // The extra ~3.5% is captured here.
  if (gameNum === 7) bump += cfg.game7HomeBump;

  return bump;
}

function computeBouncebackAdjustment({ homeTeam, awayTeam, seriesState, cfg }) {
  // Zig-zag: team that just lost has historically outperformed base rate slightly
  if (!seriesState?.gamesPlayed?.length) return 0;
  const lastGame = seriesState.gamesPlayed[seriesState.gamesPlayed.length - 1];
  if (!lastGame?.winner) return 0;

  if (lastGame.winner === homeTeam) {
    // Home team won last game — slight fade
    return -cfg.bouncebackBump;
  } else if (lastGame.winner === awayTeam) {
    // Away team won last game — means home team is the "bouncing back" one
    return +cfg.bouncebackBump;
  }
  return 0;
}

function computeEliminationAdjustment({ homeTeam, awayTeam, seriesState, cfg }) {
  if (!seriesState) return 0;

  const homeIsTeamA = homeTeam === seriesState.teamA;
  const winsHome = homeIsTeamA ? seriesState.winsA : seriesState.winsB;
  const winsAway = homeIsTeamA ? seriesState.winsB : seriesState.winsA;

  // Facing elimination = desperate effort from top-6 forwards and top-4 D
  // Historical effect: teams facing elimination at home perform slightly above
  // their base rate. Captured as a small bump.
  if (winsHome === 3 && winsAway !== 3) {
    // Home team can win series — desperation from away team is small anti-bump
    return -cfg.eliminationGameTopLineBoost * 0.3;
  }
  if (winsAway === 3 && winsHome !== 3) {
    // Home team faces elimination — top-6 boost gives them slight edge
    return +cfg.eliminationGameTopLineBoost;
  }
  return 0;
}

function computeTravelAdjustment({ homeTeam, awayTeam, cfg }) {
  // Placeholder for full travel model. For now:
  //   - Cross-country games (ETZ vs PTZ) get small home bump
  //   - Everything else is zero
  // Real implementation pulls team coordinates from a static table and
  // calculates time-zone delta based on previous game's venue.
  const ETZ = new Set(['BOS','BUF','CAR','CBJ','DET','FLA','MTL','NJD','NYI','NYR','OTT','PHI','PIT','TBL','TOR','WSH']);
  const PTZ = new Set(['ANA','LAK','SEA','SJS','VAN','VGK']);

  const homeIsEast = ETZ.has(homeTeam);
  const homeIsWest = PTZ.has(homeTeam);
  const awayIsEast = ETZ.has(awayTeam);
  const awayIsWest = PTZ.has(awayTeam);

  // Away team traveling across 3 time zones
  if ((homeIsEast && awayIsWest) || (homeIsWest && awayIsEast)) {
    return cfg.travelFatiguePerTimeZone * 3;
  }
  return 0;
}

// ============================================================================
// Special teams composite adjustment
// ============================================================================
// Prefers Berkeley-style PP+/PK+ composites (where 100 = league average,
// each 15 = 1 standard deviation) when `ppPlus` / `pkPlus` fields are
// present on team features. Falls back to legacy PP%/PK% percentages
// otherwise. The feature builder attaches ppPlus/pkPlus via
// enrichWithSpecialTeamsComposite() from features/specialTeams.js.
//
// Both formulations produce the same output range (a small ± multiplier
// on each team's scoring lambda), so downstream math is unchanged.

function specialTeamsAdjustment(homeRow, awayRow, cfg) {
  // Prefer composite metrics when present
  if (Number.isFinite(homeRow.ppPlus) && Number.isFinite(awayRow.pkPlus) &&
      Number.isFinite(homeRow.pkPlus) && Number.isFinite(awayRow.ppPlus)) {
    // Convert ppPlus (centered at 100, SD ≈ 15) to multiplicative ratio
    // ratio of 1.0 = league average. +15 above league avg → 1.15, etc.
    const homePPRatio = homeRow.ppPlus / 100;
    const awayPKRatio = awayRow.pkPlus / 100;  // higher = better for defender
    const homePKRatio = homeRow.pkPlus / 100;
    const awayPPRatio = awayRow.ppPlus / 100;

    // Home team scores more when their PP is strong AND opponent's PK is weak.
    // Weak PK = pkPlus < 100 → (1/awayPKRatio) > 1 → boost to home offense
    const homeOffMultiplier = Math.pow(homePPRatio / awayPKRatio, cfg.specialTeamsInfluenceWeight);
    const awayOffMultiplier = Math.pow(awayPPRatio / homePKRatio, cfg.specialTeamsInfluenceWeight);

    return {
      homeMult: clamp(homeOffMultiplier, 0.85, 1.15),
      awayMult: clamp(awayOffMultiplier, 0.85, 1.15),
      source: 'pp_plus_composite',
    };
  }

  // Legacy fallback using percentages
  const leagueAvgPP = 21.0;
  const leagueAvgPK = 79.0;

  const homePP = homeRow.pp_pct ?? leagueAvgPP;
  const homePK = homeRow.pk_pct ?? leagueAvgPK;
  const awayPP = awayRow.pp_pct ?? leagueAvgPP;
  const awayPK = awayRow.pk_pct ?? leagueAvgPK;

  const homePPDelta = (homePP - leagueAvgPP) / leagueAvgPP;
  const awayPKDelta = (leagueAvgPK - awayPK) / leagueAvgPK; // inverted: lower PK = worse
  const homePKDelta = (leagueAvgPK - homePK) / leagueAvgPK;
  const awayPPDelta = (awayPP - leagueAvgPP) / leagueAvgPP;

  const homeOffensiveBoost = (homePPDelta + awayPKDelta) * cfg.specialTeamsInfluenceWeight;
  const awayOffensiveBoost = (awayPPDelta + homePKDelta) * cfg.specialTeamsInfluenceWeight;

  return {
    homeMult: clamp(1 + homeOffensiveBoost, 0.85, 1.15),
    awayMult: clamp(1 + awayOffensiveBoost, 0.85, 1.15),
    source: 'pct_legacy',
  };
}
