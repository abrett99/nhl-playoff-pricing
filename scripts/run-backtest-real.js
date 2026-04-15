#!/usr/bin/env node
// ============================================================================
// REAL-DATA BACKTEST RUNNER (CALIBRATION-FIRST, v2 model)
// ============================================================================
// Now uses goals-v2 model with round-scaled baselines and R1-carry features.
// For each R2+ series, we look up the team's R1 result from the same
// playoff year and inject r1_wins/r1_losses into the team's feature snapshot.
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadHistoricalSeries, summarizeSeries }
  from '../src/ingest/historical.js';
import { simulateSeries } from '../src/engine/simulateSeries.js';
import { buildPerGameModelGoals }
  from '../src/engine/perGameModelGoals.js';
import { buildAllSnapshots }
  from '../src/features/preplayoffSnapshots.js';

const DEFAULTS = {
  startSeason: 2016,
  endSeason: 2024,
  trials: 10000,
  modelVariant: 'v2',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS };
  for (const arg of args) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'start-season') opts.startSeason = parseInt(v, 10);
    else if (k === 'end-season') opts.endSeason = parseInt(v, 10);
    else if (k === 'trials') opts.trials = parseInt(v, 10);
    else if (k === 'model-variant') opts.modelVariant = v;
  }
  return opts;
}

function playoffYear(series) {
  return (series.seasonStartYear || 0) + 1;
}

function indexSnapshots(snapshots) {
  const index = new Map();
  for (const s of snapshots) index.set(`${s.season}::${s.team_abbrev}`, s);
  return index;
}

/**
 * Build a lookup of R1 results: per (year, team), { r1_wins, r1_losses }.
 * Uses the historical series records themselves to derive this.
 */
function buildR1Lookup(historical) {
  const r1ByYear = new Map(); // key: `${year}::${team}` -> { r1_wins, r1_losses }
  for (const s of historical) {
    if (s.round !== 1) continue;
    const year = playoffYear(s);
    // teamA wins/losses in this series
    const aWins = s.winsA ?? 0;
    const aLosses = s.winsB ?? 0;
    const bWins = s.winsB ?? 0;
    const bLosses = s.winsA ?? 0;
    r1ByYear.set(`${year}::${s.teamA}`, { r1_wins: aWins, r1_losses: aLosses });
    r1ByYear.set(`${year}::${s.teamB}`, { r1_wins: bWins, r1_losses: bLosses });
  }
  return r1ByYear;
}

function attachFeatures(series, snapshotIndex, r1Lookup) {
  const withFeatures = [];
  const dropped = [];
  for (const s of series) {
    const y = playoffYear(s);
    const aSnap = snapshotIndex.get(`${y}::${s.teamA}`);
    const bSnap = snapshotIndex.get(`${y}::${s.teamB}`);
    if (!aSnap || !bSnap) {
      dropped.push({
        series: s,
        reason: `missing: ${!aSnap ? y + '::' + s.teamA : ''} ${!bSnap ? y + '::' + s.teamB : ''}`.trim(),
      });
      continue;
    }

    // Inject R1 performance for R2+ series
    const aR1 = r1Lookup.get(`${y}::${s.teamA}`) || {};
    const bR1 = r1Lookup.get(`${y}::${s.teamB}`) || {};

    const featuresA = { ...aSnap, ...aR1 };
    const featuresB = { ...bSnap, ...bR1 };

    withFeatures.push({
      ...s,
      features: { [s.teamA]: featuresA, [s.teamB]: featuresB },
    });
  }
  return { withFeatures, dropped };
}

function predictSeries(s, trials, modelVariant) {
  const cfg = modelVariant === 'v1' ? { v1: true } : {};
  const model = buildPerGameModelGoals({
    teamFeatures: s.features,
    goalieFeatures: {},
    cfg,
  });
  const mc = simulateSeries({
    state: {
      seriesId: s.seriesId,
      teamA: s.teamA, teamB: s.teamB,
      winsA: 0, winsB: 0, gamesPlayed: [],
      round: s.round,
    },
    perGameModel: model,
    trials,
    seed: 42,
  });
  return mc.seriesWinner[s.teamA].prob;
}

