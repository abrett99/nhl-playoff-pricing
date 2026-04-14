// ============================================================================
// PER-GAME BACKTEST HARNESS
// ============================================================================
// Validates the per-game model on individual playoff games rather than
// complete series. ~850 games over 10 years gives much more statistical
// power than 150 series, at the cost of not validating the MC itself.
//
// Two things we care about:
//   1. ACCURACY: % of games where favored team won. Hard ceiling ~62%.
//   2. CALIBRATION: Do games we predicted at 60% actually win 60% of the
//      time? A model can be ROI-positive with only 58% accuracy if it's
//      well-calibrated.
//
// Calibration is reported as a Brier score + reliability diagram bins.
// Lower Brier = better calibration. 0.25 = random coin flip.
// ============================================================================

import { americanToProb, americanToDecimal, edge } from '../engine/odds.js';
import { mean, std, percentile } from '../engine/util.js';
import { HISTORICAL_BASE_RATES, MODEL } from '../config.js';

// ============================================================================
// Core: per-game backtest
// ============================================================================

/**
 * @param {Object} params
 * @param {Array} params.games - flat array of historical games, each:
 *   { gameId, seriesId, round, gameNum, homeTeam, awayTeam, winner,
 *     homeGoals, awayGoals, ot, asOfDate, features, bookPrices, seriesState }
 * @param {Function} params.modelFactory - (features) => perGameModel closure
 * @param {Object} [params.config]
 * @returns {Object} { accuracy, calibration, markets, redFlags }
 */
export function runPerGameBacktest({ games, modelFactory, config = {} }) {
  const cfg = {
    minEdgePct: 0.03,
    kellyFraction: 0.25,
    bankroll: 10000,
    bootstrapResamples: MODEL.BOOTSTRAP_RESAMPLES,
    calibrationBins: 10,
    ...config,
  };

  const predictions = [];
  const bets = {
    homeML: [],
    awayML: [],
    over55: [],
    under55: [],
  };

  for (const game of games) {
    const perGameModel = modelFactory(game.features);
    const pred = perGameModel({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      gameNum: game.gameNum,
      seriesState: game.seriesState,
    });

    const prediction = {
      gameId: game.gameId,
      seriesId: game.seriesId,
      asOfDate: game.asOfDate,
      modelHomeProb: pred.homeWinProb,
      modelLambda: pred.totalGoalsLambda,
      actualHomeWin: game.winner === game.homeTeam,
      actualTotalGoals: (game.homeGoals || 0) + (game.awayGoals || 0),
      favored: pred.homeWinProb > 0.5 ? game.homeTeam : game.awayTeam,
      correct: (pred.homeWinProb > 0.5) === (game.winner === game.homeTeam),
    };
    predictions.push(prediction);

    // Collect bets if book prices present
    if (game.bookPrices) {
      considerBet(bets.homeML, {
        modelProb: pred.homeWinProb,
        american: game.bookPrices.homeML,
        won: game.winner === game.homeTeam,
        cfg,
        meta: { gameId: game.gameId, asOfDate: game.asOfDate,
                clv: computeClv(game.bookPrices.homeML, game.pinnacleClosing?.homeML) },
      });
      considerBet(bets.awayML, {
        modelProb: 1 - pred.homeWinProb,
        american: game.bookPrices.awayML,
        won: game.winner === game.awayTeam,
        cfg,
        meta: { gameId: game.gameId, asOfDate: game.asOfDate,
                clv: computeClv(game.bookPrices.awayML, game.pinnacleClosing?.awayML) },
      });
      // Totals
      if (game.bookPrices.over55) {
        const modelOverProb = poissonTailProb(pred.totalGoalsLambda, 5.5, 'over');
        considerBet(bets.over55, {
          modelProb: modelOverProb,
          american: game.bookPrices.over55,
          won: prediction.actualTotalGoals > 5.5,
          cfg,
          meta: { gameId: game.gameId, asOfDate: game.asOfDate },
        });
      }
      if (game.bookPrices.under55) {
        const modelUnderProb = poissonTailProb(pred.totalGoalsLambda, 5.5, 'under');
        considerBet(bets.under55, {
          modelProb: modelUnderProb,
          american: game.bookPrices.under55,
          won: prediction.actualTotalGoals < 5.5,
          cfg,
          meta: { gameId: game.gameId, asOfDate: game.asOfDate },
        });
      }
    }
  }

  // ═══ Accuracy ═══
  const correct = predictions.filter(p => p.correct).length;
  const accuracy = predictions.length > 0 ? correct / predictions.length : null;

  // ═══ Calibration ═══
  const calibration = computeCalibration(predictions, cfg.calibrationBins);

  // ═══ Per-market betting ═══
  const marketResults = {};
  for (const [name, marketBets] of Object.entries(bets)) {
    marketResults[name] = summarizeBets(marketBets, cfg);
  }

  // ═══ Red flags ═══
  const redFlags = [];
  if (accuracy !== null && accuracy > HISTORICAL_BASE_RATES.single_game_accuracy_ceiling) {
    redFlags.push({
      type: 'per_game_accuracy_ceiling_exceeded',
      value: accuracy,
      ceiling: HISTORICAL_BASE_RATES.single_game_accuracy_ceiling,
      message: `Per-game accuracy ${(accuracy * 100).toFixed(1)}% exceeds ` +
               `theoretical ceiling ${(HISTORICAL_BASE_RATES.single_game_accuracy_ceiling * 100)}% — ` +
               `almost certainly leakage`,
    });
  }
  if (calibration.brierScore > 0.27) {
    redFlags.push({
      type: 'poor_calibration',
      value: calibration.brierScore,
      message: `Brier score ${calibration.brierScore.toFixed(3)} worse than near-random — ` +
               `model may be anti-calibrated`,
    });
  }
  if (calibration.brierScore < 0.18) {
    redFlags.push({
      type: 'suspiciously_good_calibration',
      value: calibration.brierScore,
      message: `Brier score ${calibration.brierScore.toFixed(3)} is implausibly good — ` +
               `NHL single-game prediction has a theoretical floor around 0.21`,
    });
  }

  return {
    accuracy,
    sampleSize: predictions.length,
    calibration,
    markets: marketResults,
    redFlags,
    config: cfg,
  };
}

