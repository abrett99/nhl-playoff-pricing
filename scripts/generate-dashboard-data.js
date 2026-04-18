import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadAllMoneyPuck, getTeamProfile } from '../src/ingest/moneypuck/loaders.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const OUT_DIR = path.resolve('data/derived');

const R1 = [
  { id: '2026-R1-A1', a: 'BUF', b: 'BOS', g1: '2026-04-19T19:30:00-04:00' },
  { id: '2026-R1-A2', a: 'TBL', b: 'MTL', g1: '2026-04-19T17:45:00-04:00' },
  { id: '2026-R1-M1', a: 'CAR', b: 'OTT', g1: '2026-04-18T15:00:00-04:00' },
  { id: '2026-R1-M2', a: 'PIT', b: 'PHI', g1: '2026-04-18T20:00:00-04:00' },
  { id: '2026-R1-C1', a: 'COL', b: 'LAK', g1: '2026-04-19T15:00:00-04:00' },
  { id: '2026-R1-C2', a: 'DAL', b: 'MIN', g1: '2026-04-18T17:30:00-04:00' },
  { id: '2026-R1-P1', a: 'VGK', b: 'UTA', g1: '2026-04-19T22:00:00-04:00' },
  { id: '2026-R1-P2', a: 'EDM', b: 'ANA', g1: '2026-04-20T22:00:00-04:00' },
];

const STARTER_INFO = {
  BUF: { name: 'Luukkonen', backupName: 'Levi' },
  BOS: { name: 'Swayman', backupName: 'Ullmark' },
  TBL: { name: 'Vasilevskiy', backupName: 'Johansson' },
  MTL: { name: 'Dobes', backupName: 'Primeau' },
  CAR: { name: 'Bussi', backupName: 'Andersen' },
  OTT: { name: 'Ullmark', backupName: 'Forsberg' },
  PIT: { name: 'Skinner', backupName: 'Jarry' },
  PHI: { name: 'Vladar', backupName: 'Ersson' },
  COL: { name: 'Wedgewood', backupName: 'Blackwood' },
  LAK: { name: 'Talbot', backupName: 'Rittich' },
  DAL: { name: 'Oettinger', backupName: 'DeSmith' },
  MIN: { name: 'Wallstedt', backupName: 'Gustavsson' },
  VGK: { name: 'Hart', backupName: 'Hill' },
  UTA: { name: 'Vejmelka', backupName: 'Ingram' },
  EDM: { name: 'Ingram', backupName: 'Skinner' },
  ANA: { name: 'Dostal', backupName: 'Gibson' },
};

async function load2025GoaliesFull() {
  const goalies = [];
  const rl = createInterface({
    input: createReadStream('data/raw/moneypuck/goalies_2025.csv'),
    crlfDelay: Infinity,
  });
  let headers = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!headers) { headers = line.split(','); continue; }
    const cells = line.split(',');
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cells[i];
    if (row.situation !== '5on5') continue;
    const xGoals = parseFloat(row.xGoals) || 0;
    const goals = parseFloat(row.goals) || 0;
    const icetime = parseFloat(row.icetime) || 0;
    goalies.push({
      playerId: row.playerId,
      name: row.name,
      team: row.team,
      gp: parseInt(row.games_played) || 0,
      icetime,
      gsax: xGoals - goals,
      gsaxPer60: icetime > 0 ? ((xGoals - goals) / icetime) * 3600 : 0,
    });
  }
  return goalies;
}

function findGoalie(goalies, team, namePart) {
  const lastName = namePart.split(' ').pop();
  return goalies.find(g => {
    const gLast = g.name.split(' ').pop();
    return g.team === team && gLast === lastName;
  }) || goalies.find(g => {
    return g.name.includes(namePart);
  }) || null;
}

