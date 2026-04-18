#!/usr/bin/env node
import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';
const WORKFLOW_PATH = '.github/workflows/deploy-pages.yml';

async function main() {
  // === FIX 1: Model toggle click handler ===
  let html = await fs.readFile(HTML_PATH, 'utf-8');
  await fs.writeFile(HTML_PATH + '.bak_fix2', html);

  // Check if handler exists
  const hasHandler = html.includes(".model-btn')");
  console.log('[fix2] Model handler currently present:', hasHandler);

  if (!hasHandler) {
    // Need to find where listeners are attached - after goalie-override handler
    const marker = ".goalie-override')";
    const idx = html.indexOf(marker);
    if (idx === -1) throw new Error('Cannot find goalie listener');
    
    // Find end of the forEach block
    const endMarker = '});';
    const endIdx = html.indexOf(endMarker, idx);
    if (endIdx === -1) throw new Error('Cannot find end of goalie block');
    const insertAt = endIdx + endMarker.length;
    
    const handler = `

  document.querySelectorAll('.model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeModel = btn.dataset.model;
      document.querySelectorAll('.model-btn').forEach(b => b.classList.toggle('active', b === btn));
      render();
    });
  });`;

    html = html.slice(0, insertAt) + handler + html.slice(insertAt);
    console.log('[fix2] Added model-btn click handler');
  } else {
    console.log('[fix2] Handler exists - checking if it runs...');
  }

  // Also check - the handler is inside attachListeners but it runs only ONCE at page load.
  // When render() re-generates HTML, the new .model-btn buttons don't have listeners!
  // Fix: Use event delegation on document
  
  // Remove any existing non-delegated model-btn handler and add delegated one
  // Also guard against DOMContentLoaded timing
  
  // Insert delegated handler at top-level (not inside attachListeners)
  // Find where render() function is defined
  const delegatedHandler = `
// Global delegated click handler for model toggle (works across re-renders)
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.model-btn');
  if (!btn) return;
  e.preventDefault();
  activeModel = btn.dataset.model;
  document.querySelectorAll('.model-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});
`;

  // Insert before the closing </script> tag
  const scriptEndIdx = html.lastIndexOf('</script>');
  if (scriptEndIdx !== -1 && !html.includes('Global delegated click handler for model toggle')) {
    html = html.slice(0, scriptEndIdx) + delegatedHandler + html.slice(scriptEndIdx);
    console.log('[fix2] Added delegated model-btn handler');
  }

  await fs.writeFile(HTML_PATH, html);

  // === FIX 2: Deploy backtest files ===
  let workflow = await fs.readFile(WORKFLOW_PATH, 'utf-8');
  await fs.writeFile(WORKFLOW_PATH + '.bak_fix2', workflow);

  if (!workflow.includes('backtest_results_real.json')) {
    const insertAfter = 'cp data/derived/seeding_projection.json _site/data/ 2>/dev/null || true\n          fi';
    const newBlock = `${insertAfter}
          if [ -f data/derived/backtest_results_real.json ]; then
            cp data/derived/backtest_results_real.json _site/data/ 2>/dev/null || true
          fi
          if [ -f data/derived/backtest_calibration.json ]; then
            cp data/derived/backtest_calibration.json _site/data/ 2>/dev/null || true
          fi
          if [ -f data/derived/backtest_xg_calibration.json ]; then
            cp data/derived/backtest_xg_calibration.json _site/data/ 2>/dev/null || true
          fi`;
    workflow = workflow.replace(insertAfter, newBlock);
    await fs.writeFile(WORKFLOW_PATH, workflow);
    console.log('[fix2] Updated workflow to include backtest files');
  } else {
    console.log('[fix2] Workflow already includes backtest');
  }

  console.log('[fix2] \u2713 Done');
}

main().catch(err => {
  console.error('[fix2] FAILED:', err.message);
  process.exit(1);
});
