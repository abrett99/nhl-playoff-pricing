#!/usr/bin/env node
// ============================================================================
// DEMO: Simulate a Series
// ============================================================================
// Runs a full MC simulation with synthetic team data to demonstrate the
// pipeline end-to-end. Prints market prices + edges vs sample book prices.
//
// Usage:
//   node scripts/simulate-series.js
//   node scripts/simulate-series.js --state 2-1 --round 1
// ============================================================================

import { simulateSeries, computeEdges } from '../src/engine/simulateSeries.js';
import { buildPerGameModel } from '../src/engine/perGameModel.js';
import { MODEL } from '../src/config.js';

// ============================================================================
// Parse CLI args
// ============================================================================

const args = process.argv.slice(2);
function arg(name, def) {
  const idx = args.findIndex(a => a === `--${name}`);
  return idx >= 0 ? args[idx + 1] : def;
}

const stateArg = arg('state', '0-0');
const round = parseInt(arg('round', '1'), 10);
const trials = parseInt(arg('trials', String(MODEL.MC_TRIALS)), 10);
const seed = parseInt(arg('seed', '42'), 10);

const [winsA, winsB] = stateArg.split('-').map(n => parseInt(n, 10));

// ============================================================================
// Synthetic team & goalie features (substitute for real ingest)
// ============================================================================

// Simulating a matchup between a slightly stronger favorite (BOS) and
// underdog with strong goaltending (TOR)
const teamFeatures = {
  BOS: {
    xgf_per_60: 3.10,    // above-avg offense
    xga_per_60: 2.45,    // above-avg defense
    cf_pct: 54.2,
    pp_pct: 24.5,        // elite PP
    pk_pct: 82.1,
    default_goalie_id: 8475167,
  },
  TOR: {
    xgf_per_60: 2.75,
    xga_per_60: 2.70,
    cf_pct: 50.8,
    pp_pct: 21.0,
    pk_pct: 79.8,
    default_goalie_id: 8477964,
  },
};

const goalieFeatures = {
  8475167: {  // BOS: average starter
    gsax_per_60: 0.08,
    save_pct: 0.917,
    games_played: 58,
  },
  8477964: {  // TOR: hot goalie
    gsax_per_60: 0.32,
    save_pct: 0.929,
    games_played: 45,
  },
};

// ============================================================================
// Build state
// ============================================================================

// Construct realistic gamesPlayed if partial state requested
const gamesPlayed = [];
if (winsA + winsB > 0) {
  const VENUES = ['BOS','BOS','TOR','TOR','BOS','TOR','BOS'];
  let aDone = 0, bDone = 0;
  for (let i = 0; i < winsA + winsB; i++) {
    // Alternate winners to produce realistic-looking sequence
    const aWinsThisGame = aDone < winsA && (bDone >= winsB || i % 2 === 0);
    const winner = aWinsThisGame ? 'BOS' : 'TOR';
    if (aWinsThisGame) aDone++; else bDone++;
    gamesPlayed.push({
      gameNum: i + 1,
      gameId: `202503011${i + 1}`,
      venue: VENUES[i],
      winner,
      goals: [2, 3],
      ot: false,
    });
  }
}

const state = {
  seriesId: '2025-R1-M1',
  round,
  matchup: 1,
  teamA: 'BOS',
  teamB: 'TOR',
  winsA,
  winsB,
  gamesPlayed,
  status: 'active',
  currentStarters: {
    BOS: { playerId: 8475167, name: 'Swayman', confirmed: true, since: 'G1' },
    TOR: { playerId: 8477964, name: 'Stolarz', confirmed: true, since: 'G1' },
  },
};

// ============================================================================
// Run the sim
// ============================================================================

console.log('\n═════════════════════════════════════════════════════════════');
console.log(`  NHL PLAYOFF SERIES SIMULATION`);
console.log('═════════════════════════════════════════════════════════════');
console.log(`  Matchup:       BOS vs TOR (Round ${round})`);
console.log(`  Current state: ${winsA}-${winsB} BOS`);
console.log(`  Starters:      Swayman vs Stolarz`);
console.log(`  MC trials:     ${trials.toLocaleString()}  (seed=${seed})`);
console.log('═════════════════════════════════════════════════════════════\n');