// ============================================================================
// Calibration (Brier score + reliability bins)
// ============================================================================

function computeCalibration(predictions, nBins) {
  if (predictions.length === 0) {
    return { brierScore: null, bins: [], logLoss: null };
  }

  // Brier score: mean((predicted - actual)^2)
  let brierSum = 0;
  let logLossSum = 0;
  const EPS = 1e-9;
  for (const p of predictions) {
    const actual = p.actualHomeWin ? 1 : 0;
    brierSum += (p.modelHomeProb - actual) ** 2;
    logLossSum += actual * Math.log(Math.max(p.modelHomeProb, EPS))
                + (1 - actual) * Math.log(Math.max(1 - p.modelHomeProb, EPS));
  }
  const brierScore = brierSum / predictions.length;
  const logLoss = -logLossSum / predictions.length;

  // Reliability bins
  const bins = [];
  for (let i = 0; i < nBins; i++) {
    const lo = i / nBins;
    const hi = (i + 1) / nBins;
    const inBin = predictions.filter(p =>
      p.modelHomeProb >= lo && p.modelHomeProb < hi + (i === nBins - 1 ? 0.0001 : 0)
    );
    if (inBin.length === 0) {
      bins.push({ range: [lo, hi], n: 0, avgPredicted: null, actualRate: null });
      continue;
    }
    const avgPredicted = mean(inBin.map(p => p.modelHomeProb));
    const actualRate = mean(inBin.map(p => p.actualHomeWin ? 1 : 0));
    bins.push({
      range: [lo, hi],
      n: inBin.length,
      avgPredicted,
      actualRate,
      gap: actualRate - avgPredicted,
    });
  }

  return { brierScore, logLoss, bins };
}

// ============================================================================
// Betting helpers
// ============================================================================

function considerBet(list, { modelProb, american, won, cfg, meta = {} }) {
  if (american === undefined || american === null) return;
  const betEdge = edge(modelProb, american);
  if (betEdge < cfg.minEdgePct) return;

  const decimal = americanToDecimal(american);
  const b = decimal - 1;
  const kelly = (b * modelProb - (1 - modelProb)) / b;
  if (kelly <= 0) return;
  const stake = cfg.bankroll * kelly * cfg.kellyFraction;

  const payout = won ? stake * b : -stake;
  list.push({ modelProb, american, stake, won, pnl: payout, edge: betEdge, ...meta });
}

