#!/usr/bin/env node
// ============================================================================
// SEED: Synthetic Historical Dataset
// ============================================================================
// Generates a plausible-looking synthetic historical dataset so we can
// smoke-test the backtest pipeline before the real NHL API ingest runs.
//
// Outcomes are generated from a "true" per-game probability that's a
// function of team strength differential, so the model should recover
// ~60-70% series accuracy — realistic and below the 75% leakage ceiling.
//
// Usage:
//   node scripts/seed-synthetic-historical.js
//   node scripts/seed-synthetic-historical.js --series 150 --seed 42
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { NHL_TEAMS, VENUE_SEQUENCE } from '../src/config.js';
import { seededRng, isoTimestamp } from '../src/engine/util.js';

const OUT_PATH = path.resolve(process.cwd(), 'data', 'derived', 'historical_series.json');

async function main() {
  const args = process.argv.slice(2);
  function arg(name, def) {
    const idx = args.findIndex(a => a === `--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  }

  const count = parseInt(arg('series', '150'), 10);
  const seed = parseInt(arg('seed', '42'), 10);
  const startYear = parseInt(arg('start-year', '2015'), 10);
  const rng = seededRng(seed);

  console.log(`[seed] Generating ${count} synthetic series, seed=${seed}`);

  // Build team strength ratings (rating ~0.5 ± 0.15)
  const ratings = {};
  for (const team of NHL_TEAMS) {
    ratings[team] = 0.42 + rng() * 0.16; // 0.42-0.58
  }

  const series = [];
  for (let i = 0; i < count; i++) {
    const year = startYear + Math.floor(i / 15); // ~15 series/year
    const round = 1 + Math.floor(rng() * 4);

    // Pick two distinct teams
    const teams = [...NHL_TEAMS];
    const iA = Math.floor(rng() * teams.length);
    const [teamA] = teams.splice(iA, 1);
    const iB = Math.floor(rng() * teams.length);
    const teamB = teams[iB];

    // True per-game prob derived from rating differential + home ice
    const diff = ratings[teamA] - ratings[teamB];
    const baseProb = 0.5 + diff; // ratings have ~0.16 spread → ~±0.16 perturbation
    const homeIceBump = 0.03;

    // Play the series out
    const games = [];
    let winsA = 0, winsB = 0;
    while (winsA < 4 && winsB < 4) {
      const gameNum = winsA + winsB + 1;
      const venueLetter = VENUE_SEQUENCE[gameNum - 1];
      const homeTeam = venueLetter === 'A' ? teamA : teamB;
      const awayTeam = venueLetter === 'A' ? teamB : teamA;

      // Home team wins with bumped probability
      const pHomeWins = (venueLetter === 'A' ? baseProb : (1 - baseProb)) + homeIceBump;
      const homeWins = rng() < Math.max(0.1, Math.min(0.9, pHomeWins));
      const winner = homeWins ? homeTeam : awayTeam;
      if (winner === teamA) winsA++; else winsB++;

      // Synthetic goals (Poisson-ish around 5.8 total)
      const totalGoals = Math.max(1, Math.round(5.8 + (rng() - 0.5) * 3));
      const homeGoals = homeWins ? Math.ceil(totalGoals / 2 + rng()) : Math.floor(totalGoals / 2 - rng());
      const awayGoals = Math.max(0, totalGoals - homeGoals);

      const date = new Date(year, 3, 15 + gameNum * 2 + i * 10);
      games.push({
        gameId: `${year}03${round}${i % 10}${gameNum}`.padStart(10, '0'),
        gameNum,
        homeTeam,
        awayTeam,
        homeGoals,
        awayGoals,
        winner,
        ot: rng() < 0.2, // ~20% OT rate (realistic for playoffs)
        startTime: date.toISOString(),
        gameState: 'OFF',
      });
    }

    const actualWinner = winsA === 4 ? teamA : teamB;
    series.push({
      seriesId: `${year}-R${round}-S${i}`,
      season: `${year}${year + 1}`,
      seasonStartYear: year,
      round,
      seriesLetter: String.fromCharCode(65 + (i % 16)),
      teamA,
      teamB,
      topSeedRank: 1 + Math.floor(rng() * 3),
      bottomSeedRank: 5 + Math.floor(rng() * 4),
      actualWinner,
      actualTotalGames: games.length,
      winsA,
      winsB,
      startTime: games[0].startTime,
      endTime: games[games.length - 1].startTime,
      games,
    });
  }

  const output = {
    generatedAt: isoTimestamp(),
    count: series.length,
    synthetic: true,
    note: 'This is a synthetic dataset for smoke-testing the backtest pipeline. Replace with real data via scripts/ingest-historical.js before trusting any results.',
    series,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(output, null, 2));

  // Quick summary
  const topSeedWins = series.filter(s => s.actualWinner === s.teamA).length;
  const g7Count = series.filter(s => s.actualTotalGames === 7).length;
  console.log(`[seed] Wrote ${series.length} series to ${OUT_PATH}`);
  console.log(`[seed]   Top-seed win rate: ${(topSeedWins / series.length * 100).toFixed(1)}%`);
  console.log(`[seed]   G7 rate: ${(g7Count / series.length * 100).toFixed(1)}%`);
  console.log(`[seed]   Avg games: ${(series.reduce((s, sr) => s + sr.actualTotalGames, 0) / series.length).toFixed(2)}`);
  console.log('\n[seed] Now run: node scripts/run-backtest.js');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
