#!/usr/bin/env node
// ============================================================================
// Minimal patch v4: smooth histogram + model toggle (select dropdown, module scope)
// ============================================================================

import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';

// ---- Change 1: new renderHistogram (smooth, gradient, shaded CI, larger) ----
const NEW_RENDER_HIST = `function renderHistogram(samples, modelProb, marketProb, width = 460, height = 180, p10, p90) {
  const bins = 60;
  const binWidth = 1 / bins;
  const counts = new Array(bins).fill(0);
  samples.forEach(s => {
    const idx = Math.min(Math.floor(s / binWidth), bins - 1);
    if (idx >= 0) counts[idx]++;
  });
  const kernel = [0.05, 0.12, 0.2, 0.26, 0.2, 0.12, 0.05];
  const smoothed = counts.map((_, i) => {
    let sum = 0, weightSum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j >= 0 && j < bins) { sum += counts[j] * kernel[k + 3]; weightSum += kernel[k + 3]; }
    }
    return sum / weightSum;
  });
  const maxVal = Math.max(...smoothed, 1);
  const padding = { top: 20, right: 14, bottom: 32, left: 36 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  let pathD = 'M ' + padding.left + ' ' + (padding.top + plotH);
  smoothed.forEach((v, i) => {
    const x = padding.left + ((i + 0.5) / bins) * plotW;
    const y = padding.top + plotH - (v / maxVal) * plotH;
    pathD += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
  });
  pathD += ' L ' + (padding.left + plotW) + ' ' + (padding.top + plotH) + ' Z';
  let strokeD = '';
  smoothed.forEach((v, i) => {
    const x = padding.left + ((i + 0.5) / bins) * plotW;
    const y = padding.top + plotH - (v / maxVal) * plotH;
    strokeD += (i === 0 ? 'M ' : ' L ') + x.toFixed(1) + ' ' + y.toFixed(1);
  });
  let ciRect = '';
  if (p10 != null && p90 != null) {
    const xStart = padding.left + p10 * plotW;
    const xEnd = padding.left + p90 * plotW;
    ciRect = '<rect x="' + xStart + '" y="' + padding.top + '" width="' + (xEnd - xStart) + '" height="' + plotH + '" fill="rgba(78,205,196,0.08)"/>';
  }
  const gridlines = [0.25, 0.5, 0.75].map(pct => {
    const x = padding.left + pct * plotW;
    return '<line x1="' + x + '" y1="' + padding.top + '" x2="' + x + '" y2="' + (padding.top + plotH) + '" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>';
  }).join('');
  const modelX = padding.left + modelProb * plotW;
  const modelLine = '<line x1="' + modelX + '" y1="' + padding.top + '" x2="' + modelX + '" y2="' + (padding.top + plotH) + '" stroke="#4ecdc4" stroke-width="2" stroke-dasharray="5 3"/>' +
    '<rect x="' + (modelX - 22) + '" y="' + (padding.top - 8) + '" width="44" height="14" fill="#4ecdc4" rx="2"/>' +
    '<text x="' + modelX + '" y="' + (padding.top + 2) + '" fill="#000" font-size="9" font-family="ui-monospace,monospace" font-weight="700" text-anchor="middle">MODEL</text>';
  let marketLine = '';
  if (marketProb != null && !isNaN(marketProb)) {
    const mx = padding.left + marketProb * plotW;
    marketLine = '<line x1="' + mx + '" y1="' + padding.top + '" x2="' + mx + '" y2="' + (padding.top + plotH) + '" stroke="#ff9f43" stroke-width="2" stroke-dasharray="5 3"/>' +
      '<rect x="' + (mx - 24) + '" y="' + (padding.top + plotH + 4) + '" width="48" height="14" fill="#ff9f43" rx="2"/>' +
      '<text x="' + mx + '" y="' + (padding.top + plotH + 14) + '" fill="#000" font-size="9" font-family="ui-monospace,monospace" font-weight="700" text-anchor="middle">MARKET</text>';
  }
  const xLabels = [0, 25, 50, 75, 100].map(pct => {
    const x = padding.left + (pct / 100) * plotW;
    return '<text x="' + x + '" y="' + (height - 12) + '" fill="#888" font-size="10" font-family="ui-monospace,monospace" text-anchor="middle">' + pct + '%</text>';
  }).join('');
  const xAxis = '<line x1="' + padding.left + '" y1="' + (padding.top + plotH) + '" x2="' + (padding.left + plotW) + '" y2="' + (padding.top + plotH) + '" stroke="#333" stroke-width="1"/>';
  return '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:' + width + 'px;">' +
    '<defs><linearGradient id="histGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(78,205,196,0.55)"/><stop offset="100%" stop-color="rgba(78,205,196,0.1)"/></linearGradient></defs>' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="rgba(0,0,0,0.15)" rx="6"/>' +
    gridlines + ciRect +
    '<path d="' + pathD + '" fill="url(#histGradient)"/>' +
    '<path d="' + strokeD + '" fill="none" stroke="#4ecdc4" stroke-width="1.5" opacity="0.8"/>' +
    xAxis + marketLine + modelLine + xLabels +
    '</svg>';
}`;

