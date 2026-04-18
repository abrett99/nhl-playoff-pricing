import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATE_DIR = 'data/derived/series_state';

// From predict-r1.js output
const PREDICTIONS = {
  '2026-R1-A1': { teamA: 'BUF', teamB: 'BOS', xgA: 0.472, xgB: 0.528, goalsA: 0.606, goalsB: 0.394 },
  '2026-R1-A2': { teamA: 'TBL', teamB: 'MTL', xgA: 0.648, xgB: 0.352, goalsA: 0.626, goalsB: 0.374 },
  '2026-R1-M1': { teamA: 'CAR', teamB: 'OTT', xgA: 0.553, xgB: 0.447, goalsA: 0.610, goalsB: 0.390 },
  '2026-R1-M2': { teamA: 'PIT', teamB: 'PHI', xgA: 0.514, xgB: 0.486, goalsA: 0.649, goalsB: 0.351 },
  '2026-R1-C1': { teamA: 'COL', teamB: 'LAK', xgA: 0.753, xgB: 0.247, goalsA: 0.876, goalsB: 0.124 },
  '2026-R1-C2': { teamA: 'DAL', teamB: 'MIN', xgA: 0.525, xgB: 0.475, goalsA: 0.595, goalsB: 0.405 },
  '2026-R1-P1': { teamA: 'VGK', teamB: 'UTA', xgA: 0.582, xgB: 0.418, goalsA: 0.471, goalsB: 0.529 },
  '2026-R1-P2': { teamA: 'EDM', teamB: 'ANA', xgA: 0.537, xgB: 0.463, goalsA: 0.666, goalsB: 0.334 },
};

async function main() {
  for (const [id, pred] of Object.entries(PREDICTIONS)) {
    const filePath = path.join(STATE_DIR, id + '.json');
    const state = JSON.parse(await fs.readFile(filePath));
    
    // Blend xG and goals models (60/40)
    const blendA = pred.xgA * 0.6 + pred.goalsA * 0.4;
    const blendB = pred.xgB * 0.6 + pred.goalsB * 0.4;
    
    state.seriesWinner = { [pred.teamA]: blendA, [pred.teamB]: blendB };
    state.totalGames = { "4": 0.12, "5": 0.24, "6": 0.32, "7": 0.32 };
    state.over55 = blendA > blendB ? 0.58 : 0.62;
    state.goesToSeven = 0.32;
    
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
    console.log(`[add-pred] ${id}: ${pred.teamA} ${(blendA*100).toFixed(1)}% vs ${pred.teamB} ${(blendB*100).toFixed(1)}%`);
  }
}

main().catch(console.error);
