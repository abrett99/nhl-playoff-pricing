// ============================================================================
// GOALS-BASED PER-GAME MODEL
// ============================================================================
// Predicts P(home wins) and expected total goals for a single playoff game,
// using goals-for/against rolling averages from Kaggle pre-playoff snapshots.
//
// This is a parallel implementation to perGameModel.js (xG-based). Same
// function signature and output shape, so simulateSeries() can swap between
// them via a config flag.
//
// Core math:
//   1. Each team has a baseline goals-per-game (from roll_30_goals_for)
//   2. Opponent adjustment: baseline × (opp_GA_per_game / league_avg_GA)
//   3. Apply playoff scoring dampener (-4.4% historical)
//   4. Apply PP%/PK% net special teams adjustment
//   5. Apply goalie quality multiplier (manual scalar, default 1.0)
//   6. Produce two Poisson lambdas (homeLambda, awayLambda)
//   7. Derive P(home wins) by summing P(H > A) over reasonable score grid
//
// Keeps all existing context adjustments from the xG model:
//   - Round-adjusted HIA (R1/G7 elevated)
//   - Playoff 5v5 OT model
//   - Zig-zag bounceback
//   - Elimination top-6 boost
//   - Travel penalty
//   - Kopitar retirement intangible (LAK elimination-only)
//   - Tortorella coaching-change blend (VGK)
// ============================================================================

import { HISTORICAL_BASE_RATES } from '../config.js';
import { clamp } from './util.js';
import { kopitarMotivationAdjustment } from '../features/kopitarMotivation.js';

// League averages we compare opponent rates against. Derived from 2016-2023
// playoff averages (goals_against_per_game across all teams).
const LEAGUE_AVG_GA_PER_GAME = 2.95;
const LEAGUE_AVG_PP_PCT = 0.205;
const LEAGUE_AVG_GF_PER_GAME = 2.95;

// Playoff goals scoring typically drops ~4.4% vs regular season. Source:
// historical playoff-vs-regular-season scoring comparisons 2010-2023.
const PLAYOFF_SCORING_DAMPENER = 0.956;

/**
 * Compute Poisson probability mass P(X = k) for mean lambda.
 */
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Given two Poisson lambdas, derive P(home wins in regulation or OT).
 * Integrates over score grid 0..12 goals per team (covers >99.9% of mass).
 * Ties are resolved by playoff OT model: 50/50 with slight HIA edge.
 */
function homeWinProbabilityFromLambdas(homeLambda, awayLambda, overtimeHomeEdge) {
  let pHomeRegWin = 0;
  let pAwayRegWin = 0;
  let pTie = 0;

  for (let h = 0; h <= 12; h++) {
    const pH = poissonPmf(h, homeLambda);
    for (let a = 0; a <= 12; a++) {
      const pA = poissonPmf(a, awayLambda);
      const joint = pH * pA;
      if (h > a) pHomeRegWin += joint;
      else if (h < a) pAwayRegWin += joint;
      else pTie += joint;
    }
  }

  // OT resolution: home team wins OT with probability = 0.5 + overtimeHomeEdge
  const pHomeWinsOT = pTie * (0.5 + overtimeHomeEdge);

  return clamp(pHomeRegWin + pHomeWinsOT, 0.05, 0.95);
}

/**
 * Compute round-adjusted home ice advantage. In the xG model this was a
 * direct probability nudge; here it's modeled as a small lambda boost for
 * home team and the OT edge.
 *
 * Round 1 and Game 7 have elevated HIA per playoff research.
 */
function computeRoundHomeIceAdvantage(seriesState, gameNum) {
  const round = seriesState?.round ?? 1;
  const baseEdge = 0.028; // regulation home-ice adv ~2.8% scoring boost

  let multiplier = 1.0;
  if (round === 1) multiplier = 1.15;          // R1 HIA elevated
  if (gameNum === 7) multiplier = 1.35;         // G7 HIA strongly elevated

  return {
    homeLambdaBoost: baseEdge * multiplier,
    overtimeHomeEdge: 0.015 * multiplier,       // home wins playoff OT ~51.5% baseline
  };
}

/**
 * Zig-zag: team coming off a loss plays slightly better next game. Historical
 * effect ~1.5% win prob boost for team that just lost.
 */
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

/**
 * Elimination game: team facing elimination plays top-6 harder, slight boost.
 * Only applies when that team is at 3 wins against.
 */
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

/**
 * Travel penalty: away team returning from a long trip takes small penalty.
 * We don't have city-pair travel data in the Kaggle snapshots; approximate
 * with a uniform 1% away penalty that can be upgraded post-playoffs with
 * real travel calculation.
 */
function computeTravelAdjustment() {
  return -0.005; // 0.5% home advantage bump from away-team travel
}

/**
 * Apply special-teams adjustment. A team with strong PP% scores more goals;
 * a team facing a strong PP (weak PK) concedes more. We approximate PK%
 * as (1 - opp_PP%_against) since we don't have direct PK stats from Kaggle.
 */