const perGameModel = buildPerGameModel({ teamFeatures, goalieFeatures });
const t0 = Date.now();
const result = simulateSeries({ state, perGameModel, trials, seed });
const elapsed = Date.now() - t0;

console.log(`  Completed in ${elapsed}ms\n`);

// ============================================================================
// Display results
// ============================================================================

console.log('─── SERIES WINNER ──────────────────────────────────────────');
for (const [team, { prob, fairAmerican }] of Object.entries(result.seriesWinner)) {
  const sign = fairAmerican > 0 ? '+' : '';
  console.log(`  ${team}:  ${(prob * 100).toFixed(1)}%  (fair ${sign}${fairAmerican})`);
}

console.log('\n─── TOTAL GAMES ────────────────────────────────────────────');
console.log(`  Expected:      ${result.totalGames.expected.toFixed(2)} games`);
console.log('  PMF:');
for (const len of [4, 5, 6, 7]) {
  const p = result.totalGames.pmf[len] || 0;
  const bar = '█'.repeat(Math.round(p * 50));
  console.log(`    ${len}:  ${(p * 100).toFixed(1).padStart(5)}%  ${bar}`);
}
console.log(`  O 5.5:         ${(result.totalGames.over55.prob * 100).toFixed(1)}%  (fair ${result.totalGames.over55.fairAmerican})`);
console.log(`  U 5.5:         ${(result.totalGames.under55.prob * 100).toFixed(1)}%  (fair ${result.totalGames.under55.fairAmerican})`);
console.log(`  O 6.5:         ${(result.totalGames.over65.prob * 100).toFixed(1)}%  (fair ${result.totalGames.over65.fairAmerican})`);
console.log(`  U 6.5:         ${(result.totalGames.under65.prob * 100).toFixed(1)}%  (fair ${result.totalGames.under65.fairAmerican})`);

console.log('\n─── GOES TO 7 ──────────────────────────────────────────────');
console.log(`  Yes:  ${(result.goesSeven.yes.prob * 100).toFixed(1)}%  (fair ${result.goesSeven.yes.fairAmerican})`);
console.log(`  No:   ${(result.goesSeven.no.prob * 100).toFixed(1)}%  (fair ${result.goesSeven.no.fairAmerican})`);

console.log('\n─── CORRECT SCORE ──────────────────────────────────────────');
const sorted = Object.entries(result.correctScore)
  .sort(([, a], [, b]) => b - a);
for (const [key, prob] of sorted) {
  const bar = '█'.repeat(Math.round(prob * 100));
  console.log(`  ${key.padEnd(12)}  ${(prob * 100).toFixed(1).padStart(5)}%  ${bar}`);
}

console.log('\n─── GRAND SALAMI (TOTAL GOALS) ─────────────────────────────');
console.log(`  Mean:          ${result.grandSalami.mean.toFixed(2)} goals`);
console.log(`  Median:        ${result.grandSalami.median} goals`);

// ============================================================================
// Sample book prices & edges (what a real book might offer)
// ============================================================================

const bookPrices = {
  seriesWinner: {
    BOS: -150,   // book thinks BOS ~60%
    TOR: +130,   // book thinks TOR ~43%
  },
  over55: -110,
  under55: -110,
  goesSevenYes: +240,
  goesSevenNo: -320,
};

console.log('\n─── EDGES VS SAMPLE BOOK ───────────────────────────────────');
const edges = computeEdges(result, bookPrices);
for (const e of edges) {
  const sign = e.edge >= 0 ? '+' : '';
  const emoji = e.edge >= 0.05 ? '🎯 ' : e.edge >= 0 ? '   ' : '   ';
  const side = e.side ? ` ${e.side}` : '';
  console.log(`  ${emoji}${e.market}${side}`);
  console.log(`       book=${formatAmerican(e.bookAmerican)}  model=${(e.modelProb * 100).toFixed(1)}%  edge=${sign}${(e.edge * 100).toFixed(1)}%`);
}

console.log('\n═════════════════════════════════════════════════════════════\n');

function formatAmerican(n) {
  return n > 0 ? `+${n}` : String(n);
}
