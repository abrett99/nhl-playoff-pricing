// ============================================================================
// BACKTEST HARNESS
// ============================================================================
// Walk-forward backtesting with per-market breakdown and bootstrap CI.
//
// Design principles enforced by this module:
//   • Chronological train/test split only (no random splits)
//   • Per-market ROI + Kelly-weighted ROI + CLV vs Pinnacle
//   • Bootstrap CI on ROI (1000 resamples) — playoff sample size is small
//     (~150 series over 10 years) so confidence bands matter
//   • Red-flag checks: per-game accuracy >62% or series accuracy >75% =
//     almost certainly leakage
//   • Aggregate ROI masks underperforming markets; always drill per-market
// ============================================================================

import { simulateSeries, computeEdges } from '../engine/simulateSeries.js';
import { americanToProb, americanToDecimal, edge as edgeFn, kellyStake } from '../engine/odds.js';
import { mean, std, percentile } from '../engine/util.js';
import { HISTORICAL_BASE_RATES, MODEL } from '../config.js';

// ============================================================================
// Core: run backtest across a dataset of historical series
// ============================================================================

/**
 * @param {Object} params
 * @param {Array} params.series       - Historical series with known outcomes
 *                                      Each: { seriesId, teamA, teamB, round,
 *                                              actualWinner, actualTotalGames,
 *                                              asOfDate, bookPrices, features }
 * @param {Function} params.modelFactory - (features) => perGameModel closure
 * @param {Object} [params.config]
 * @returns {Object} Results by market + overall + CI
 */
export function runBacktest({ series, modelFactory, config = {} }) {
  const cfg = {
    minEdgePct: 0.03,
    bankroll: 10000,
    kellyFraction: 0.25,
    trials: MODEL.MC_TRIALS,
    seed: 42,
    bootstrapResamples: MODEL.BOOTSTRAP_RESAMPLES,
    ...config,
  };

  const bets = {
    seriesWinner: [],
    over55: [],
    under55: [],
    over65: [],
    under65: [],
    goesSevenYes: [],
    goesSevenNo: [],
  };

  let perGameCorrect = 0;
  let perGameTotal = 0;
  let seriesCorrect = 0;

  for (const s of series) {
    const perGameModel = modelFactory(s.features);

    const mc = simulateSeries({
      state: {
        seriesId: s.seriesId,
        teamA: s.teamA,
        teamB: s.teamB,
        winsA: 0,
        winsB: 0,
        gamesPlayed: [],
        round: s.round,
      },
      perGameModel,
      trials: cfg.trials,
      seed: cfg.seed,
    });

    // Series accuracy: which side did model favor?
    const favored = mc.seriesWinner[s.teamA].prob > 0.5 ? s.teamA : s.teamB;
    if (favored === s.actualWinner) seriesCorrect++;

    // Find edges against historical book prices
    const edges = computeEdges(mc, s.bookPrices || {});

    for (const e of edges) {
      if (e.edge < cfg.minEdgePct) continue;

      const marketKey = normalizeMarketKey(e.market);
      if (!bets[marketKey]) continue;

      const won = didBetWin(e, s);
      const payout = won
        ? (americanToDecimal(e.bookAmerican) - 1)  // profit per $1 staked
        : -1;
      const stake = kellyStake(e.modelProb, e.bookAmerican, cfg.bankroll, cfg.kellyFraction).stake;

      bets[marketKey].push({
        seriesId: s.seriesId,
        asOfDate: s.asOfDate,
        modelProb: e.modelProb,
        bookAmerican: e.bookAmerican,
        bookImpliedProb: americanToProb(e.bookAmerican),
        edge: e.edge,
        stake,
        won,
        pnl: stake * payout,
        side: e.side,
        actualWinner: s.actualWinner,
        actualTotalGames: s.actualTotalGames,
        // CLV vs Pinnacle closing
        clv: s.pinnacleClosing ? computeClv(e, s.pinnacleClosing) : null,
      });
    }

    // Per-game accuracy (if per-game predictions were logged)
    if (s.perGamePredictions) {
      for (const pred of s.perGamePredictions) {
        perGameTotal++;
        if (pred.favored === pred.actualWinner) perGameCorrect++;
      }
    }
  }

  // Per-market summary with bootstrap CI
  const byMarket = {};
  for (const [market, marketBets] of Object.entries(bets)) {
    byMarket[market] = summarizeMarket(marketBets, cfg);
  }

  // ══ Red-flag checks ══
  const redFlags = [];
  const perGameAcc = perGameTotal > 0 ? perGameCorrect / perGameTotal : null;
  const seriesAcc = series.length > 0 ? seriesCorrect / series.length : null;
  if (perGameAcc && perGameAcc > HISTORICAL_BASE_RATES.single_game_accuracy_ceiling) {
    redFlags.push({
      type: 'per_game_accuracy_ceiling_exceeded',
      value: perGameAcc,
      ceiling: HISTORICAL_BASE_RATES.single_game_accuracy_ceiling,
      message: `Per-game accuracy ${(perGameAcc * 100).toFixed(1)}% exceeds theoretical ceiling ${(HISTORICAL_BASE_RATES.single_game_accuracy_ceiling * 100)}% — likely data leakage`,
    });
  }
  if (seriesAcc && seriesAcc > HISTORICAL_BASE_RATES.series_accuracy_ceiling) {
    redFlags.push({
      type: 'series_accuracy_ceiling_exceeded',
      value: seriesAcc,
      ceiling: HISTORICAL_BASE_RATES.series_accuracy_ceiling,
      message: `Series accuracy ${(seriesAcc * 100).toFixed(1)}% exceeds theoretical ceiling ${(HISTORICAL_BASE_RATES.series_accuracy_ceiling * 100)}% — likely data leakage`,
    });
  }

  // Aggregate across all markets
  const allBets = Object.values(bets).flat();
  const overall = summarizeMarket(allBets, cfg);

  return {
    overall,
    byMarket,
    accuracy: {
      perGame: perGameAcc,
      series: seriesAcc,
      perGameSampleSize: perGameTotal,
      seriesSampleSize: series.length,
    },
    redFlags,
    config: cfg,
  };
}

