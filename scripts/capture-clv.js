#!/usr/bin/env node
// ============================================================================
// CLV CAPTURE: T-5min Closing Line Snapshot
// ============================================================================
// The single most important metric for long-run ROI validation.
//
// For each game scheduled in the next 10 minutes, fetches Pinnacle closing
// odds and stores them separately. This is the "ground truth" price we
// compare our bets against. Trademate Sports found r²=0.997 between
// Pinnacle closing line and true probability — which is why CLV predicts
// ROI better than sample ROI does over small samples.
//
// Runs on cron every 5 minutes. Only acts on games within the capture
// window.
//
// Usage:
//   node scripts/capture-clv.js
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { NHL_API, ODDS_API, GAME_TYPE, ALERT_THRESHOLDS } from '../src/config.js';
import { getSnapshotAsOf } from '../src/ingest/store.js';
import { commitPull } from '../src/ingest/store.js';
import {
  CheckReport,
  checkFetch,
  checkParse,
  CheckResult,
} from '../src/sanity/checks.js';
import { isoTimestamp, parseGameId } from '../src/engine/util.js';
import { americanToProb } from '../src/engine/odds.js';

const CLV_DIR = path.resolve(process.cwd(), 'data', 'derived', 'clv');
const CAPTURE_WINDOW_MIN = ALERT_THRESHOLDS.CLV_CAPTURE_MINUTES_BEFORE_GAME;

// ============================================================================
// Find games that need CLV capture
// ============================================================================

async function findGamesInCaptureWindow() {
  const now = Date.now();
  const windowStart = now;
  const windowEnd = now + CAPTURE_WINDOW_MIN * 60 * 1000;

  const snap = await getSnapshotAsOf('nhl_schedule', new Date());
  if (!snap) {
    console.log('[clv] No schedule snapshot available');
    return [];
  }

  const body = typeof snap.body === 'string' ? snap.body : snap.body.toString('utf-8');
  const parsed = JSON.parse(body);
  const games = parsed.gameWeek?.[0]?.games || parsed.games || [];

  return games.filter(g => {
    const startTime = new Date(g.startTimeUTC).getTime();
    return startTime >= windowStart &&
           startTime <= windowEnd &&
           (g.gameState === 'FUT' || g.gameState === 'PRE' || !g.gameState);
  });
}

// ============================================================================
// Capture Pinnacle odds for a specific game
// ============================================================================

async function captureGameClv(game) {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    console.error('[clv] Missing ODDS_API_KEY');
    return null;
  }

  const url = ODDS_API.pinnacle(key);
  let resp, body;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'nhl-playoff-pricing/0.1' },
    });
    body = await resp.text();
  } catch (e) {
    console.error(`[clv] Network error for ${game.id}: ${e.message}`);
    return null;
  }

  const report = new CheckReport('pinnacle_closing');
  for (const c of checkFetch({
    status: resp.status,
    headers: resp.headers,
    size: body.length,
    body,
  }, {
    minSize: 50,
    expectedContentType: 'application/json',
  })) report.add(c);

  let allGames;
  try {
    allGames = JSON.parse(body);
  } catch (e) {
    report.add(CheckResult.fail(2, 'json_parse', e.message));
    return null;
  }

  // Match the odds API game to our NHL API game
  const pinnacleGame = findMatchingGame(allGames, game);
  if (!pinnacleGame) {
    console.warn(`[clv] No matching Pinnacle game for ${game.id} (${game.awayTeam?.abbrev}@${game.homeTeam?.abbrev})`);
    return null;
  }

  const closing = extractClosingPrices(pinnacleGame);
  if (!closing) return null;

  // Persist the CLV record
  const record = {
    gameId: String(game.id),
    capturedAt: isoTimestamp(),
    gameStartTime: game.startTimeUTC,
    minutesBeforeStart: Math.round(
      (new Date(game.startTimeUTC).getTime() - Date.now()) / 60000
    ),
    homeTeam: game.homeTeam?.abbrev,
    awayTeam: game.awayTeam?.abbrev,
    gameType: game.gameType,
    seriesId: parseGameId(game.id).isPlayoff
      ? `${parseGameId(game.id).seasonStartYear}-R${parseGameId(game.id).round}-M${parseGameId(game.id).matchup}`
      : null,
    pinnacleClosing: closing,
    vig: closing.h2hVig,
  };

  const filename = `${String(game.id)}.json`;
  await fs.mkdir(CLV_DIR, { recursive: true });
  await fs.writeFile(path.join(CLV_DIR, filename), JSON.stringify(record, null, 2));

  console.log(`[clv] ✅ Captured ${game.awayTeam?.abbrev}@${game.homeTeam?.abbrev} (T-${record.minutesBeforeStart}min) → ${filename}`);
  return record;
}

function findMatchingGame(oddsApiGames, nhlGame) {
  // Odds API uses full team names; NHL uses abbreviations. Match by
  // commencement time proximity + team name inclusion
  const nhlStart = new Date(nhlGame.startTimeUTC).getTime();
  for (const og of oddsApiGames) {
    const ogStart = new Date(og.commence_time).getTime();
    if (Math.abs(ogStart - nhlStart) > 2 * 60 * 60 * 1000) continue; // within 2 hours

    const homeMatch = teamMatches(og.home_team, nhlGame.homeTeam?.name?.default ?? nhlGame.homeTeam?.abbrev);
    const awayMatch = teamMatches(og.away_team, nhlGame.awayTeam?.name?.default ?? nhlGame.awayTeam?.abbrev);
    if (homeMatch && awayMatch) return og;
  }
  return null;
}

function teamMatches(oddsName, nhlName) {
  if (!oddsName || !nhlName) return false;
  const n1 = String(oddsName).toLowerCase();
  const n2 = String(nhlName).toLowerCase();
  return n1.includes(n2) || n2.includes(n1) ||
         // Handle edge cases like "St Louis" vs "St. Louis"
         n1.replace(/\./g, '') === n2.replace(/\./g, '');
}

function extractClosingPrices(game) {
  const pinnacle = game.bookmakers?.find(b => b.key === 'pinnacle');
  if (!pinnacle) return null;

  const h2h = pinnacle.markets?.find(m => m.key === 'h2h');
  const totals = pinnacle.markets?.find(m => m.key === 'totals');

  const closing = { captureTimestamp: pinnacle.last_update };

  if (h2h && h2h.outcomes?.length === 2) {
    const [a, b] = h2h.outcomes;
    closing.h2h = {
      [a.name]: a.price,
      [b.name]: b.price,
    };
    const pA = americanToProb(a.price);
    const pB = americanToProb(b.price);
    closing.h2hVig = pA + pB - 1;
  }

  if (totals && totals.outcomes?.length >= 2) {
    closing.totals = totals.outcomes.map(o => ({
      name: o.name,
      point: o.point,
      price: o.price,
    }));
  }

  return closing;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('[clv] Checking for games in capture window...');

  const games = await findGamesInCaptureWindow();
  if (games.length === 0) {
    console.log('[clv] No games in capture window (next 10 min)');
    return;
  }

  console.log(`[clv] ${games.length} game(s) in window`);
  for (const g of games) {
    try {
      await captureGameClv(g);
    } catch (e) {
      console.error(`[clv] Error on game ${g.id}: ${e.message}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
