// ============================================================================
// HISTORICAL PLAYOFF SERIES LOADER
// ============================================================================
// Pulls historical playoff series from the NHL API (2012-present) and
// structures them for backtesting. Each series record contains:
//   - Matchup info (teamA, teamB, seeds, round)
//   - Actual outcome (winner, total games, per-game winners)
//   - Series-level metadata (start date, end date, duration)
//
// This is the CORE backtesting dataset. Without it, all ROI claims are
// vaporware. With it, we can validate calibration before risking capital.
//
// Output: data/derived/historical_series.json
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { NHL_API, GAME_TYPE } from '../config.js';
import { parseGameId, isoTimestamp } from '../engine/util.js';

const HISTORICAL_OUT = path.resolve(process.cwd(), 'data', 'derived', 'historical_series.json');

// ============================================================================
// Fetch a season's playoff bracket from NHL API
// ============================================================================

/**
 * @param {number} seasonStartYear - e.g. 2023 for the 2023-24 season
 * @returns {Promise<Array>} array of series objects
 */
export async function loadPlayoffSeason(seasonStartYear) {
  const seasonStr = `${seasonStartYear}${seasonStartYear + 1}`;
  const url = NHL_API.endpoints.playoffCarousel(seasonStr);

  console.log(`[historical] Fetching ${url}`);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'nhl-playoff-pricing/0.1' },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch playoff carousel for ${seasonStr}: ${resp.status}`);
  }
  const data = await resp.json();

  const seriesList = [];
  for (const round of data.rounds || []) {
    for (const series of round.series || []) {
      const parsed = await parseSeriesDetail({
        seasonStr,
        seasonStartYear,
        round: round.roundNumber,
        series,
      });
      if (parsed) seriesList.push(parsed);
    }
  }
  return seriesList;
}

async function parseSeriesDetail({ seasonStr, seasonStartYear, round, series }) {
  const letter = series.seriesLetter;
  if (!letter) return null;

  // Fetch full series schedule for per-game winner info
  const detailUrl = NHL_API.endpoints.playoffSeries(seasonStr, letter);
  let detail;
  try {
    const resp = await fetch(detailUrl, {
      headers: { 'User-Agent': 'nhl-playoff-pricing/0.1' },
    });
    if (!resp.ok) {
      console.warn(`[historical] series ${letter} detail failed: ${resp.status}`);
      return null;
    }
    detail = await resp.json();
  } catch (e) {
    console.warn(`[historical] series ${letter} fetch error: ${e.message}`);
    return null;
  }

  const teamA = detail.topSeedTeam?.abbrev || series.topSeedTeam?.abbrev;
  const teamB = detail.bottomSeedTeam?.abbrev || series.bottomSeedTeam?.abbrev;
  if (!teamA || !teamB) return null;

  const games = (detail.games || []).map(g => {
    const homeAbbr = g.homeTeam?.abbrev;
    const awayAbbr = g.awayTeam?.abbrev;
    const homeGoals = g.homeTeam?.score;
    const awayGoals = g.awayTeam?.score;
    let winner = null;
    if (Number.isFinite(homeGoals) && Number.isFinite(awayGoals)) {
      winner = homeGoals > awayGoals ? homeAbbr : awayAbbr;
    }
    const parsed = parseGameId(g.id);
    return {
      gameId: String(g.id),
      gameNum: parsed.gameInSeries,
      homeTeam: homeAbbr,
      awayTeam: awayAbbr,
      homeGoals,
      awayGoals,
      winner,
      ot: g.periodDescriptor?.number > 3,
      startTime: g.startTimeUTC,
      gameState: g.gameState,
    };
  }).filter(g => g.winner !== null);

  if (games.length === 0) return null;

  // Derive series outcome
  const winsA = games.filter(g => g.winner === teamA).length;
  const winsB = games.filter(g => g.winner === teamB).length;
  if (winsA < 4 && winsB < 4) {
    // Series didn't complete in data (rare edge case, old seasons)
    return null;
  }

  const actualWinner = winsA === 4 ? teamA : teamB;
  const startTime = games[0]?.startTime;
  const endTime = games[games.length - 1]?.startTime;

  return {
    seriesId: `${seasonStartYear}-R${round}-${letter}`,
    season: seasonStr,
    seasonStartYear,
    round,
    seriesLetter: letter,
    teamA,
    teamB,
    topSeedRank: detail.topSeedRank || null,
    bottomSeedRank: detail.bottomSeedRank || null,
    actualWinner,
    actualTotalGames: games.length,
    winsA,
    winsB,
    startTime,
    endTime,
    games,
  };
}

// ============================================================================
// Load many seasons
// ============================================================================

export async function loadMultipleSeasons(startYear, endYear) {
  const allSeries = [];
  for (let year = startYear; year <= endYear; year++) {
    try {
      const seasonSeries = await loadPlayoffSeason(year);
      console.log(`[historical] ${year}-${year + 1}: ${seasonSeries.length} series`);
      allSeries.push(...seasonSeries);
      // Polite delay to not hammer the API
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn(`[historical] ${year} failed: ${e.message}`);
    }
  }
  return allSeries;
}

// ============================================================================
// Disk persistence
// ============================================================================

export async function saveHistoricalSeries(series, outPath = HISTORICAL_OUT) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({
    generatedAt: isoTimestamp(),
    count: series.length,
    series,
  }, null, 2));
  return outPath;
}

export async function loadHistoricalSeries(inPath = HISTORICAL_OUT) {
  try {
    const text = await fs.readFile(inPath, 'utf-8');
    const parsed = JSON.parse(text);
    return parsed.series || [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// ============================================================================
// Summary stats (for sanity-checking the dataset)
// ============================================================================

export function summarizeSeries(series) {
  const byRound = {};
  const byLength = { 4: 0, 5: 0, 6: 0, 7: 0 };
  let totalGames = 0;
  let topSeedWins = 0;
  let sevenGameSeries = 0;
  let game7HomeWins = 0;
  let game7Total = 0;

  for (const s of series) {
    byRound[s.round] = (byRound[s.round] || 0) + 1;
    byLength[s.actualTotalGames] = (byLength[s.actualTotalGames] || 0) + 1;
    totalGames += s.actualTotalGames;
    if (s.actualWinner === s.teamA) topSeedWins++;
    if (s.actualTotalGames === 7) {
      sevenGameSeries++;
      game7Total++;
      const g7 = s.games.find(g => g.gameNum === 7);
      if (g7 && g7.winner === g7.homeTeam) game7HomeWins++;
    }
  }

  return {
    totalSeries: series.length,
    totalGames,
    avgGamesPerSeries: series.length ? totalGames / series.length : 0,
    topSeedWinRate: series.length ? topSeedWins / series.length : 0,
    seriesByRound: byRound,
    lengthDistribution: byLength,
    game7HomeWinRate: game7Total ? game7HomeWins / game7Total : null,
    game7Count: game7Total,
    seasonsSpan: series.length ? {
      first: Math.min(...series.map(s => s.seasonStartYear)),
      last: Math.max(...series.map(s => s.seasonStartYear)),
    } : null,
  };
}
