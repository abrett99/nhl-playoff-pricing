// ============================================================================
// SERIES MONTE CARLO ENGINE
// ============================================================================
// The single most important function in the system. Everything else consumes
// this: regular-season seeding sim, live state machine, hypothetical engine.
//
// Given a series state and a per-game win probability model, simulates the
// remaining games many times and returns the joint distribution over
// (winner, total_games) from which all series markets are priced.
//
// This function is PURE: same inputs -> same outputs. No side effects.
// Uses a seeded RNG so MC runs are reproducible.
// ============================================================================

import { VENUE_SEQUENCE, MODEL } from '../config.js';
import { seededRng, clamp } from './util.js';
import { probToAmerican } from './odds.js';

/**
 * @typedef {Object} SeriesState
 * @property {string} seriesId
 * @property {string} teamA         - Higher-seeded team (has home ice)
 * @property {string} teamB
 * @property {number} winsA
 * @property {number} winsB
 * @property {Array} gamesPlayed    - [{ gameNum, venue, winner, goals, ot }]
 * @property {number} [round]
 */

/**
 * @typedef {Function} PerGameModel
 * @param {Object} params - { homeTeam, awayTeam, gameNum, seriesState, rng }
 * @returns {Object} { homeWinProb: number, totalGoalsLambda?: number }
 */

/**
 * Simulate the remainder of a series.
 *
 * @param {Object} params
 * @param {SeriesState} params.state
 * @param {PerGameModel} params.perGameModel
 * @param {Object} [params.overrides]        - For hypothetical engine
 * @param {number} [params.trials]
 * @param {number} [params.seed]
 * @returns {Object} Joint distribution + derived market prices
 */
export function simulateSeries({
  state,
  perGameModel,
  overrides = {},
  trials = MODEL.MC_TRIALS,
  seed = 42,
}) {
  validateState(state);

  // Apply overrides to working state for hypothetical scenarios
  const workingState = applyOverrides(state, overrides);

  // Already-completed or forced-completed series
  if (workingState.winsA >= 4 || workingState.winsB >= 4) {
    return degenerateComplete(workingState);
  }

  const rng = seededRng(seed);

  // Counters
  const totalsCounter = { 4: [0, 0], 5: [0, 0], 6: [0, 0], 7: [0, 0] };
  //                    ^                    ^
  //                    index 0: teamA won   index 1: teamB won
  let winsACount = 0;
  let goalsDistribution = []; // total goals per simulated series (for grand salami)

  for (let i = 0; i < trials; i++) {
    const result = playOutSeries(workingState, perGameModel, overrides, rng);
    if (result.winner === 'A') winsACount++;
    const idx = result.winner === 'A' ? 0 : 1;
    totalsCounter[result.totalGames][idx]++;
    goalsDistribution.push(result.totalGoals);
  }

  return deriveMarkets({
    state: workingState,
    winsACount,
    totalsCounter,
    goalsDistribution,
    trials,
  });
}

// ============================================================================
// Core loop: play out ONE series to completion
// ============================================================================

function playOutSeries(state, perGameModel, overrides, rng) {
  let winsA = state.winsA;
  let winsB = state.winsB;
  let gamesPlayedCount = state.gamesPlayed?.length || 0;
  let totalGoals = (state.gamesPlayed || [])
    .reduce((s, g) => s + (g.goals ? g.goals[0] + g.goals[1] : 0), 0);

  // Continue until one team hits 4
  while (winsA < 4 && winsB < 4) {
    const gameNum = gamesPlayedCount + 1;
    const venueLetter = VENUE_SEQUENCE[gameNum - 1]; // 'A' or 'B'
    const homeTeam = venueLetter === 'A' ? state.teamA : state.teamB;
    const awayTeam = venueLetter === 'A' ? state.teamB : state.teamA;

    // Per-game override (hypothetical engine can force an outcome)
    const gameOverride = overrides.gameOutcomes?.[gameNum];
    let winnerLetter;
    let gameGoals = 0;

    if (gameOverride) {
      if (gameOverride === 'skip') {
        // User told us to simulate this game normally
        const prediction = perGameModel({
          homeTeam,
          awayTeam,
          gameNum,
          seriesState: { ...state, winsA, winsB, gamesPlayedCount },
          rng,
          overrides,
        });
        const homeWins = rng() < prediction.homeWinProb;
        winnerLetter = (homeWins ? homeTeam : awayTeam) === state.teamA ? 'A' : 'B';
        gameGoals = sampleGameGoals(prediction, rng);
      } else {
        // User forced a specific winner (team abbrev)
        winnerLetter = gameOverride === state.teamA ? 'A' : 'B';
        gameGoals = 6; // synthetic; doesn't affect series winner math
      }
    } else {
      const prediction = perGameModel({
        homeTeam,
        awayTeam,
        gameNum,
        seriesState: { ...state, winsA, winsB, gamesPlayedCount },
        rng,
        overrides,
      });
      const homeWins = rng() < prediction.homeWinProb;
      winnerLetter = (homeWins ? homeTeam : awayTeam) === state.teamA ? 'A' : 'B';
      gameGoals = sampleGameGoals(prediction, rng);
    }

    if (winnerLetter === 'A') winsA++;
    else winsB++;

    totalGoals += gameGoals;
    gamesPlayedCount++;

    if (gamesPlayedCount > 7) {
      throw new Error(`Series exceeded 7 games — bug in state or MC: ${JSON.stringify(state)}`);
    }
  }

  return {
    winner: winsA === 4 ? 'A' : 'B',
    totalGames: gamesPlayedCount,
    totalGoals,
  };
}

