#!/usr/bin/env node
// ============================================================================
// BACKFILL: Historical Odds from sportsoddshistory.com
// ============================================================================
// Fetches one or more years of Stanley Cup playoff series odds and merges
// them into the historical series dataset for backtest use.
//
// Usage:
//   node scripts/backfill-historical-odds.js --start 2015 --end 2023
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import {
  fetchSohPlayoffs,
  normalizeSohTeam,
} from '../src/ingest/sportsoddshistory.js';
import {
  loadHistoricalSeries,
  saveHistoricalSeries,
} from '../src/ingest/historical.js';

async function main() {
  const args = process.argv.slice(2);
  function arg(name, def) {
    const idx = args.findIndex(a => a === `--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  }

  const startYear = parseInt(arg('start', '2015'), 10);
  const endYear = parseInt(arg('end', String(new Date().getFullYear() - 1)), 10);

  console.log(`[soh-backfill] Fetching odds for years ${startYear}-${endYear}`);

  const existing = await loadHistoricalSeries();
  if (existing.length === 0) {
    console.warn('[soh-backfill] No historical series loaded. Run ingest-historical.js first.');
    console.warn('[soh-backfill] Continuing anyway — will produce orphaned odds records.');
  }

  const allOdds = [];
  for (let year = startYear; year <= endYear; year++) {
    try {
      console.log(`[soh-backfill] ${year}...`);
      const rows = await fetchSohPlayoffs(year);
      console.log(`[soh-backfill]   ${rows.length} rows`);
      for (const row of rows) {
        allOdds.push({
          year,
          date: row.date,
          teamA: normalizeSohTeam(row.teamA) || row.teamA,
          teamB: normalizeSohTeam(row.teamB) || row.teamB,
          numericValues: row.numericValues,
          rawCells: row.rawCells,
        });
      }
      // Polite delay
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`[soh-backfill] ${year} error: ${e.message}`);
    }
  }

  // Merge odds into historical series by (teamA, teamB, rough date match)
  let matched = 0;
  for (const series of existing) {
    const startDate = series.startTime?.slice(0, 10);
    if (!startDate) continue;

    // Find SOH row where teams match and date is within ± 3 days of series start
    const candidate = allOdds.find(o => {
      const teamsMatch =
        (o.teamA === series.teamA && o.teamB === series.teamB) ||
        (o.teamA === series.teamB && o.teamB === series.teamA);
      if (!teamsMatch) return false;
      if (!o.date) return false;
      const daysDiff = Math.abs(
        (new Date(startDate).getTime() - new Date(o.date).getTime()) / 86_400_000
      );
      return daysDiff <= 3;
    });

    if (candidate) {
      // Attach odds to series record. Match which team has which number:
      // assume [favorite_ML, dog_ML, total_line] — but we don't know order,
      // so be defensive. Store raw values; downstream code decides.
      series.historicalOdds = {
        source: 'sportsoddshistory.com',
        year: candidate.year,
        date: candidate.date,
        numericValues: candidate.numericValues,
        rawCells: candidate.rawCells,
      };
      matched++;
    }
  }

  console.log(`[soh-backfill] Matched ${matched}/${existing.length} series with historical odds`);

  await saveHistoricalSeries(existing);
  console.log(`[soh-backfill] Updated historical series dataset`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