// ============================================================================
// Walk-forward validation
// ============================================================================

/**
 * Chronological windows: train on [start, splitDate), test on [splitDate, end).
 * For each window, fit → evaluate → advance.
 *
 * @param {Object} params
 * @param {Array} params.series - all historical series, chronologically sorted
 * @param {Function} params.fitModel - (trainingSeries) => modelFactory
 * @param {number} [params.windowMonths] - test window size
 * @param {number} [params.minTrainingSize]
 */
export function runWalkForward({
  series,
  fitModel,
  windowMonths = 12,
  minTrainingSize = 50,
  config = {},
}) {
  // Sort by date ascending (defensive)
  const sorted = [...series].sort((a, b) =>
    new Date(a.asOfDate) - new Date(b.asOfDate)
  );

  const windows = [];
  const msPerMonth = 30 * 24 * 60 * 60 * 1000;

  let pivot = new Date(sorted[minTrainingSize]?.asOfDate);
  while (pivot) {
    const trainEnd = pivot.getTime();
    const testEnd = trainEnd + windowMonths * msPerMonth;

    const train = sorted.filter(s => new Date(s.asOfDate) < pivot);
    const test = sorted.filter(s => {
      const t = new Date(s.asOfDate).getTime();
      return t >= trainEnd && t < testEnd;
    });

    if (test.length === 0) break;
    if (train.length < minTrainingSize) {
      pivot = new Date(testEnd);
      continue;
    }

    const modelFactory = fitModel(train);
    const result = runBacktest({ series: test, modelFactory, config });

    windows.push({
      trainStart: train[0]?.asOfDate,
      trainEnd: pivot.toISOString(),
      testEnd: new Date(testEnd).toISOString(),
      trainSize: train.length,
      testSize: test.length,
      ...result,
    });

    pivot = new Date(testEnd);
  }

  // Consistency metric: how stable is per-market ROI across windows?
  const consistency = computeConsistency(windows);

  return {
    windows,
    consistency,
    overall: aggregateWindows(windows),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function didBetWin(edge, series) {
  if (edge.market === 'seriesWinner') {
    return edge.side === series.actualWinner;
  }
  const tg = series.actualTotalGames;
  if (edge.market === 'over55')  return tg > 5.5;
  if (edge.market === 'under55') return tg < 5.5;
  if (edge.market === 'over65')  return tg > 6.5;
  if (edge.market === 'under65') return tg < 6.5;
  if (edge.market === 'goesSevenYes') return tg === 7;
  if (edge.market === 'goesSevenNo')  return tg !== 7;
  return null;
}

function computeClv(edge, pinnacleClosing) {
  const closingPrice = pinnacleClosing[edge.market];
  if (!closingPrice) return null;
  const closingImplied = americanToProb(closingPrice);
  const ourImplied = americanToProb(edge.bookAmerican);
  // Positive CLV = we beat closing (got better price than closing)
  return (closingImplied - ourImplied) / ourImplied;
}

function normalizeMarketKey(m) {
  const map = {
    over55: 'over55', under55: 'under55',
    over65: 'over65', under65: 'under65',
    goesSevenYes: 'goesSevenYes', goesSevenNo: 'goesSevenNo',
    seriesWinner: 'seriesWinner',
  };
  return map[m] || m;
}

function summarizeMarket(bets, cfg) {
  if (bets.length === 0) {
    return {
      n: 0, hitRate: null, avgEdge: null,
      roiPerUnit: null, roiKelly: null, totalPnl: 0,
      avgClv: null, ci95: null,
    };
  }

  const wins = bets.filter(b => b.won).length;
  const hitRate = wins / bets.length;
  const avgEdge = mean(bets.map(b => b.edge));
  const totalStake = bets.reduce((s, b) => s + b.stake, 0);
  const totalPnl = bets.reduce((s, b) => s + b.pnl, 0);
  const roiPerUnit = mean(bets.map(b => b.pnl / Math.max(b.stake, 1)));
  const roiKelly = totalStake > 0 ? totalPnl / totalStake : 0;
  const clvs = bets.map(b => b.clv).filter(c => c !== null && c !== undefined);
  const avgClv = clvs.length > 0 ? mean(clvs) : null;

  // Bootstrap CI on roiPerUnit
  const ci95 = bootstrapCi(bets, cfg.bootstrapResamples);

  return {
    n: bets.length,
    wins,
    hitRate,
    avgEdge,
    totalStake,
    totalPnl,
    roiPerUnit,
    roiKelly,
    avgClv,
    ci95,
  };
}

function bootstrapCi(bets, resamples = 1000) {
  if (bets.length === 0) return null;
  const rois = [];
  for (let i = 0; i < resamples; i++) {
    const sample = [];
    for (let j = 0; j < bets.length; j++) {
      sample.push(bets[Math.floor(Math.random() * bets.length)]);
    }
    const stake = sample.reduce((s, b) => s + b.stake, 0);
    const pnl = sample.reduce((s, b) => s + b.pnl, 0);
    rois.push(stake > 0 ? pnl / stake : 0);
  }
  return {
    lower: percentile(rois, 2.5),
    median: percentile(rois, 50),
    upper: percentile(rois, 97.5),
    mean: mean(rois),
    std: std(rois),
  };
}

function computeConsistency(windows) {
  if (windows.length < 2) return null;
  const marketConsistencies = {};
  for (const window of windows) {
    for (const [market, summary] of Object.entries(window.byMarket || {})) {
      if (!marketConsistencies[market]) marketConsistencies[market] = [];
      if (summary.roiKelly !== null) marketConsistencies[market].push(summary.roiKelly);
    }
  }
  const result = {};
  for (const [market, rois] of Object.entries(marketConsistencies)) {
    if (rois.length < 2) continue;
    const positiveWindows = rois.filter(r => r > 0).length;
    result[market] = {
      windowsCount: rois.length,
      positiveWindows,
      positiveRate: positiveWindows / rois.length,
      meanRoi: mean(rois),
      stdRoi: std(rois),
    };
  }
  return result;
}

function aggregateWindows(windows) {
  const allBets = [];
  for (const w of windows) {
    for (const marketBets of Object.values(w.byMarket || {})) {
      // We don't have the raw bets per market after summarizeMarket runs,
      // so this aggregation uses market-level numbers; for raw-level
      // aggregation, summarize should retain raw bets (future improvement).
    }
  }
  // Aggregate hitRate and ROI across all windows by weighting by n
  let totalBets = 0, totalWins = 0, totalStake = 0, totalPnl = 0;
  for (const w of windows) {
    totalBets += w.overall?.n ?? 0;
    totalWins += w.overall?.wins ?? 0;
    totalStake += w.overall?.totalStake ?? 0;
    totalPnl += w.overall?.totalPnl ?? 0;
  }
  return {
    windowCount: windows.length,
    totalBets,
    hitRate: totalBets > 0 ? totalWins / totalBets : null,
    roiKelly: totalStake > 0 ? totalPnl / totalStake : null,
    totalPnl,
  };
}
