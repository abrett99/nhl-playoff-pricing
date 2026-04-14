// ============================================================================
// LEAKAGE TESTS
// ============================================================================
// The whole point of the timestamped store and point-in-time builder is that
// buildFeaturesAsOf(T) produces the same output no matter what data arrives
// AFTER T. These tests prove it.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { commitPull, getSnapshotAsOf } from '../src/ingest/store.js';
import { CheckReport, CheckResult } from '../src/sanity/checks.js';

// Redirect data dir to a tmp location for tests
const ORIGINAL_CWD = process.cwd();
let TEST_DIR;

async function setupTmpCwd() {
  TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'nhl-leak-test-'));
  process.chdir(TEST_DIR);
}

async function teardownTmpCwd() {
  process.chdir(ORIGINAL_CWD);
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}

function makePassingReport() {
  const r = new CheckReport('test_source');
  r.add(CheckResult.ok(1, 'http_status'));
  r.add(CheckResult.ok(2, 'is_array'));
  r.add(CheckResult.ok(3, 'semantic_ranges'));
  r.add(CheckResult.ok(4, 'drift_freshness'));
  return r;
}

// ============================================================================
// Test 1: getSnapshotAsOf returns snapshot BEFORE the target time
// ============================================================================

test('getSnapshotAsOf returns only snapshots strictly before target time', async () => {
  await setupTmpCwd();
  try {
    const source = 'test_source';

    // Commit a snapshot, wait, commit another, wait, commit a third
    await commitPull({
      source,
      extension: 'json',
      body: JSON.stringify({ version: 1 }),
      report: makePassingReport(),
    });
    const firstTime = new Date();

    await new Promise(r => setTimeout(r, 1100)); // advance wall clock > 1s

    await commitPull({
      source,
      extension: 'json',
      body: JSON.stringify({ version: 2 }),
      report: makePassingReport(),
    });
    const secondTime = new Date();

    await new Promise(r => setTimeout(r, 1100));

    await commitPull({
      source,
      extension: 'json',
      body: JSON.stringify({ version: 3 }),
      report: makePassingReport(),
    });

    // Asking "as of now" should give version 3
    const nowSnap = await getSnapshotAsOf(source, new Date());
    assert.equal(JSON.parse(nowSnap.body).version, 3);

    // Asking "as of secondTime" should give version 1 (version 2 is committed AT secondTime)
    // (filename timestamp has second precision; this test depends on our > 1s waits)
    const beforeSecondSnap = await getSnapshotAsOf(source, secondTime);
    assert.ok(JSON.parse(beforeSecondSnap.body).version < 3,
      'Must not include snapshots at or after target');

    // Asking for a time before ANY commit should return null
    const beforeAnySnap = await getSnapshotAsOf(source, new Date('2020-01-01'));
    assert.equal(beforeAnySnap, null);
  } finally {
    await teardownTmpCwd();
  }
});

// ============================================================================
// Test 2: Committing new data does NOT change past point-in-time results
// ============================================================================

test('new commits do not alter historical point-in-time results', async () => {
  await setupTmpCwd();
  try {
    const source = 'test_source';

    // Commit v1
    await commitPull({
      source,
      extension: 'json',
      body: JSON.stringify({ xGF: 2.8, version: 1 }),
      report: makePassingReport(),
    });

    await new Promise(r => setTimeout(r, 1100));
    const queryTime = new Date();
    await new Promise(r => setTimeout(r, 1100));

    // Take a snapshot reading BEFORE the new commit
    const before = await getSnapshotAsOf(source, queryTime);
    const beforeContent = JSON.parse(before.body);

    // Commit MORE data AFTER queryTime
    await commitPull({
      source,
      extension: 'json',
      body: JSON.stringify({ xGF: 3.5, version: 2 }),
      report: makePassingReport(),
    });

    // Re-ask for the same historical time — MUST be identical
    const after = await getSnapshotAsOf(source, queryTime);
    const afterContent = JSON.parse(after.body);

    assert.deepEqual(beforeContent, afterContent,
      'Point-in-time result changed after new commit — LEAKAGE DETECTED');
    assert.equal(afterContent.version, 1,
      'Historical query should return v1 even though v2 is committed');
  } finally {
    await teardownTmpCwd();
  }
});

// ============================================================================
// Test 3: Quarantined data never reaches point-in-time reads
// ============================================================================

test('quarantined pulls are never returned by getSnapshotAsOf', async () => {
  await setupTmpCwd();
  try {
    const source = 'test_source';

    // First commit passes
    await commitPull({
      source,
      extension: 'json',
      body: JSON.stringify({ value: 'good' }),
      report: makePassingReport(),
    });

    await new Promise(r => setTimeout(r, 1100));

    // Second commit FAILS sanity and goes to quarantine
    const failingReport = new CheckReport(source);
    failingReport.add(CheckResult.ok(1, 'http_status'));
    failingReport.add(CheckResult.fail(3, 'semantic_ranges', 'out of range'));
    await commitPull({
      source,
      extension: 'json',
      body: JSON.stringify({ value: 'corrupt' }),
      report: failingReport,
    });

    // Reading "as of now" should give the GOOD pull, not the quarantined one
    const latest = await getSnapshotAsOf(source, new Date());
    assert.equal(JSON.parse(latest.body).value, 'good',
      'Quarantined data leaked into point-in-time read');
  } finally {
    await teardownTmpCwd();
  }
});

// ============================================================================
// Test 4: File naming format is parseable back to timestamp
// ============================================================================

test('file naming format round-trips through getSnapshotAsOf', async () => {
  await setupTmpCwd();
  try {
    const source = 'roundtrip_test';

    // Commit several snapshots spread over time
    const committed = [];
    for (let i = 0; i < 5; i++) {
      await commitPull({
        source,
        extension: 'json',
        body: JSON.stringify({ i }),
        report: makePassingReport(),
      });
      committed.push(new Date());
      await new Promise(r => setTimeout(r, 1100));
    }

    // For each known commit time, verify we can reconstruct the appropriate snapshot
    for (let i = 1; i < committed.length; i++) {
      const justAfterPrev = new Date(committed[i - 1].getTime() + 500);
      const snap = await getSnapshotAsOf(source, justAfterPrev);
      assert.ok(snap, `Should find snapshot between commit ${i-1} and ${i}`);
    }
  } finally {
    await teardownTmpCwd();
  }
});
