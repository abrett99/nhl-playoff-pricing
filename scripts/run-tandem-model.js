#!/usr/bin/env node
// ============================================================================
// Tandem-v1 Model: Probabilistic Goalie Rotation Across Playoff Series
// ============================================================================
// Unlike xG-v3 and Goals-v2 which assume "starter plays all 7 games", this
// model samples goalie usage per game based on:
//   - G1 start probability (per-team tandem style)
//   - Hook risk (starter pulled after bad outing)
//   - Hot hand (backup who wins stays in)
//   - Back-to-back rest dynamics
//
// For each MC trial:
//   1. Sample who starts Game 1 using g1StartProb
//   2. Simulate Game 1 with that goalie's GSAx
//   3. Post-game: determine next goalie based on result/hook
//   4. Repeat until series ends
//
// Usage:
//   node scripts/run-tandem-model.js
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATE_DIR = 'data/derived/series_state';
const TRIALS = 20000;

// ---------- Per-team goalie tandem config ----------
const TANDEM_CONFIG = {
  BUF: { starter: 'Luukkonen',  backup: 'Levi',         g1Start: 0.90, hook: 0.10, hotHand: 0.50 },
  BOS: { starter: 'Swayman',    backup: 'Korpisalo',    g1Start: 0.92, hook: 0.08, hotHand: 0.55 },
  TBL: { starter: 'Vasilevskiy',backup: 'Johansson',    g1Start: 0.98, hook: 0.05, hotHand: 0.70 },
  MTL: { starter: 'Dobes',      backup: 'Montembeault', g1Start: 0.70, hook: 0.25, hotHand: 0.45 },
  CAR: { starter: 'Andersen',   backup: 'Bussi',        g1Start: 0.75, hook: 0.20, hotHand: 0.50 },
  OTT: { starter: 'Ullmark',    backup: 'Reimer',       g1Start: 0.85, hook: 0.15, hotHand: 0.55 },
  PIT: { starter: 'Skinner',    backup: 'Silovs',       g1Start: 0.70, hook: 0.25, hotHand: 0.50 },
  PHI: { starter: 'Vladar',     backup: 'Ersson',       g1Start: 0.75, hook: 0.20, hotHand: 0.55 },
  COL: { starter: 'Blackwood',  backup: 'Wedgewood',    g1Start: 0.55, hook: 0.30, hotHand: 0.50 },
  LAK: { starter: 'Kuemper',    backup: 'Forsberg',     g1Start: 0.65, hook: 0.25, hotHand: 0.50 },
  DAL: { starter: 'Oettinger',  backup: 'DeSmith',      g1Start: 0.95, hook: 0.08, hotHand: 0.65 },
  MIN: { starter: 'Wallstedt',  backup: 'Gustavsson',   g1Start: 0.65, hook: 0.25, hotHand: 0.45 },
  VGK: { starter: 'Hart',       backup: 'Hill',         g1Start: 0.70, hook: 0.20, hotHand: 0.50 },
  UTA: { starter: 'Vejmelka',   backup: 'Vanecek',      g1Start: 0.80, hook: 0.18, hotHand: 0.55 },
  EDM: { starter: 'Ingram',     backup: 'Jarry',        g1Start: 0.65, hook: 0.25, hotHand: 0.45 },
  ANA: { starter: 'Dostal',     backup: 'Husso',        g1Start: 0.88, hook: 0.10, hotHand: 0.55 },
};

// ---------- Team 5v5 xGF/xGA per 60 (from team stats) ----------
const TEAM_XG = {
  BUF: { xgf60: 2.56, xga60: 2.55 }, BOS: { xgf60: 2.38, xga60: 2.67 },
  TBL: { xgf60: 2.66, xga60: 2.28 }, MTL: { xgf60: 2.41, xga60: 2.63 },
  CAR: { xgf60: 2.98, xga60: 2.31 }, OTT: { xgf60: 2.66, xga60: 2.13 },
  PIT: { xgf60: 2.66, xga60: 2.54 }, PHI: { xgf60: 2.27, xga60: 2.20 },
  COL: { xgf60: 3.03, xga60: 2.33 }, LAK: { xgf60: 2.39, xga60: 2.23 },
  DAL: { xgf60: 2.35, xga60: 2.30 }, MIN: { xgf60: 2.54, xga60: 2.40 },
  VGK: { xgf60: 2.52, xga60: 2.11 }, UTA: { xgf60: 2.63, xga60: 2.40 },
  EDM: { xgf60: 2.64, xga60: 2.48 }, ANA: { xgf60: 2.79, xga60: 2.59 },
};

// ---------- Goalie GSAx per 60 ----------
const GSAX = {
  Luukkonen: 0.15, Levi: 0,
  Swayman: 0.67, Korpisalo: 0,
  Vasilevskiy: 0.10, Johansson: -0.13,
  Dobes: 0.41, Montembeault: -0.13,
  Andersen: 0.07, Bussi: 0.05,
  Ullmark: -0.14, Reimer: 0.04,
  Skinner: 0.08, Silovs: -0.25,
  Vladar: 0.35, Ersson: -0.33,
  Blackwood: -0.20, Wedgewood: 0.34,
  Kuemper: 0.09, Forsberg: 0.19,
  Oettinger: 0.10, DeSmith: 0.23,
  Wallstedt: 0.04, Gustavsson: 0.09,
  Hart: -0.40, Hill: -0.35,
  Vejmelka: 0.05, Vanecek: -0.18,
  Ingram: -0.07, Jarry: -0.04,
  Dostal: -0.08, Husso: -0.11,
};

