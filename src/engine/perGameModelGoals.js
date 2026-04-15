// ============================================================================
// GOALS-BASED PER-GAME MODEL (v2: round-adjusted)
// ============================================================================
// Successor to v1 after 104-series backtest showed R2 collapse (36% accuracy).
//
// Changes from v1:
//  1. Round-scaled league-average baselines (R2+ opponents are above-average,
//     so scaling opponent GA by static league avg overestimates weak teams)
//  2. Round-scaled home ice advantage (attenuated in later rounds)
//  3. Optional R1-performance adjustment for R2+ predictions (hot/cold carry)
//  4. Configurable fall-back to season-long special teams (less noisy than
//     roll_30 at end of regular season)
//
// All four fixes are controlled by the cfg object passed to
// buildPerGameModelGoals. Defaults match the fix; pass {v1: true} to
// reproduce original behavior for A/B comparison.
// ============================================================================

import { HISTORICAL_BASE_RATES } from '../config.js';
import { clamp } from './util.js';
import { kopitarMotivationAdjustment } from '../features/kopitarMotivation.js';

// Baseline league averages (regular season; we adjust per round below)
const BASE_LEAGUE_GA = 2.95;
const BASE_LEAGUE_GF = 2.95;
const BASE_LEAGUE_PP = 0.205;
const PLAYOFF_SCORING_DAMPENER = 0.956;

// Round-specific baseline scalars. R1 teams are the full league range;
// R2 teams are stronger than average (survived R1); R3/R4 stronger still.
// These multipliers adjust the league-avg baselines we compare teams against.
const ROUND_LEAGUE_GA_SCALAR = { 1: 1.00, 2: 0.92, 3: 0.88, 4: 0.85 };
const ROUND_LEAGUE_GF_SCALAR = { 1: 1.00, 2: 1.04, 3: 1.06, 4: 1.08 };

// Home ice advantage multiplier by round. R1 has full HIA; later rounds
// have diminished HIA (research suggests travel/rest advantages dominate
// later-round matchups).
const ROUND_HIA_SCALAR = { 1: 1.00, 2: 0.80, 3: 0.65, 4: 0.50 };

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

function computeZigZagAdjustment(homeTeam, awayTeam, seriesState) {
  const lastGame = seriesState?.gamesPlayed?.slice(-1)[0];
  if (!lastGame) return { homeBoost: 0, awayBoost: 0 };
  const homeJustLost = lastGame.winner !== homeTeam;
  const awayJustLost = lastGame.winner !== awayTeam;
  return {
    homeBoost: homeJustLost ? 0.02 : 0,
    awayBoost: awayJustLost ? 0.02 : 0,
  };
}

function computeEliminationBoost(homeTeam, awayTeam, seriesState) {
  if (!seriesState) return { homeBoost: 0, awayBoost: 0 };
  const { teamA, teamB, winsA, winsB } = seriesState;
  const homeIsA = homeTeam === teamA;
  const homeWins = homeIsA ? winsA : winsB;
  const awayWins = homeIsA ? winsB : winsA;
  const homeFacingElim = homeWins === 3 ? false : (awayWins === 3);
  const awayFacingElim = awayWins === 3 ? false : (homeWins === 3);
  return {
    homeBoost: homeFacingElim ? 0.03 : 0,
    awayBoost: awayFacingElim ? 0.03 : 0,
  };
}

function computeTravelAdjustment() {
  return -0.005;
}

/**
 * Special teams: use season_long_pp_pct if available in features, fall back
 * to roll_30-derived pp_pct. Season-long is less noisy and more predictive.
 */
function getTeamPp(teamFeatures) {
  return teamFeatures.season_long_pp_pct
      ?? teamFeatures.pp_pct
      ?? BASE_LEAGUE_PP;
}

function computeSpecialTeamsMultiplier(team, opponent) {
  const teamPp = getTeamPp(team);
  const oppPp = getTeamPp(opponent);
  const ppBoost = (teamPp - BASE_LEAGUE_PP) * 0.3;
  const pkWeakness = (oppPp - BASE_LEAGUE_PP) * 0.1;
  return 1 + ppBoost + pkWeakness;
}

/**
 * Round-scaled league baselines. Needs `round` from series state.
 */
function getRoundScaledLeagueBaselines(round = 1) {
  const gaScalar = ROUND_LEAGUE_GA_SCALAR[round] ?? 0.85;
  const gfScalar = ROUND_LEAGUE_GF_SCALAR[round] ?? 1.08;
  return {
    leagueGA: BASE_LEAGUE_GA * gaScalar,
    leagueGF: BASE_LEAGUE_GF * gfScalar,
  };
}

/**
 * R1-performance carry: teams that won R1 in 4-5 games get a small boost
 * going into R2. Teams that needed 7 games get penalized (banged up).
 * Requires features.r1_wins and features.r1_losses if present.
 */