function brierScore(p, a) {
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += (p[i] - a[i]) ** 2;
  return sum / p.length;
}

function logLoss(p, a) {
  const eps = 1e-10;
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = Math.max(eps, Math.min(1 - eps, p[i]));
    sum += a[i] * Math.log(pi) + (1 - a[i]) * Math.log(1 - pi);
  }
  return -sum / p.length;
}

function reliabilityBins(p, a, n = 5) {
  const bins = Array.from({ length: n }, () => ({ ps: 0, as: 0, c: 0 }));
  for (let i = 0; i < p.length; i++) {
    const idx = Math.min(n - 1, Math.floor(p[i] * n));
    bins[idx].ps += p[i];
    bins[idx].as += a[i];
    bins[idx].c++;
  }
  return bins.map((b, i) => ({
    range: `[${(i / n).toFixed(2)}, ${((i + 1) / n).toFixed(2)}]`,
    n: b.c,
    meanPredicted: b.c > 0 ? b.ps / b.c : null,
    actualFrequency: b.c > 0 ? b.as / b.c : null,
  }));
}

function fmt(x, d = 1) {
  if (x == null || Number.isNaN(x)) return 'N/A';
  return `${(x * 100).toFixed(d)}%`;
}

function printReport(predictions, actuals, seriesList, opts) {
  const n = predictions.length;
  let correct = 0;
  for (let i = 0; i < n; i++) {
    if ((predictions[i] > 0.5 ? 1 : 0) === actuals[i]) correct++;
  }
  const acc = correct / n;
  const brier = brierScore(predictions, actuals);
  const ll = logLoss(predictions, actuals);
  const bins = reliabilityBins(predictions, actuals);

  const roundAcc = {};
  for (let i = 0; i < n; i++) {
    const r = seriesList[i].round || '?';
    roundAcc[r] = roundAcc[r] || { c: 0, t: 0 };
    roundAcc[r].t++;
    if ((predictions[i] > 0.5 ? 1 : 0) === actuals[i]) roundAcc[r].c++;
  }

  console.log('─── MODEL CALIBRATION REPORT ─────────────────────────');
  console.log(`  Model variant:         ${opts.modelVariant}`);
  console.log(`  Sample size:           n = ${n} series`);
  console.log(`  Series accuracy:       ${fmt(acc)}  (${correct}/${n})`);
  console.log(`  Brier score:           ${brier.toFixed(4)}  (lower=better, 0.25=coin)`);
  console.log(`  Log loss:              ${ll.toFixed(4)}  (lower=better, 0.693=coin)`);
  console.log('');
  console.log('  Per-round accuracy:');
  for (const r of Object.keys(roundAcc).sort()) {
    const ra = roundAcc[r];
    console.log(`    Round ${r}: ${fmt(ra.c / ra.t, 0)} (${ra.c}/${ra.t})`);
  }
  console.log('');
  console.log('  Reliability bins:');
  console.log('    bin_range        n     mean_pred    actual_freq    cal');
  for (const b of bins) {
    const pred = b.meanPredicted != null ? fmt(b.meanPredicted, 1) : 'N/A';
    const act = b.actualFrequency != null ? fmt(b.actualFrequency, 1) : 'N/A';
    let v = '--';
    if (b.meanPredicted != null && b.actualFrequency != null) {
      const d = Math.abs(b.meanPredicted - b.actualFrequency);
      if (d < 0.08) v = '✓';
      else if (d < 0.15) v = '~';
      else v = '✗';
    }
    console.log(`    ${b.range.padEnd(16)} ${String(b.n).padStart(3)}     ${pred.padEnd(10)} ${act.padEnd(14)} ${v}`);
  }
  console.log('');
  if (acc > 0.72) console.log('    ⚠  Accuracy > 72% — check leakage');
  else if (acc < 0.50) console.log('    ⚠  Below coin flip — anti-calibrated');
  else console.log(`    ✓  Accuracy ${fmt(acc, 0)} in plausible 50-72% range`);
  if (brier < 0.18) console.log('    ⚠  Brier < 0.18 — check leakage');
  else if (brier > 0.27) console.log('    ⚠  Brier > 0.27 — worse than coin');
  else if (brier < 0.24) console.log(`    ✓  Brier ${brier.toFixed(3)} — good calibration`);
  else console.log(`    ~  Brier ${brier.toFixed(3)} — modest calibration`);
}

