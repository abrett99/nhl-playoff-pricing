#!/usr/bin/env node
// ============================================================================
// BOOTSTRAP 2026 R1 SERIES STATE FILES
// ============================================================================
// After the regular season locks (Thursday April 16, 2026), creates the 8
// first-round series state files from the known bracket. Run once.
//
// Projected bracket as of April 13, 2026 (seeding still fluid in Pacific):
//   EAST:
//     A1 BUF vs WC1 BOS
//     A2 TBL vs A3 MTL
//     M1 CAR vs WC2 OTT
//     M2 PIT vs M3 PHI
//   WEST:
//     C1 COL vs WC2 LAK
//     C2 DAL vs C3 MIN
//     P1 VGK vs WC1 UTA
//     P2 EDM vs P3 ANA
//
// Usage:
//   node scripts/bootstrap-2026-r1.js
//   node scripts/bootstrap-2026-r1.js --dry-run
//   node scripts/bootstrap-2026-r1.js --force       (overwrite existing)
// ============================================================================

import { createSeries, saveState, loadState } from '../src/state/series.js';

// A = higher seed, B = lower seed. Home ice goes to team A per 2-2-1-1-1 sequence.
const R1_BRACKET = [
  // EAST
  {
    seriesId: '2025-R1-E1', teamA: 'BUF', teamB: 'BOS',
    round: 1, conference: 'EAST', description: 'A1 vs WC1',
    starters: { BUF: { name: 'Luukkonen', confirmed: false },
                BOS: { name: 'Swayman', confirmed: false } },
  },
  {
    seriesId: '2025-R1-E2', teamA: 'TBL', teamB: 'MTL',
    round: 1, conference: 'EAST', description: 'A2 vs A3',
    starters: { TBL: { name: 'Vasilevskiy', confirmed: false },
                MTL: { name: 'Montembeault', confirmed: false } },
  },
  {
    seriesId: '2025-R1-E3', teamA: 'CAR', teamB: 'OTT',
    round: 1, conference: 'EAST', description: 'M1 vs WC2',
    starters: { CAR: { name: 'Andersen', confirmed: false },
                OTT: { name: 'Ullmark', confirmed: false } },
  },
  {
    seriesId: '2025-R1-E4', teamA: 'PIT', teamB: 'PHI',
    round: 1, conference: 'EAST', description: 'M2 vs M3',
    starters: { PIT: { name: 'Jarry', confirmed: false },
                PHI: { name: 'Ersson', confirmed: false } },
  },
  // WEST
  {
    seriesId: '2025-R1-W1', teamA: 'COL', teamB: 'LAK',
    round: 1, conference: 'WEST', description: 'C1 (Pres Trophy) vs WC2',
    starters: { COL: { name: 'Blackwood', confirmed: false },
                LAK: { name: 'Kuemper', confirmed: false } },
  },
  {
    seriesId: '2025-R1-W2', teamA: 'DAL', teamB: 'MIN',
    round: 1, conference: 'WEST', description: 'C2 vs C3',
    starters: { DAL: { name: 'Oettinger', confirmed: false },
                MIN: { name: 'Gustavsson', confirmed: false } },
  },
  {
    seriesId: '2025-R1-W3', teamA: 'VGK', teamB: 'UTA',
    round: 1, conference: 'WEST', description: 'P1 (new coach Tortorella) vs WC1',
    starters: { VGK: { name: 'Hill', confirmed: false },
                UTA: { name: 'Vejmelka', confirmed: false } },
  },
  {
    seriesId: '2025-R1-W4', teamA: 'EDM', teamB: 'ANA',
    round: 1, conference: 'WEST', description: 'P2 vs P3 (first playoff since 2018)',
    starters: { EDM: { name: 'Skinner', confirmed: false },
                ANA: { name: 'Dostal', confirmed: false } },
  },
];

// Notable storylines this bracket
const STORYLINES = [
  'FLA eliminated — defending back-to-back Cup champs out, new champion guaranteed',
  'VGK hired John Tortorella March 30 replacing Cassidy — model should blend post-3/30 stats at ~30% vs season-long',
  'ANA first playoff berth since 2017-18 — lean on xG, not "playoff experience" priors',
  'LAK potentially Kopitar\'s final games — minor intangible bump',
  'COL Presidents\' Trophy at 52-16-11 — but historically Pres Trophy winners go ~55% in R1',
  'Pacific seeding still fluid Thursday — scenarios for VGK/EDM/ANA orderings',
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');

  console.log('═════════════════════════════════════════════════════════════');
  console.log('  Bootstrapping 2026 R1 series state files');
  console.log('═════════════════════════════════════════════════════════════\n');

  let created = 0, skipped = 0;

  for (const m of R1_BRACKET) {
    const existing = await loadState(m.seriesId);
    if (existing && !force) {
      console.log(`  ⏭  ${m.seriesId.padEnd(12)}  ${m.teamA} vs ${m.teamB}  — already exists (use --force to overwrite)`);
      skipped++;
      continue;
    }

    const state = createSeries({
      seriesId: m.seriesId,
      teamA: m.teamA,
      teamB: m.teamB,
      round: m.round,
      startDate: '2026-04-18',  // Playoffs start Saturday April 18
      currentStarters: m.starters,
      metadata: {
        conference: m.conference,
        description: m.description,
        bracketLockedAt: new Date().toISOString(),
      },
    });

    const tag = `[${m.description}]`;
    if (dryRun) {
      console.log(`  🔍 ${m.seriesId.padEnd(12)}  ${m.teamA} vs ${m.teamB}  ${tag}`);
    } else {
      await saveState(state);
      console.log(`  ✅ ${m.seriesId.padEnd(12)}  ${m.teamA} vs ${m.teamB}  ${tag}`);
      created++;
    }
  }

  console.log();
  if (dryRun) {
    console.log(`  [DRY RUN] Would create ${R1_BRACKET.length - skipped} series. ${skipped} already exist.`);
  } else {
    console.log(`  ✅ Created ${created} series. ${skipped} skipped.`);
  }

  console.log('\n─── Key storylines for this playoff run ────────────────');
  for (const s of STORYLINES) {
    console.log(`  • ${s}`);
  }

  console.log('\n─── Next steps ──────────────────────────────────────────');
  console.log('  1. Run `node scripts/simulate-regular-season.js` after April 16');
  console.log('     games settle to finalize seeding');
  console.log('  2. Run `node scripts/ingest-odds.js` to snapshot current prices');
  console.log('  3. Run `node scripts/ingest-draftkings.js` for series props');
  console.log('  4. Tortorella adjustment: edit VGK features in');
  console.log('     data/derived/features/ after they build');
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
