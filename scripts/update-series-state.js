#!/usr/bin/env node
// ============================================================================
// UPDATE: Series State from Completed Games
// ============================================================================
// Reads today's NHL schedule, finds completed playoff games, and updates
// the authoritative series state for each. Re-runs MC afterward and
// triggers Telegram alerts on significant changes.
//
// Runs on cron during playoffs (~every 15min during active game windows).
//
// Usage:
//   node scripts/update-series-state.js
// ============================================================================

import { GAME_TYPE } from '../src/config.js';
import { getSnapshotAsOf } from '../src/ingest/store.js';
import {
  loadState,
  saveState,
  ingestGameResult,
  updateGoalie,
  listActiveSeries,
} from '../src/state/series.js';
import { seriesIdFromGameId, parseGameId } from '../src/engine/util.js';
import { alertGoalieChange } from '../src/alerts/telegram.js';

async function getTodaysGames() {
  const snap = await getSnapshotAsOf('nhl_schedule', new Date());
  if (!snap) return [];
  const body = typeof snap.body === 'string' ? snap.body : snap.body.toString('utf-8');
  const parsed = JSON.parse(body);
  const games = parsed.gameWeek?.[0]?.games || parsed.games || [];
  return games.filter(g =>
    g.gameType === GAME_TYPE.PLAYOFF &&
    (g.gameState === 'FINAL' || g.gameState === 'OFF')
  );
}

async function processGame(game) {
  const seriesId = seriesIdFromGameId(game.id);
  const state = await loadState(seriesId);

  if (!state) {
    console.log(`[update-state] ${seriesId}: no state file yet — series not registered`);
    return null;
  }

  if (state.status === 'complete') {
    console.log(`[update-state] ${seriesId}: already complete, skipping`);
    return null;
  }

  // Already ingested?
  const alreadyIn = state.gamesPlayed.some(g => g.gameId === String(game.id));
  if (alreadyIn) {
    console.log(`[update-state] ${seriesId}: G${parseGameId(game.id).gameInSeries} already ingested`);
    return null;
  }

  const homeTeam = game.homeTeam.abbrev;
  const awayTeam = game.awayTeam.abbrev;
  const homeGoals = game.homeTeam.score;
  const awayGoals = game.awayTeam.score;
  const winner = homeGoals > awayGoals ? homeTeam : awayTeam;

  const newState = ingestGameResult(state, {
    gameId: String(game.id),
    homeTeam,
    awayTeam,
    winner,
    goals: [awayGoals, homeGoals],
    ot: game.periodDescriptor?.number > 3,
    date: game.startTimeUTC,
  });

  await saveState(newState);
  console.log(`[update-state] ${seriesId}: ingested G${parseGameId(game.id).gameInSeries}, now ${newState.winsA}-${newState.winsB}`);

  if (newState.status === 'complete') {
    console.log(`[update-state] ${seriesId}: 🏆 COMPLETE — ${newState.seriesWinner} wins`);
  }

  return newState;
}

async function detectGoalieChanges() {
  // Future: scrape confirmed-starter news / NHL gameLanding and compare
  // to state.currentStarters; fire alertGoalieChange when they differ.
  // For now, this is a placeholder.
}

async function main() {
  console.log('[update-state] Checking for completed playoff games...');

  const games = await getTodaysGames();
  console.log(`[update-state] Found ${games.length} completed playoff games today`);

  for (const game of games) {
    try {
      await processGame(game);
    } catch (e) {
      console.error(`[update-state] Error on game ${game.id}:`, e.message);
    }
  }

  await detectGoalieChanges();

  // List active series summary
  const active = await listActiveSeries();
  if (active.length) {
    console.log(`\n[update-state] Active series:`);
    for (const s of active) {
      console.log(`  ${s.seriesId}: ${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