const VENUE_SEQUENCE = ['A','A','B','B','A','B','A'];
const LEAGUE_AVG_XG = 2.85;
const PLAYOFF_DAMPENER = 0.956;

// ---------- Seeded RNG ----------
function seededRng(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Select goalie for next game ----------
function selectGoalie(team, prevGoalie, prevResult, isBackToBack, rng) {
  const cfg = TANDEM_CONFIG[team];
  if (!cfg) return null;
  
  // No prior game: use g1StartProb
  if (!prevGoalie) {
    return rng() < cfg.g1Start ? cfg.starter : cfg.backup;
  }
  
  // Prior game result context
  const prevWasStarter = prevGoalie === cfg.starter;
  const prevWon = prevResult === 'win';
  const prevBlowout = prevResult === 'blowout'; // gave up 4+
  
  let starterProb;
  if (prevWasStarter) {
    if (prevWon) {
      starterProb = 0.92; // winning starter stays
    } else if (prevBlowout) {
      starterProb = 1 - cfg.hook; // hook probability
    } else {
      starterProb = 0.80; // normal loss, usually stays
    }
  } else {
    // Backup started last game
    if (prevWon) {
      starterProb = 1 - cfg.hotHand; // hot hand stays
    } else if (prevBlowout) {
      starterProb = 0.80; // revert to starter after backup blowup
    } else {
      starterProb = 0.60; // normal loss, often revert
    }
  }
  
  // Back-to-back makes rotation more likely
  if (isBackToBack) {
    starterProb = prevWasStarter ? starterProb - 0.15 : starterProb + 0.15;
  }
  
  return rng() < starterProb ? cfg.starter : cfg.backup;
}

// ---------- Poisson win probability from lambdas ----------
function poissonPMF(lambda, k) {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

function poissonWinProb(lambdaHome, lambdaAway) {
  let homeWin = 0, tie = 0;
  const maxGoals = 12;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPMF(lambdaHome, h) * poissonPMF(lambdaAway, a);
      if (h > a) homeWin += p;
      else if (h === a) tie += p;
    }
  }
  // In playoffs OT, assume 50/50 on ties
  return homeWin + tie * 0.5;
}

// ---------- Simulate one game ----------
function simulateGame(homeTeam, awayTeam, homeGoalie, awayGoalie, rng) {
  const homeData = TEAM_XG[homeTeam];
  const awayData = TEAM_XG[awayTeam];
  if (!homeData || !awayData) return { homeWins: rng() < 0.5, homeGoals: 3, awayGoals: 3 };

  let homeLambda = (homeData.xgf60 * (awayData.xga60 / LEAGUE_AVG_XG)) * 1.10;
  let awayLambda = (awayData.xgf60 * (homeData.xga60 / LEAGUE_AVG_XG)) * 1.10;

  // Goalie impact
  const homeGsax = GSAX[homeGoalie] ?? 0;
  const awayGsax = GSAX[awayGoalie] ?? 0;
  homeLambda *= Math.exp(-awayGsax * 0.40); // away goalie stops home goals
  awayLambda *= Math.exp(-homeGsax * 0.40);

  // Home ice bump
  homeLambda *= 1.03;
  awayLambda *= 0.97;

  homeLambda *= PLAYOFF_DAMPENER;
  awayLambda *= PLAYOFF_DAMPENER;
  
  homeLambda = Math.max(0.8, Math.min(5.5, homeLambda));
  awayLambda = Math.max(0.8, Math.min(5.5, awayLambda));

  // Sample goals
  const sampleGoals = lambda => {
    let k = 0, L = Math.exp(-lambda), p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  };
  
  let homeGoals = sampleGoals(homeLambda);
  let awayGoals = sampleGoals(awayLambda);
  if (homeGoals === awayGoals) {
    if (rng() < 0.5) homeGoals++; else awayGoals++;
  }

  return {
    homeWins: homeGoals > awayGoals,
    homeGoals,
    awayGoals,
    homeGoalieResult: homeGoals < awayGoals ? (awayGoals - homeGoals >= 3 ? 'blowout' : 'loss') : 'win',
    awayGoalieResult: awayGoals < homeGoals ? (homeGoals - awayGoals >= 3 ? 'blowout' : 'loss') : 'win',
  };
}

