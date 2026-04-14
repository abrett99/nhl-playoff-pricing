#!/usr/bin/env node
// ============================================================================
// INGEST: Historical Playoff Series (10-year dataset for backtesting)
// ============================================================================
// Pulls every playoff series from the specified year range and stores them
// in data/derived/historical_series.json. This is the backbone dataset
// for walk-forward validation.
//
// Expected output: ~150 series (15 per year × 10 years).
//
// Usage:
//   node scripts/ingest-historical.js
//   node scripts/ingest-historical.js --start 2015 --end 2024
// ============================================================================

import {
  loadMultipleSeasons,
  saveHistoricalSeries,
  summarizeSeries,
  loadHistoricalSeries,
} from '../src/ingest/historical.js';

async function main() {
  const args = process.argv.slice(2);
  function arg(name, def) {
    const idx = args.findIndex(a => a === `--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  }

  const startYear = parseInt(arg('start', '2015'), 10);
  const endYear = parseInt(arg('end', String(new Date().getFullYear() - 1)), 10);
  const append = args.includes('--append');

  console.log(`[ingest-historical] Loading playoff seasons ${startYear}-${endYear + 1} to ${endYear}-${endYear + 2}`);

  const existing = append ? await loadHistoricalSeries() : [];
  const existingIds = new Set(existing.map(s => s.seriesId));
  console.log(`[ingest-historical] ${existing.length} series already in dataset`);

  const newSeries = await loadMultipleSeasons(startYear, endYear);
  const merged = [...existing];
  let added = 0;
  for (const s of newSeries) {
    if (!existingIds.has(s.seriesId)) {
      merged.push(s);
      added++;
    }
  }

  await saveHistoricalSeries(merged);
  console.log(`[ingest-historical] Added ${added} new series. Total: ${merged.length}`);

  // Sanity summary
  const summary = summarizeSeries(merged);
  console.log('\n─── DATASET SUMMARY ──────────────────────────────────────');
  console.log(`  Total series:           ${summary.totalSeries}`);
  console.log(`  Total games:            ${summary.totalGames}`);
  console.log(`  Avg games/series:       ${summary.avgGamesPerSeries.toFixed(2)}`);
  console.log(`  Top-seed win rate:      ${(summary.topSeedWinRate * 100).toFixed(1)}%`);
  console.log(`  Game 7 home win rate:   ${summary.game7HomeWinRate !== null ? (summary.game7HomeWinRate * 100).toFixed(1) + '%' : 'n/a'} (n=${summary.game7Count})`);
  console.log(`  Seasons span:           ${summary.seasonsSpan?.first}-${summary.seasonsSpan?.last}`);
  console.log(`  Series by round:        ${JSON.stringify(summary.seriesByRound)}`);
  console.log(`  Length distribution:    ${JSON.stringify(summary.lengthDistribution)}`);

  // Reference historical base rates:
  // Expected ~75% top-seed win rate (weighted heavily by R1 1v8 matchups),
  // expected ~58% Game 7 home win rate, expected ~26% seven-game series.
  console.log('\n  Reference base rates:');
  console.log('    Game 7 home win rate: ~58% (Puck Report all-time)');
  console.log('    Series reaching G7:   ~26% (Puck Report all-time)');
  const g7Pct = summary.lengthDistribution[7] / summary.totalSeries;
  console.log(`    Our G7 rate:          ${(g7Pct * 100).toFixed(1)}%`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
