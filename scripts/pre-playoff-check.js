#!/usr/bin/env node
// ============================================================================
// PRE-PLAYOFF READINESS CHECK
// ============================================================================
// Runs a comprehensive pre-flight check before the playoffs begin. Catches
// common misconfigurations, stale data, missing environment variables,
// uncommitted series state files, etc.
//
// Exit code 0 if all green. Exit code 1 if any warning. Exit code 2 if
// any hard failure.
//
// Usage:
//   node scripts/pre-playoff-check.js
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { listActiveSeries } from '../src/state/series.js';
import { BRACKET_2026, summarizeBracket } from '../src/state/bracket.js';
import { describeManifest } from '../src/ingest/store.js';

const CHECKS = [];
let hardFailures = 0;
let softWarnings = 0;

function pass(label, detail = '') {
  CHECKS.push({ level: 'pass', label, detail });
}
function warn(label, detail = '') {
  CHECKS.push({ level: 'warn', label, detail });
  softWarnings++;
}
function fail(label, detail = '') {
  CHECKS.push({ level: 'fail', label, detail });
  hardFailures++;
}

// ============================================================================
// Individual checks
// ============================================================================

async function checkEnvironment() {
  // Required for API access when pulled in production
  const required = ['ODDS_API_KEY'];
  const optional = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

  for (const key of required) {
    if (process.env[key]) {
      pass(`env: ${key} is set`);
    } else {
      fail(`env: ${key} missing`, 'Required for live odds ingest');
    }
  }
  for (const key of optional) {
    if (process.env[key]) {
      pass(`env: ${key} is set`);
    } else {
      warn(`env: ${key} missing`, 'Alerts will be disabled');
    }
  }
}

async function checkR1SeriesFiles() {
  const expectedR1 = [
    '2025-R1-E1', '2025-R1-E2', '2025-R1-E3', '2025-R1-E4',
    '2025-R1-W1', '2025-R1-W2', '2025-R1-W3', '2025-R1-W4',
  ];
  const existing = await listActiveSeries({ includeComplete: true });
  const existingIds = new Set(existing.map(s => s.seriesId));

  let missing = [];
  for (const id of expectedR1) {
    if (!existingIds.has(id)) missing.push(id);
  }
  if (missing.length === 0) {
    pass('R1 series files: all 8 present');
  } else {
    fail(`R1 series files: ${missing.length} missing`,
         `Missing: ${missing.join(', ')}. Run: node scripts/bootstrap-2026-r1.js`);
  }

  // Each R1 series should have currentStarters populated
  for (const series of existing) {
    if (series.round !== 1) continue;
    const starters = series.currentStarters || {};
    const hasBoth = starters[series.teamA] && starters[series.teamB];
    if (!hasBoth) {
      warn(`${series.seriesId}: missing goalie starters`,
           `Set ${series.teamA}=? ${series.teamB}=? before first game`);
    }
  }
}

async function checkHistoricalDataset() {
  const p = path.resolve(process.cwd(), 'data', 'derived', 'historical_series.json');
  try {
    const txt = await fs.readFile(p, 'utf-8');
    const data = JSON.parse(txt);
    const count = data.series?.length ?? 0;
    if (data.synthetic) {
      warn(`historical dataset: ${count} synthetic series`,
           'Replace with real data: node scripts/ingest-historical.js --start 2016');
    } else if (count < 100) {
      warn(`historical dataset: only ${count} series`,
           'Backtest power is weak. Consider --start 2013 for 10+ years.');
    } else {
      pass(`historical dataset: ${count} series loaded`);
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      warn('historical dataset: not present',
           'Run: node scripts/ingest-historical.js (or seed-synthetic-historical.js for smoke test)');
    } else {
      fail('historical dataset: failed to read', e.message);
    }
  }
}

