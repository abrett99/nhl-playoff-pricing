#!/usr/bin/env node
// ============================================================================
// REGULAR-SEASON SEEDING SIMULATION
// ============================================================================
// Simulates the remaining regular-season schedule to project the most likely
// playoff bracket. Feeds the "hypothetical playoff bracket" dashboard.
//
// For each team, we need:
//   - Current standings (wins, losses, OT losses, points)
//   - Remaining schedule
//   - Team strength estimate (xGF - xGA)
//
// Usage:
//   node scripts/simulate-regular-season.js
//   node scripts/simulate-regular-season.js --trials 10000
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getSnapshotAsOf } from '../src/ingest/store.js';
import { NHL_API, NHL_TEAMS, MODEL } from '../src/config.js';
import { seededRng, samplePoisson, clamp, isoTimestamp } from '../src/engine/util.js';

const OUT_PATH = path.resolve(process.cwd(), 'data', 'derived', 'seeding_projection.json');

async function fetchStandings() {
  // Try the latest local snapshot first; fall back to live
  const snap = await getSnapshotAsOf('nhl_standings', new Date());
  if (snap) {
    return JSON.parse(
      typeof snap.body === 'string' ? snap.body : snap.body.toString('utf-8')
    );
  }
  const resp = await fetch(NHL_API.endpoints.standings());
  return resp.json();
}

/** Build team strength priors from most recent team features */
async function fetchTeamStrengths() {
  // Prefer MoneyPuck regular-season snapshot
  const snap = await getSnapshotAsOf('moneypuck_teams_regular', new Date());
  const strengths = {};
  const leagueAvg = 2.85;

  if (snap?.body) {
    const text = typeof snap.body === 'string' ? snap.body : snap.body.toString('utf-8');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j]; });
      const team = String(row.team || '').toUpperCase();
      if (!NHL_TEAMS.includes(team)) continue;
      const xgf = Number(row.xGoalsFor) / Math.max(Number(row.iceTime), 1) * 3600;
      const xga = Number(row.xGoalsAgainst) / Math.max(Number(row.iceTime), 1) * 3600;
      if (Number.isFinite(xgf) && Number.isFinite(xga)) {
        strengths[team] = { xgf, xga };
      }
    }
  }

  // Fill in missing teams with league average (safe default)
  for (const team of NHL_TEAMS) {
    if (!strengths[team]) strengths[team] = { xgf: leagueAvg, xga: leagueAvg };
  }
  return strengths;
}

/** Simulate a single game: returns { winner, overtime } */
function simulateGame(homeTeam, awayTeam, strengths, rng) {
  const leagueAvg = 2.85;
  const homeS = strengths[homeTeam] || { xgf: leagueAvg, xga: leagueAvg };
  const awayS = strengths[awayTeam] || { xgf: leagueAvg, xga: leagueAvg };

  // Home boost built into lambdas (~3% edge)
  const homeLambda = clamp((homeS.xgf * (awayS.xga / leagueAvg)) * 1.05, 0.5, 6);
  const awayLambda = clamp((awayS.xgf * (homeS.xga / leagueAvg)) * 1.00, 0.5, 6);

  const h = samplePoisson(homeLambda, rng);
  const a = samplePoisson(awayLambda, rng);

  if (h > a) return { winner: homeTeam, overtime: false };
  if (a > h) return { winner: awayTeam, overtime: false };
  // Tie → OT + possible SO (regulation games only count for RW)
  const homeWinsOT = rng() < 0.5;
  return { winner: homeWinsOT ? homeTeam : awayTeam, overtime: true };
}

/** Advance a team's record by one game */
function applyResult(records, team, isWin, isOtLoss) {
  const r = records[team];
  if (isWin) {
    r.wins++;
    r.points += 2;
  } else if (isOtLoss) {
    r.otLosses++;
    r.points += 1;
  } else {
    r.losses++;
  }
}

function sortStandings(records, conference) {
  return Object.entries(records)
    .filter(([team]) => records[team].conference === conference)
    .sort(([, a], [, b]) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.regWins !== a.regWins) return b.regWins - a.regWins;
      return b.wins - a.wins;
    })
    .map(([team]) => team);
}

