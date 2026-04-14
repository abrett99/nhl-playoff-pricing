// ============================================================================
// SAVED SCENARIOS
// ============================================================================
// User-defined hypothetical scenarios (e.g. "if Woll starts Game 4 AND TOR
// wins Game 3") with automatic edge-crossing detection and auto-expire
// when the actual series state contradicts the scenario.
//
// Lifecycle:
//   1. Created with a seriesId, overrides, and an edge threshold
//   2. Evaluated on each state update (runs MC, checks edge)
//   3. Triggers Telegram alert when edge crosses threshold
//   4. Auto-expires when the actual state contradicts the scenario
//      (e.g. "if TOR wins G3" scenario dies when BOS wins G3)
//
// Persistence: one JSON file per scenario at data/derived/scenarios/<id>.json.
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { isoTimestamp } from '../engine/util.js';

const SCENARIO_DIR = path.resolve(process.cwd(), 'data', 'derived', 'scenarios');

// ============================================================================
// Scenario shape
// ============================================================================
/*
{
  "scenarioId": "2026-04-14T17-30Z_bos-tor-woll-starts-g4",
  "createdAt": "2026-04-14T17:30:00Z",
  "label": "If Woll gets the net in Game 4",
  "seriesId": "2025-R1-M1",

  "overrides": {
    "goalieOverrides": {
      "perTeam": { "TOR": 8476412 }          // playerId for Woll
    },
    "gameOutcomes": { "3": "TOR" }            // force G3 = TOR win
  },

  "triggerMarket": "seriesWinner",           // market to watch
  "triggerSide": "TOR",                       // side to watch
  "triggerEdgeMin": 0.05,                     // fire when edge >= 5%

  "status": "active",                         // "active" | "triggered" | "expired"
  "triggeredAt": null,
  "expiredAt": null,
  "expiredReason": null,

  "history": [                                // audit of every evaluation
    { "evaluatedAt": "...", "edge": 0.04, "fired": false }
  ]
}
*/

// ============================================================================
// CRUD
// ============================================================================

export async function saveScenario(scenario) {
  validateScenario(scenario);
  scenario.updatedAt = isoTimestamp();
  const filePath = path.join(SCENARIO_DIR, `${scenario.scenarioId}.json`);
  await fs.mkdir(SCENARIO_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(scenario, null, 2));
  return scenario;
}

