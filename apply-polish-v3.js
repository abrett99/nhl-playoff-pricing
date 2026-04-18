#!/usr/bin/env node
// ============================================================================
// Patch v3: Polish histograms + model toggle + backtest tab + fix overlaps
// ============================================================================

import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';

// ============================================================================
// Polished renderHistogram (smooth KDE-like curve, shaded CI, better axes)
// ============================================================================
const NEW_RENDER_HIST = `function renderHistogram(samples, modelProb, marketProb, width = 460, height = 180, p10, p90) {
  const bins = 60;
  const binWidth = 1 / bins;
  const counts = new Array(bins).fill(0);
  samples.forEach(s => {
    const idx = Math.min(Math.floor(s / binWidth), bins - 1);
    if (idx >= 0) counts[idx]++;
  });

  // Gaussian smoothing
  const kernel = [0.05, 0.12, 0.2, 0.26, 0.2, 0.12, 0.05];
  const smoothed = counts.map((_, i) => {
    let sum = 0, weightSum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j >= 0 && j < bins) {
        sum += counts[j] * kernel[k + 3];
        weightSum += kernel[k + 3];
      }
    }
    return sum / weightSum;
  });

  const maxVal = Math.max(...smoothed, 1);
  const padding = { top: 20, right: 14, bottom: 32, left: 36 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  // Build smooth area path
  let pathD = 'M ' + padding.left + ' ' + (padding.top + plotH);
  smoothed.forEach((v, i) => {
    const x = padding.left + ((i + 0.5) / bins) * plotW;
    const y = padding.top + plotH - (v / maxVal) * plotH;
    pathD += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
  });
  pathD += ' L ' + (padding.left + plotW) + ' ' + (padding.top + plotH) + ' Z';

  // Build stroke line (top edge only)
  let strokeD = '';
  smoothed.forEach((v, i) => {
    const x = padding.left + ((i + 0.5) / bins) * plotW;
    const y = padding.top + plotH - (v / maxVal) * plotH;
    strokeD += (i === 0 ? 'M ' : ' L ') + x.toFixed(1) + ' ' + y.toFixed(1);
  });

  // 80% CI shaded region
  let ciRect = '';
  if (p10 != null && p90 != null) {
    const xStart = padding.left + p10 * plotW;
    const xEnd = padding.left + p90 * plotW;
    ciRect = '<rect x="' + xStart + '" y="' + padding.top + '" width="' + (xEnd - xStart) + '" height="' + plotH + '" fill="rgba(78,205,196,0.08)"/>';
  }

  // Gridlines at 25/50/75
  const gridlines = [0.25, 0.5, 0.75].map(pct => {
    const x = padding.left + pct * plotW;
    return '<line x1="' + x + '" y1="' + padding.top + '" x2="' + x + '" y2="' + (padding.top + plotH) + '" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>';
  }).join('');

  // Y-axis label
  const yLabel = '<text x="10" y="' + (padding.top + plotH / 2) + '" fill="#666" font-size="9" font-family="ui-monospace,monospace" transform="rotate(-90 10 ' + (padding.top + plotH / 2) + ')" text-anchor="middle">DENSITY</text>';

  // Model line
  const modelX = padding.left + modelProb * plotW;
  const modelLine = '<line x1="' + modelX + '" y1="' + padding.top + '" x2="' + modelX + '" y2="' + (padding.top + plotH) + '" stroke="#4ecdc4" stroke-width="2" stroke-dasharray="5 3"/>' +
    '<rect x="' + (modelX - 22) + '" y="' + (padding.top - 8) + '" width="44" height="14" fill="#4ecdc4" rx="2"/>' +
    '<text x="' + modelX + '" y="' + (padding.top + 2) + '" fill="#000" font-size="9" font-family="ui-monospace,monospace" font-weight="700" text-anchor="middle">MODEL</text>';

  // Market line
  let marketLine = '';
  if (marketProb != null && !isNaN(marketProb)) {
    const mx = padding.left + marketProb * plotW;
    marketLine = '<line x1="' + mx + '" y1="' + padding.top + '" x2="' + mx + '" y2="' + (padding.top + plotH) + '" stroke="#ff9f43" stroke-width="2" stroke-dasharray="5 3"/>' +
      '<rect x="' + (mx - 24) + '" y="' + (padding.top + plotH + 4) + '" width="48" height="14" fill="#ff9f43" rx="2"/>' +
      '<text x="' + mx + '" y="' + (padding.top + plotH + 14) + '" fill="#000" font-size="9" font-family="ui-monospace,monospace" font-weight="700" text-anchor="middle">MARKET</text>';
  }

  // X-axis - use actual probability values
  const xLabels = [0, 25, 50, 75, 100].map(pct => {
    const x = padding.left + (pct / 100) * plotW;
    return '<text x="' + x + '" y="' + (height - 12) + '" fill="#888" font-size="10" font-family="ui-monospace,monospace" text-anchor="middle">' + pct + '%</text>';
  }).join('');

  // Axis lines
  const xAxis = '<line x1="' + padding.left + '" y1="' + (padding.top + plotH) + '" x2="' + (padding.left + plotW) + '" y2="' + (padding.top + plotH) + '" stroke="#333" stroke-width="1"/>';

  return '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:' + width + 'px;">' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="rgba(0,0,0,0.15)" rx="6"/>' +
    gridlines + ciRect + yLabel +
    '<path d="' + pathD + '" fill="url(#histGradient)"/>' +
    '<path d="' + strokeD + '" fill="none" stroke="#4ecdc4" stroke-width="1.5" opacity="0.8"/>' +
    xAxis + marketLine + modelLine + xLabels +
    '<defs><linearGradient id="histGradient" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="rgba(78,205,196,0.55)"/>' +
      '<stop offset="100%" stop-color="rgba(78,205,196,0.1)"/>' +
    '</linearGradient></defs>' +
    '</svg>';
}`;