/** Build the playoff bracket from final standings */
function buildBracket(records) {
  const bracket = { east: [], west: [] };
  for (const conf of ['east', 'west']) {
    const byDivision = {};
    for (const [team, rec] of Object.entries(records)) {
      if (rec.conference !== conf) continue;
      byDivision[rec.division] = byDivision[rec.division] || [];
      byDivision[rec.division].push({ team, ...rec });
    }
    // Top 3 per division + 2 wild cards
    const divisionWinners = [];
    const wildCardPool = [];
    for (const div of Object.keys(byDivision)) {
      const sorted = byDivision[div].sort((a, b) => b.points - a.points);
      divisionWinners.push(sorted.slice(0, 3));
      wildCardPool.push(...sorted.slice(3));
    }
    const wildCards = wildCardPool.sort((a, b) => b.points - a.points).slice(0, 2);

    // Matchups follow the NHL's division-based bracket rules
    bracket[conf] = [divisionWinners, wildCards];
  }
  return bracket;
}

async function main() {
  const args = process.argv.slice(2);
  const trials = parseInt(args.find(a => a.startsWith('--trials'))?.split('=')[1] ?? '2000', 10);
  const seed = parseInt(args.find(a => a.startsWith('--seed'))?.split('=')[1] ?? '42', 10);

  console.log(`[sim-season] Loading standings and strengths...`);
  const standings = await fetchStandings();
  const strengths = await fetchTeamStrengths();

  // Initialize team records from current standings
  const baseRecords = {};
  for (const row of standings.standings || []) {
    const team = row.teamAbbrev?.default || row.teamAbbrev;
    if (!team) continue;
    baseRecords[team] = {
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      otLosses: row.otLosses ?? 0,
      points: row.points ?? 0,
      regWins: row.regulationWins ?? 0,
      conference: row.conferenceName?.toLowerCase().includes('east') ? 'east' : 'west',
      division: row.divisionName ?? '',
      gamesPlayed: row.gamesPlayed ?? 0,
    };
  }

  console.log(`[sim-season] Running ${trials} Monte Carlo seasons...`);
  const rng = seededRng(seed);
  const playoffCounts = {};
  const seedingCounts = {}; // [team] => { seed1: N, seed2: N, ... }
  for (const team of Object.keys(baseRecords)) {
    playoffCounts[team] = 0;
    seedingCounts[team] = {};
  }

  const remainingSchedule = standings.remainingGames || [];

  for (let i = 0; i < trials; i++) {
    // Deep clone records
    const records = Object.fromEntries(
      Object.entries(baseRecords).map(([k, v]) => [k, { ...v }])
    );

    // Play out remaining schedule
    for (const game of remainingSchedule) {
      const { homeTeam, awayTeam } = game;
      if (!records[homeTeam] || !records[awayTeam]) continue;
      const { winner, overtime } = simulateGame(homeTeam, awayTeam, strengths, rng);
      const loser = winner === homeTeam ? awayTeam : homeTeam;
      applyResult(records, winner, true, false);
      applyResult(records, loser, false, overtime);
    }

    // Identify playoff teams
    const eastStanding = sortStandings(records, 'east').slice(0, 8);
    const westStanding = sortStandings(records, 'west').slice(0, 8);
    const combined = [...eastStanding, ...westStanding];
    for (const team of combined) playoffCounts[team]++;

    // Track seed distribution per conference
    for (let s = 0; s < eastStanding.length; s++) {
      const t = eastStanding[s];
      seedingCounts[t][`east_seed_${s + 1}`] = (seedingCounts[t][`east_seed_${s + 1}`] || 0) + 1;
    }
    for (let s = 0; s < westStanding.length; s++) {
      const t = westStanding[s];
      seedingCounts[t][`west_seed_${s + 1}`] = (seedingCounts[t][`west_seed_${s + 1}`] || 0) + 1;
    }
  }

  // Build projection output
  const projection = {
    generatedAt: isoTimestamp(),
    trials,
    seed,
    teams: Object.fromEntries(
      Object.entries(playoffCounts).map(([team, count]) => [team, {
        playoffProb: count / trials,
        seeding: seedingCounts[team],
      }])
    ),
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(projection, null, 2));
  console.log(`[sim-season] Wrote ${OUT_PATH}`);

  // Print top 20 by playoff probability
  const top = Object.entries(projection.teams)
    .sort(([, a], [, b]) => b.playoffProb - a.playoffProb)
    .slice(0, 20);
  console.log('\n  Top 20 playoff probabilities:');
  for (const [team, { playoffProb }] of top) {
    const pct = (playoffProb * 100).toFixed(1).padStart(5);
    const bar = '█'.repeat(Math.round(playoffProb * 30));
    console.log(`    ${team}  ${pct}%  ${bar}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
