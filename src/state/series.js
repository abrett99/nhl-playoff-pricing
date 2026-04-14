// ============================================================================
// SERIES STATE MACHINE
// ============================================================================
// Maintains the authoritative state of every active playoff series.
// After each game completes, ingests the result, advances the state,
// re-runs MC, detects edge changes, and triggers alerts.
//
// State is persisted as JSON files committed to the repo by GitHub Actions.
// Every state change is a git commit = perfect audit trail.
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { parseGameId, seriesIdFromGameId, isoTimestamp } from '../engine/util.js';
import { VENUE_SEQUENCE } from '../config.js';

const STATE_DIR = path.resolve(process.cwd(), 'data', 'derived', 'series_state');

// ============================================================================
// State shape
// ============================================================================
/*
{
  "seriesId": "2025-R1-M1",
  "round": 1,
  "matchup": 1,
  "teamA": "BOS",    // higher seed / home ice
  "teamB": "TOR",
  "winsA": 2,
  "winsB": 1,
  "status": "active",  // "active" | "complete"
  "seriesWinner": null,  // populated when status=complete
  "currentStarters": {
    "BOS": { "playerId": 8475167, "name": "Swayman", "confirmed": true, "since": "G1" },
    "TOR": { "playerId": 8477964, "name": "Stolarz", "confirmed": false, "since": "G1" }
  },
  "rosterGoalies": {
    "BOS": [ { "playerId": 8475167, "name": "Swayman" }, ... ],
    "TOR": [ ... ]
  },
  "gamesPlayed": [
    { "gameNum": 1, "gameId": "2025030111", "venue": "BOS",
      "winner": "BOS", "goals": [4, 2], "ot": false, "firstGoal": "BOS",
      "date": "2026-04-20T19:00:00Z" },
    ...
  ],
  "createdAt": "...",
  "lastUpdated": "..."
}
*/

// ============================================================================
// Read / Write
// ============================================================================

export async function loadState(seriesId) {
  const filePath = path.join(STATE_DIR, `${seriesId}.json`);
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function saveState(state) {
  validateState(state);
  state.lastUpdated = isoTimestamp();
  const filePath = path.join(STATE_DIR, `${state.seriesId}.json`);
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  return state;
}

export async function listActiveSeries(options = {}) {
  const { includeComplete = false } = options;
  try {
    const files = await fs.readdir(STATE_DIR);
    const states = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          try {
            return JSON.parse(await fs.readFile(path.join(STATE_DIR, f), 'utf-8'));
          } catch {
            return null;
          }
        })
    );
    if (includeComplete) {
      return states.filter(s => s !== null);
    }
    return states.filter(s => s && s.status === 'active');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// ============================================================================
// Create a new series at round start
// ============================================================================

/**
 * @param {Object} params
 * @param {string} params.seriesId
 * @param {number} params.round
 * @param {number} params.matchup
 * @param {string} params.teamA        - higher seed (home ice)
 * @param {string} params.teamB
 * @param {Object} params.rosterGoalies - { [team]: [{playerId, name}] }
 * @param {Object} [params.currentStarters] - defaults to first goalie in roster
 */
export function createSeries(params) {
  const state = {
    seriesId: params.seriesId,
    round: params.round,
    matchup: params.matchup,
    teamA: params.teamA,
    teamB: params.teamB,
    winsA: 0,
    winsB: 0,
    status: 'active',
    seriesWinner: null,
    currentStarters: params.currentStarters ?? defaultStarters(params.rosterGoalies),
    rosterGoalies: params.rosterGoalies,
    gamesPlayed: [],
    metadata: params.metadata ?? {},
    createdAt: isoTimestamp(),
    lastUpdated: isoTimestamp(),
  };
  validateState(state);
  return state;
}

function defaultStarters(rosterGoalies) {
  const starters = {};
  for (const [team, goalies] of Object.entries(rosterGoalies || {})) {
    if (goalies?.[0]) {
      starters[team] = {
        playerId: goalies[0].playerId,
        name: goalies[0].name,
        confirmed: false,
        since: 'G1',
      };
    }
  }
  return starters;
}

// ============================================================================
// Ingest a game result and advance state
// ============================================================================

/**
 * Pure function: given current state + game result, return new state.
 * Does not persist — caller decides when to save.
 *
 * @param {Object} state - current series state
 * @param {Object} gameResult - { gameId, winner, goals: [awayGoals, homeGoals],
 *                               ot, firstGoal, homeTeam, awayTeam, date }
 * @returns {Object} new state
 */
