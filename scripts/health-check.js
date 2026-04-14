#!/usr/bin/env node
// ============================================================================
// HEALTH CHECK: Data Source Freshness
// ============================================================================
// Verifies every critical source has had a successful pull within its
// max-age window. Fires Telegram alert for any stale sources.
//
// Exit code 0 = all healthy, 1 = at least one issue.
// ============================================================================

import { healthCheck, describeManifest } from '../src/ingest/store.js';
import { alertPipelineHealth } from '../src/alerts/telegram.js';

// Max age in hours per source
const REQUIREMENTS = {
  nhl_schedule: 6,
  odds_us_books: 2,
  odds_pinnacle: 2,
  moneypuck_teams_regular: 48,
  moneypuck_goalies_regular: 48,
  moneypuck_teams_playoffs: 48,
  moneypuck_goalies_playoffs: 48,
  // nst_team_sva: 48,       // enable once NST scraper wired
  // nst_goalies: 48,
};

async function main() {
  console.log('[health] Checking source freshness...\n');

  const result = await healthCheck(REQUIREMENTS);

  console.log('[health] Current manifest:');
  const summary = await describeManifest();
  for (const src of summary.sources) {
    const age = src.lastGood ? msSince(src.lastGood) : 'never';
    console.log(`  ${src.source.padEnd(35)} ${age.padStart(8)}  rows=${src.rowCount ?? '?'}`);
  }

  if (result.healthy) {
    console.log('\n[health] ✅ All required sources fresh');
    process.exit(0);
  }

  console.log(`\n[health] ⚠  ${result.issues.length} issue(s):`);
  for (const issue of result.issues) {
    console.log(`  ${issue.source}: ${issue.status}${
      issue.ageHours ? ` (${issue.ageHours}h old, max ${issue.maxAllowedHours}h)` : ''
    }`);
    await alertPipelineHealth({
      source: issue.source,
      status: issue.status,
      detail: issue.status === 'missing'
        ? 'Never successfully pulled'
        : `Stale: ${issue.ageHours}h old (max ${issue.maxAllowedHours}h)`,
      ageHours: issue.ageHours,
    });
  }

  process.exit(1);
}

function msSince(iso) {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