// ---------- Simulate full series with tandem rotation ----------
function simulateSeriesTandem(teamA, teamB, trials = TRIALS) {
  let winsACount = 0;
  const totalsCount = { 4: 0, 5: 0, 6: 0, 7: 0 };
  
  for (let t = 0; t < trials; t++) {
    const rng = seededRng(42 + t * 7919);
    let wA = 0, wB = 0;
    let gameNum = 1;
    let prevGoalieA = null, prevGoalieB = null;
    let prevResultA = null, prevResultB = null;
    
    while (wA < 4 && wB < 4) {
      const venueLetter = VENUE_SEQUENCE[gameNum - 1];
      const homeTeam = venueLetter === 'A' ? teamA : teamB;
      const awayTeam = venueLetter === 'A' ? teamB : teamA;
      
      // Back-to-back on game 2 and game 4 (typical playoff schedule)
      const isBackToBack = (gameNum === 2 || gameNum === 4) && rng() < 0.3;
      
      // Select goalies based on rotation model
      const goalieA = selectGoalie(teamA, prevGoalieA, prevResultA, isBackToBack, rng);
      const goalieB = selectGoalie(teamB, prevGoalieB, prevResultB, isBackToBack, rng);
      
      const homeGoalie = homeTeam === teamA ? goalieA : goalieB;
      const awayGoalie = homeTeam === teamA ? goalieB : goalieA;
      
      const result = simulateGame(homeTeam, awayTeam, homeGoalie, awayGoalie, rng);
      
      const aWins = (homeTeam === teamA && result.homeWins) || (homeTeam === teamB && !result.homeWins);
      if (aWins) wA++; else wB++;
      
      // Track previous result for rotation decisions
      prevGoalieA = goalieA;
      prevGoalieB = goalieB;
      prevResultA = (homeTeam === teamA) ? result.homeGoalieResult : result.awayGoalieResult;
      prevResultB = (homeTeam === teamB) ? result.homeGoalieResult : result.awayGoalieResult;
      
      gameNum++;
      if (gameNum > 7) break; // safety
    }
    
    if (wA === 4) winsACount++;
    const totalGames = wA + wB;
    if (totalsCount[totalGames] != null) totalsCount[totalGames]++;
  }
  
  const aProb = winsACount / trials;
  return {
    [teamA]: aProb,
    [teamB]: 1 - aProb,
    pmf: {
      4: totalsCount[4] / trials,
      5: totalsCount[5] / trials,
      6: totalsCount[6] / trials,
      7: totalsCount[7] / trials,
    },
  };
}

// ---------- Update ensemble to blend 3 models: xG 40% / Goals 30% / Tandem 30% ----------
async function main() {
  const files = await fs.readdir(STATE_DIR);
  
  console.log('\n==========================================');
  console.log('  TANDEM-v1 MODEL PREDICTIONS');
  console.log('  20,000 MC trials per series');
  console.log('  Goalie rotation + hook dynamics');
  console.log('==========================================\n');
  
  for (const f of files.filter(x => x.endsWith('.json'))) {
    const fp = path.join(STATE_DIR, f);
    const state = JSON.parse(await fs.readFile(fp));
    const { teamA, teamB } = state;
    
    if (!TEAM_XG[teamA] || !TEAM_XG[teamB]) {
      console.log(`[tandem] SKIP ${f}: missing team data`);
      continue;
    }
    
    const result = simulateSeriesTandem(teamA, teamB, TRIALS);
    
    // Update modelPredictions
    state.modelPredictions = state.modelPredictions || {};
    state.modelPredictions.tandem = {
      [teamA]: result[teamA],
      [teamB]: result[teamB],
    };
    
    // Recompute ensemble: 40% xG + 30% Goals + 30% Tandem
    const mp = state.modelPredictions;
    if (mp.xg && mp.goals && mp.tandem) {
      const ensembleA = mp.xg[teamA] * 0.40 + mp.goals[teamA] * 0.30 + mp.tandem[teamA] * 0.30;
      const ensembleB = mp.xg[teamB] * 0.40 + mp.goals[teamB] * 0.30 + mp.tandem[teamB] * 0.30;
      state.modelPredictions.ensemble = { [teamA]: ensembleA, [teamB]: ensembleB };
      state.seriesWinner = { [teamA]: ensembleA, [teamB]: ensembleB };
      
      // Track disagreement
      const maxSpread = Math.max(
        Math.abs(mp.xg[teamA] - mp.goals[teamA]),
        Math.abs(mp.xg[teamA] - mp.tandem[teamA]),
        Math.abs(mp.goals[teamA] - mp.tandem[teamA]),
      );
      state.modelAgreement = maxSpread;
    }
    
    await fs.writeFile(fp, JSON.stringify(state, null, 2));
    
    console.log(`${state.seriesId}: ${teamA} vs ${teamB}`);
    console.log(`  xG-v3:    ${teamA} ${(mp.xg[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.xg[teamB]*100).toFixed(1)}%`);
    console.log(`  Goals-v2: ${teamA} ${(mp.goals[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.goals[teamB]*100).toFixed(1)}%`);
    console.log(`  Tandem:   ${teamA} ${(mp.tandem[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.tandem[teamB]*100).toFixed(1)}%`);
    if (mp.ensemble) {
      console.log(`  ENSEMBLE: ${teamA} ${(mp.ensemble[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.ensemble[teamB]*100).toFixed(1)}%`);
    }
    console.log('');
  }
  
  console.log('\u2713 Tandem-v1 predictions added to all series files\n');
}

main().catch(console.error);
