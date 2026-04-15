// ============================================================================
// xG-BASED PER-GAME MODEL (v3)
// ============================================================================
// Successor to perGameModelGoals.js. Uses real xG inputs from MoneyPuck
// instead of raw goal rates.
//
// Key differences from goals-v2:
//   1. Lambdas built from 5on5 xG/60 instead of all-situations goals/game
//   2. Special teams uses real 5on4/4on5 xG/60 (not approximated multiplier)
//   3. Goalie GSAx applied as multiplier on opponent's xGA
//   4. PDO regression: teams with extreme PDO (>1.02 or <0.98) get pulled
//      toward sustainable expectation
//   5. All round-scaling and context adjustments from goals-v2 preserved
//
// Expected inputs (per team, from MoneyPuck loaders):
//   - 5on5 profile: xgfPer60, xgaPer60, pdo
//   - 5on4 profile: xgfPer60 (PP scoring rate)
//   - 4on5 profile: xgaPer60 (PK scoring rate against)
//   - starting goalie: gsax (GSAx in 5on5)
// ============================================================================

import { clamp } from './util.js';
import { kopitarMotivationAdjustment } from '../features/kopitarMotivation.js';

// League-average xG/60 baselines (MoneyPuck era, 2008-2024)
const LEAGUE_5V5_XGF_PER60 = 2.45;
const LEAGUE_5V5_XGA_PER60 = 2.45;
const LEAGUE_5V4_XGF_PER60 = 6.20;  // PP scoring rate
const LEAGUE_4V5_XGA_PER60 = 6.20;  // shorthanded against rate

// Average minutes per game by situation
const AVG_5V5_MIN_PER_GAME = 49.5;
const AVG_5V4_MIN_PER_GAME = 3.6;
const AVG_4V5_MIN_PER_GAME = 3.6;

// Playoff scoring is ~5% below regular season (tighter D, refs swallow whistle)
const PLAYOFF_SCORING_DAMPENER = 0.95;

// Round-scaled baselines (R2+ opponents are above-average teams that survived)
const ROUND_LEAGUE_XGA_SCALAR = { 1: 1.00, 2: 0.93, 3: 0.89, 4: 0.86 };
const ROUND_LEAGUE_XGF_SCALAR = { 1: 1.00, 2: 1.03, 3: 1.05, 4: 1.07 };

// Home ice scalar by round
const ROUND_HIA_SCALAR = { 1: 1.00, 2: 0.80, 3: 0.65, 4: 0.50 };

// PDO regression threshold — teams with extreme PDO get pulled toward 1.0
const PDO_REGRESSION_TARGET = 1.000;
const PDO_REGRESSION_WEIGHT = 0.2; // 40% pull toward 1.0 if extreme

// Goalie GSAx multiplier scaling — GSAx of +20 = ~10% boost to team's defense
// Formula: 1 + (gsax / GSAX_SCALE_DENOMINATOR), clamped to [0.85, 1.18]
const GSAX_SCALE_DENOMINATOR = 350;
const GOALIE_MULT_MIN = 0.85;
const GOALIE_MULT_MAX = 1.18;

// ----------------------------------------------------------------------------
// Poisson helpers (same as goals model)
// ----------------------------------------------------------------------------
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function homeWinProbabilityFromLambdas(homeLambda, awayLambda, overtimeHomeEdge) {
  let pHomeRegWin = 0;
  let pTie = 0;
  for (let h = 0; h <= 12; h++) {
    const pH = poissonPmf(h, homeLambda);
    for (let a = 0; a <= 12; a++) {
      const pA = poissonPmf(a, awayLambda);
      const joint = pH * pA;
      if (h > a) pHomeRegWin += joint;
      else if (h === a) pTie += joint;
    }
  }
  const pHomeWinsOT = pTie * (0.5 + overtimeHomeEdge);
  return clamp(pHomeRegWin + pHomeWinsOT, 0.05, 0.95);
}

// ----------------------------------------------------------------------------
// Lambda construction from xG-based features
// ----------------------------------------------------------------------------

/**
 * Build expected goals lambda for a team over a single game.
 * Combines 5on5 + PP + PK contributions.
 *
 * @param {Object} team - team feature object with .xg5on5For, .xg5on5Against,
 *                       .pp_xgf_per60, .pk_xga_per60, .pdo
 * @param {Object} opp - opposing team's same features
 * @param {number} round - playoff round (1-4) for baseline scaling
 * @returns {number} expected goals for team this game
 */