function sampleGameGoals(prediction, rng) {
  const lambda = prediction.totalGoalsLambda ?? 5.8;
  // Simple poisson sample; no OT differentiation for MVP
  let k = 0;
  const L = Math.exp(-lambda);
  let p = 1;
  while (p > L) {
    k++;
    p *= rng();
  }
  return k - 1;
}

// ============================================================================
// Convert raw counters into prices for each market
// ============================================================================

function deriveMarkets({ state, winsACount, totalsCounter, goalsDistribution, trials }) {
  const aWinsProb = winsACount / trials;
  const bWinsProb = 1 - aWinsProb;

  // Total games PMF
  const totalsCombined = {
    4: (totalsCounter[4][0] + totalsCounter[4][1]) / trials,
    5: (totalsCounter[5][0] + totalsCounter[5][1]) / trials,
    6: (totalsCounter[6][0] + totalsCounter[6][1]) / trials,
    7: (totalsCounter[7][0] + totalsCounter[7][1]) / trials,
  };

  // Correct score (8 buckets: 4-0, 4-1, 4-2, 4-3 for each team)
  const correctScore = {
    [`${state.teamA}_4_0`]: totalsCounter[4][0] / trials,
    [`${state.teamA}_4_1`]: totalsCounter[5][0] / trials,
    [`${state.teamA}_4_2`]: totalsCounter[6][0] / trials,
    [`${state.teamA}_4_3`]: totalsCounter[7][0] / trials,
    [`${state.teamB}_4_0`]: totalsCounter[4][1] / trials,
    [`${state.teamB}_4_1`]: totalsCounter[5][1] / trials,
    [`${state.teamB}_4_2`]: totalsCounter[6][1] / trials,
    [`${state.teamB}_4_3`]: totalsCounter[7][1] / trials,
  };

  // O/U 5.5 games (remaining games included)
  const over55 = totalsCombined[6] + totalsCombined[7];
  const under55 = totalsCombined[4] + totalsCombined[5];

  // O/U 6.5 games
  const over65 = totalsCombined[7];
  const under65 = totalsCombined[4] + totalsCombined[5] + totalsCombined[6];

  // Will go 7
  const goesSeven = totalsCombined[7];

  // Expected length
  const expectedGames =
    4 * totalsCombined[4] +
    5 * totalsCombined[5] +
    6 * totalsCombined[6] +
    7 * totalsCombined[7];

  // Grand Salami (total goals across series)
  const meanGoals = goalsDistribution.reduce((s, g) => s + g, 0) / trials;
  const sortedGoals = [...goalsDistribution].sort((a, b) => a - b);
  const medianGoals = sortedGoals[Math.floor(trials / 2)];

  return {
    meta: {
      trials,
      seriesId: state.seriesId,
      teamA: state.teamA,
      teamB: state.teamB,
      currentWins: { A: state.winsA, B: state.winsB },
    },

    // ─── Primary markets ───
    seriesWinner: {
      [state.teamA]: { prob: aWinsProb, fairAmerican: probToAmericanSafe(aWinsProb) },
      [state.teamB]: { prob: bWinsProb, fairAmerican: probToAmericanSafe(bWinsProb) },
    },

    totalGames: {
      pmf: totalsCombined,
      expected: expectedGames,
      over55: { prob: over55, fairAmerican: probToAmericanSafe(over55) },
      under55: { prob: under55, fairAmerican: probToAmericanSafe(under55) },
      over65: { prob: over65, fairAmerican: probToAmericanSafe(over65) },
      under65: { prob: under65, fairAmerican: probToAmericanSafe(under65) },
    },

    goesSeven: {
      yes: { prob: goesSeven, fairAmerican: probToAmericanSafe(goesSeven) },
      no:  { prob: 1 - goesSeven, fairAmerican: probToAmericanSafe(1 - goesSeven) },
    },

    exactLength: {
      4: totalsCombined[4],
      5: totalsCombined[5],
      6: totalsCombined[6],
      7: totalsCombined[7],
    },

    correctScore,

    grandSalami: {
      mean: meanGoals,
      median: medianGoals,
    },
  };
}