function summarizeBets(bets, cfg) {
  if (bets.length === 0) {
    return { n: 0, hitRate: null, roi: null, totalPnl: 0, ci95: null, avgClv: null };
  }
  const wins = bets.filter(b => b.won).length;
  const totalStake = bets.reduce((s, b) => s + b.stake, 0);
  const totalPnl = bets.reduce((s, b) => s + b.pnl, 0);
  const roi = totalStake > 0 ? totalPnl / totalStake : 0;
  const clvs = bets.map(b => b.clv).filter(c => c !== null && c !== undefined);
  const avgClv = clvs.length > 0 ? mean(clvs) : null;

  const ci95 = bootstrapRoiCi(bets, cfg.bootstrapResamples);
  return {
    n: bets.length,
    wins,
    hitRate: wins / bets.length,
    totalStake,
    totalPnl,
    roi,
    avgEdge: mean(bets.map(b => b.edge)),
    avgClv,
    ci95,
  };
}

function bootstrapRoiCi(bets, resamples) {
  if (bets.length === 0) return null;
  const rois = [];
  for (let i = 0; i < resamples; i++) {
    let pnl = 0, stake = 0;
    for (let j = 0; j < bets.length; j++) {
      const b = bets[Math.floor(Math.random() * bets.length)];
      pnl += b.pnl;
      stake += b.stake;
    }
    rois.push(stake > 0 ? pnl / stake : 0);
  }
  return {
    lower: percentile(rois, 2.5),
    median: percentile(rois, 50),
    upper: percentile(rois, 97.5),
    std: std(rois),
  };
}

function computeClv(bookAmerican, pinnacleClosing) {
  if (bookAmerican === undefined || pinnacleClosing === undefined) return null;
  const ourProb = americanToProb(bookAmerican);
  const closingProb = americanToProb(pinnacleClosing);
  return (closingProb - ourProb) / ourProb;
}

// ============================================================================
// Poisson tail probabilities (for totals bets)
// ============================================================================

function poissonTailProb(lambda, threshold, direction) {
  // P(X > threshold) where X ~ Poisson(lambda), for threshold = N.5
  // Equivalent to P(X >= ceil(threshold)) for "over" direction
  const floor = Math.floor(threshold);
  let cdf = 0;
  let p = Math.exp(-lambda);
  cdf += p;
  for (let k = 1; k <= floor; k++) {
    p *= lambda / k;
    cdf += p;
  }
  return direction === 'over' ? 1 - cdf : cdf;
}

// ============================================================================
// Per-series → flat games conversion helper
// ============================================================================

/**
 * Convert an array of historical series (from ingest-historical.js) into
 * the flat games array that runPerGameBacktest expects.
 */
export function flattenSeriesToGames(series, { featureBuilder } = {}) {
  const games = [];
  for (const s of series) {
    let runningWinsA = 0, runningWinsB = 0;
    const prevGames = [];

    for (const g of s.games) {
      // Build seriesState AS OF this game (before it was played)
      const seriesState = {
        seriesId: s.seriesId,
        teamA: s.teamA,
        teamB: s.teamB,
        winsA: runningWinsA,
        winsB: runningWinsB,
        round: s.round,
        gamesPlayed: [...prevGames],
      };

      // Default: use series-level features if no featureBuilder passed
      const features = featureBuilder
        ? featureBuilder(s, g, seriesState)
        : s.features;

      games.push({
        gameId: g.gameId,
        seriesId: s.seriesId,
        round: s.round,
        gameNum: g.gameNum,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        winner: g.winner,
        homeGoals: g.homeGoals,
        awayGoals: g.awayGoals,
        ot: g.ot,
        asOfDate: g.startTime,
        seriesState,
        features,
        bookPrices: g.bookPrices || null,
        pinnacleClosing: g.pinnacleClosing || null,
      });

      // Advance state for next iteration
      if (g.winner === s.teamA) runningWinsA++;
      else if (g.winner === s.teamB) runningWinsB++;
      prevGames.push({
        gameNum: g.gameNum,
        winner: g.winner,
        venue: g.homeTeam,
        goals: [g.awayGoals, g.homeGoals],
      });
    }
  }
  return games;
}