// ---- Change 2: insert model toggle state declaration & add model selector ----
// We add a module-scope `let activeModel = 'ensemble';` right next to activeMarketTab
// And the toggle UI + onchange handler goes into the series view render

const TOGGLE_HTML_SNIPPET = `<div class="model-toggle-bar"><span class="model-toggle-label">MODEL:</span><select id="modelSelect" class="model-select"><option value="ensemble">Ensemble (60/40)</option><option value="xg">xG-v3</option><option value="goals">Goals-v2</option></select><span class="model-toggle-hint">60% xG + 40% goals</span></div>`;

const TOGGLE_CSS = `
  .model-toggle-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .model-toggle-label { font-size: 10px; color: var(--text-dim); letter-spacing: 2px; font-weight: 600; }
  .model-select { background: rgba(0,0,0,0.4); color: #4ecdc4; border: 1px solid rgba(78,205,196,0.3); border-radius: 4px; padding: 6px 10px; font-family: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
  .model-select:hover { border-color: rgba(78,205,196,0.6); }
  .model-toggle-hint { font-size: 10px; color: var(--text-faint); margin-left: auto; }
  .agreement-badge { font-size: 9px; font-weight: 700; letter-spacing: 1px; padding: 2px 6px; border-radius: 3px; margin-left: 8px; vertical-align: middle; }
`;

