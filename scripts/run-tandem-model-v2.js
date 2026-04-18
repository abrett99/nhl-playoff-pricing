#!/usr/bin/env node
// ============================================================================
// Corrected Tandem-v1 with REAL per-60 GSAx values from MoneyPuck
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATE_DIR = 'data/derived/series_state';
const TRIALS = 20000;

// ---------- CORRECTED per-60 GSAx values from MoneyPuck 2025 5v5 data ----------
const GSAX = {
  // Elite
  Swayman: 0.670,
  Dobes: 0.483,
  Wedgewood: 0.468,
  Vladar: 0.464,
  DeSmith: 0.450,
  Forsberg: 0.365,
  Blackwood: 0.285,
  Luukkonen: 0.152,
  Vasilevskiy: 0.128,
  Skinner: 0.158,
  Oettinger: 0.124,
  Gustavsson: 0.118,
  Bussi: 0.088,
  Wallstedt: 0.064,
  Vejmelka: 0.063,
  Kuemper: 0.052,
  Korpisalo: 0.004,
  Reimer: -0.040,
  Jarry: -0.074,
  Dostal: -0.102,
  Andersen: -0.128,
  Ingram: -0.137,
  Ullmark: -0.173,
  Hart: -0.200,     // Estimated - minimal GP
  Hill: -0.150,     // Estimated
  Ersson: -0.180,   // Estimated from raw data
  Johansson: -0.150,
  Vanecek: -0.180,
  Silovs: -0.230,
  Husso: -0.130,
  Montembeault: -0.130,
  Levi: 0.0,  // league avg fallback
};

// ---------- Per-team goalie tandem config ----------
const TANDEM_CONFIG = {
  BUF: { starter: 'Luukkonen',  backup: 'Levi',         g1Start: 0.90, hook: 0.10 },
  BOS: { starter: 'Swayman',    backup: 'Korpisalo',    g1Start: 0.92, hook: 0.08 },
  TBL: { starter: 'Vasilevskiy',backup: 'Johansson',    g1Start: 0.98, hook: 0.05 },
  MTL: { starter: 'Dobes',      backup: 'Montembeault', g1Start: 0.70, hook: 0.25 },
  CAR: { starter: 'Andersen',   backup: 'Bussi',        g1Start: 0.75, hook: 0.20 },
  OTT: { starter: 'Ullmark',    backup: 'Reimer',       g1Start: 0.85, hook: 0.15 },
  PIT: { starter: 'Skinner',    backup: 'Silovs',       g1Start: 0.70, hook: 0.25 },
  PHI: { starter: 'Vladar',     backup: 'Ersson',       g1Start: 0.75, hook: 0.20 },
  COL: { starter: 'Blackwood',  backup: 'Wedgewood',    g1Start: 0.55, hook: 0.30 },
  LAK: { starter: 'Kuemper',    backup: 'Forsberg',     g1Start: 0.65, hook: 0.25 },
  DAL: { starter: 'Oettinger',  backup: 'DeSmith',      g1Start: 0.95, hook: 0.08 },
  MIN: { starter: 'Wallstedt',  backup: 'Gustavsson',   g1Start: 0.65, hook: 0.25 },
  VGK: { starter: 'Hart',       backup: 'Hill',         g1Start: 0.70, hook: 0.20 },
  UTA: { starter: 'Vejmelka',   backup: 'Vanecek',      g1Start: 0.80, hook: 0.18 },
  EDM: { starter: 'Ingram',     backup: 'Jarry',        g1Start: 0.65, hook: 0.25 },
  ANA: { starter: 'Dostal',     backup: 'Husso',        g1Start: 0.88, hook: 0.10 },
};