// ============================================================================
// New renderSeriesCard with model toggle + polished layout + fixed overlaps
// ============================================================================
const NEW_RENDER_CARD = `function renderSeriesCard(series) {
  const perGameModel = buildPerGameModel({
    teamFeatures: series.teamFeatures,
    goalieFeatures: series.goalieFeatures,
  });
  const overrides = userOverrides[series.seriesId] || {};
  const mc = simulateSeries({ state: series, perGameModel, overrides, trials: 20000, seed: 42 });
  const boot = simulateSeriesBootstrap({ state: series, perGameModel, overrides, bootstraps: 500, trialsPerBootstrap: 200 });
  const bp = series.bookPrices || {};
  const sw = bp.seriesWinner || {};

  // Global model selection (ensemble | xg | goals)
  const modelKey = activeModel || 'ensemble';
  const mp = series.modelPredictions || null;
  
  // Apply model override to series winner probs if modelPredictions available
  let winnerAProb = mc.seriesWinner[series.teamA].prob;
  let winnerBProb = mc.seriesWinner[series.teamB].prob;
  if (mp && mp[modelKey]) {
    winnerAProb = mp[modelKey][series.teamA];
    winnerBProb = mp[modelKey][series.teamB];
  }

  const aOdds = sw[series.teamA];
  const bOdds = sw[series.teamB];
  const favoriteTeam = (aOdds != null && bOdds != null) ? (aOdds < bOdds ? series.teamA : series.teamB) : series.teamA;
  
  // Model agreement badge
  let agreementBadge = '';
  if (mp && mp.xg && mp.goals) {
    const diff = Math.abs(mp.xg[series.teamA] - mp.goals[series.teamA]) * 100;
    let badgeColor = '#6bcb77', badgeText = 'AGREE';
    if (diff >= 15) { badgeColor = '#ff6b6b'; badgeText = 'DIVERGE ' + diff.toFixed(0) + '%'; }
    else if (diff >= 8) { badgeColor = '#ff9f43'; badgeText = 'SOFT ' + diff.toFixed(0) + '%'; }
    else { badgeText = 'AGREE ' + diff.toFixed(0) + '%'; }
    agreementBadge = '<span class="agreement-badge" style="background:' + badgeColor + '20;color:' + badgeColor + ';border:1px solid ' + badgeColor + '40;">' + badgeText + '</span>';
  }

  const marketTabs = [
    { id: 'winA', label: series.teamA + ' Series', dist: boot.winnerA, modelProb: winnerAProb, book: sw[series.teamA] },
    { id: 'winB', label: series.teamB + ' Series', dist: boot.winnerB, modelProb: winnerBProb, book: sw[series.teamB] },
    { id: 'o55',  label: 'O 5.5',   dist: boot.over55,       modelProb: mc.totalGames.over55.prob,  book: bp.over55 },
    { id: 'u55',  label: 'U 5.5',   dist: boot.under55,      modelProb: mc.totalGames.under55.prob, book: bp.under55 },
    { id: 'o65',  label: 'O 6.5',   dist: boot.over65,       modelProb: (mc.totalGames.over65 && mc.totalGames.over65.prob) || 0,  book: bp.over65 },
    { id: 'u65',  label: 'U 6.5',   dist: boot.under65,      modelProb: (mc.totalGames.under65 && mc.totalGames.under65.prob) || 0, book: bp.under65 },
    { id: 'g7y',  label: 'Goes 7 Y', dist: boot.goesSevenYes, modelProb: mc.goesSeven.yes.prob, book: bp.goesSevenYes },
    { id: 'g7n',  label: 'Goes 7 N', dist: boot.goesSevenNo,  modelProb: mc.goesSeven.no.prob,  book: bp.goesSevenNo },
  ].map(m => {
    const mProb = impliedProb(m.book);
    const edge = (m.book != null && m.book !== '' && !isNaN(m.book)) ? computeEdge(m.modelProb, m.book) : null;
    return Object.assign({}, m, { marketProb: mProb, edge: edge });
  });

  const defaultTabId = favoriteTeam === series.teamA ? 'winA' : 'winB';
  const activeTabId = activeMarketTab[series.seriesId] || defaultTabId;
  const activeMarket = marketTabs.find(m => m.id === activeTabId) || marketTabs[0];
  const lastGame = series.gamesPlayed[series.gamesPlayed.length - 1];
  const stateStr = series.winsA + '\u2013' + series.winsB + '  \u00b7  ' + (lastGame ? 'G' + lastGame.gameNum + ': ' + lastGame.winner : 'G1 upcoming');

  const tabBar = marketTabs.map(m => {
    const edgeCls = m.edge == null ? '' : (m.edge >= 0.03 ? 'tab-pos' : m.edge <= -0.03 ? 'tab-neg' : 'tab-neutral');
    const isActive = m.id === activeTabId ? 'active' : '';
    const edgeStr = m.edge == null ? '\u2014' : ((m.edge >= 0 ? '+' : '') + (m.edge * 100).toFixed(1) + '%');
    return '<button class="mkt-tab ' + isActive + ' ' + edgeCls + '" data-series="' + series.seriesId + '" data-tab="' + m.id + '"><div style="font-size:10px;font-weight:600;">' + m.label + '</div><div style="font-size:9px;opacity:0.7;">' + edgeStr + '</div></button>';
  }).join('');

  const modelFairAmer = probToAmerican(activeMarket.modelProb);
  const marketProbPct = activeMarket.marketProb != null ? (activeMarket.marketProb * 100).toFixed(1) : '\u2014';
  const modelProbPct = (activeMarket.modelProb * 100).toFixed(1);
  const edgeDisplay = activeMarket.edge == null ? '\u2014' : ((activeMarket.edge >= 0 ? '+' : '') + (activeMarket.edge * 100).toFixed(1) + '%');
  const edgeColor = activeMarket.edge == null ? '#888' : (activeMarket.edge >= 0.03 ? '#6bcb77' : activeMarket.edge <= -0.03 ? '#ff6b6b' : '#ff9f43');
  const histogram = renderHistogram(activeMarket.dist.samples, activeMarket.modelProb, activeMarket.marketProb, 460, 180, activeMarket.dist.p10, activeMarket.dist.p90);
  const ci80 = (activeMarket.dist.p10 * 100).toFixed(1) + '% \u2013 ' + (activeMarket.dist.p90 * 100).toFixed(1) + '%';

  const goalies = Object.entries(series.goalieFeatures);
  const hStarterId = (overrides.goalieOverrides && overrides.goalieOverrides.perTeam && overrides.goalieOverrides.perTeam[series.teamA]) || series.currentStarters[series.teamA].playerId;
  const aStarterId = (overrides.goalieOverrides && overrides.goalieOverrides.perTeam && overrides.goalieOverrides.perTeam[series.teamB]) || series.currentStarters[series.teamB].playerId;
  const canBet = activeMarket.edge != null && activeMarket.edge >= 0.03;
  const betBtn = canBet ? '<button class="btn-log-bet-big" data-series="' + series.seriesId + '" data-market="' + activeMarket.label + '" data-side="' + encodeURIComponent(activeMarket.label) + '" data-odds="' + activeMarket.book + '" data-prob="' + activeMarket.modelProb + '" data-edge="' + activeMarket.edge + '">\uff0b Log this bet</button>' : '';

  const pmfHtml = [4,5,6,7].map(n => {
    const p = mc.totalGames.pmf[n] || 0;
    return '<div class="pmf-bar-row"><span>' + n + '</span><div class="pmf-bar" style="width: ' + (p * 100) + '%"></div><span style="color: var(--text-faint)">' + (p * 100).toFixed(0) + '%</span></div>';
  }).join('');

  return '<div class="series-card">' +
    '<div class="matchup">' + series.teamA + ' <span style="color: var(--text-faint); font-size: 14px;">vs</span> ' + series.teamB + ' <span class="badge-round">R' + series.round + '</span> ' + agreementBadge + '</div>' +
    '<div class="state">' + stateStr + '</div>' +
    '<div class="next-game">' + series.currentStarters[series.teamA].name + ' vs ' + series.currentStarters[series.teamB].name + '</div>' +
    '<div class="mkt-tabs">' + tabBar + '</div>' +
    '<div class="active-market">' +
      '<div class="active-market-header">' +
        '<div><div class="active-market-title">' + activeMarket.label + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-top:2px;">80% CI: ' + ci80 + '</div></div>' +
        '<div style="text-align:right;">' +
          '<div style="color:' + edgeColor + ';font-size:20px;font-weight:700;font-family:ui-monospace,monospace;">' + edgeDisplay + '</div>' +
          '<div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Edge</div>' +
        '</div>' +
      '</div>' +
      '<div class="hist-container">' + histogram + '</div>' +
      '<div class="stat-grid">' +
        '<div class="stat-cell"><div class="stat-label">Model Fair</div><div class="stat-val" style="color:#4ecdc4;">' + fmtAmerican(modelFairAmer) + '</div><div class="stat-sub">' + modelProbPct + '%</div></div>' +
        '<div class="stat-cell"><div class="stat-label">Market</div><div class="stat-val" style="color:#ff9f43;">' + fmtAmerican(activeMarket.book) + '</div><div class="stat-sub">' + marketProbPct + '%</div></div>' +
      '</div>' +
      (betBtn ? '<div class="bet-btn-wrap">' + betBtn + '</div>' : '') +
    '</div>' +
    '<div class="section-label">Total games PMF</div>' + pmfHtml +
    '<div style="color: var(--text-dim); font-size: 11px; margin-top: 6px;">Expected: ' + mc.totalGames.expected.toFixed(2) + '</div>' +
    '<div class="what-if">' +
      '<div class="what-if-title">What if\u2026</div>' +
      '<div class="toggle"><span>' + series.teamA + ' goalie</span><select data-series="' + series.seriesId + '" data-team="' + series.teamA + '" class="goalie-override">' + goalies.map(([id, g]) => '<option value="' + id + '" ' + (id == hStarterId ? 'selected' : '') + '>' + (series.currentStarters[series.teamA].playerId == id ? series.currentStarters[series.teamA].name : 'Goalie ' + id) + '</option>').join('') + '</select></div>' +
      '<div class="toggle"><span>' + series.teamB + ' goalie</span><select data-series="' + series.seriesId + '" data-team="' + series.teamB + '" class="goalie-override">' + goalies.map(([id, g]) => '<option value="' + id + '" ' + (id == aStarterId ? 'selected' : '') + '>' + (series.currentStarters[series.teamB].playerId == id ? series.currentStarters[series.teamB].name : 'Goalie ' + id) + '</option>').join('') + '</select></div>' +
      '<button class="btn-save-scenario" data-series="' + series.seriesId + '">\ud83d\udcbe Save this scenario</button>' +
    '</div>' +
  '</div>';
}`;

