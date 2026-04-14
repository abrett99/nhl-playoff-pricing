#!/usr/bin/env node
// ============================================================================
// RUN BACKTEST
// ============================================================================
// Walk-forward validates the per-game playoff-adjusted model against the
// historical series dataset. Outputs per-market ROI, bootstrap CI, and
// red-flag checks.
//
// Prerequisites:
//   1. node scripts/ingest-historical.js    (build dataset)
//   2. Feature data for each historical series — this script uses synthetic
//      team features as a placeholder. Real features come from historical
//      NST/MoneyPuck snapshots that predate each series.
//
// Usage:
//   node scripts/run-backtest.js
//   node scripts/run-backtest.js --min-edge 0.05 --kelly 0.25
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { loadHistoricalSeries, summarizeSeries } from '../src/ingest/historical.js';
import { runWalkForward, runBacktest } from '../src/backtest/harness.js';
import { buildPerGameModel } from '../src/engine/perGameModel.js';
import { NHL_TEAMS } from '../src/config.js';

// ============================================================================
// Synthetic feature generator (placeholder)
// ============================================================================
// In production, this is replaced by buildFeaturesAsOf() pulling historical
// snapshots. For now we generate league-average-ish features with small
// per-team perturbations so the model has something sensible to work with.

function buildPlaceholderFeatures() {
  const teamFeatures = {};
  const goalieFeatures = {};

  for (let i = 0; i < NHL_TEAMS.length; i++) {
    const team = NHL_TEAMS[i];
    // Deterministic small perturbations
    const seed = (i * 2654435761) >>> 0;
    const offense = 2.70 + ((seed % 100) / 100) * 0.6;  // 2.70-3.30
    const defense = 2.70 + (((seed >> 8) % 100) / 100) * 0.6;
    teamFeatures[team] = {
      xgf_per_60: offense,
      xga_per_60: defense,
      pp_pct: 19 + ((seed >> 16) % 10),  // 19-29
      pk_pct: 76 + ((seed >> 24) % 8),   // 76-84
      default_goalie_id: `G-${team}`,
    };
    goalieFeatures[`G-${team}`] = {
      gsax_per_60: ((seed % 20) - 10) / 50, // -0.2 to +0.2
      save_pct: 0.905 + ((seed >> 4) % 20) / 1000,
    };
  }

  return { teamFeatures, goalieFeatures };
}

// ============================================================================
// Convert historical series into the shape backtest harness expects
// ============================================================================

