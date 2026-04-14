#!/usr/bin/env node
// ============================================================================
// BUILD: Point-in-Time Features for Upcoming Games
// ============================================================================
// For each active series's next game, build the feature vector using only
// data available BEFORE the scheduled game start. Writes to
// data/derived/features/<gameId>.json for consumption by the MC pipeline.
//
// Usage:
//   node scripts/build-features.js
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { buildFeaturesAsOf } from '../src/features/pointInTime.js';
import { listActiveSeries, nextGameInfo } from '../src/state/series.js';
import { getSnapshotAsOf } from '../src/ingest/store.js';
import { GAME_TYPE } from '../src/config.js';

const OUT_DIR = path.resolve(process.cwd(), 'data', 'derived', 'features');

async function getGameStartTime(homeTeam, awayTeam) {
  // Pull from latest NHL schedule snapshot
  const snap = await getSnapshotAsOf('nhl_schedule', new Date());
  if (!snap) return null;
  const body = typeof snap.body === 'string' ? snap.body : snap.body.toString('utf-8');
  const parsed = JSON.parse(body);
  const games = parsed.gameWeek?.[0]?.games || parsed.games || [];
  const game = games.find(g =>
    g.gameType === GAME_TYPE.PLAYOFF &&
    g.homeTeam?.abbrev === homeTeam &&
    g.awayTeam?.abbrev === awayTeam
  );
  return game ? { gameId: String(game.id), startTime: game.startTimeUTC } : null;
}

async function main() {
  console.log('[build-features] Listing active series...');
  const activeSeries = await listActiveSeries();
  if (!activeSeries.length) {
    console.log('[build-features] No active series. Nothing to build.');
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const series of activeSeries) {
    const next = nextGameInfo(series);
    if (!next) continue;

    const gameInfo = await getGameStartTime(next.homeTeam, next.awayTeam);
    if (!gameInfo) {
      console.log(`[build-features] ${series.seriesId}: no scheduled game found for ${next.awayTeam}@${next.homeTeam}`);
      continue;
    }

    const homeGoalieId = series.currentStarters[next.homeTeam]?.playerId;
    const awayGoalieId = series.currentStarters[next.awayTeam]?.playerId;

    const features = await buildFeaturesAsOf({
      gameId: gameInfo.gameId,
      homeTeam: next.homeTeam,
      awayTeam: next.awayTeam,
      gameStartTime: gameInfo.startTime,
      seriesState: series,
      homeGoalieId,
      awayGoalieId,
    });

    const outPath = path.join(OUT_DIR, `${gameInfo.gameId}.json`);
    await fs.writeFile(outPath, JSON.stringify(features, null, 2));
    console.log(`[build-features] ${series.seriesId} G${next.gameNum}: ${next.awayTeam} @ ${next.homeTeam} → ${outPath}`);

    // Report on snapshot freshness
    for (const [src, info] of Object.entries(features.asOf.snapshots)) {
      if (info.status === 'missing') {
        console.log(`    ⚠  ${src}: MISSING`);
      } else {
        console.log(`    ✓  ${src}: ${info.ageHoursBeforeGame}h before game`);
      }
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