function probToAmericanSafe(p) {
  if (p <= 0.001) return 99999;
  if (p >= 0.999) return -99999;
  return probToAmerican(clamp(p, 0.001, 0.999));
}

// ============================================================================
// State validation
// ============================================================================

function validateState(state) {
  if (!state) throw new Error('simulateSeries: state is required');
  if (!state.teamA || !state.teamB) throw new Error('state must have teamA and teamB');
  if (state.teamA === state.teamB) throw new Error('teamA and teamB cannot be the same');
  const wA = state.winsA ?? 0;
  const wB = state.winsB ?? 0;
  if (wA < 0 || wA > 4 || wB < 0 || wB > 4) {
    throw new Error(`Invalid wins: A=${wA} B=${wB}`);
  }
  if (wA === 4 && wB === 4) throw new Error('Both teams cannot have 4 wins');
  const played = state.gamesPlayed?.length || 0;
  if (played !== wA + wB) {
    throw new Error(
      `gamesPlayed length (${played}) must equal winsA + winsB (${wA + wB})`
    );
  }
}

// ============================================================================
// Hypothetical override machinery
// ============================================================================

/**
 * Apply overrides to a state object.
 * @param {SeriesState} state
 * @param {Object} overrides
 * @param {number} [overrides.winsA]           - override series wins
 * @param {number} [overrides.winsB]
 * @param {Object} [overrides.gameOutcomes]    - { 4: "CAR", 5: "skip", ... }
 * @param {Object} [overrides.goalieOverrides] - handled by perGameModel
 */
function applyOverrides(state, overrides) {
  const out = { ...state };
  if (overrides.winsA !== undefined) out.winsA = overrides.winsA;
  if (overrides.winsB !== undefined) out.winsB = overrides.winsB;
  if (overrides.gamesPlayed) out.gamesPlayed = overrides.gamesPlayed;

  // Re-validate after override
  validateState(out);
  return out;
}

function degenerateComplete(state) {
  const winner = state.winsA >= 4 ? state.teamA : state.teamB;
  const winnerLetter = state.winsA >= 4 ? 'A' : 'B';
  const gamesPlayed = (state.gamesPlayed?.length) || (state.winsA + state.winsB);

  return {
    meta: {
      trials: 0,
      complete: true,
      winner,
      seriesId: state.seriesId,
    },
    seriesWinner: {
      [state.teamA]: { prob: winnerLetter === 'A' ? 1 : 0 },
      [state.teamB]: { prob: winnerLetter === 'B' ? 1 : 0 },
    },
    totalGames: {
      pmf: { [gamesPlayed]: 1 },
      expected: gamesPlayed,
    },
    goesSeven: { yes: { prob: gamesPlayed === 7 ? 1 : 0 }, no: { prob: gamesPlayed === 7 ? 0 : 1 } },
  };
}

// ============================================================================
// Edge calculation against a book's series markets
// ============================================================================

/**
 * Given model output from simulateSeries and book prices, return edge per market.
 * @param {Object} modelResult - output of simulateSeries
 * @param {Object} bookPrices  - { seriesWinner: {[team]: american}, over55: american, ... }
 */
export function computeEdges(modelResult, bookPrices) {
  const edges = [];

  if (bookPrices.seriesWinner) {
    for (const [team, american] of Object.entries(bookPrices.seriesWinner)) {
      const modelProb = modelResult.seriesWinner[team]?.prob;
      if (modelProb === undefined) continue;
      edges.push({
        market: 'seriesWinner',
        side: team,
        bookAmerican: american,
        modelProb,
        edge: computeSingleEdge(modelProb, american),
      });
    }
  }

  const simpleMarkets = [
    ['over55', modelResult.totalGames?.over55?.prob],
    ['under55', modelResult.totalGames?.under55?.prob],
    ['over65', modelResult.totalGames?.over65?.prob],
    ['under65', modelResult.totalGames?.under65?.prob],
    ['goesSevenYes', modelResult.goesSeven?.yes?.prob],
    ['goesSevenNo', modelResult.goesSeven?.no?.prob],
  ];
  for (const [marketKey, modelProb] of simpleMarkets) {
    const american = bookPrices[marketKey];
    if (american === undefined || modelProb === undefined) continue;
    edges.push({
      market: marketKey,
      bookAmerican: american,
      modelProb,
      edge: computeSingleEdge(modelProb, american),
    });
  }

  return edges.sort((a, b) => b.edge - a.edge);
}

function computeSingleEdge(modelProb, american) {
  const decimal = american < 0 ? 1 + (100 / -american) : 1 + (american / 100);
  return modelProb * decimal - 1;
}
