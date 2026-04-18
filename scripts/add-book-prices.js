import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATE_DIR = 'data/derived/series_state';

// Real odds - 2026 R1
// Best available across DraftKings, Bet365, theScore, Fanatics
const REAL_ODDS = {
  '2026-R1-A1': {
    teams: { BUF: -175, BOS: 152 },
    over55: -180, under55: 165,
    over65: 176, under65: -210,
    goesSevenYes: null, goesSevenNo: null,
  },
  '2026-R1-A2': {
    teams: { TBL: -250, MTL: 202 },
    over55: -170, under55: 140,
    over65: null, under65: null,
    goesSevenYes: 200, goesSevenNo: -220,
  },
  '2026-R1-M1': {
    teams: { CAR: -176, OTT: 146 },
    over55: -180, under55: 165,
    over65: 176, under65: -210,
    goesSevenYes: null, goesSevenNo: null,
  },
  '2026-R1-M2': {
    teams: { PIT: -140, PHI: 116 },
    over55: -190, under55: 165,
    over65: 172, under65: -205,
    goesSevenYes: null, goesSevenNo: null,
  },
  '2026-R1-C1': {
    teams: { COL: -530, LAK: 390 },
    over55: -142, under55: 116,
    over65: null, under65: null,
    goesSevenYes: 230, goesSevenNo: -300,
  },
  '2026-R1-C2': {
    teams: { DAL: -118, MIN: -102 },
    over55: -210, under55: 168,
    over65: null, under65: null,
    goesSevenYes: 165, goesSevenNo: -165,
  },
  '2026-R1-P1': {
    teams: { VGK: -160, UTA: 142 },
    over55: -180, under55: 165,
    over65: 176, under65: -220,
    goesSevenYes: null, goesSevenNo: null,
  },
  '2026-R1-P2': {
    teams: { EDM: -245, ANA: 200 },
    over55: -205, under55: 164,
    over65: null, under65: null,
    goesSevenYes: 175, goesSevenNo: -200,
  },
};

async function main() {
  for (const [id, odds] of Object.entries(REAL_ODDS)) {
    const filePath = path.join(STATE_DIR, id + '.json');
    const state = JSON.parse(await fs.readFile(filePath));
    
    state.bookPrices = {
      seriesWinner: odds.teams,
      over55: odds.over55,
      under55: odds.under55,
      over65: odds.over65,
      under65: odds.under65,
      goesSevenYes: odds.goesSevenYes,
      goesSevenNo: odds.goesSevenNo,
    };
    
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
    console.log(`[add-odds] ${id}: best line odds applied`);
  }
}

main().catch(console.error);
