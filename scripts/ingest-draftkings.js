#!/usr/bin/env node
// ============================================================================
// INGEST: DraftKings Series Props
// ============================================================================
// Pulls eventgroup 42133 (NHL playoff series props) from the DK JSON API.
// Runs through sanity checks, persists both raw JSON and parsed prices.
//
// Usage:
//   node scripts/ingest-draftkings.js
// ============================================================================

import {
  CheckReport,
  checkFetch,
  checkParse,
  CheckResult,
} from '../src/sanity/checks.js';
import { commitPull } from '../src/ingest/store.js';
import {
  fetchDkSeriesPrices,
  parseDkResponse,
  validateDkSeries,
} from '../src/ingest/draftkings.js';
import { alertPipelineHealth } from '../src/alerts/telegram.js';

const DK_URL = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/v5/eventgroups/42133?format=json';

async function main() {
  console.log(`[ingest-dk] Fetching ${DK_URL}`);
  const report = new CheckReport('dk_series_props');

  let resp, body;
  try {
    resp = await fetch(DK_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    body = await resp.text();
  } catch (e) {
    console.error(`[ingest-dk] Network error: ${e.message}`);
    await alertPipelineHealth({
      source: 'dk_series_props',
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
    minSize: 1000,
    expectedContentType: ['application/json'],
  })) report.add(c);

  // Layer 2: parse and check structure
  let data;
  try {
    data = JSON.parse(body);
    if (!data.eventGroup) {
      report.add(CheckResult.fail(2, 'has_eventgroup', 'Missing eventGroup key'));
    } else {
      report.add(CheckResult.ok(2, 'has_eventgroup', {}));
    }
  } catch (e) {
    report.add(CheckResult.fail(2, 'json_parse', e.message));
  }

  const parsedSeries = data ? parseDkResponse(data) : [];
  for (const c of checkParse(parsedSeries, {
    type: 'array',
    minRows: 0, // during offseason, can be 0
  })) report.add(c);

  // Layer 3: per-series vig checks
  let validCount = 0, invalidCount = 0;
  const invalidDetails = [];
  for (const s of parsedSeries) {
    const v = validateDkSeries(s);
    if (v.valid) validCount++;
    else {
      invalidCount++;
      invalidDetails.push({ seriesKey: s.seriesKey, issues: v.issues });
    }
  }

  if (parsedSeries.length > 0 && invalidCount / parsedSeries.length > 0.25) {
    report.add(CheckResult.fail(3, 'series_validation',
      `${invalidCount}/${parsedSeries.length} series failed validation`,
      { invalidDetails: invalidDetails.slice(0, 5) }));
  } else {
    report.add(CheckResult.ok(3, 'series_validation', {
      valid: validCount,
      invalid: invalidCount,
    }));
  }

  // Commit raw JSON
  const rawResult = await commitPull({
    source: 'dk_series_props_raw',
    extension: 'json',
    body,
    metadata: {
      size: body.length,
      parsedSeriesCount: parsedSeries.length,
      validCount,
    },
    report,
  });

  // Commit normalized parsed data alongside
  if (report.passed()) {
    const normalized = JSON.stringify({
      capturedAt: new Date().toISOString(),
      series: parsedSeries,
    }, null, 2);

    const parsedReport = new CheckReport('dk_series_props_parsed');
    parsedReport.add(CheckResult.ok(1, 'inherits_from_raw_pull', {}));
    parsedReport.add(CheckResult.ok(2, 'valid_json', {}));
    parsedReport.add(CheckResult.ok(3, 'inherits_from_raw_pull', {}));
    parsedReport.add(CheckResult.ok(4, 'no_baseline', {}));

    await commitPull({
      source: 'dk_series_props_parsed',
      extension: 'json',
      body: normalized,
      metadata: { seriesCount: parsedSeries.length },
      report: parsedReport,
    });

    console.log(`[ingest-dk] ✅ ${parsedSeries.length} series captured`);
    for (const s of parsedSeries.slice(0, 5)) {
      const markets = Object.keys(s.markets).join(', ');
      console.log(`  ${s.teamA || '?'} vs ${s.teamB || '?'}  [${markets}]`);
    }
    if (parsedSeries.length > 5) {
      console.log(`  ... and ${parsedSeries.length - 5} more`);
    }
  } else {
    console.error(`[ingest-dk] ⛔ Quarantined`);
    console.error(`  Failures: ${report.allFailures().map(f => f.checkName).join(', ')}`);
    await alertPipelineHealth({
      source: 'dk_series_props',
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
