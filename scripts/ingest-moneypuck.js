#!/usr/bin/env node
// ============================================================================
// INGEST: MoneyPuck Team & Goalie Data
// ============================================================================
// Public CSV feeds. Primary cross-check against NST.
//
// Usage:
//   node scripts/ingest-moneypuck.js
// ============================================================================

import { MONEYPUCK, SEASON } from '../src/config.js';
import {
  CheckReport,
  checkFetch,
  checkParse,
  CheckResult,
} from '../src/sanity/checks.js';
import { commitPull } from '../src/ingest/store.js';
import { alertPipelineHealth } from '../src/alerts/telegram.js';

async function fetchCsvAndCommit({ source, variant, url, minRows, requiredCols }) {
  console.log(`[ingest-moneypuck] ${source}: fetching`);
  const report = new CheckReport(source);

  let resp, body;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'nhl-playoff-pricing/0.1' },
    });
    body = await resp.text();
  } catch (e) {
    console.error(`[ingest-moneypuck] ${source}: network error ${e.message}`);
    await alertPipelineHealth({
      source, status: 'network_error', detail: e.message,
    });
    return false;
  }

  // Layer 1
  for (const c of checkFetch({
    status: resp.status,
    headers: resp.headers,
    size: body.length,
    body,
  }, {
    minSize: 1000,
    expectedContentType: ['text/csv', 'application/csv', 'text/plain'],
  })) report.add(c);

  // Layer 2: CSV shape
  const lines = body.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    report.add(CheckResult.fail(2, 'csv_not_empty', 'Fewer than 2 lines'));
  } else {
    report.add(CheckResult.ok(2, 'csv_not_empty', { lines: lines.length }));

    const headers = lines[0].split(',').map(h => h.trim());
    const rows = lines.slice(1).map(line => {
      const vals = line.split(',');
      const row = {};
      headers.forEach((h, i) => { row[h] = vals[i]; });
      return row;
    });

    for (const c of checkParse(rows, {
      type: 'array',
      minRows,
      requiredColumns: requiredCols,
    })) report.add(c);
  }

  // Commit
  const result = await commitPull({
    source,
    variant,
    extension: 'csv',
    body,
    metadata: {
      rowCount: Math.max(0, lines.length - 1),
      size: body.length,
    },
    report,
  });

  if (result.committed) {
    console.log(`[ingest-moneypuck] ${source}: ✅ ${result.path}`);
    return true;
  } else {
    console.error(`[ingest-moneypuck] ${source}: ⛔ quarantined`);
    console.error(`  Failures: ${report.allFailures().map(f => f.checkName).join(', ')}`);
    await alertPipelineHealth({
      source, status: 'sanity_fail',
      detail: report.allFailures().map(f => f.checkName).join(', '),
    });
    return false;
  }
}

async function main() {
  const year = SEASON.CURRENT_START_YEAR;

  // Regular season team performance
  await fetchCsvAndCommit({
    source: 'moneypuck_teams_regular',
    variant: `${year}_regular`,
    url: `https://moneypuck.com/moneypuck/playerData/seasonSummary/${year}/regular/teams.csv`,
    minRows: 30,
    requiredCols: ['team'],
  });

  // Playoff team performance (if any games played yet)
  await fetchCsvAndCommit({
    source: 'moneypuck_teams_playoffs',
    variant: `${year}_playoffs`,
    url: MONEYPUCK.playoffsTeams(year),
    minRows: 0, // may be empty pre-playoffs
    requiredCols: ['team'],
  });

  // Playoff goalies (key for starter identification)
  await fetchCsvAndCommit({
    source: 'moneypuck_goalies_playoffs',
    variant: `${year}_playoffs`,
    url: MONEYPUCK.playoffsGoalies(year),
    minRows: 0,
    requiredCols: ['name'],
  });

  // Regular season goalies (deeper sample)
  await fetchCsvAndCommit({
    source: 'moneypuck_goalies_regular',
    variant: `${year}_regular`,
    url: `https://moneypuck.com/moneypuck/playerData/seasonSummary/${year}/regular/goalies.csv`,
    minRows: 30,
    requiredCols: ['name'],
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