export function ingestGameResult(state, gameResult) {
  if (state.status !== 'active') {
    throw new Error(`Cannot ingest game into non-active series (${state.status})`);
  }

  // Validate game belongs to this series
  const parsed = parseGameId(gameResult.gameId);
  if (!parsed.isPlayoff) {
    throw new Error(`Not a playoff game: ${gameResult.gameId}`);
  }
  const inferredSeries = seriesIdFromGameId(gameResult.gameId);
  if (inferredSeries !== state.seriesId) {
    throw new Error(
      `Game ${gameResult.gameId} belongs to series ${inferredSeries}, not ${state.seriesId}`
    );
  }

  // Validate game number continues the sequence
  const expectedGameNum = state.gamesPlayed.length + 1;
  if (parsed.gameInSeries !== expectedGameNum) {
    throw new Error(
      `Game number mismatch: series expected G${expectedGameNum}, got G${parsed.gameInSeries}`
    );
  }

  // Validate teams
  const validTeams = new Set([state.teamA, state.teamB]);
  if (!validTeams.has(gameResult.winner) ||
      !validTeams.has(gameResult.homeTeam) ||
      !validTeams.has(gameResult.awayTeam)) {
    throw new Error(`Invalid teams in game result for series ${state.seriesId}`);
  }

  // Validate venue matches 2-2-1-1-1 sequence
  const expectedVenueLetter = VENUE_SEQUENCE[expectedGameNum - 1];
  const expectedVenueTeam = expectedVenueLetter === 'A' ? state.teamA : state.teamB;
  if (gameResult.homeTeam !== expectedVenueTeam) {
    throw new Error(
      `Venue mismatch: G${expectedGameNum} expected to be at ${expectedVenueTeam}, was at ${gameResult.homeTeam}`
    );
  }

  // Build new state
  const newState = {
    ...state,
    winsA: state.winsA + (gameResult.winner === state.teamA ? 1 : 0),
    winsB: state.winsB + (gameResult.winner === state.teamB ? 1 : 0),
    gamesPlayed: [
      ...state.gamesPlayed,
      {
        gameNum: expectedGameNum,
        gameId: gameResult.gameId,
        venue: gameResult.homeTeam,
        winner: gameResult.winner,
        goals: gameResult.goals,
        ot: Boolean(gameResult.ot),
        firstGoal: gameResult.firstGoal ?? null,
        date: gameResult.date,
      },
    ],
    lastUpdated: isoTimestamp(),
  };

  // Check for series completion
  if (newState.winsA >= 4) {
    newState.status = 'complete';
    newState.seriesWinner = newState.teamA;
  } else if (newState.winsB >= 4) {
    newState.status = 'complete';
    newState.seriesWinner = newState.teamB;
  }

  validateState(newState);
  return newState;
}

// ============================================================================
// Goalie change ingestion (separate from game result since it can happen
// mid-game or between games)
// ============================================================================

export function updateGoalie(state, team, goalieInfo) {
  if (!state.rosterGoalies[team]) {
    throw new Error(`Team ${team} not in series ${state.seriesId}`);
  }
  const gameNum = (state.gamesPlayed.length || 0) + 1;
  return {
    ...state,
    currentStarters: {
      ...state.currentStarters,
      [team]: {
        playerId: goalieInfo.playerId,
        name: goalieInfo.name,
        confirmed: Boolean(goalieInfo.confirmed),
        since: `G${gameNum}`,
      },
    },
    lastUpdated: isoTimestamp(),
  };
}

// ============================================================================
// Validation
// ============================================================================

export function validateState(state) {
  if (!state.seriesId) throw new Error('state.seriesId required');
  if (!state.teamA || !state.teamB) throw new Error('teamA and teamB required');
  if (state.teamA === state.teamB) throw new Error('teamA and teamB cannot be the same');
  if (state.winsA < 0 || state.winsA > 4) throw new Error(`Invalid winsA: ${state.winsA}`);
  if (state.winsB < 0 || state.winsB > 4) throw new Error(`Invalid winsB: ${state.winsB}`);
  if (state.winsA === 4 && state.winsB === 4) throw new Error('Both teams cannot have 4 wins');
  if (state.gamesPlayed.length !== state.winsA + state.winsB) {
    throw new Error(
      `gamesPlayed count (${state.gamesPlayed.length}) != winsA+winsB (${state.winsA + state.winsB})`
    );
  }
  if (!['active', 'complete'].includes(state.status)) {
    throw new Error(`Invalid status: ${state.status}`);
  }
  if (state.status === 'complete' && !state.seriesWinner) {
    throw new Error('Complete series must have seriesWinner');
  }
}

// ============================================================================
// Helpers for presentation / MC input
// ============================================================================

/** Get the remaining venue sequence from current state */
export function remainingVenues(state) {
  const played = state.gamesPlayed.length;
  return VENUE_SEQUENCE.slice(played).map(letter =>
    letter === 'A' ? state.teamA : state.teamB
  );
}

/** Get the next game info without advancing state */
export function nextGameInfo(state) {
  if (state.status !== 'active') return null;
  const gameNum = state.gamesPlayed.length + 1;
  if (gameNum > 7) return null;
  const venueLetter = VENUE_SEQUENCE[gameNum - 1];
  const homeTeam = venueLetter === 'A' ? state.teamA : state.teamB;
  const awayTeam = venueLetter === 'A' ? state.teamB : state.teamA;
  return {
    gameNum,
    homeTeam,
    awayTeam,
    venueLetter,
    starterHome: state.currentStarters[homeTeam]?.name,
    starterAway: state.currentStarters[awayTeam]?.name,
  };
}
