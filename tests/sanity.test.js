// ============================================================================
// SANITY CHECK TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CheckReport,
  checkFetch,
  checkParse,
  checkSemanticRanges,
  checkKnownTeams,
  checkDrift,
} from '../src/sanity/checks.js';

// ============================================================================
// Layer 1: Fetch checks
// ============================================================================

test('Layer 1: HTTP status accepted for 2xx', () => {
  const results = checkFetch(
    { status: 200, headers: { get: () => 'application/json' }, size: 5000 },
    { minSize: 1000, expectedContentType: 'application/json' }
  );
  assert.ok(results.every(r => r.passed));
});

test('Layer 1: rejects tiny responses (CAPTCHA pages)', () => {
  const results = checkFetch(
    { status: 200, headers: { get: () => 'text/html' }, size: 500 },
    { minSize: 50000 }
  );
  assert.ok(results.some(r => !r.passed && r.checkName === 'response_size'));
});

test('Layer 1: detects bot-challenge pages', () => {
  const results = checkFetch(
    {
      status: 200,
      headers: { get: () => 'text/html' },
      body: '<html>Please enable JavaScript and cookies to continue</html>',
      size: 50000,
    },
    { minSize: 1000 }
  );
  const antiBot = results.find(r => r.checkName === 'anti_bot');
  assert.ok(antiBot && !antiBot.passed);
});

test('Layer 1: rejects non-2xx status', () => {
  const results = checkFetch(
    { status: 503, headers: { get: () => 'text/html' }, size: 1000 },
    {}
  );
  assert.ok(results.some(r => !r.passed && r.checkName === 'http_status'));
});

// ============================================================================
// Layer 2: Parse checks
// ============================================================================

test('Layer 2: exact row count', () => {
  const data = new Array(32).fill({ team: 'X' });
  const results = checkParse(data, { type: 'array', exactRows: 32 });
  assert.ok(results.every(r => r.passed));

  const wrong = checkParse(data.slice(0, 30), { type: 'array', exactRows: 32 });
  assert.ok(wrong.some(r => !r.passed && r.checkName === 'row_count_exact'));
});

test('Layer 2: required columns present', () => {
  const data = [{ team: 'BOS', xgf: 2.8, xga: 2.5 }];
  const results = checkParse(data, {
    type: 'array',
    requiredColumns: ['team', 'xgf', 'xga'],
  });
  assert.ok(results.every(r => r.passed));

  const missing = checkParse([{ team: 'BOS' }], {
    type: 'array',
    requiredColumns: ['team', 'xgf'],
  });
  assert.ok(missing.some(r => !r.passed && r.checkName === 'required_columns'));
});

test('Layer 2: row count range', () => {
  const data = new Array(50).fill({});
  const results = checkParse(data, {
    type: 'array',
    minRows: 30,
    maxRows: 100,
  });
  assert.ok(results.every(r => r.passed));

  const tooFew = checkParse(new Array(10).fill({}), {
    type: 'array',
    minRows: 30,
  });
  assert.ok(tooFew.some(r => !r.passed));
});

// ============================================================================
// Layer 3: Semantic range checks
// ============================================================================

test('Layer 3: values in range pass', () => {
  const rows = [
    { team: 'BOS', xGF: 2.8, xGA: 2.5 },
    { team: 'TOR', xGF: 3.2, xGA: 2.7 },
  ];
  const results = checkSemanticRanges(rows, {
    team_xgf_per_60: 'xGF',
    team_xga_per_60: 'xGA',
  }, 'team');
  assert.ok(results[0].passed);
});

test('Layer 3: out-of-range values caught', () => {
  const rows = [
    { team: 'BOS', xGF: 2.8 },
    { team: 'ITA', xGF: 8.5 }, // Italy in NHL? Absurd value
  ];
  const results = checkSemanticRanges(rows, {
    team_xgf_per_60: 'xGF',
  }, 'team');
  assert.ok(!results[0].passed);
  assert.ok(results[0].details.violations.some(v => v.identifier === 'ITA'));
});

test('Layer 3: unknown teams detected', () => {
  const rows = [
    { team: 'BOS' },
    { team: 'TOR' },
    { team: 'XYZ' }, // Not an NHL team
  ];
  const results = checkKnownTeams(rows, 'team');
  assert.ok(!results[0].passed);
  assert.ok(results[0].details.unknown.includes('XYZ'));
});

test('Layer 3: non-finite numbers are flagged', () => {
  const rows = [
    { team: 'BOS', xGF: 'N/A' },
  ];
  const results = checkSemanticRanges(rows, {
    team_xgf_per_60: 'xGF',
  }, 'team');
  assert.ok(!results[0].passed);
  assert.ok(results[0].details.violations.some(v => v.reason === 'not_finite'));
});

// ============================================================================
// Layer 4: Drift checks
// ============================================================================

test('Layer 4: no baseline is OK', () => {
  const results = checkDrift({ timestamp: '2026-04-14T00:00:00Z' }, null, {});
  assert.ok(results.every(r => r.passed));
});

test('Layer 4: freshness check catches non-advancing timestamps', () => {
  const current = { timestamp: '2026-04-14T10:00:00Z' };
  const previous = { timestamp: '2026-04-14T10:00:00Z' };
  const results = checkDrift(current, previous);
  assert.ok(results.some(r => !r.passed && r.checkName === 'drift_freshness'));
});

test('Layer 4: row-count shrinkage flagged', () => {
  const current = {
    timestamp: '2026-04-14T11:00:00Z',
    rows: new Array(20).fill({}),
  };
  const previous = {
    timestamp: '2026-04-14T10:00:00Z',
    rows: new Array(32).fill({}),
  };
  const results = checkDrift(current, previous, { compareRowCounts: true });
  assert.ok(results.some(r => !r.passed && r.checkName === 'drift_row_count'));
});

test('Layer 4: large field deltas flagged', () => {
  const current = {
    timestamp: '2026-04-14T11:00:00Z',
    byKey: {
      BOS: { xgf: 4.5 }, // jumped from 2.8 — impossible overnight
      TOR: { xgf: 3.0 },
    },
  };
  const previous = {
    timestamp: '2026-04-13T11:00:00Z',
    byKey: {
      BOS: { xgf: 2.8 },
      TOR: { xgf: 3.0 },
    },
  };
  const results = checkDrift(current, previous, {
    maxDeltas: { xgf: 0.3 },
  });
  assert.ok(results.some(r => !r.passed && r.checkName === 'drift_field_deltas'));
});

// ============================================================================
// CheckReport aggregation
// ============================================================================

test('CheckReport aggregates all failures', () => {
  const r = new CheckReport('test');
  for (const c of checkFetch(
    { status: 200, headers: { get: () => 'application/json' }, size: 10000 },
    { minSize: 1000, expectedContentType: 'application/json' }
  )) r.add(c);

  assert.ok(r.passed());
});

test('CheckReport reports failure when any check fails', () => {
  const r = new CheckReport('test');
  for (const c of checkFetch(
    { status: 500, headers: { get: () => 'text/html' }, size: 500 },
    { minSize: 1000 }
  )) r.add(c);

  assert.ok(!r.passed());
  assert.ok(r.allFailures().length > 0);
});
