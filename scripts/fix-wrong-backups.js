#!/usr/bin/env node
// ============================================================================
// Fix wrong backup goalie names in series files
// - EDM: Stuart Skinner (wrong, he's PIT) -> Tristan Jarry
// - ANA: John Gibson (wrong, he's DET) -> Ville Husso
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATE_DIR = 'data/derived/series_state';

const FIXES = [
  {
    file: '2026-R1-P2.json',
    team: 'EDM',
    newBackup: { playerId: '8477293', name: 'Tristan Jarry' },
    oldBackupId: '8479973', // Stuart Skinner (on PIT)
  },
  {
    file: '2026-R1-P2.json',
    team: 'ANA',
    newBackup: { playerId: '8476905', name: 'Ville Husso' },
    oldBackupId: '8476434', // John Gibson (on DET)
  },
];

async function main() {
  for (const fix of FIXES) {
    const fp = path.join(STATE_DIR, fix.file);
    const state = JSON.parse(await fs.readFile(fp));
    
    // Update backup goalie name/id
    state.backupGoalies[fix.team] = fix.newBackup;
    
    // Remove old backup's gsax entry if present
    if (state.goalieFeatures[fix.oldBackupId]) {
      delete state.goalieFeatures[fix.oldBackupId];
    }
    
    // Add new backup's gsax (from MoneyPuck per-60 lookup)
    const newBackupGsax = {
      '8477293': -0.074, // Jarry
      '8476905': -0.130, // Husso
    };
    state.goalieFeatures[fix.newBackup.playerId] = { 
      gsax_per_60: newBackupGsax[fix.newBackup.playerId] ?? 0 
    };
    
    await fs.writeFile(fp, JSON.stringify(state, null, 2));
    console.log(`[fix] ${fix.file}: ${fix.team} backup -> ${fix.newBackup.name}`);
  }
  
  console.log('[fix] \u2713 Done');
}

main().catch(err => {
  console.error('[fix] FAILED:', err.message);
  process.exit(1);
});