// ============================================================================
// Model toggle bar (inserted above series grid)
// ============================================================================
const MODEL_TOGGLE_HTML = `<div class="model-toggle-bar" id="modelToggleBar">
  <span class="model-toggle-label">MODEL:</span>
  <button class="model-btn active" data-model="ensemble">Ensemble</button>
  <button class="model-btn" data-model="xg">xG-v3</button>
  <button class="model-btn" data-model="goals">Goals-v2</button>
  <span class="model-toggle-hint">Ensemble blends 60% xG + 40% goals</span>
</div>`;

// ============================================================================
// Backtest tab content
// ============================================================================
const BACKTEST_TAB_CONTENT = `function renderBacktestTab() {
  // Try to load backtest results
  const holder = '<div id="backtestContent">Loading backtest data...</div>';
  setTimeout(loadBacktestData, 100);
  return holder;
}

async function loadBacktestData() {
  const holder = document.getElementById('backtestContent');
  if (!holder) return;
  try {
    const resp = await fetch('./data/backtest_results_real.json').catch(() => null);
    if (!resp || !resp.ok) {
      holder.innerHTML = '<div style="padding:20px;color:var(--text-dim);">No backtest data found. Run: node scripts/run-backtest-real.js</div>';
      return;
    }
    const data = await resp.json();
    const summary = data.summary || data;
    const roi = summary.roi != null ? (summary.roi * 100).toFixed(2) : 'N/A';
    const roiColor = summary.roi >= 0 ? '#6bcb77' : '#ff6b6b';
    const sharpe = summary.sharpe != null ? summary.sharpe.toFixed(2) : 'N/A';
    const winRate = summary.winRate != null ? (summary.winRate * 100).toFixed(1) : 'N/A';
    const maxDD = summary.maxDrawdown != null ? (summary.maxDrawdown * 100).toFixed(2) : 'N/A';
    const totalBets = summary.totalBets || summary.bets || 'N/A';

    const perMarket = summary.perMarket || {};
    const marketCards = Object.entries(perMarket).map(([mkt, m]) => {
      const mROI = m.roi != null ? (m.roi * 100).toFixed(2) : 'N/A';
      const mColor = m.roi >= 0 ? '#6bcb77' : '#ff6b6b';
      return '<div class="bt-market-card"><div class="bt-market-name">' + mkt.toUpperCase() + '</div>' +
        '<div class="bt-market-roi" style="color:' + mColor + '">' + (m.roi >= 0 ? '+' : '') + mROI + '%</div>' +
        '<div class="bt-market-sub">' + (m.bets || 0) + ' bets \u00b7 ' + ((m.winRate || 0) * 100).toFixed(1) + '% win</div>' +
        '</div>';
    }).join('');

    // Walk-forward consistency
    const windows = summary.walkForward || [];
    const consistency = windows.length > 0 ? (windows.filter(w => w.profit > 0).length / windows.length * 100).toFixed(0) : 'N/A';

    holder.innerHTML = 
      '<div class="bt-hero">' +
        '<div class="bt-hero-stat"><div class="bt-stat-label">Overall ROI</div><div class="bt-stat-val" style="color:' + roiColor + '">' + (summary.roi >= 0 ? '+' : '') + roi + '%</div></div>' +
        '<div class="bt-hero-stat"><div class="bt-stat-label">Sharpe</div><div class="bt-stat-val">' + sharpe + '</div></div>' +
        '<div class="bt-hero-stat"><div class="bt-stat-label">Win Rate</div><div class="bt-stat-val">' + winRate + '%</div></div>' +
        '<div class="bt-hero-stat"><div class="bt-stat-label">Max DD</div><div class="bt-stat-val" style="color:#ff6b6b">' + maxDD + '%</div></div>' +
        '<div class="bt-hero-stat"><div class="bt-stat-label">Bets</div><div class="bt-stat-val">' + totalBets + '</div></div>' +
        '<div class="bt-hero-stat"><div class="bt-stat-label">Consist</div><div class="bt-stat-val">' + consistency + '%</div></div>' +
      '</div>' +
      (marketCards ? '<div class="bt-section-title">PER-MARKET BREAKDOWN</div><div class="bt-market-grid">' + marketCards + '</div>' : '') +
      (windows.length > 0 ? '<div class="bt-section-title">WALK-FORWARD WINDOWS</div><div class="bt-windows">' + 
        windows.map((w, i) => {
          const p = w.profit || 0;
          const color = p >= 0 ? '#6bcb77' : '#ff6b6b';
          return '<div class="bt-window"><div style="font-size:9px;color:var(--text-dim);">W' + (i+1) + '</div><div style="font-weight:700;color:' + color + ';">' + (p >= 0 ? '+' : '') + (p * 100).toFixed(1) + '%</div></div>';
        }).join('') + '</div>' : '');
  } catch (e) {
    holder.innerHTML = '<div style="padding:20px;color:#ff6b6b;">Error loading backtest: ' + e.message + '</div>';
  }
}`;

// ============================================================================
// CSS additions for polish + model toggle + backtest
// ============================================================================
const CSS_ADDITIONS = `
  /* Model toggle bar */
  .model-toggle-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .model-toggle-label { font-size: 10px; color: var(--text-dim); letter-spacing: 2px; font-weight: 600; }
  .model-btn { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: var(--text-dim); padding: 6px 14px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 11px; font-weight: 600; transition: all 0.15s; }
  .model-btn:hover { border-color: rgba(255,255,255,0.25); color: var(--text); }
  .model-btn.active { background: rgba(78,205,196,0.15); border-color: rgba(78,205,196,0.5); color: #4ecdc4; }
  .model-toggle-hint { font-size: 10px; color: var(--text-faint); margin-left: auto; }
  
  /* Agreement badge */
  .agreement-badge { font-size: 9px; font-weight: 700; letter-spacing: 1px; padding: 2px 6px; border-radius: 3px; margin-left: 8px; vertical-align: middle; }
  
  /* Bet button positioning (no more overlap) */
  .bet-btn-wrap { margin-top: 12px; text-align: center; }
  .btn-log-bet-big { background: linear-gradient(180deg, rgba(107,203,119,0.2), rgba(107,203,119,0.1)); border: 1px solid rgba(107,203,119,0.5); color: #6bcb77; padding: 10px 18px; border-radius: 5px; cursor: pointer; font-family: inherit; font-size: 11px; font-weight: 700; letter-spacing: 1px; width: 100%; transition: all 0.15s; }
  .btn-log-bet-big:hover { background: linear-gradient(180deg, rgba(107,203,119,0.3), rgba(107,203,119,0.15)); transform: translateY(-1px); }
  
  /* Section label */
  .section-label { margin-top: 16px; font-size: 10px; letter-spacing: 1px; color: var(--text-dim); text-transform: uppercase; margin-bottom: 8px; }
  
  /* Backtest tab */
  .bt-hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 24px; }
  .bt-hero-stat { background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.05); padding: 14px; border-radius: 6px; text-align: center; }
  .bt-stat-label { font-size: 10px; color: var(--text-dim); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px; }
  .bt-stat-val { font-size: 22px; font-weight: 700; font-family: ui-monospace, monospace; color: var(--text); }
  .bt-section-title { font-size: 11px; color: var(--text-dim); letter-spacing: 2px; margin: 20px 0 12px; font-weight: 600; }
  .bt-market-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
  .bt-market-card { background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.05); padding: 14px; border-radius: 6px; }
  .bt-market-name { font-size: 10px; color: var(--text-dim); letter-spacing: 1px; margin-bottom: 6px; }
  .bt-market-roi { font-size: 20px; font-weight: 700; font-family: ui-monospace, monospace; }
  .bt-market-sub { font-size: 10px; color: var(--text-faint); margin-top: 4px; }
  .bt-windows { display: flex; gap: 6px; flex-wrap: wrap; }
  .bt-window { background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 4px; text-align: center; min-width: 60px; }
`;

