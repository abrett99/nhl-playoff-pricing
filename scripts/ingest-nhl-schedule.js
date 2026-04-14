#!/usr/bin/env node
// ============================================================================
// INGEST: NHL Schedule & Completed Games
// ============================================================================
// Pulls today's schedule and any recently-completed games from the NHL API.
// Runs through the 4-layer sanity check framework before committing.
//
// Usage:
//   node scripts/ingest-nhl-schedule.js
//   node scripts/ingest-nhl-schedule.js --date 2026-04-20
// ============================================================================

import { NHL_API, GAME_TYPE } from '../src/config.js';
import {
  CheckReport,
  checkFetch,
  checkParse,
  checkKnownTeams,
} from '../src/sanity/checks.js';
import { commitPull } from '../src/ingest/store.js';
import { isoDate } from '../src/engine/util.js';
import { alertPipelineHealth } from '../src/alerts/telegram.js';

async function main() {
  const args = process.argv.slice(2);
  const dateFlag = args.findIndex(a => a === '--date');
  const date = dateFlag >= 0 ? args[dateFlag + 1] : isoDate();

  const url = NHL_API.endpoints.schedule(date);
  console.log(`[ingest-nhl-schedule] Fetching ${url}`);

  const report = new CheckReport('nhl_schedule');
  let resp, body, parsed;

  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'nhl-playoff-pricing/0.1' },
    });
    body = await resp.text();
  } catch (e) {
    console.error(`[ingest-nhl-schedule] Network error: ${e.message}`);
    await alertPipelineHealth({
      source: 'nhl_schedule',
      status: 'network_error',
      detail: e.message,
    });
    process.exit(1);
  }

  // Layer 1: fetch
  for (const c of checkFetch(
    {
      status: resp.status,
      headers: resp.headers,
      size: body.length,
      body,
    },
    {
      minSize: 100,
      expectedContentType: 'application/json',
    }
  )) report.add(c);

  // Layer 2: parse
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    report.add({
      passed: false, layer: 2, checkName: 'json_parse',
      message: e.message, details: {},
    });
  }

  if (parsed) {
    const games = (parsed.gameWeek?.[0]?.games) || parsed.games || [];
    for (const c of checkParse(games, {
      type: 'array',
      minRows: 0,
      maxRows: 32,
    })) report.add(c);

    // Layer 3: known teams (if any games scheduled)
    if (games.length > 0) {
      const teamsInResponse = [];
      for (const g of games) {
        if (g.homeTeam?.abbrev) teamsInResponse.push({ team: g.homeTeam.abbrev });
        if (g.awayTeam?.abbrev) teamsInResponse.push({ team: g.awayTeam.abbrev });
      }
      for (const c of checkKnownTeams(teamsInResponse, 'team')) report.add(c);
    }
  }

  // Commit
  const result = await commitPull({
    source: 'nhl_schedule',
    variant: date,
    extension: 'json',
    body,
    metadata: {
      rowCount: (parsed?.gameWeek?.[0]?.games || parsed?.games || []).length,
      size: body.length,
      date,
    },
    report,
  });

  if (result.committed) {
    console.log(`[ingest-nhl-schedule] ✅ Committed ${result.path}`);

    // Surface any playoff games in the schedule
    const games = parsed?.gameWeek?.[0]?.games || parsed?.games || [];
    const playoffs = games.filter(g => g.gameType === GAME_TYPE.PLAYOFF);
    if (playoffs.length > 0) {
      console.log(`[ingest-nhl-schedule] ${playoffs.length} playoff games today:`);
      for (const g of playoffs) {
        console.log(`  ${g.id}: ${g.awayTeam.abbrev} @ ${g.homeTeam.abbrev} (${g.gameState})`);
      }
    }
  } else {
    console.error(`[ingest-nhl-schedule] ⛔ Quarantined: ${result.path}`);
    console.error(`  Failures: ${report.allFailures().map(f => f.checkName).join(', ')}`);
    await alertPipelineHealth({
      source: 'nhl_schedule',
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