async function main() {
  const opts = parseArgs();

  console.log('[backtest] Building Kaggle pre-playoff snapshots...');
  const snapshots = await buildAllSnapshots();
  const idx = indexSnapshots(snapshots);
  console.log(`[backtest] Built ${snapshots.length} snapshots`);

  console.log('[backtest] Loading historical playoff series...');
  const historical = await loadHistoricalSeries();
  const inRange = historical.filter(s => {
    const y = playoffYear(s);
    return y >= opts.startSeason && y <= opts.endSeason;
  });

  const r1Lookup = buildR1Lookup(historical);
  console.log(`[backtest] Built R1 lookup for ${r1Lookup.size} (year, team) pairs`);

  const { withFeatures, dropped } = attachFeatures(inRange, idx, r1Lookup);
  console.log(`[backtest] Attached features to ${withFeatures.length}; dropped ${dropped.length}`);

  // Quick R2+ feature inject sanity check
  const r2plus = withFeatures.filter(s => s.round > 1);
  const withR1Data = r2plus.filter(s =>
    s.features[s.teamA].r1_wins != null || s.features[s.teamB].r1_wins != null
  );
  console.log(`[backtest] R2+ series with R1 carry data: ${withR1Data.length}/${r2plus.length}`);

  const summary = summarizeSeries(withFeatures);
  console.log('');
  console.log('[backtest] Historical summary:');
  console.log(`  Total series:          ${summary.totalSeries}`);
  console.log(`  Top-seed win rate:     ${fmt(summary.topSeedWinRate)}`);
  console.log(`  Game 7 home win rate:  ${fmt(summary.game7HomeWinRate)}`);
  console.log('');

  console.log(`[backtest] Running MC predictions (${opts.trials.toLocaleString()} trials each, model=${opts.modelVariant})...`);
  const t0 = Date.now();

  const predictions = [];
  const actuals = [];
  const seriesList = [];

  for (let i = 0; i < withFeatures.length; i++) {
    const s = withFeatures[i];
    const predA = predictSeries(s, opts.trials, opts.modelVariant);
    predictions.push(predA);
    actuals.push(s.actualWinner === s.teamA ? 1 : 0);
    seriesList.push(s);
    if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${withFeatures.length}`);
  }

  console.log(`[backtest] MC done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('');
  printReport(predictions, actuals, seriesList, opts);

  const detail = withFeatures.map((s, i) => ({
    seriesId: s.seriesId,
    season: playoffYear(s),
    round: s.round,
    teamA: s.teamA, teamB: s.teamB,
    actualWinner: s.actualWinner,
    predictedTeamAProb: predictions[i],
    actualTeamAWon: actuals[i],
    correct: (predictions[i] > 0.5 ? 1 : 0) === actuals[i],
  }));

  const outPath = path.resolve('data/derived/backtest_calibration.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({
    opts,
    sample_size: withFeatures.length,
    accuracy: predictions.filter((p, i) => (p > 0.5 ? 1 : 0) === actuals[i]).length / withFeatures.length,
    brier: brierScore(predictions, actuals),
    logLoss: logLoss(predictions, actuals),
    reliabilityBins: reliabilityBins(predictions, actuals),
    detail,
  }, null, 2));
  console.log('');
  console.log(`[backtest] Wrote calibration to ${path.relative(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error('[backtest] FATAL:', err);
  process.exit(1);
});