// ---------- Goalie player IDs for updating series files ----------
const GOALIE_IDS = {
  Luukkonen: '8480045', Levi: 'unknown',
  Swayman: '8480280', Korpisalo: '8479979',
  Vasilevskiy: '8476883', Johansson: '8476347',
  Dobes: '8483434', Montembeault: '8482245',
  Andersen: '8475883', Bussi: '8480888',
  Ullmark: '8476999', Reimer: '8475790',
  Skinner: '8477979', Silovs: '8480046',
  Vladar: '8479193', Ersson: '8479360',
  Blackwood: '8478406', Wedgewood: '8477465',
  Kuemper: '8475311', Forsberg: '8476341',
  Oettinger: '8479973', DeSmith: '8478024',
  Wallstedt: '8483432', Gustavsson: '8479406',
  Hart: '8479882', Hill: '8478492',
  Vejmelka: '8478075', Vanecek: '8477970',
  Ingram: '8478233', Jarry: '8477293',
  Dostal: '8475717', Husso: '8476905',
};

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

const VENUE_SEQUENCE = ['A','A','B','B','A','B','A'];
const LEAGUE_AVG_XG = 2.85;
const PLAYOFF_DAMPENER = 0.956;

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

function selectGoalie(team, prevGoalie, prevResult, rng) {
  const cfg = TANDEM_CONFIG[team];
  if (!prevGoalie) return rng() < cfg.g1Start ? cfg.starter : cfg.backup;
  
  const prevWasStarter = prevGoalie === cfg.starter;
  const prevWon = prevResult === 'win';
  const prevBlowout = prevResult === 'blowout';
  
  let starterProb;
  if (prevWasStarter) {
    if (prevWon) starterProb = 0.92;
    else if (prevBlowout) starterProb = 1 - cfg.hook;
    else starterProb = 0.80;
  } else {
    if (prevWon) starterProb = 0.45;
    else if (prevBlowout) starterProb = 0.80;
    else starterProb = 0.60;
  }
  
  return rng() < starterProb ? cfg.starter : cfg.backup;
}

function poissonPMF(lambda, k) {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

function simulateGame(homeTeam, awayTeam, homeGoalie, awayGoalie, rng) {
  const homeData = TEAM_XG[homeTeam], awayData = TEAM_XG[awayTeam];
  let homeLambda = (homeData.xgf60 * (awayData.xga60 / LEAGUE_AVG_XG)) * 1.10;
  let awayLambda = (awayData.xgf60 * (homeData.xga60 / LEAGUE_AVG_XG)) * 1.10;

  const homeGsax = GSAX[homeGoalie] ?? 0;
  const awayGsax = GSAX[awayGoalie] ?? 0;
  homeLambda *= Math.exp(-awayGsax * 0.40);
  awayLambda *= Math.exp(-homeGsax * 0.40);

  homeLambda *= 1.03;
  awayLambda *= 0.97;
  homeLambda *= PLAYOFF_DAMPENER;
  awayLambda *= PLAYOFF_DAMPENER;
  homeLambda = Math.max(0.8, Math.min(5.5, homeLambda));
  awayLambda = Math.max(0.8, Math.min(5.5, awayLambda));

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
    homeGoalieResult: homeGoals < awayGoals ? (awayGoals - homeGoals >= 3 ? 'blowout' : 'loss') : 'win',
    awayGoalieResult: awayGoals < homeGoals ? (homeGoals - awayGoals >= 3 ? 'blowout' : 'loss') : 'win',
  };
}

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
      
      const goalieA = selectGoalie(teamA, prevGoalieA, prevResultA, rng);
      const goalieB = selectGoalie(teamB, prevGoalieB, prevResultB, rng);
      
      const homeGoalie = homeTeam === teamA ? goalieA : goalieB;
      const awayGoalie = homeTeam === teamA ? goalieB : goalieA;
      
      const result = simulateGame(homeTeam, awayTeam, homeGoalie, awayGoalie, rng);
      
      const aWins = (homeTeam === teamA && result.homeWins) || (homeTeam === teamB && !result.homeWins);
      if (aWins) wA++; else wB++;
      
      prevGoalieA = goalieA;
      prevGoalieB = goalieB;
      prevResultA = (homeTeam === teamA) ? result.homeGoalieResult : result.awayGoalieResult;
      prevResultB = (homeTeam === teamB) ? result.homeGoalieResult : result.awayGoalieResult;
      
      gameNum++;
      if (gameNum > 7) break;
    }
    
    if (wA === 4) winsACount++;
    const totalGames = wA + wB;
    if (totalsCount[totalGames] != null) totalsCount[totalGames]++;
  }
  
  return {
    [teamA]: winsACount / trials,
    [teamB]: 1 - winsACount / trials,
  };
}

