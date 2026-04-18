#!/usr/bin/env node
// ============================================================================
// xG-MODEL BACKTEST RUNNER
// ============================================================================
// Sister script to run-backtest-real.js. Same calibration metrics, but uses
// MoneyPuck xG features and goalie GSAx instead of Kaggle goal rates.
//
// Allows direct A/B against goals-v2:
//   node scripts/run-backtest-real.js   # goals-v2 baseline
//   node scripts/run-backtest-xg.js     # xg-v3 model
//
// Same 104 historical series, same metrics, different feature pipeline.
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadHistoricalSeries, summarizeSeries }
  from '../src/ingest/historical.js';
import { simulateSeries } from '../src/engine/simulateSeries.js';
import { buildPerGameModelXg } from '../src/engine/perGameModelXg.js';
import { loadAllMoneyPuck, getTeamProfile }
  from '../src/ingest/moneypuck/loaders.js';

const DEFAULTS = {
  startSeason: 2016,
  endSeason: 2024,
  trials: 10000,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS };
  for (const arg of args) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'start-season') opts.startSeason = parseInt(v, 10);
    else if (k === 'end-season') opts.endSeason = parseInt(v, 10);
    else if (k === 'trials') opts.trials = parseInt(v, 10);
  }
  return opts;
}

function playoffYear(series) {
  return series.seasonStartYear || 0;
}

/**
 * Build the team feature object expected by perGameModelXg from MoneyPuck data.
 *
 * For each team-season, we need:
 *   xg5on5For, xg5on5Against, pp_xgf_per60, pk_xga_per60, pdo, goalie_gsax
 */
function buildTeamFeature(season, team, mpData) {
  const ctx = mpData;

  // 5on5 profile (skater-aggregated for historical, direct for 2025)
  const t5on5 = getTeamProfile(season, team, '5on5', ctx);
  // 5on4 (PP) profile
  const t5on4 = getTeamProfile(season, team, '5on4', ctx);
  // 4on5 (PK) profile
  const t4on5 = getTeamProfile(season, team, '4on5', ctx);
  // Starting goalie
  const goalie = ctx.startingGoalies.get(`${season}::${team}`);

  if (!t5on5) return null;

  return {
    xg5on5For: t5on5.xgfPer60,
    xg5on5Against: t5on5.xgaPer60,
    pp_xgf_per60: t5on4?.xgfPer60 ?? null,
    pk_xga_per60: t4on5?.xgaPer60 ?? null,
    pdo: t5on5.pdo,
    goalie_gsax: goalie?.gsax ?? 0,
    goalie_name: goalie?.name ?? null,
  };
}

function buildR1Lookup(historical) {
  const r1ByYear = new Map();
  for (const s of historical) {
    if (s.round !== 1) continue;
    const year = playoffYear(s);
    r1ByYear.set(`${year}::${s.teamA}`, { r1_wins: s.winsA ?? 0, r1_losses: s.winsB ?? 0 });
    r1ByYear.set(`${year}::${s.teamB}`, { r1_wins: s.winsB ?? 0, r1_losses: s.winsA ?? 0 });
  }
  return r1ByYear;
}

function attachXgFeatures(series, mpData, r1Lookup) {
  const withFeatures = [];
  const dropped = [];
  for (const s of series) {
    const y = playoffYear(s);
    const aFeat = buildTeamFeature(y, s.teamA, mpData);
    const bFeat = buildTeamFeature(y, s.teamB, mpData);

    if (!aFeat || !bFeat) {
      dropped.push({
        series: s,
        reason: `missing xG: ${!aFeat ? y + '::' + s.teamA : ''} ${!bFeat ? y + '::' + s.teamB : ''}`.trim(),
      });
      continue;
    }

    // Inject R1 carry data
    const aR1 = r1Lookup.get(`${y}::${s.teamA}`) || {};
    const bR1 = r1Lookup.get(`${y}::${s.teamB}`) || {};
    Object.assign(aFeat, aR1);
    Object.assign(bFeat, bR1);

    withFeatures.push({
      ...s,
      features: { [s.teamA]: aFeat, [s.teamB]: bFeat },
    });
  }
  return { withFeatures, dropped };
}