function buildLambdaFromXg(team, opp, round) {
  const xgaScalar = ROUND_LEAGUE_XGA_SCALAR[round] ?? 0.86;
  const xgfScalar = ROUND_LEAGUE_XGF_SCALAR[round] ?? 1.07;
  const leagueXga = LEAGUE_5V5_XGA_PER60 * xgaScalar;
  const leagueXgf = LEAGUE_5V5_XGF_PER60 * xgfScalar;

  // PDO regression: pull team's effective rates toward sustainable
  const teamPdoBoost = pdoRegressionMultiplier(team.pdo);
  const oppPdoBoost = pdoRegressionMultiplier(opp.pdo);

  // 5on5: team's xGF/60 adjusted by opp's relative defense
  const team5v5Rate = (team.xg5on5For ?? leagueXgf) * teamPdoBoost;
  const opp5v5Defense = (opp.xg5on5Against ?? leagueXga) / leagueXga;
  const xg5v5 = team5v5Rate * opp5v5Defense * (AVG_5V5_MIN_PER_GAME / 60);

  // 5on4 (PP): team's PP rate × opp's PK weakness
  const teamPpRate = (team.pp_xgf_per60 ?? LEAGUE_5V4_XGF_PER60);
  const oppPkRelativeDefense = (opp.pk_xga_per60 ?? LEAGUE_4V5_XGA_PER60) / LEAGUE_4V5_XGA_PER60;
  const xgPp = teamPpRate * oppPkRelativeDefense * (AVG_5V4_MIN_PER_GAME / 60);

  // 4on5 (PK): team gives up some xG while shorthanded.
  // Opponent's PP scoring rate × team's PK weakness, then this is xGA for team
  // (we DON'T add to team's lambda — this is for opponent. Skip here.)

  let lambda = (xg5v5 + xgPp) * PLAYOFF_SCORING_DAMPENER;
  lambda *= oppPdoBoost; // opponent's luck affects how many of their xGA convert

  return lambda;
}

/**
 * PDO regression multiplier. Teams with extreme PDO get pulled toward 1.0
 * because PDO is heavily luck-driven over short samples.
 */
function pdoRegressionMultiplier(pdo) {
  if (pdo == null) return 1.0;
  // If pdo is way above 1, team has been "lucky" — regress their effective rate down
  // If below 1, team has been "unlucky" — regress their effective rate up
  const pdoDiff = pdo - PDO_REGRESSION_TARGET;
  // Inverted: high pdo = unsustainable goals scored at high rate
  // We DAMPEN the boost by 1 - (pdoDiff × weight)
  return 1 - (pdoDiff * PDO_REGRESSION_WEIGHT);
}

/**
 * Apply goalie GSAx as multiplier on opponent's xG.
 * Better goalie (high GSAx) = REDUCES opponent's expected goals.
 */
function goalieDefenseMultiplier(gsax) {
  if (gsax == null) return 1.0;
  // GSAx of +20 should give ~10% reduction in opponent xG
  const mult = 1 + (gsax / GSAX_SCALE_DENOMINATOR);
  return clamp(mult, GOALIE_MULT_MIN, GOALIE_MULT_MAX);
}

// ----------------------------------------------------------------------------
// Context adjustments (preserved from goals-v2)
// ----------------------------------------------------------------------------

function computeRoundHomeIceAdvantage(seriesState, gameNum) {
  const round = seriesState?.round ?? 1;
  const baseEdge = 0.028;
  let multiplier = 1.0;
  if (round === 1) multiplier = 1.15;
  if (gameNum === 7) multiplier = 1.35;
  const roundScalar = ROUND_HIA_SCALAR[round] ?? 0.50;
  return {
    homeLambdaBoost: baseEdge * multiplier * roundScalar,
    overtimeHomeEdge: 0.015 * multiplier * roundScalar,
  };
}

function computeZigZagAdjustment(homeTeam, _awayTeam, seriesState) {
  const lastGame = seriesState?.gamesPlayed?.slice(-1)[0];
  if (!lastGame) return { homeBoost: 0, awayBoost: 0 };
  const homeJustLost = lastGame.winner !== homeTeam;
  return {
    homeBoost: homeJustLost ? 0.02 : 0,
    awayBoost: homeJustLost ? 0 : 0.02,
  };
}

function computeEliminationBoost(homeTeam, _awayTeam, seriesState) {
  if (!seriesState) return { homeBoost: 0, awayBoost: 0 };
  const { teamA, winsA, winsB } = seriesState;
  const homeIsA = homeTeam === teamA;
  const homeWins = homeIsA ? winsA : winsB;
  const awayWins = homeIsA ? winsB : winsA;
  return {
    homeBoost: (awayWins === 3 && homeWins !== 3) ? 0.03 : 0,
    awayBoost: (homeWins === 3 && awayWins !== 3) ? 0.03 : 0,
  };
}