export async function loadScenario(scenarioId) {
  const filePath = path.join(SCENARIO_DIR, `${scenarioId}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function listActiveScenarios(seriesId = null) {
  try {
    const files = await fs.readdir(SCENARIO_DIR);
    const all = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          try {
            return JSON.parse(await fs.readFile(path.join(SCENARIO_DIR, f), 'utf-8'));
          } catch {
            return null;
          }
        })
    );
    return all.filter(s =>
      s && s.status === 'active' && (!seriesId || s.seriesId === seriesId)
    );
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// ============================================================================
// Create
// ============================================================================

export function createScenario(params) {
  const scenarioId = params.scenarioId
    || `${isoTimestamp().replace(/[:.]/g, '-').replace('Z', 'Z')}_${params.seriesId}_${slugify(params.label)}`;

  return {
    scenarioId,
    createdAt: isoTimestamp(),
    updatedAt: isoTimestamp(),
    label: params.label,
    seriesId: params.seriesId,
    overrides: params.overrides || {},
    triggerMarket: params.triggerMarket || 'seriesWinner',
    triggerSide: params.triggerSide || null,
    triggerEdgeMin: params.triggerEdgeMin ?? 0.05,
    status: 'active',
    triggeredAt: null,
    expiredAt: null,
    expiredReason: null,
    history: [],
  };
}

function slugify(s) {
  return String(s || 'scenario')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function validateScenario(s) {
  if (!s.scenarioId) throw new Error('scenarioId required');
  if (!s.seriesId) throw new Error('seriesId required');
  if (!s.label) throw new Error('label required');
  if (!['active', 'triggered', 'expired'].includes(s.status)) {
    throw new Error(`Invalid status: ${s.status}`);
  }
}

// ============================================================================
// Auto-expire: check if scenario's conditions are now contradicted by state
// ============================================================================

/**
 * A scenario expires when:
 *   - Its gameOutcomes override specifies a winner for game N, but game N
 *     has already been played with a different winner
 *   - The series has completed (no more games to hypothesize about)
 *   - Its goalie override specified a player who is no longer on the team
 *     (not implemented yet; roster tracking TBD)
 *
 * Returns { expired: bool, reason?: string }
 */
export function checkExpiration(scenario, seriesState) {
  if (!seriesState) return { expired: false };

  // Series complete → scenario moot
  if (seriesState.status === 'complete') {
    return {
      expired: true,
      reason: `Series ended (${seriesState.seriesWinner} won)`,
    };
  }

  // gameOutcomes overrides that contradict actual results
  if (scenario.overrides?.gameOutcomes) {
    for (const [gameNumStr, expectedWinner] of Object.entries(scenario.overrides.gameOutcomes)) {
      const gameNum = parseInt(gameNumStr, 10);
      if (expectedWinner === 'skip') continue;

      const actualGame = seriesState.gamesPlayed.find(g => g.gameNum === gameNum);
      if (actualGame && actualGame.winner !== expectedWinner) {
        return {
          expired: true,
          reason: `G${gameNum} override required ${expectedWinner} but ${actualGame.winner} won`,
        };
      }
    }
  }

  // State override for winsA / winsB that's been exceeded by reality
  if (scenario.overrides?.winsA !== undefined) {
    if (seriesState.winsA > scenario.overrides.winsA ||
        seriesState.winsB > (scenario.overrides.winsB ?? 0)) {
      return {
        expired: true,
        reason: `Series moved past override state (${scenario.overrides.winsA}-${scenario.overrides.winsB})`,
      };
    }
  }

  return { expired: false };
}

// ============================================================================
// Evaluate: run MC with scenario overrides, check trigger condition, return
// new scenario state + whether an alert should fire
// ============================================================================

/**
 * @param {Object} scenario
 * @param {Object} seriesState  - current series state
 * @param {Function} simulateFn - (state, overrides) => mcResult
 * @param {Object} bookPrices   - current book prices
 * @returns {Object} { scenario: updatedScenario, shouldAlert: bool, edge: number|null }
 */
export function evaluateScenario({ scenario, seriesState, simulateFn, bookPrices }) {
  // Check expiration first
  const expiry = checkExpiration(scenario, seriesState);
  if (expiry.expired) {
    return {
      scenario: {
        ...scenario,
        status: 'expired',
        expiredAt: isoTimestamp(),
        expiredReason: expiry.reason,
        updatedAt: isoTimestamp(),
      },
      shouldAlert: false,
      edge: null,
    };
  }

  // Run MC with scenario overrides
  const mc = simulateFn(seriesState, scenario.overrides);
  if (!mc) {
    return { scenario, shouldAlert: false, edge: null };
  }

  // Compute edge for the trigger market
  const modelProb = extractMarketProb(mc, scenario.triggerMarket, scenario.triggerSide);
  const bookPrice = extractBookPrice(bookPrices, scenario.triggerMarket, scenario.triggerSide);

  let edgeValue = null;
  if (modelProb !== null && bookPrice !== null && bookPrice !== undefined) {
    const decimal = bookPrice < 0 ? 1 + (100 / -bookPrice) : 1 + (bookPrice / 100);
    edgeValue = modelProb * decimal - 1;
  }

  // Record evaluation in history (capped)
  const history = [
    ...(scenario.history || []).slice(-19),
    { evaluatedAt: isoTimestamp(), edge: edgeValue, modelProb, bookPrice },
  ];

  // Decide whether to trigger
  const shouldTrigger = edgeValue !== null && edgeValue >= scenario.triggerEdgeMin
    && scenario.status === 'active';

  const updatedScenario = {
    ...scenario,
    status: shouldTrigger ? 'triggered' : scenario.status,
    triggeredAt: shouldTrigger ? isoTimestamp() : scenario.triggeredAt,
    updatedAt: isoTimestamp(),
    history,
  };

  return {
    scenario: updatedScenario,
    shouldAlert: shouldTrigger,
    edge: edgeValue,
    modelProb,
    bookPrice,
  };
}

// ============================================================================
// Market access helpers
// ============================================================================

function extractMarketProb(mc, market, side) {
  if (market === 'seriesWinner' && side) {
    return mc.seriesWinner?.[side]?.prob ?? null;
  }
  if (market === 'over55') return mc.totalGames?.over55?.prob ?? null;
  if (market === 'under55') return mc.totalGames?.under55?.prob ?? null;
  if (market === 'over65') return mc.totalGames?.over65?.prob ?? null;
  if (market === 'under65') return mc.totalGames?.under65?.prob ?? null;
  if (market === 'goesSevenYes') return mc.goesSeven?.yes?.prob ?? null;
  if (market === 'goesSevenNo') return mc.goesSeven?.no?.prob ?? null;
  return null;
}

function extractBookPrice(bookPrices, market, side) {
  if (!bookPrices) return null;
  if (market === 'seriesWinner' && side) {
    return bookPrices.seriesWinner?.[side] ?? null;
  }
  return bookPrices[market] ?? null;
}
