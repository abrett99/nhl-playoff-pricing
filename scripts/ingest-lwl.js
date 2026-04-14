#!/usr/bin/env node
// ============================================================================
// INGEST: LeftWingLock Line Changes
// ============================================================================
// Fetches the LWL line changes page, parses ES + PP unit changes, and
// commits both the raw HTML and the parsed JSON to the store.
//
// Usage:
//   node scripts/ingest-lwl.js
// ============================================================================

import {
  CheckReport,
  checkFetch,
  checkParse,
  CheckResult,
} from '../src/sanity/checks.js';
import { commitPull } from '../src/ingest/store.js';
import { parseLwlChanges, currentPowerPlayUnits } from '../src/ingest/lwl.js';
import { alertPipelineHealth } from '../src/alerts/telegram.js';

const LWL_URL = 'https://leftwinglock.com/line-changes/nhl/';

async function main() {
  console.log(`[ingest-lwl] Fetching ${LWL_URL}`);
  const report = new CheckReport('lwl_line_changes');

  let resp, body;
  try {
    resp = await fetch(LWL_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    body = await resp.text();
  } catch (e) {
    console.error(`[ingest-lwl] Network error: ${e.message}`);
    await alertPipelineHealth({
      source: 'lwl_line_changes',
      status: 'network_error',
      detail: e.message,
    });
    process.exit(1);
  }

  // Layer 1
  for (const c of checkFetch({
    status: resp.status,
    headers: resp.headers,
    size: body.length,
    body,
  }, {
    minSize: 10000,
    expectedContentType: ['text/html'],
  })) report.add(c);

  // Layer 2: must contain both expected tables
  const hasEs = /Even-Strength Line Changes/i.test(body);
  const hasPp = /Power Play Unit Changes/i.test(body);
  if (hasEs) report.add(CheckResult.ok(2, 'has_es_table', {}));
  else report.add(CheckResult.fail(2, 'has_es_table', 'Missing Even-Strength Line Changes table'));
  if (hasPp) report.add(CheckResult.ok(2, 'has_pp_table', {}));
  else report.add(CheckResult.fail(2, 'has_pp_table', 'Missing Power Play Unit Changes table'));

  // Parse and run Layer 2 row count + Layer 3 structural checks
  const parsed = parseLwlChanges(body);
  for (const c of checkParse(parsed.evenStrength, {
    type: 'array',
    minRows: 1,
  })) report.add(c);
  for (const c of checkParse(parsed.powerPlay, {
    type: 'array',
    minRows: 0,
  })) report.add(c);

  // Layer 3: ensure most rows have usable role info
  const withRoles = parsed.evenStrength.filter(r => r.newRole?.type === 'line').length;
  if (parsed.evenStrength.length > 0 && withRoles / parsed.evenStrength.length < 0.5) {
    report.add(CheckResult.fail(3, 'role_parse_rate',
      `Only ${withRoles}/${parsed.evenStrength.length} rows parsed a line role — parser may be broken`));
  } else {
    report.add(CheckResult.ok(3, 'role_parse_rate', { rate: withRoles / (parsed.evenStrength.length || 1) }));
  }

  // Commit raw HTML
  const htmlResult = await commitPull({
    source: 'lwl_line_changes_html',
    extension: 'html',
    body,
    metadata: {
      size: body.length,
      esRows: parsed.evenStrength.length,
      ppRows: parsed.powerPlay.length,
    },
    report,
  });

  // Commit parsed JSON alongside
  if (report.passed()) {
    const parsedJson = JSON.stringify({
      ...parsed,
      byTeam_powerPlayUnits: currentPowerPlayUnits(parsed),
    }, null, 2);

    const parsedReport = new CheckReport('lwl_line_changes_parsed');
    parsedReport.add(CheckResult.ok(1, 'inherits_from_html_pull', {}));
    parsedReport.add(CheckResult.ok(2, 'valid_json', {}));
    parsedReport.add(CheckResult.ok(3, 'inherits_from_html_pull', {}));
    parsedReport.add(CheckResult.ok(4, 'no_baseline', {}));

    await commitPull({
      source: 'lwl_line_changes_parsed',
      extension: 'json',
      body: parsedJson,
      metadata: {
        esRows: parsed.evenStrength.length,
        ppRows: parsed.powerPlay.length,
      },
      report: parsedReport,
    });
  }

  if (htmlResult.committed) {
    console.log(`[ingest-lwl] ✅ ES=${parsed.evenStrength.length}  PP=${parsed.powerPlay.length}`);
  } else {
    console.error(`[ingest-lwl] ⛔ Quarantined`);
    console.error(`  Failures: ${report.allFailures().map(f => f.checkName).join(', ')}`);
    await alertPipelineHealth({
      source: 'lwl_line_changes',
      status: 'sanity_fail',
      detail: report.allFailures().map(f => f.checkName).join(', '),
    });
    process.exit(2);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