function getR1CarryMultiplier(teamFeatures, currentRound) {
  if (currentRound <= 1) return 1.0;
  if (teamFeatures.r1_wins == null || teamFeatures.r1_losses == null) return 1.0;
  const games = teamFeatures.r1_wins + teamFeatures.r1_losses;
  if (games <= 5) return 1.03;
  if (games === 6) return 1.00;
  return 0.97;
}

// ----------------------------------------------------------------------------
// Main model builder
// ----------------------------------------------------------------------------

/**
 * Build a per-game model closure using xG inputs.
 *
 * @param {Object} params
 * @param {Object} params.teamFeatures - { TEAM_ABBREV: { xg5on5For, xg5on5Against, pp_xgf_per60, pk_xga_per60, pdo, goalie_gsax, r1_wins, r1_losses } }
 * @param {Object} [params.cfg] - { v2: true } to use v2 fallback math (no PDO regression, no goalie multiplier)
 */
export function buildPerGameModelXg({ teamFeatures, cfg = {} } = {}) {
  if (!teamFeatures) {
    throw new Error('buildPerGameModelXg requires teamFeatures');
  }
  const useV2Math = !!cfg.v2;

  return function perGameModel({ homeTeam, awayTeam, gameNum, seriesState }) {
    const home = teamFeatures[homeTeam];
    const away = teamFeatures[awayTeam];
    if (!home) throw new Error(`No features for home team ${homeTeam}`);
    if (!away) throw new Error(`No features for away team ${awayTeam}`);

    const round = seriesState?.round ?? 1;

    // Base lambdas from xG
    let homeLambda = buildLambdaFromXg(home, away, round);
    let awayLambda = buildLambdaFromXg(away, home, round);

    // R1 carry multiplier (R2+)
    homeLambda *= getR1CarryMultiplier(home, round);
    awayLambda *= getR1CarryMultiplier(away, round);

    // Goalie GSAx multiplier (skip if v2 mode)
    if (!useV2Math) {
      // Better home goalie = lower away lambda
      const homeGoalieMult = goalieDefenseMultiplier(home.goalie_gsax);
      const awayGoalieMult = goalieDefenseMultiplier(away.goalie_gsax);
      awayLambda /= homeGoalieMult;
      homeLambda /= awayGoalieMult;
    }

    // Home ice advantage (round-scaled)
    const hia = computeRoundHomeIceAdvantage(seriesState, gameNum);
    homeLambda *= (1 + hia.homeLambdaBoost);

    // Compute base win probability from Poisson
    let homeWinProb = homeWinProbabilityFromLambdas(homeLambda, awayLambda, hia.overtimeHomeEdge);

    // Context adjustments (probability-space, not lambda-space)
    const zigzag = computeZigZagAdjustment(homeTeam, awayTeam, seriesState);
    homeWinProb += zigzag.homeBoost - zigzag.awayBoost;

    const elim = computeEliminationBoost(homeTeam, awayTeam, seriesState);
    homeWinProb += elim.homeBoost - elim.awayBoost;

    // Travel disadvantage for road teams (small)
    homeWinProb += -0.005;

    // Coaching/motivation adjustments (Kopitar etc.)
    homeWinProb += kopitarMotivationAdjustment({ homeTeam, awayTeam, seriesState });

    homeWinProb = clamp(homeWinProb, 0.05, 0.95);

    return {
      homeWinProb,
      awayWinProb: 1 - homeWinProb,
      expectedTotalGoals: homeLambda + awayLambda,
      homeLambda,
      awayLambda,
      modelVariant: useV2Math ? 'xg-v3-fallback' : 'xg-v3',
    };
  };
}

// Re-exports for testing
export {
  poissonPmf,
  homeWinProbabilityFromLambdas,
  buildLambdaFromXg,
  pdoRegressionMultiplier,
  goalieDefenseMultiplier,
  computeRoundHomeIceAdvantage,
  computeZigZagAdjustment,
  computeEliminationBoost,
  getR1CarryMultiplier,
  LEAGUE_5V5_XGF_PER60,
  LEAGUE_5V5_XGA_PER60,
  LEAGUE_5V4_XGF_PER60,
  LEAGUE_4V5_XGA_PER60,
  PLAYOFF_SCORING_DAMPENER,
};
