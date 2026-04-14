#!/usr/bin/env node
// ============================================================================
// GOALIE CHANGE DETECTOR
// ============================================================================
// For each active series's next game, checks the NHL gameLanding endpoint
// for confirmed starters. If the confirmed starter differs from the series
// state's expected starter, updates state and fires a high-priority alert.
//
// Critical signal: goalie pulls mid-series have the largest single-game
// price impact of any in-series event (often swings line by 50-100 cents).
//
// Runs on cron ~every 15 min starting 2h before game time.
//
// Usage:
//   node scripts/detect-goalie-changes.js
// ============================================================================

import { NHL_API, GAME_TYPE } from '../src/config.js';
import { getSnapshotAsOf } from '../src/ingest/store.js';
import {
  listActiveSeries,
  loadState,
  saveState,
  updateGoalie,
  nextGameInfo,
} from '../src/state/series.js';
import { parseGameId } from '../src/engine/util.js';
import { alertGoalieChange } from '../src/alerts/telegram.js';

// ============================================================================
// Find next game's ID for each active series
// ============================================================================

async function findNextGameIdForSeries(series) {
  const next = nextGameInfo(series);
  if (!next) return null;

  const snap = await getSnapshotAsOf('nhl_schedule', new Date());
  if (!snap) return null;

  const body = typeof snap.body === 'string' ? snap.body : snap.body.toString('utf-8');
  const parsed = JSON.parse(body);
  const games = parsed.gameWeek?.[0]?.games || parsed.games || [];

  const match = games.find(g =>
    g.gameType === GAME_TYPE.PLAYOFF &&
    g.homeTeam?.abbrev === next.homeTeam &&
    g.awayTeam?.abbrev === next.awayTeam &&
    (g.gameState === 'FUT' || g.gameState === 'PRE' || g.gameState === 'LIVE')
  );
  return match ? String(match.id) : null;
}

// ============================================================================
// Fetch confirmed starters from gameLanding endpoint
// ============================================================================

async function fetchConfirmedStarters(gameId) {
  const url = NHL_API.endpoints.gameLanding(gameId);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'nhl-playoff-pricing/0.1' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();

    // gameLanding exposes matchup.goalieComparison with confirmed starters
    // when within ~2h of puck drop. Structure varies by gameState.
    const matchup = data.matchup || data;
    const home = matchup.goalieComparison?.homeTeam?.leaders?.[0] ||
                 matchup.homeTeam?.confirmedStarter;
    const away = matchup.goalieComparison?.awayTeam?.leaders?.[0] ||
                 matchup.awayTeam?.confirmedStarter;

    return {
      homeTeam: data.homeTeam?.abbrev,
      awayTeam: data.awayTeam?.abbrev,
      homeStarter: home ? {
        playerId: home.playerId,
        name: formatName(home),
        confirmed: Boolean(home.isConfirmed ?? home.confirmed ?? false),
      } : null,
      awayStarter: away ? {
        playerId: away.playerId,
        name: formatName(away),
        confirmed: Boolean(away.isConfirmed ?? away.confirmed ?? false),
      } : null,
    };
  } catch (e) {
    console.warn(`[goalie] Error fetching ${gameId}: ${e.message}`);
    return null;
  }
}

function formatName(player) {
  if (player.name?.default) return player.name.default;
  if (player.firstName && player.lastName) {
    return `${player.firstName.default ?? player.firstName} ${player.lastName.default ?? player.lastName}`;
  }
  return player.name || String(player.playerId);
}

// ============================================================================
// Detect and handle change
// ============================================================================

async function checkSeries(series) {
  const gameId = await findNextGameIdForSeries(series);
  if (!gameId) {
    console.log(`[goalie] ${series.seriesId}: no next game found in schedule`);
    return;
  }

  const starters = await fetchConfirmedStarters(gameId);
  if (!starters) {
    console.log(`[goalie] ${series.seriesId}: no starter info yet`);
    return;
  }

  for (const { team, newStarter } of [
    { team: starters.homeTeam, newStarter: starters.homeStarter },
    { team: starters.awayTeam, newStarter: starters.awayStarter },
  ]) {
    if (!newStarter || !team || !series.currentStarters[team]) continue;

    const current = series.currentStarters[team];
    // Only alert on CONFIRMED changes
    if (!newStarter.confirmed) continue;
    if (current.playerId === newStarter.playerId && current.confirmed) continue;

    console.log(`[goalie] ${series.seriesId}: ${team} change detected: ${current.name} → ${newStarter.name}`);

    // Update state
    const newState = updateGoalie(series, team, newStarter);
    await saveState(newState);

    // Alert
    const gameNum = (series.gamesPlayed?.length || 0) + 1;
    await alertGoalieChange({
      seriesId: series.seriesId,
      team,
      gameNum,
      previousGoalie: current.name,
      newGoalie: newStarter.name,
      // Future: compute and pass priceImpact + newEdges
    });
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const activeSeries = await listActiveSeries();
  if (!activeSeries.length) {
    console.log('[goalie] No active series');
    return;
  }

  console.log(`[goalie] Checking ${activeSeries.length} active series...`);
  for (const series of activeSeries) {
    try {
      await checkSeries(series);
    } catch (e) {
      console.error(`[goalie] ${series.seriesId}: ${e.message}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