async function checkSourceFreshness() {
  const REQUIREMENTS = {
    nhl_schedule: 24,
    odds_us_books: 6,
    odds_pinnacle: 6,
    moneypuck_teams_regular: 72,
  };
  try {
    const manifest = await describeManifest();
    const sourcesMap = Object.fromEntries(
      (manifest.sources || []).map(s => [s.source, s])
    );

    for (const [source, maxHours] of Object.entries(REQUIREMENTS)) {
      const entry = sourcesMap[source];
      if (!entry || !entry.lastGood) {
        warn(`source ${source}: never pulled`,
             `Run ingest-${source.split('_')[0]}.js before first puck drop`);
        continue;
      }
      const ageHours = (Date.now() - new Date(entry.lastGood).getTime()) / 3_600_000;
      if (ageHours > maxHours) {
        warn(`source ${source}: ${ageHours.toFixed(1)}h old (max ${maxHours}h)`);
      } else {
        pass(`source ${source}: fresh (${ageHours.toFixed(1)}h ago)`);
      }
    }
  } catch (e) {
    warn('manifest: unable to read', e.message);
  }
}

async function checkBracketIntegrity() {
  const summary = await summarizeBracket();
  const r1Count = summary.byRound[1].length;
  if (r1Count !== 8) {
    fail(`bracket: expected 8 R1 series, found ${r1Count}`);
    return;
  }
  pass('bracket: R1 has 8 series');

  // All future-round entries should be in pending (not yet created)
  const futurePending = summary.pending.filter(p => p.config.round >= 2);
  if (futurePending.length === 7) {
    pass('bracket: downstream rounds registered in BRACKET_2026');
  } else {
    warn(`bracket: expected 7 pending future series, got ${futurePending.length}`);
  }
}

async function checkWorkflowFiles() {
  const wfDir = path.resolve(process.cwd(), '.github', 'workflows');
  try {
    const files = await fs.readdir(wfDir);
    const expected = [
      'odds-snapshot.yml',
      'playoff-results.yml',
      'data-refresh.yml',
      'clv-capture.yml',
      'dk-series-snapshot.yml',
      'deploy-pages.yml',
    ];
    const missing = expected.filter(f => !files.includes(f));
    if (missing.length === 0) {
      pass(`workflows: all ${expected.length} present`);
    } else {
      fail(`workflows: ${missing.length} missing`, missing.join(', '));
    }
  } catch {
    fail('workflows: .github/workflows directory missing');
  }
}

async function checkGitStatus() {
  // Warn if there are uncommitted changes in data/ (workflow will bounce otherwise)
  try {
    const { execSync } = await import('child_process');
    const status = execSync('git status --porcelain data/', { encoding: 'utf-8' }).trim();
    if (status.length === 0) {
      pass('git: data/ directory clean');
    } else {
      const lines = status.split('\n').length;
      warn(`git: ${lines} uncommitted changes in data/`,
           'Workflow pushes may conflict. Run: git add data/ && git commit && git push');
    }
  } catch {
    warn('git: not in a git repo or git unavailable');
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('═════════════════════════════════════════════════════════════');
  console.log('  NHL Playoff Pricing — Pre-Playoff Readiness Check');
  console.log('═════════════════════════════════════════════════════════════\n');

  await checkEnvironment();
  await checkR1SeriesFiles();
  await checkBracketIntegrity();
  await checkHistoricalDataset();
  await checkSourceFreshness();
  await checkWorkflowFiles();
  await checkGitStatus();

  for (const c of CHECKS) {
    const icon = c.level === 'pass' ? '✅' : c.level === 'warn' ? '⚠️ ' : '⛔';
    console.log(`  ${icon} ${c.label}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }

  console.log();
  console.log(`  Passed:   ${CHECKS.filter(c => c.level === 'pass').length}`);
  console.log(`  Warnings: ${softWarnings}`);
  console.log(`  Failures: ${hardFailures}`);
  console.log();

  if (hardFailures > 0) {
    console.log('  ⛔ Not ready — resolve hard failures before first game.');
    process.exit(2);
  }
  if (softWarnings > 0) {
    console.log('  ⚠️  Mostly ready — review warnings.');
    process.exit(1);
  }
  console.log('  ✅ All systems go. Playoffs ready to roll.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(2); });