function prepareBacktestSeries(historical) {
  const placeholderFeatures = buildPlaceholderFeatures();
  return historical.map(s => ({
    seriesId: s.seriesId,
    teamA: s.teamA,
    teamB: s.teamB,
    round: s.round,
    actualWinner: s.actualWinner,
    actualTotalGames: s.actualTotalGames,
    asOfDate: s.startTime,
    // Synthetic book prices at "fair" (~52%/-110 tax): in production, this
    // comes from sportsoddshistory.com backfill + Pinnacle snapshots
    bookPrices: {
      seriesWinner: { [s.teamA]: -140, [s.teamB]: +120 },
      over55: -110,
      under55: -110,
      over65: +150,
      under65: -180,
      goesSevenYes: +280,
      goesSevenNo: -380,
    },
    // Placeholder features
    features: placeholderFeatures,
  }));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  function arg(name, def) {
    const idx = args.findIndex(a => a === `--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  }

  const minEdge = parseFloat(arg('min-edge', '0.03'));
  const kellyFraction = parseFloat(arg('kelly', '0.25'));
  const bankroll = parseFloat(arg('bankroll', '10000'));
  const trials = parseInt(arg('trials', '10000'), 10);
  const bootstrap = parseInt(arg('bootstrap', '1000'), 10);
  const walkWindowMonths = parseInt(arg('window-months', '12'), 10);
  const outPath = arg('out', 'data/derived/backtest_results.json');

  console.log('[backtest] Loading historical dataset...');
  const historical = await loadHistoricalSeries();
  if (historical.length === 0) {
    console.error('[backtest] No historical series found.');
    console.error('[backtest] Run `node scripts/ingest-historical.js` first.');
    process.exit(1);
  }

  const summary = summarizeSeries(historical);
  console.log(`[backtest] ${summary.totalSeries} series loaded (${summary.seasonsSpan?.first}-${summary.seasonsSpan?.last})`);
  console.log(`[backtest] Top-seed win rate: ${(summary.topSeedWinRate * 100).toFixed(1)}%`);
  console.log(`[backtest] Game 7 home win rate: ${summary.game7HomeWinRate !== null ? (summary.game7HomeWinRate * 100).toFixed(1) + '%' : 'n/a'}`);

  const series = prepareBacktestSeries(historical);
  console.log(`\n[backtest] Config:`);
  console.log(`  min-edge=${(minEdge * 100).toFixed(1)}%  kelly=${kellyFraction}  bankroll=$${bankroll}`);
  console.log(`  trials=${trials.toLocaleString()}  bootstrap=${bootstrap}  window=${walkWindowMonths}mo\n`);

  // One-shot: run against all series
  console.log('[backtest] Running full-dataset backtest...');
  const t0 = Date.now();
  const full = runBacktest({
    series,
    modelFactory: (features) => buildPerGameModel(features),
    config: {
      minEdgePct: minEdge,
      kellyFraction,
      bankroll,
      trials,
      bootstrapResamples: bootstrap,
    },
  });
  const elapsedMs = Date.now() - t0;
  console.log(`[backtest] Full-dataset backtest in ${(elapsedMs / 1000).toFixed(1)}s\n`);

  printBacktestResults(full);

  // Walk-forward
  console.log('\n[backtest] Running walk-forward validation...');
  const wfT0 = Date.now();
  const wf = runWalkForward({
    series,
    fitModel: () => (features) => buildPerGameModel(features),
    windowMonths: walkWindowMonths,
    minTrainingSize: 20,
    config: {
      minEdgePct: minEdge,
      kellyFraction,
      bankroll,
      trials: Math.min(trials, 5000),
      bootstrapResamples: Math.min(bootstrap, 200),
    },
  });
  const wfElapsed = Date.now() - wfT0;
  console.log(`[backtest] Walk-forward in ${(wfElapsed / 1000).toFixed(1)}s (${wf.windows.length} windows)\n`);

  printWalkForwardResults(wf);

  // Persist full results
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: { minEdge, kellyFraction, bankroll, trials, bootstrap, walkWindowMonths },
    datasetSummary: summary,
    full,
    walkForward: wf,
  }, null, 2));
  console.log(`\n[backtest] Wrote full results to ${outPath}`);
}

// ============================================================================
// Output formatting
// ============================================================================

function printBacktestResults(result) {
  console.log('─── FULL-DATASET RESULTS ───────────────────────────────');
  console.log(`  Series accuracy:      ${result.accuracy.series !== null ? (result.accuracy.series * 100).toFixed(1) + '%' : 'n/a'}`);

  if (result.redFlags.length > 0) {
    console.log('\n  ⛔ RED FLAGS:');
    for (const f of result.redFlags) {
      console.log(`     ${f.message}`);
    }
  }

  console.log('\n  Per-market results:');
  for (const [market, s] of Object.entries(result.byMarket)) {
    if (s.n === 0) continue;
    const roi = s.roiKelly;
    const ci = s.ci95;
    const sign = roi >= 0 ? '+' : '';
    const ciStr = ci
      ? `  CI95=[${formatPct(ci.lower)}, ${formatPct(ci.upper)}]`
      : '';
    const clvStr = s.avgClv !== null
      ? `  CLV=${formatPct(s.avgClv)}`
      : '';
    console.log(
      `    ${market.padEnd(18)} n=${String(s.n).padStart(4)} ` +
      `hit=${formatPct(s.hitRate, 0)} ROI=${sign}${formatPct(roi)}${ciStr}${clvStr}`
    );
  }

  const overall = result.overall;
  console.log('\n  Aggregate:');
  console.log(`    n=${overall.n}  total_pnl=$${overall.totalPnl?.toFixed(2) ?? 0}  ROI=${formatPct(overall.roiKelly || 0)}`);
}

function printWalkForwardResults(wf) {
  console.log('─── WALK-FORWARD RESULTS ───────────────────────────────');
  if (wf.windows.length === 0) {
    console.log('  No windows produced.');
    return;
  }

  console.log('\n  Consistency by market (positive windows / total):');
  if (wf.consistency) {
    for (const [market, c] of Object.entries(wf.consistency)) {
      const rate = (c.positiveRate * 100).toFixed(0);
      const sign = c.meanRoi >= 0 ? '+' : '';
      console.log(
        `    ${market.padEnd(18)} ${c.positiveWindows}/${c.windowsCount} ` +
        `(${rate}%)  mean ROI=${sign}${formatPct(c.meanRoi)}  σ=${formatPct(c.stdRoi)}`
      );
    }
  }

  console.log('\n  Aggregate across all windows:');
  console.log(`    n=${wf.overall.totalBets}  pnl=$${(wf.overall.totalPnl || 0).toFixed(2)}  ` +
              `ROI=${formatPct(wf.overall.roiKelly || 0)}  hitRate=${formatPct(wf.overall.hitRate || 0, 0)}`);
}

function formatPct(x, decimals = 1) {
  if (x === null || x === undefined) return 'n/a';
  return `${(x * 100).toFixed(decimals)}%`;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