function predictSeries(s, trials) {
  const model = buildPerGameModelXg({ teamFeatures: s.features });
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

function printReport(predictions, actuals, seriesList) {
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

  console.log('─── XG-V3 MODEL CALIBRATION REPORT ───────────────────');
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
  else if (acc < 0.50) console.log('    ⚠  Below coin flip');
  else console.log(`    ✓  Accuracy ${fmt(acc, 0)} in plausible 50-72% range`);
  if (brier < 0.18) console.log('    ⚠  Brier < 0.18 — check leakage');
  else if (brier > 0.27) console.log('    ⚠  Brier > 0.27 — worse than coin');
  else if (brier < 0.24) console.log(`    ✓  Brier ${brier.toFixed(3)} — good calibration`);
  else console.log(`    ~  Brier ${brier.toFixed(3)} — modest calibration`);
}

async function main() {
  const opts = parseArgs();

  console.log('[backtest-xg] Loading MoneyPuck data...');
  const t_load = Date.now();
  const mpData = await loadAllMoneyPuck();
  console.log(`[backtest-xg] Loaded MoneyPuck in ${((Date.now()-t_load)/1000).toFixed(1)}s`);
  console.log(`  teamProfiles: ${mpData.teamProfiles.size}, goalies: ${mpData.goalies.size}, starters: ${mpData.startingGoalies.size}`);

  console.log('[backtest-xg] Loading historical playoff series...');
  const historical = await loadHistoricalSeries();
  const inRange = historical.filter(s => {
    const y = playoffYear(s);
    return y >= opts.startSeason && y <= opts.endSeason;
  });

  const r1Lookup = buildR1Lookup(historical);

  const { withFeatures, dropped } = attachXgFeatures(inRange, mpData, r1Lookup);
  console.log(`[backtest-xg] Attached xG features to ${withFeatures.length}; dropped ${dropped.length}`);
  if (dropped.length > 0 && dropped.length <= 20) {
    for (const d of dropped) console.log(`    ${d.series.seriesId}: ${d.reason}`);
  }

  // Sample feature inspection: first series
  if (withFeatures.length > 0) {
    const sample = withFeatures[0];
    console.log('');
    console.log(`[backtest-xg] Sample features for ${sample.seriesId} ${sample.teamA}vs${sample.teamB}:`);
    const a = sample.features[sample.teamA];
    const b = sample.features[sample.teamB];
    console.log(`  ${sample.teamA}: xGF/60=${a.xg5on5For?.toFixed(2)}, xGA/60=${a.xg5on5Against?.toFixed(2)}, PP=${a.pp_xgf_per60?.toFixed(2)}, PDO=${a.pdo?.toFixed(3)}, G=${a.goalie_name}(${a.goalie_gsax?.toFixed(1)})`);
    console.log(`  ${sample.teamB}: xGF/60=${b.xg5on5For?.toFixed(2)}, xGA/60=${b.xg5on5Against?.toFixed(2)}, PP=${b.pp_xgf_per60?.toFixed(2)}, PDO=${b.pdo?.toFixed(3)}, G=${b.goalie_name}(${b.goalie_gsax?.toFixed(1)})`);
  }

  const summary = summarizeSeries(withFeatures);
  console.log('');
  console.log('[backtest-xg] Historical summary:');
  console.log(`  Total series:          ${summary.totalSeries}`);
  console.log(`  Top-seed win rate:     ${fmt(summary.topSeedWinRate)}`);
  console.log(`  Game 7 home win rate:  ${fmt(summary.game7HomeWinRate)}`);
  console.log('');

  console.log(`[backtest-xg] Running MC predictions (${opts.trials.toLocaleString()} trials each)...`);
  const t0 = Date.now();
  const predictions = [];
  const actuals = [];
  const seriesList = [];

  for (let i = 0; i < withFeatures.length; i++) {
    const s = withFeatures[i];
    const predA = predictSeries(s, opts.trials);
    predictions.push(predA);
    actuals.push(s.actualWinner === s.teamA ? 1 : 0);
    seriesList.push(s);
    if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${withFeatures.length}`);
  }

  console.log(`[backtest-xg] MC done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('');
  printReport(predictions, actuals, seriesList);

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

  const outPath = path.resolve('data/derived/backtest_xg_calibration.json');
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
  console.log(`[backtest-xg] Wrote results to ${path.relative(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error('[backtest-xg] FATAL:', err);
  process.exit(1);
});