async function main() {
  let html = await fs.readFile(HTML_PATH, 'utf-8');
  await fs.writeFile(HTML_PATH + '.bak_v4', html);
  console.log('[v4] Backup saved');

  // 1. Replace renderHistogram
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
  console.log('[v4] Replacing renderHistogram at', hIdx, '-', hEnd);
  html = html.slice(0, hIdx) + NEW_RENDER_HIST + html.slice(hEnd);

  // 2. Add activeModel declaration next to activeMarketTab
  const amtIdx = html.indexOf('const activeMarketTab = {};');
  if (amtIdx === -1) throw new Error('Could not find activeMarketTab');
  if (!html.includes("let activeModel ")) {
    html = html.slice(0, amtIdx) + "let activeModel = 'ensemble';\n" + html.slice(amtIdx);
    console.log('[v4] Added activeModel declaration');
  }

  // 3. In renderSeriesCard, modify the winnerA/winnerB probs to use activeModel if modelPredictions exist
  // Find the marketTabs declaration
  const marketTabsLine = html.indexOf("const marketTabs = [");
  if (marketTabsLine === -1) throw new Error('Could not find marketTabs');
  // Insert BEFORE the marketTabs declaration: pull model probs if available
  const preTabsCode = `const mp = series.modelPredictions;
  let winnerAProb = mc.seriesWinner[series.teamA].prob;
  let winnerBProb = mc.seriesWinner[series.teamB].prob;
  if (mp && mp[activeModel]) {
    winnerAProb = mp[activeModel][series.teamA];
    winnerBProb = mp[activeModel][series.teamB];
  }
  `;
  html = html.slice(0, marketTabsLine) + preTabsCode + html.slice(marketTabsLine);
  console.log('[v4] Added model-override logic before marketTabs');

  // Update winA/winB lines to use winnerAProb / winnerBProb
  html = html.replace(
    "{ id: 'winA', label: series.teamA + ' Series', dist: boot.winnerA, modelProb: mc.seriesWinner[series.teamA].prob,",
    "{ id: 'winA', label: series.teamA + ' Series', dist: boot.winnerA, modelProb: winnerAProb,"
  );
  html = html.replace(
    "{ id: 'winB', label: series.teamB + ' Series', dist: boot.winnerB, modelProb: mc.seriesWinner[series.teamB].prob,",
    "{ id: 'winB', label: series.teamB + ' Series', dist: boot.winnerB, modelProb: winnerBProb,"
  );
  console.log('[v4] Updated winA/winB to use activeModel probs');

  // 4. Pass p10/p90 to renderHistogram call (for shaded CI)
  html = html.replace(
    'const histogram = renderHistogram(activeMarket.dist.samples, activeMarket.modelProb, activeMarket.marketProb);',
    'const histogram = renderHistogram(activeMarket.dist.samples, activeMarket.modelProb, activeMarket.marketProb, 460, 180, activeMarket.dist.p10, activeMarket.dist.p90);'
  );
  console.log('[v4] Updated renderHistogram call to pass p10/p90');

  // 5. Insert model toggle into series tab HTML (BEFORE series-grid)
  const seriesHtmlLine = `view.innerHTML = '<div class="series-grid">' + data.series.map(renderSeriesCard).join('') + '</div>'`;
  const newSeriesHtmlLine = `view.innerHTML = '${TOGGLE_HTML_SNIPPET}<div class="series-grid">' + data.series.map(renderSeriesCard).join('') + '</div>'`;
  if (html.includes(seriesHtmlLine)) {
    html = html.replace(seriesHtmlLine, newSeriesHtmlLine);
    console.log('[v4] Inserted model toggle HTML');
  } else {
    console.warn('[v4] Could not find series render line');
  }

  // 6. Add onchange handler for the model select (inside series render block)
  // Find the goalie-override listener block and add model-select handler next to it
  const goalieAttachIdx = html.indexOf("document.querySelectorAll('.goalie-override')");
  if (goalieAttachIdx === -1) throw new Error('Could not find goalie listener');
  const insertBefore = html.slice(0, goalieAttachIdx);
  const insertAfter = html.slice(goalieAttachIdx);
  const modelHandler = `// Wire model selector
    const modelSel = document.getElementById('modelSelect');
    if (modelSel) {
      modelSel.value = activeModel;
      modelSel.addEventListener('change', (e) => {
        activeModel = e.target.value;
        render();
      });
    }

    `;
  html = insertBefore + modelHandler + insertAfter;
  console.log('[v4] Added model-select change handler');

  // 7. Add CSS
  const styleEndIdx = html.indexOf('</style>');
  if (styleEndIdx === -1) throw new Error('Could not find </style>');
  html = html.slice(0, styleEndIdx) + TOGGLE_CSS + '\n' + html.slice(styleEndIdx);
  console.log('[v4] Added toggle CSS');

  await fs.writeFile(HTML_PATH, html);
  console.log('[v4] \u2713 Done! File written.');
  console.log('[v4] Test locally: open src/ui/index.html');
  console.log('[v4] Then: git add src/ui/index.html && git commit -m "v4: smooth hist + model toggle" && git push');
}

main().catch(err => {
  console.error('[v4] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