async function main() {
  const files = await fs.readdir(STATE_DIR);
  
  console.log('\n===============================================');
  console.log('  TANDEM-v1 (CORRECTED per-60 GSAx)');
  console.log('===============================================\n');
  
  for (const f of files.filter(x => x.endsWith('.json'))) {
    const fp = path.join(STATE_DIR, f);
    const state = JSON.parse(await fs.readFile(fp));
    const { teamA, teamB } = state;
    
    if (!TEAM_XG[teamA] || !TEAM_XG[teamB]) continue;
    
    const result = simulateSeriesTandem(teamA, teamB, TRIALS);
    
    // Also update goalie features with CORRECT per-60 values
    const cfgA = TANDEM_CONFIG[teamA];
    const cfgB = TANDEM_CONFIG[teamB];
    state.goalieFeatures = state.goalieFeatures || {};
    
    // Update starter + backup per-60 values
    if (cfgA) {
      const starterId = GOALIE_IDS[cfgA.starter];
      const backupId = GOALIE_IDS[cfgA.backup];
      if (starterId && starterId !== 'unknown') state.goalieFeatures[starterId] = { gsax_per_60: GSAX[cfgA.starter] };
      if (backupId && backupId !== 'unknown') state.goalieFeatures[backupId] = { gsax_per_60: GSAX[cfgA.backup] };
    }
    if (cfgB) {
      const starterId = GOALIE_IDS[cfgB.starter];
      const backupId = GOALIE_IDS[cfgB.backup];
      if (starterId && starterId !== 'unknown') state.goalieFeatures[starterId] = { gsax_per_60: GSAX[cfgB.starter] };
      if (backupId && backupId !== 'unknown') state.goalieFeatures[backupId] = { gsax_per_60: GSAX[cfgB.backup] };
    }
    
    // Update predictions
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
    }
    
    await fs.writeFile(fp, JSON.stringify(state, null, 2));
    
    console.log(`${state.seriesId}: ${teamA} vs ${teamB}`);
    console.log(`  Starters: ${cfgA?.starter}(${GSAX[cfgA.starter]?.toFixed(3)}) vs ${cfgB?.starter}(${GSAX[cfgB.starter]?.toFixed(3)})`);
    console.log(`  Backups:  ${cfgA?.backup}(${GSAX[cfgA.backup]?.toFixed(3)}) vs ${cfgB?.backup}(${GSAX[cfgB.backup]?.toFixed(3)})`);
    console.log(`  xG-v3:    ${teamA} ${(mp.xg[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.xg[teamB]*100).toFixed(1)}%`);
    console.log(`  Goals-v2: ${teamA} ${(mp.goals[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.goals[teamB]*100).toFixed(1)}%`);
    console.log(`  Tandem:   ${teamA} ${(mp.tandem[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.tandem[teamB]*100).toFixed(1)}%`);
    if (mp.ensemble) {
      console.log(`  ENSEMBLE: ${teamA} ${(mp.ensemble[teamA]*100).toFixed(1)}%  ${teamB} ${(mp.ensemble[teamB]*100).toFixed(1)}%`);
    }
    console.log('');
  }
  
  console.log('\u2713 Corrected Tandem-v1 predictions + goalie features updated\n');
}

main().catch(console.error);
