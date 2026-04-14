// ============================================================================
// NATURAL STAT TRICK SCRAPER
// ============================================================================
// NST is the primary source for multi-timeframe team and goalie stats with
// per-situation filtering (sva, pp, pk, 5v5). It's also behind Cloudflare
// which blocks direct fetch(). This module uses Playwright to render the
// page in a real browser, then extracts the team/goalie tables.
//
// Install once:
//   npm install --save-dev playwright
//   npx playwright install chromium
//
// Two export modes:
//   - teamTableUrl(opts)   → URL for team table
//   - goalieTableUrl(opts) → URL for goalie table
// Each page has a sortable HTML table we extract with a single DOM query.
//
// This module is lazy-imported from scripts/ingest-nst.js so that the rest
// of the codebase doesn't require Playwright.
// ============================================================================

import { nstTeamUrl, nstGoalieUrl, GAME_TYPE } from '../config.js';

// ============================================================================
// URL builders (re-exported for convenience)
// ============================================================================

export { nstTeamUrl, nstGoalieUrl };

// ============================================================================
// Table extraction
// ============================================================================

/**
 * Fetch a NST page via Playwright and extract the primary table as rows
 * of { column: value } objects.
 *
 * @param {Object} params
 * @param {string} params.url
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{ headers: string[], rows: object[], rawHtml: string }>}
 */
export async function fetchNstTable({ url, timeoutMs = 30000 }) {
  // Lazy import — only pulled in if this function is actually called
  const { chromium } = await import('playwright');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // NST pages render tables with id="teams" or id="players"
    // Wait for one to appear
    await page.waitForSelector('table tbody tr', { timeout: timeoutMs });

    // Extract table: headers + rows
    const data = await page.evaluate(() => {
      const table = document.querySelector('table#teams, table#players, table');
      if (!table) return { headers: [], rows: [] };

      const headerCells = Array.from(table.querySelectorAll('thead th'));
      const headers = headerCells.map(th => th.textContent.trim());

      const rowEls = Array.from(table.querySelectorAll('tbody tr'));
      const rows = rowEls.map(tr => {
        const cells = Array.from(tr.querySelectorAll('td'));
        const row = {};
        cells.forEach((td, i) => {
          const key = headers[i] || `col${i}`;
          row[key] = td.textContent.trim();
        });
        return row;
      });

      return { headers, rows };
    });

    const rawHtml = await page.content();
    return { ...data, rawHtml };
  } finally {
    await browser.close();
  }
}

/**
 * Convert extracted table rows into CSV text (tab-delimited to match NST's
 * CSV export format, which the rest of the pipeline expects).
 */
export function rowsToTsv(headers, rows) {
  const lines = [headers.join('\t')];
  for (const row of rows) {
    lines.push(headers.map(h => row[h] ?? '').join('\t'));
  }
  return lines.join('\n');
}

// ============================================================================
// Canonical feature pulls (team + goalie for multiple situations)
// ============================================================================

/**
 * Pull all situations needed for the playoff-adjusted model.
 * Returns one dataset per situation.
 */
export async function pullAllNstFeatures({ season, stype = GAME_TYPE.PLAYOFF }) {
  const seasonStr = String(season);
  const fromSeason = seasonStr;
  const thruSeason = seasonStr;

  const situations = [
    { name: 'team_sva', url: nstTeamUrl({ fromSeason, thruSeason, situation: 'sva', stype }) },
    { name: 'team_pp',  url: nstTeamUrl({ fromSeason, thruSeason, situation: 'pp',  stype }) },
    { name: 'team_pk',  url: nstTeamUrl({ fromSeason, thruSeason, situation: 'pk',  stype }) },
    { name: 'goalies',  url: nstGoalieUrl({ fromSeason, thruSeason, stype }) },
  ];

  const results = {};
  for (const s of situations) {
    console.log(`[nst] pulling ${s.name}: ${s.url}`);
    try {
      const table = await fetchNstTable({ url: s.url });
      results[s.name] = {
        headers: table.headers,
        rows: table.rows,
        tsv: rowsToTsv(table.headers, table.rows),
        rawHtml: table.rawHtml,
      };
      console.log(`[nst] ${s.name}: ${table.rows.length} rows`);
      // Polite delay between pulls
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[nst] ${s.name}: ${e.message}`);
      results[s.name] = { error: e.message };
    }
  }

  return results;
}