function getR1CarryMultiplier(teamFeatures, currentRound) {
  if (currentRound <= 1) return 1.0;
  if (teamFeatures.r1_wins == null || teamFeatures.r1_losses == null) return 1.0;

  const { r1_wins, r1_losses } = teamFeatures;
  const gamesPlayed = r1_wins + r1_losses;

  if (gamesPlayed <= 5) return 1.03;       // swept or 4-1: +3%
  if (gamesPlayed === 6) return 1.00;      // neutral
  return 0.97;                             // 4-3: -3% (attrition)
}

/**
 * Build a per-game model function (closure over global parameters).
 */
export function buildPerGameModelGoals({ teamFeatures, goalieFeatures = {}, cfg = {} } = {}) {
  if (!teamFeatures) {
    throw new Error('buildPerGameModelGoals requires teamFeatures');
  }
  const v1Compatible = !!cfg.v1;

  return function perGameModel({ homeTeam, awayTeam, gameNum, seriesState }) {
    const home = teamFeatures[homeTeam];
    const away = teamFeatures[awayTeam];
    if (!home) throw new Error(`No features for home team ${homeTeam}`);
    if (!away) throw new Error(`No features for away team ${awayTeam}`);

    const round = seriesState?.round ?? 1;

    // Round-adjusted league baselines (v2 fix; v1 uses static baselines)
    const baselines = v1Compatible
      ? { leagueGA: BASE_LEAGUE_GA, leagueGF: BASE_LEAGUE_GF }
      : getRoundScaledLeagueBaselines(round);

    let homeLambda = (home.goals_for_per_game ?? baselines.leagueGF) *
      ((away.goals_against_per_game ?? baselines.leagueGA) / baselines.leagueGA);
    let awayLambda = (away.goals_for_per_game ?? baselines.leagueGF) *
      ((home.goals_against_per_game ?? baselines.leagueGA) / baselines.leagueGA);

    homeLambda *= PLAYOFF_SCORING_DAMPENER;
    awayLambda *= PLAYOFF_SCORING_DAMPENER;

    // R1 carry-forward (v2 fix; no-op if features don't include r1 stats)
    if (!v1Compatible) {
      homeLambda *= getR1CarryMultiplier(home, round);
      awayLambda *= getR1CarryMultiplier(away, round);
    }

    homeLambda *= computeSpecialTeamsMultiplier(home, away);
    awayLambda *= computeSpecialTeamsMultiplier(away, home);

    const homeGoalieId = home.default_goalie_id;
    const awayGoalieId = away.default_goalie_id;
    const homeGoalieQuality = goalieFeatures[homeGoalieId]?.quality ?? 1.0;
    const awayGoalieQuality = goalieFeatures[awayGoalieId]?.quality ?? 1.0;
    awayLambda /= homeGoalieQuality;
    homeLambda /= awayGoalieQuality;

    const hia = computeRoundHomeIceAdvantage(seriesState, gameNum);
    homeLambda *= (1 + hia.homeLambdaBoost);

    let homeWinProb = homeWinProbabilityFromLambdas(homeLambda, awayLambda, hia.overtimeHomeEdge);

    const zigzag = computeZigZagAdjustment(homeTeam, awayTeam, seriesState);
    homeWinProb += zigzag.homeBoost - zigzag.awayBoost;

    const elim = computeEliminationBoost(homeTeam, awayTeam, seriesState);
    homeWinProb += elim.homeBoost - elim.awayBoost;

    homeWinProb += computeTravelAdjustment();

    homeWinProb += kopitarMotivationAdjustment({ homeTeam, awayTeam, seriesState });

    homeWinProb = clamp(homeWinProb, 0.05, 0.95);

    return {
      homeWinProb,
      awayWinProb: 1 - homeWinProb,
      expectedTotalGoals: homeLambda + awayLambda,
      homeLambda,
      awayLambda,
      modelVariant: v1Compatible ? 'goals-v1' : 'goals-v2',
    };
  };
}

export {
  poissonPmf,
  homeWinProbabilityFromLambdas,
  computeRoundHomeIceAdvantage,
  computeZigZagAdjustment,
  computeEliminationBoost,
  computeSpecialTeamsMultiplier,
  getRoundScaledLeagueBaselines,
  getR1CarryMultiplier,
  BASE_LEAGUE_GA,
  BASE_LEAGUE_GF,
  BASE_LEAGUE_PP as LEAGUE_AVG_PP_PCT,
  BASE_LEAGUE_GA as LEAGUE_AVG_GA_PER_GAME,
  BASE_LEAGUE_GF as LEAGUE_AVG_GF_PER_GAME,
  PLAYOFF_SCORING_DAMPENER,
};
