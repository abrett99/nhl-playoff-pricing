import { loadAllMoneyPuck, getTeamProfile } from '../src/ingest/moneypuck/loaders.js';
import { buildPerGameModelXg } from '../src/engine/perGameModelXg.js';
import { buildPerGameModelGoals } from '../src/engine/perGameModelGoals.js';
import { simulateSeries } from '../src/engine/simulateSeries.js';

const STARTERS = {
  BUF: { name: "Luukkonen", gsax: 4.2, gp: 35 },
  BOS: { name: "Swayman", gsax: 29.1, gp: 55 },
  TBL: { name: "Vasilevskiy", gsax: 5.9, gp: 58 },
  MTL: { name: "Dobes", gsax: 16.7, gp: 43 },
  CAR: { name: "Bussi", gsax: 2.9, gp: 39 },
  OTT: { name: "Ullmark", gsax: -6.8, gp: 49 },
  PIT: { name: "Jarry", gsax: -1.8, gp: 33 },
  PHI: { name: "Vladar", gsax: 19.0, gp: 52 },
  COL: { name: "Wedgewood", gsax: 16.1, gp: 45 },
  LAK: { name: "Talbot", gsax: -9.6, gp: 34 },
  DAL: { name: "Oettinger", gsax: 5.4, gp: 54 },
  MIN: { name: "Wallstedt", gsax: 1.8, gp: 35 },
  VGK: { name: "Hart", gsax: -9.2, gp: 18 },
  UTA: { name: "Vejmelka", gsax: 3.2, gp: 64 },
  EDM: { name: "Ingram", gsax: -3.4, gp: 32 },
  ANA: { name: "Dostal", gsax: -4.5, gp: 56 },
};

const R1 = [
  { a: "CAR", b: "OTT", label: "CAR (M1) vs OTT (WC2)", g1: "Apr 18 3pm" },
  { a: "DAL", b: "MIN", label: "DAL (C2) vs MIN (C3)", g1: "Apr 18 5:30pm" },
  { a: "PIT", b: "PHI", label: "PIT (M2) vs PHI (M3)", g1: "Apr 18 8pm" },
  { a: "BUF", b: "BOS", label: "BUF (A1) vs BOS (WC1)", g1: "Apr 19" },
  { a: "TBL", b: "MTL", label: "TBL (A2) vs MTL (A3)", g1: "Apr 19" },
  { a: "COL", b: "LAK", label: "COL (C1) vs LAK (WC2)", g1: "Apr 19" },
  { a: "VGK", b: "UTA", label: "VGK (P1) vs UTA (WC1)", g1: "Apr 19" },
  { a: "EDM", b: "ANA", label: "EDM (P2) vs ANA (P3)", g1: "Apr 20" },
];

function buildXgFeat(season, team, mpData) {
  const t5 = getTeamProfile(season, team, "5on5", mpData);
  const t54 = getTeamProfile(season, team, "5on4", mpData);
  const t45 = getTeamProfile(season, team, "4on5", mpData);
  const g = STARTERS[team];
  if (!t5) return null;
  return {
    xg5on5For: t5.xgfPer60, xg5on5Against: t5.xgaPer60,
    pp_xgf_per60: t54 ? t54.xgfPer60 : null,
    pk_xga_per60: t45 ? t45.xgaPer60 : null,
    pdo: t5.pdo, goalie_gsax: g ? g.gsax : 0,
  };
}

function buildGoalsFeat(season, team, mpData) {
  const tAll = getTeamProfile(season, team, "all", mpData);
  const t54 = getTeamProfile(season, team, "5on4", mpData);
  if (!tAll) return null;
  const gp = tAll.gamesPlayed || 82;
  return {
    goals_for_per_game: tAll.goalsFor / gp,
    goals_against_per_game: tAll.goalsAgainst / gp,
    pp_pct: t54 ? (t54.goalsFor / (t54.iceTime / 60) * 60) / 60 : null,
    default_goalie_id: team + "-G",
  };
}

function sim(teamA, teamB, model) {
  const mc = simulateSeries({
    state: { seriesId: teamA+"v"+teamB, teamA, teamB, winsA: 0, winsB: 0, gamesPlayed: [], round: 1 },
    perGameModel: model, trials: 50000, seed: 42,
  });
  return mc.seriesWinner[teamA].prob;
}

async function main() {
  const mpData = await loadAllMoneyPuck();

  console.log("");
  console.log("============================================================");
  console.log("  2026 NHL PLAYOFF R1 — CORRECTED GOALIES");
  console.log("  xG-v3 (Brier 0.238) + Goals-v2 (Acc 61.7%)");
  console.log("============================================================");
  console.log("");

  for (const m of R1) {
    const aXg = buildXgFeat(2025, m.a, mpData);
    const bXg = buildXgFeat(2025, m.b, mpData);
    const aG = buildGoalsFeat(2025, m.a, mpData);
    const bG = buildGoalsFeat(2025, m.b, mpData);
    const ga = STARTERS[m.a];
    const gb = STARTERS[m.b];

    const xgProb = sim(m.a, m.b, buildPerGameModelXg({ teamFeatures: { [m.a]: aXg, [m.b]: bXg } }));
    let goalsProb = null;
    if (aG && bG) {
      goalsProb = sim(m.a, m.b, buildPerGameModelGoals({ teamFeatures: { [m.a]: aG, [m.b]: bG }, goalieFeatures: {} }));
    }

    const xgFav = xgProb > 0.5 ? m.a : m.b;
    const gFav = goalsProb !== null ? (goalsProb > 0.5 ? m.a : m.b) : "?";
    const agree = xgFav === gFav;

    console.log("── " + m.label + "  [" + m.g1 + "] ──");
    console.log("");
    console.log("  xG-v3:    " + m.a + " " + (xgProb*100).toFixed(1) + "%  |  " + m.b + " " + ((1-xgProb)*100).toFixed(1) + "%");
    if (goalsProb !== null)
      console.log("  Goals-v2: " + m.a + " " + (goalsProb*100).toFixed(1) + "%  |  " + m.b + " " + ((1-goalsProb)*100).toFixed(1) + "%");
    console.log("");
    console.log("  " + ga.name + " (" + (ga.gsax>=0?"+":"") + ga.gsax + ", " + ga.gp + "GP)  vs  " + gb.name + " (" + (gb.gsax>=0?"+":"") + gb.gsax + ", " + gb.gp + "GP)");
    console.log("  5v5 xGF/60: " + aXg.xg5on5For.toFixed(2) + " vs " + bXg.xg5on5For.toFixed(2));
    console.log("  5v5 xGA/60: " + aXg.xg5on5Against.toFixed(2) + " vs " + bXg.xg5on5Against.toFixed(2));
    console.log("  PDO:        " + aXg.pdo.toFixed(3) + " vs " + bXg.pdo.toFixed(3));
    console.log("");
    console.log("  " + (agree ? "AGREE" : "SPLIT") + " -> " + xgFav + " (xG) / " + gFav + " (goals)");
    console.log("");
  }
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });
