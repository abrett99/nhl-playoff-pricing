#!/usr/bin/env node
// ============================================================================
// Patch script: Apply histogram + market tabs to src/ui/index.html
// ============================================================================
// Usage: node apply-histogram-patch.js
// ============================================================================

import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';

// ----------------------------------------------------------------------------
// BOOTSTRAP + HISTOGRAM FUNCTIONS (inserted after simulateSeries)
// ----------------------------------------------------------------------------
const BOOTSTRAP_CODE = `
function simulateSeriesBootstrap({ state, perGameModel, overrides = {}, bootstraps = 500, trialsPerBootstrap = 200 }) {
  const dists = {
    winnerA: [], winnerB: [],
    over55: [], under55: [],
    over65: [], under65: [],
    goesSevenYes: [], goesSevenNo: [],
  };
  for (let b = 0; b < bootstraps; b++) {
    const rng = seededRng(42 + b * 7919);
    let winsACount = 0;
    const totalsCount = { 4: 0, 5: 0, 6: 0, 7: 0 };
    for (let i = 0; i < trialsPerBootstrap; i++) {
      let wA = state.winsA, wB = state.winsB;
      let gp = state.gamesPlayed?.length || 0;
      while (wA < 4 && wB < 4) {
        const gameNum = gp + 1;
        const venueLetter = VENUE_SEQUENCE[gameNum - 1];
        const homeTeam = venueLetter === 'A' ? state.teamA : state.teamB;
        const awayTeam = venueLetter === 'A' ? state.teamB : state.teamA;
        const pred = perGameModel({ homeTeam, awayTeam, gameNum,
          seriesState: { ...state, winsA: wA, winsB: wB }, overrides });
        const homeWins = rng() < pred.homeWinProb;
        const winnerTeam = homeWins ? homeTeam : awayTeam;
        if (winnerTeam === state.teamA) wA++; else wB++;
        gp++;
      }
      if (wA === 4) winsACount++;
      totalsCount[gp]++;
    }
    const aProb = winsACount / trialsPerBootstrap;
    const t4 = totalsCount[4] / trialsPerBootstrap;
    const t5 = totalsCount[5] / trialsPerBootstrap;
    const t6 = totalsCount[6] / trialsPerBootstrap;
    const t7 = totalsCount[7] / trialsPerBootstrap;
    dists.winnerA.push(aProb);
    dists.winnerB.push(1 - aProb);
    dists.over55.push(t6 + t7);
    dists.under55.push(t4 + t5);
    dists.over65.push(t7);
    dists.under65.push(t4 + t5 + t6);
    dists.goesSevenYes.push(t7);
    dists.goesSevenNo.push(1 - t7);
  }
  const summarize = arr => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    const p10 = sorted[Math.floor(sorted.length * 0.10)];
    const p90 = sorted[Math.floor(sorted.length * 0.90)];
    return { mean, p10, p90, samples: arr };
  };
  return Object.fromEntries(Object.entries(dists).map(([k, v]) => [k, summarize(v)]));
}

function renderHistogram(samples, modelProb, marketProb, width = 380, height = 140) {
  const bins = 30;
  const binWidth = 1 / bins;
  const counts = new Array(bins).fill(0);
  samples.forEach(s => {
    const idx = Math.min(Math.floor(s / binWidth), bins - 1);
    if (idx >= 0) counts[idx]++;
  });
  const maxCount = Math.max(...counts, 1);
  const padding = { top: 10, right: 10, bottom: 24, left: 10 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const bars = counts.map((c, i) => {
    const x = padding.left + (i / bins) * plotW;
    const w = plotW / bins - 1;
    const h = (c / maxCount) * plotH;
    const y = padding.top + plotH - h;
    return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="rgba(78,205,196,0.45)"/>';
  }).join('');
  const modelX = padding.left + modelProb * plotW;
  const modelLine = '<line x1="' + modelX + '" y1="' + padding.top + '" x2="' + modelX + '" y2="' + (padding.top + plotH) + '" stroke="#4ecdc4" stroke-width="2" stroke-dasharray="4 3"/><text x="' + (modelX + 4) + '" y="' + (padding.top + 12) + '" fill="#4ecdc4" font-size="10" font-family="ui-monospace,monospace" font-weight="600">MODEL</text>';
  let marketLine = '';
  if (marketProb != null && !isNaN(marketProb)) {
    const mx = padding.left + marketProb * plotW;
    marketLine = '<line x1="' + mx + '" y1="' + padding.top + '" x2="' + mx + '" y2="' + (padding.top + plotH) + '" stroke="#ff9f43" stroke-width="2" stroke-dasharray="4 3"/><text x="' + (mx - 40) + '" y="' + (padding.top + 12) + '" fill="#ff9f43" font-size="10" font-family="ui-monospace,monospace" font-weight="600">MARKET</text>';
  }
  const xLabels = [0, 25, 50, 75, 100].map(pct => {
    const x = padding.left + (pct / 100) * plotW;
    return '<text x="' + x + '" y="' + (height - 8) + '" fill="#666" font-size="9" font-family="ui-monospace,monospace" text-anchor="middle">' + pct + '%</text>';
  }).join('');
  return '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:' + width + 'px;"><rect x="0" y="0" width="' + width + '" height="' + height + '" fill="rgba(0,0,0,0.2)" rx="4"/>' + bars + marketLine + modelLine + xLabels + '</svg>';
}

function impliedProb(americanOdds) {
  if (americanOdds == null || isNaN(americanOdds)) return null;
  return americanOdds < 0 ? (-americanOdds) / (-americanOdds + 100) : 100 / (americanOdds + 100);
}

const activeMarketTab = {};
`;

// ----------------------------------------------------------------------------
// NEW renderSeriesCard FUNCTION (replaces existing)
// ----------------------------------------------------------------------------
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
  const aOdds = sw[series.teamA];
  const bOdds = sw[series.teamB];
  const favoriteTeam = (aOdds != null && bOdds != null) ? (aOdds < bOdds ? series.teamA : series.teamB) : series.teamA;
  const marketTabs = [
    { id: 'winA', label: series.teamA + ' Series', dist: boot.winnerA, modelProb: mc.seriesWinner[series.teamA].prob, book: sw[series.teamA] },
    { id: 'winB', label: series.teamB + ' Series', dist: boot.winnerB, modelProb: mc.seriesWinner[series.teamB].prob, book: sw[series.teamB] },
    { id: 'o55',  label: 'O 5.5',   dist: boot.over55,       modelProb: mc.totalGames.over55.prob,  book: bp.over55 },
    { id: 'u55',  label: 'U 5.5',   dist: boot.under55,      modelProb: mc.totalGames.under55.prob, book: bp.under55 },
    { id: 'o65',  label: 'O 6.5',   dist: boot.over65,       modelProb: (mc.totalGames.over65 && mc.totalGames.over65.prob) || 0,  book: bp.over65 },
    { id: 'u65',  label: 'U 6.5',   dist: boot.under65,      modelProb: (mc.totalGames.under65 && mc.totalGames.under65.prob) || 0, book: bp.under65 },
    { id: 'g7y',  label: 'Goes 7 Y', dist: boot.goesSevenYes, modelProb: mc.goesSeven.yes.prob, book: bp.goesSevenYes },
    { id: 'g7n',  label: 'Goes 7 N', dist: boot.goesSevenNo,  modelProb: mc.goesSeven.no.prob,  book: bp.goesSevenNo },
  ].map(m => {
    const mp = impliedProb(m.book);
    const edge = (m.book != null && m.book !== '' && !isNaN(m.book)) ? computeEdge(m.modelProb, m.book) : null;
    return Object.assign({}, m, { marketProb: mp, edge: edge });
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
  const histogram = renderHistogram(activeMarket.dist.samples, activeMarket.modelProb, activeMarket.marketProb);
  const ci80 = (activeMarket.dist.p10 * 100).toFixed(1) + '% \u2013 ' + (activeMarket.dist.p90 * 100).toFixed(1) + '%';
  const goalies = Object.entries(series.goalieFeatures);
  const hStarterId = (overrides.goalieOverrides && overrides.goalieOverrides.perTeam && overrides.goalieOverrides.perTeam[series.teamA]) || series.currentStarters[series.teamA].playerId;
  const aStarterId = (overrides.goalieOverrides && overrides.goalieOverrides.perTeam && overrides.goalieOverrides.perTeam[series.teamB]) || series.currentStarters[series.teamB].playerId;
  const canBet = activeMarket.edge != null && activeMarket.edge >= 0.03;
  const betBtn = canBet ? '<button class="btn-log-bet" data-series="' + series.seriesId + '" data-market="' + activeMarket.label + '" data-side="' + encodeURIComponent(activeMarket.label) + '" data-odds="' + activeMarket.book + '" data-prob="' + activeMarket.modelProb + '" data-edge="' + activeMarket.edge + '">\uff0b Log bet</button>' : '';
  const pmfHtml = [4,5,6,7].map(n => {
    const p = mc.totalGames.pmf[n] || 0;
    return '<div class="pmf-bar-row"><span>' + n + '</span><div class="pmf-bar" style="width: ' + (p * 100) + '%"></div><span style="color: var(--text-faint)">' + (p * 100).toFixed(0) + '%</span></div>';
  }).join('');
  return '<div class="series-card"><div class="matchup">' + series.teamA + ' <span style="color: var(--text-faint); font-size: 14px;">vs</span> ' + series.teamB + ' <span class="badge-round">R' + series.round + '</span></div><div class="state">' + stateStr + '</div><div class="next-game">' + series.currentStarters[series.teamA].name + ' vs ' + series.currentStarters[series.teamB].name + '</div><div class="mkt-tabs">' + tabBar + '</div><div class="active-market"><div class="active-market-header"><div><div class="active-market-title">' + activeMarket.label + '</div><div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-top:2px;">80% CI: ' + ci80 + '</div></div><div style="text-align:right;"><div style="color:' + edgeColor + ';font-size:18px;font-weight:700;font-family:ui-monospace,monospace;">' + edgeDisplay + '</div><div style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Edge</div></div></div><div class="hist-container">' + histogram + '</div><div class="stat-grid"><div class="stat-cell"><div class="stat-label">Model Fair</div><div class="stat-val" style="color:#4ecdc4;">' + fmtAmerican(modelFairAmer) + '</div><div class="stat-sub">' + modelProbPct + '%</div></div><div class="stat-cell"><div class="stat-label">Market</div><div class="stat-val" style="color:#ff9f43;">' + fmtAmerican(activeMarket.book) + '</div><div class="stat-sub">' + marketProbPct + '%</div></div></div>' + (betBtn ? '<div style="margin-top:10px;text-align:center;">' + betBtn + '</div>' : '') + '</div><div style="margin-top: 16px; font-size: 10px; letter-spacing: 1px; color: var(--text-dim); text-transform: uppercase; margin-bottom: 6px;">Total games PMF</div>' + pmfHtml + '<div style="color: var(--text-dim); font-size: 11px; margin-top: 6px;">Expected: ' + mc.totalGames.expected.toFixed(2) + '</div><div class="what-if"><div class="what-if-title">What if\u2026</div><div class="toggle"><span>' + series.teamA + ' goalie</span><select data-series="' + series.seriesId + '" data-team="' + series.teamA + '" class="goalie-override">' + goalies.map(([id, g]) => '<option value="' + id + '" ' + (id == hStarterId ? 'selected' : '') + '>' + (series.currentStarters[series.teamA].playerId == id ? series.currentStarters[series.teamA].name : 'Goalie ' + id) + '</option>').join('') + '</select></div><div class="toggle"><span>' + series.teamB + ' goalie</span><select data-series="' + series.seriesId + '" data-team="' + series.teamB + '" class="goalie-override">' + goalies.map(([id, g]) => '<option value="' + id + '" ' + (id == aStarterId ? 'selected' : '') + '>' + (series.currentStarters[series.teamB].playerId == id ? series.currentStarters[series.teamB].name : 'Goalie ' + id) + '</option>').join('') + '</select></div><button class="btn-save-scenario" data-series="' + series.seriesId + '">\ud83d\udcbe Save this scenario</button></div></div>';
}`;

// ----------------------------------------------------------------------------
// CSS additions
// ----------------------------------------------------------------------------
const CSS_ADDITIONS = `
  .mkt-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 14px 0 12px; }
  .mkt-tab { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); color: var(--text-dim); padding: 6px 4px; border-radius: 4px; cursor: pointer; font-family: inherit; transition: all 0.15s; }
  .mkt-tab:hover { border-color: rgba(255,255,255,0.2); }
  .mkt-tab.active { background: rgba(78,205,196,0.1); border-color: rgba(78,205,196,0.4); color: #4ecdc4; }
  .mkt-tab.tab-pos div:last-child { color: #6bcb77; }
  .mkt-tab.tab-neg div:last-child { color: #ff6b6b; }
  .mkt-tab.tab-neutral div:last-child { color: #ff9f43; }
  .active-market { background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; padding: 14px; margin-bottom: 14px; }
  .active-market-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px; }
  .active-market-title { font-size: 16px; font-weight: 600; color: var(--text); }
  .hist-container { margin: 10px 0; }
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
  .stat-cell { background: rgba(0,0,0,0.25); padding: 10px; border-radius: 4px; text-align: center; }
  .stat-label { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .stat-val { font-size: 18px; font-weight: 700; font-family: ui-monospace, monospace; }
  .stat-sub { font-size: 10px; color: var(--text-faint); margin-top: 2px; }
`;

// ----------------------------------------------------------------------------
// TAB CLICK HANDLER (inserted where other listeners attach)
// ----------------------------------------------------------------------------
const TAB_HANDLER = `
  document.querySelectorAll('.mkt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.series;
      const tid = btn.dataset.tab;
      activeMarketTab[sid] = tid;
      render();
    });
  });
`;

// ----------------------------------------------------------------------------
// APPLY PATCH
// ----------------------------------------------------------------------------
async function main() {
  let html = await fs.readFile(HTML_PATH, 'utf-8');

  // Backup
  await fs.writeFile(HTML_PATH + '.bak', html);
  console.log('[patch] Backup saved to', HTML_PATH + '.bak');

  // 1. Insert bootstrap functions after simulateSeries closing brace
  // Find the end of simulateSeries (first `^}` after `function simulateSeries`)
  const simIdx = html.indexOf('function simulateSeries(');
  if (simIdx === -1) throw new Error('Could not find simulateSeries');
  // Find the matching closing brace
  let depth = 0, endIdx = -1;
  for (let i = simIdx; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx === -1) throw new Error('Could not find end of simulateSeries');
  console.log('[patch] Inserting bootstrap code at position', endIdx);
  html = html.slice(0, endIdx) + '\n' + BOOTSTRAP_CODE + '\n' + html.slice(endIdx);

  // 2. Replace renderSeriesCard entirely
  const rscIdx = html.indexOf('function renderSeriesCard(series)');
  if (rscIdx === -1) throw new Error('Could not find renderSeriesCard');
  depth = 0; endIdx = -1;
  let started = false;
  for (let i = rscIdx; i < html.length; i++) {
    if (html[i] === '{') { depth++; started = true; }
    else if (html[i] === '}') {
      depth--;
      if (started && depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx === -1) throw new Error('Could not find end of renderSeriesCard');
  console.log('[patch] Replacing renderSeriesCard from', rscIdx, 'to', endIdx);
  html = html.slice(0, rscIdx) + NEW_RENDER_CARD + html.slice(endIdx);

  // 3. Add CSS - insert before </style>
  const styleEndIdx = html.indexOf('</style>');
  if (styleEndIdx === -1) throw new Error('Could not find </style>');
  html = html.slice(0, styleEndIdx) + CSS_ADDITIONS + '\n' + html.slice(styleEndIdx);
  console.log('[patch] CSS added');

  // 4. Add tab click handler - insert after .goalie-override listener setup
  // Look for document.querySelectorAll('.goalie-override') or similar
  const goalieIdx = html.indexOf(".goalie-override')");
  if (goalieIdx !== -1) {
    // Find the end of that querySelectorAll block (forEach closing });)
    let searchStart = goalieIdx;
    const endMarker = '});';
    const endBlock = html.indexOf(endMarker, searchStart);
    if (endBlock !== -1) {
      const insertAt = endBlock + endMarker.length;
      html = html.slice(0, insertAt) + '\n' + TAB_HANDLER + html.slice(insertAt);
      console.log('[patch] Tab handler added after goalie-override listener');
    } else {
      console.warn('[patch] Could not find end of goalie-override block - you will need to add TAB_HANDLER manually');
    }
  } else {
    console.warn('[patch] Could not find goalie-override listener - you will need to add TAB_HANDLER manually');
  }

  await fs.writeFile(HTML_PATH, html);
  console.log('[patch] \u2713 Patch applied successfully to', HTML_PATH);
  console.log('[patch] \u2713 Backup at', HTML_PATH + '.bak');
  console.log('[patch] Next: git add src/ui/index.html && git commit -m "Histogram + tabs" && git push');
}

main().catch(err => {
  console.error('[patch] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