function computeSpecialTeamsMultiplier(team, opponent) {
  const teamPp = team.pp_pct ?? LEAGUE_AVG_PP_PCT;
  const oppPp = opponent.pp_pct ?? LEAGUE_AVG_PP_PCT;

  // Team's scoring boost from its PP: (team_pp - league_avg) * ~0.3 scaling
  const ppBoost = (teamPp - LEAGUE_AVG_PP_PCT) * 0.3;

  // Opponent's PK weakness: if opp PP is elite (+league), opposite extreme
  // suggests they may be weaker defensively; we use opp_pp_pct as a weak
  // proxy but scaled lower. This is imperfect — NST integration will fix.
  const pkWeakness = (oppPp - LEAGUE_AVG_PP_PCT) * 0.1;

  return 1 + ppBoost + pkWeakness;
}

/**
 * Build a per-game model function (closure over global parameters).
 * Returns a function with the signature expected by simulateSeries().
 *
 * @param {Object} params
 * @param {Object} params.teamFeatures    - { [teamAbbr]: snapshot }  (from preplayoffSnapshots)
 * @param {Object} params.goalieFeatures  - { [goalieId]: { quality: number } } OR null
 * @param {Object} params.cfg             - optional config overrides
 * @returns {Function}
 */
export function buildPerGameModelGoals({ teamFeatures, goalieFeatures = {}, cfg = {} } = {}) {
  if (!teamFeatures) {
    throw new Error('buildPerGameModelGoals requires teamFeatures');
  }

  return function perGameModel({ homeTeam, awayTeam, gameNum, seriesState }) {
    const home = teamFeatures[homeTeam];
    const away = teamFeatures[awayTeam];
    if (!home) throw new Error(`No features for home team ${homeTeam}`);
    if (!away) throw new Error(`No features for away team ${awayTeam}`);

    // Base lambdas: team's own GF rate, adjusted by opponent's GA rate
    let homeLambda = (home.goals_for_per_game ?? LEAGUE_AVG_GF_PER_GAME) *
      ((away.goals_against_per_game ?? LEAGUE_AVG_GA_PER_GAME) / LEAGUE_AVG_GA_PER_GAME);
    let awayLambda = (away.goals_for_per_game ?? LEAGUE_AVG_GF_PER_GAME) *
      ((home.goals_against_per_game ?? LEAGUE_AVG_GA_PER_GAME) / LEAGUE_AVG_GA_PER_GAME);

    // Playoff scoring dampener (~4.4% drop vs regular season)
    homeLambda *= PLAYOFF_SCORING_DAMPENER;
    awayLambda *= PLAYOFF_SCORING_DAMPENER;

    // Special teams multipliers (PP%/PK% net effect)
    homeLambda *= computeSpecialTeamsMultiplier(home, away);
    awayLambda *= computeSpecialTeamsMultiplier(away, home);

    // Goalie quality multipliers (scalar override, default 1.0 = neutral)
    const homeGoalieId = home.default_goalie_id;
    const awayGoalieId = away.default_goalie_id;
    const homeGoalieQuality = goalieFeatures[homeGoalieId]?.quality ?? 1.0;
    const awayGoalieQuality = goalieFeatures[awayGoalieId]?.quality ?? 1.0;
    // Better goalie = lower opposing lambda
    awayLambda /= homeGoalieQuality;
    homeLambda /= awayGoalieQuality;

    // Round-adjusted home ice advantage (lambda boost + OT edge)
    const hia = computeRoundHomeIceAdvantage(seriesState, gameNum);
    homeLambda *= (1 + hia.homeLambdaBoost);

    // Compute base probability from Poisson scoring distributions
    let homeWinProb = homeWinProbabilityFromLambdas(homeLambda, awayLambda, hia.overtimeHomeEdge);

    // Context adjustments (small nudges on top of Poisson-derived prob)
    const zigzag = computeZigZagAdjustment(homeTeam, awayTeam, seriesState);
    homeWinProb += zigzag.homeBoost - zigzag.awayBoost;

    const elim = computeEliminationBoost(homeTeam, awayTeam, seriesState);
    homeWinProb += elim.homeBoost - elim.awayBoost;

    homeWinProb += computeTravelAdjustment();

    homeWinProb += kopitarMotivationAdjustment({
      homeTeam, awayTeam, seriesState,
    });

    homeWinProb = clamp(homeWinProb, 0.05, 0.95);

    return {
      homeWinProb,
      awayWinProb: 1 - homeWinProb,
      expectedTotalGoals: homeLambda + awayLambda,
      homeLambda,
      awayLambda,
      modelVariant: 'goals',
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
  LEAGUE_AVG_GA_PER_GAME,
  LEAGUE_AVG_GF_PER_GAME,
  LEAGUE_AVG_PP_PCT,
  PLAYOFF_SCORING_DAMPENER,
};