const MODEL_TOGGLE_STATE = `let activeModel = 'ensemble';`;

const MODEL_CLICK_HANDLER = `
  document.querySelectorAll('.model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeModel = btn.dataset.model;
      document.querySelectorAll('.model-btn').forEach(b => b.classList.toggle('active', b === btn));
      render();
    });
  });
`;

// ============================================================================
// APPLY PATCH
// ============================================================================
async function main() {
  let html = await fs.readFile(HTML_PATH, 'utf-8');
  await fs.writeFile(HTML_PATH + '.bak3', html);
  console.log('[patch-v3] Backup saved to', HTML_PATH + '.bak3');

  // 1. Replace renderHistogram function
  const hIdx = html.indexOf('function renderHistogram(samples,');
  if (hIdx === -1) throw new Error('Could not find renderHistogram');
  let hEnd = -1, depth = 0, started = false;
  for (let i = hIdx; i < html.length; i++) {
    if (html[i] === '{') { depth++; started = true; }
    else if (html[i] === '}') {
      depth--;
      if (started && depth === 0) { hEnd = i + 1; break; }
    }
  }
  if (hEnd === -1) throw new Error('Could not find end of renderHistogram');
  console.log('[patch-v3] Replacing renderHistogram');
  html = html.slice(0, hIdx) + NEW_RENDER_HIST + html.slice(hEnd);

  // 2. Replace renderSeriesCard
  const rscIdx = html.indexOf('function renderSeriesCard(series)');
  if (rscIdx === -1) throw new Error('Could not find renderSeriesCard');
  let rscEnd = -1;
  depth = 0; started = false;
  for (let i = rscIdx; i < html.length; i++) {
    if (html[i] === '{') { depth++; started = true; }
    else if (html[i] === '}') {
      depth--;
      if (started && depth === 0) { rscEnd = i + 1; break; }
    }
  }
  if (rscEnd === -1) throw new Error('Could not find end of renderSeriesCard');
  console.log('[patch-v3] Replacing renderSeriesCard');
  html = html.slice(0, rscIdx) + NEW_RENDER_CARD + html.slice(rscEnd);

  // 3. Add activeModel state (near activeMarketTab)
  const amtIdx = html.indexOf('const activeMarketTab = {};');
  if (amtIdx === -1) throw new Error('Could not find activeMarketTab declaration');
  html = html.slice(0, amtIdx) + MODEL_TOGGLE_STATE + '\n' + html.slice(amtIdx);

  // 4. Insert model toggle HTML in the series view - before series.map
  // Find where data.series.map(renderSeriesCard) is called
  const mapIdx = html.indexOf('data.series.map(renderSeriesCard)');
  if (mapIdx === -1) throw new Error('Could not find data.series.map');
  // Go back to find the assignment
  const assignStart = html.lastIndexOf('view.innerHTML =', mapIdx);
  if (assignStart === -1) throw new Error('Could not find view.innerHTML assignment');
  // Wrap the series content with model toggle + grid wrapper
  const oldMapCall = 'view.innerHTML = ';
  const mapLineStart = assignStart;
  const newPrefix = "view.innerHTML = '" + MODEL_TOGGLE_HTML.replace(/'/g, "\\'").replace(/\n/g, '') + "' + ";
  html = html.slice(0, mapLineStart) + newPrefix + html.slice(mapLineStart + oldMapCall.length);
  console.log('[patch-v3] Model toggle HTML inserted');

  // 5. Add backtest function
  const renderTabsIdx = html.indexOf('function renderTabs()');
  if (renderTabsIdx !== -1) {
    html = html.slice(0, renderTabsIdx) + BACKTEST_TAB_CONTENT + '\n\n' + html.slice(renderTabsIdx);
    console.log('[patch-v3] renderBacktestTab added');
  }

  // 6. Wire Health tab to use renderBacktestTab
  // Find the tab switching logic for health
  const healthIdx = html.indexOf("currentTab === 'health'");
  if (healthIdx !== -1) {
    // Find the HTML for health tab and replace
    // Look for innerHTML assignment in that block
    const searchStart = healthIdx;
    const nextBlockEnd = html.indexOf('}', searchStart + 200);
    const block = html.slice(searchStart, nextBlockEnd);
    if (block.includes('healthy')) {
      // Simple replacement: use renderBacktestTab output
      const healthBlockIdx = html.indexOf('view.innerHTML =', healthIdx);
      if (healthBlockIdx !== -1) {
        const endOfLine = html.indexOf(';', healthBlockIdx);
        if (endOfLine !== -1) {
          html = html.slice(0, healthBlockIdx) + 'view.innerHTML = renderBacktestTab()' + html.slice(endOfLine);
          console.log('[patch-v3] Health tab now shows backtest');
        }
      }
    }
  }

  // 7. Update tab label from Health to Backtest
  html = html.replace(/>Health</g, '>Backtest<');
  html = html.replace(/>HEALTH</g, '>BACKTEST<');

  // 8. Add CSS before </style>
  const styleEndIdx = html.indexOf('</style>');
  if (styleEndIdx === -1) throw new Error('Could not find </style>');
  html = html.slice(0, styleEndIdx) + CSS_ADDITIONS + '\n' + html.slice(styleEndIdx);

  // 9. Add model click handler
  const goalieListenerIdx = html.indexOf(".goalie-override')");
  if (goalieListenerIdx !== -1) {
    const endMarker = '});';
    const endBlock = html.indexOf(endMarker, goalieListenerIdx);
    if (endBlock !== -1) {
      const insertAt = endBlock + endMarker.length;
      html = html.slice(0, insertAt) + '\n' + MODEL_CLICK_HANDLER + html.slice(insertAt);
      console.log('[patch-v3] Model click handler added');
    }
  }

  await fs.writeFile(HTML_PATH, html);
  console.log('[patch-v3] \u2713 Success!');
  console.log('[patch-v3] Next: node scripts/add-predictions.js && git add -A && git commit -m "Polish v3" && git push');
}

main().catch(err => {
  console.error('[patch-v3] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
