#!/usr/bin/env node
// ============================================================================
// INGEST: Natural Stat Trick (via Playwright)
// ============================================================================
// Pulls team and goalie tables from NST for the current playoff season.
// Uses Playwright because NST is behind Cloudflare.
//
// One-time setup:
//   npm install --save-dev playwright
//   npx playwright install chromium
//
// Usage:
//   node scripts/ingest-nst.js
//   node scripts/ingest-nst.js --season 2025 --stype 3   (playoff=3, regular=2)
// ============================================================================

import { pullAllNstFeatures } from '../src/ingest/nst.js';
import {
  CheckReport,
  checkParse,
  checkSemanticRanges,
  checkKnownTeams,
  CheckResult,
} from '../src/sanity/checks.js';
import { commitPull } from '../src/ingest/store.js';
import { SEASON, GAME_TYPE } from '../src/config.js';
import { alertPipelineHealth } from '../src/alerts/telegram.js';

async function main() {
  const args = process.argv.slice(2);
  function arg(name, def) {
    const idx = args.findIndex(a => a === `--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  }

  const season = parseInt(arg('season', String(SEASON.CURRENT_START_YEAR)), 10);
  const stype = parseInt(arg('stype', String(GAME_TYPE.PLAYOFF)), 10);

  console.log(`[ingest-nst] Pulling season=${season} stype=${stype}`);

  let results;
  try {
    results = await pullAllNstFeatures({ season, stype });
  } catch (e) {
    console.error(`[ingest-nst] Playwright error: ${e.message}`);
    await alertPipelineHealth({
      source: 'nst',
      status: 'scraper_error',
      detail: e.message,
    });
    process.exit(1);
  }

  for (const [name, data] of Object.entries(results)) {
    if (data.error) {
      console.error(`[ingest-nst] ${name}: ${data.error}`);
      continue;
    }

    const source = `nst_${name}`;
    const report = new CheckReport(source);

    // Layer 1: we got data back (Playwright equivalent of fetch check)
    if (data.rows.length > 0) {
      report.add(CheckResult.ok(1, 'playwright_returned_data', { rows: data.rows.length }));
    } else {
      report.add(CheckResult.fail(1, 'playwright_returned_data', 'Empty rowset'));
    }

    // Layer 2: parse (row count + required cols)
    const minRows = name === 'goalies' ? 30 : 30;
    const maxRows = name === 'goalies' ? 200 : 33;
    const requiredCols = name === 'goalies'
      ? ['Player']
      : ['Team'];
    for (const c of checkParse(data.rows, {
      type: 'array',
      minRows,
      maxRows,
      requiredColumns: requiredCols,
    })) report.add(c);

    // Layer 3: semantic (team abbrevs for team tables)
    if (name.startsWith('team_')) {
      // NST uses full team names, so skip the abbrev check
      // Use the row-level xGF/60 check instead
      for (const c of checkSemanticRanges(data.rows, {
        team_xgf_per_60: 'xGF/60',
        team_xga_per_60: 'xGA/60',
      }, 'Team')) report.add(c);
    }

    const outcome = await commitPull({
      source,
      extension: 'csv',
      body: data.tsv,
      metadata: {
        rowCount: data.rows.length,
        size: data.tsv.length,
        season,
        stype,
      },
      report,
    });

    if (outcome.committed) {
      console.log(`[ingest-nst] ✅ ${name}: ${data.rows.length} rows`);
    } else {
      console.error(`[ingest-nst] ⛔ ${name}: quarantined`);
      console.error(`  Failures: ${report.allFailures().map(f => f.checkName).join(', ')}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