async function main() {
  console.log('[gen] Loading MoneyPuck data...');
  const mpData = await loadAllMoneyPuck();
  const goalies2025 = await load2025GoaliesFull();
  console.log('[gen] Loaded', goalies2025.length, 'goalies for 2025');

  await fs.mkdir(path.join(OUT_DIR, 'series_state'), { recursive: true });

  const seriesIds = [];

  for (const m of R1) {
    const t5a = getTeamProfile(2025, m.a, '5on5', mpData);
    const t5b = getTeamProfile(2025, m.b, '5on5', mpData);
    const t54a = getTeamProfile(2025, m.a, '5on4', mpData);
    const t54b = getTeamProfile(2025, m.b, '5on4', mpData);
    const t45a = getTeamProfile(2025, m.a, '4on5', mpData);
    const t45b = getTeamProfile(2025, m.b, '4on5', mpData);

    if (!t5a || !t5b) {
      console.log('[gen] SKIP', m.id, '- missing team data');
      continue;
    }

    const info = STARTER_INFO;
    const starterA = findGoalie(goalies2025, m.a, info[m.a].name);
    const backupA = findGoalie(goalies2025, m.a, info[m.a].backupName);
    const starterB = findGoalie(goalies2025, m.b, info[m.b].name);
    const backupB = findGoalie(goalies2025, m.b, info[m.b].backupName);

    // Handle traded goalies (search all teams)
    const findAny = (name) => goalies2025.find(g => g.name.split(' ').pop() === name) || null;
    const sA = starterA || findAny(info[m.a].name);
    const bA = backupA || findAny(info[m.a].backupName);
    const sB = starterB || findAny(info[m.b].name);
    const bB = backupB || findAny(info[m.b].backupName);

    // PP% = goals / (icetime_in_seconds / 60) * 60 ... simplified to goals per 60 min of PP
    const ppPctA = t54a ? (t54a.goalsFor / (t54a.iceTime / 3600)) : 0;
    const ppPctB = t54b ? (t54b.goalsFor / (t54b.iceTime / 3600)) : 0;
    const pkPctA = t45a ? (1 - t45a.goalsAgainst / (t45a.iceTime / 3600) / 60) * 100 : 80;
    const pkPctB = t45b ? (1 - t45b.goalsAgainst / (t45b.iceTime / 3600) / 60) * 100 : 80;

    const goalieFeatures = {};
    if (sA) goalieFeatures[sA.playerId] = { gsax_per_60: sA.gsaxPer60 };
    if (bA) goalieFeatures[bA.playerId] = { gsax_per_60: bA.gsaxPer60 };
    if (sB) goalieFeatures[sB.playerId] = { gsax_per_60: sB.gsaxPer60 };
    if (bB) goalieFeatures[bB.playerId] = { gsax_per_60: bB.gsaxPer60 };

    const series = {
      seriesId: m.id,
      teamA: m.a,
      teamB: m.b,
      round: 1,
      winsA: 0,
      winsB: 0,
      status: 'pre',
      game1Start: m.g1,
      gamesPlayed: [],
      currentStarters: {
        [m.a]: { playerId: sA ? sA.playerId : 'unknown', name: sA ? sA.name : info[m.a].name },
        [m.b]: { playerId: sB ? sB.playerId : 'unknown', name: sB ? sB.name : info[m.b].name },
      },
      backupGoalies: {
        [m.a]: { playerId: bA ? bA.playerId : 'unknown', name: bA ? bA.name : info[m.a].backupName },
        [m.b]: { playerId: bB ? bB.playerId : 'unknown', name: bB ? bB.name : info[m.b].backupName },
      },
      teamFeatures: {
        [m.a]: {
          xgf_per_60: parseFloat(t5a.xgfPer60.toFixed(2)),
          xga_per_60: parseFloat(t5a.xgaPer60.toFixed(2)),
          pp_pct: parseFloat(ppPctA.toFixed(1)),
          pk_pct: parseFloat(pkPctA.toFixed(1)),
        },
        [m.b]: {
          xgf_per_60: parseFloat(t5b.xgfPer60.toFixed(2)),
          xga_per_60: parseFloat(t5b.xgaPer60.toFixed(2)),
          pp_pct: parseFloat(ppPctB.toFixed(1)),
          pk_pct: parseFloat(pkPctB.toFixed(1)),
        },
      },
      goalieFeatures,
      bookPrices: null, // Will be filled by odds API later
    };

    const outFile = path.join(OUT_DIR, 'series_state', m.id + '.json');
    await fs.writeFile(outFile, JSON.stringify(series, null, 2));
    seriesIds.push(m.id);
    console.log('[gen]', m.id, m.a, 'vs', m.b,
      '| G:', (sA ? sA.name : '?') + ' vs ' + (sB ? sB.name : '?'));
  }

  // Write manifest
  await fs.writeFile(
    path.join(OUT_DIR, 'series_manifest.json'),
    JSON.stringify({ seriesIds, generatedAt: new Date().toISOString() }, null, 2)
  );

  // Write build.json
  await fs.writeFile(
    path.join(OUT_DIR, 'build.json'),
    JSON.stringify({
      commit: 'live',
      builtAt: new Date().toISOString(),
      model: 'xg-v3 + goals-v2',
      backtest: { accuracy: 0.595, brier: 0.2377 },
    }, null, 2)
  );

  console.log('[gen] Done. Generated', seriesIds.length, 'series files');
  console.log('[gen] Output:', OUT_DIR);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
