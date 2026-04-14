#!/usr/bin/env node
// ============================================================================
// ADVANCE BRACKET
// ============================================================================
// Checks for R1 (or later) series that have completed and auto-creates
// their next-round child series. Intended to run after the
// playoff-results cron so the bracket advances automatically.
//
// Usage:
//   node scripts/advance-bracket.js
//   node scripts/advance-bracket.js --dry-run
// ============================================================================

import {
  findReadyAdvancements,
  createNextRoundSeries,
  summarizeBracket,
} from '../src/state/bracket.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('[advance] Checking for ready bracket advancements...\n');

  const ready = await findReadyAdvancements();
  if (ready.length === 0) {
    console.log('[advance] No advancements ready.');
    const summary = await summarizeBracket();
    console.log(`\n  Current state:`);
    for (const [round, seriesList] of Object.entries(summary.byRound)) {
      if (seriesList.length > 0) {
        console.log(`    R${round}: ${seriesList.length} series`);
        for (const s of seriesList) {
          const state = s.status === 'complete'
            ? `✓ ${s.seriesWinner}`
            : `${s.winsA}-${s.winsB}`;
          console.log(`      ${s.teamA} vs ${s.teamB}: ${state}`);
        }
      }
    }
    const readyPending = summary.pending.filter(p => p.readyToCreate);
    const waitingParents = summary.pending.filter(p => !p.readyToCreate);
    if (readyPending.length > 0) {
      console.log(`\n  🎯 Ready to advance (will be created on next run): ${readyPending.length}`);
    }
    if (waitingParents.length > 0) {
      console.log(`  ⏳ Awaiting parents: ${waitingParents.length}`);
    }
    return;
  }

  for (const advancement of ready) {
    const { childId, config, proposedTeamA, proposedTeamB, parents } = advancement;
    const p1 = parents[config.parents[0]];
    const p2 = parents[config.parents[1]];

    console.log(`  ${config.label} (${config.conference || 'SCF'})`);
    console.log(`    ${p1.seriesWinner} (from ${config.parents[0]}) + ${p2.seriesWinner} (from ${config.parents[1]})`);
    console.log(`    → ${childId}: ${proposedTeamA} vs ${proposedTeamB} (${proposedTeamA} gets home ice)`);

    if (!dryRun) {
      await createNextRoundSeries(advancement);
      console.log(`    ✅ Created`);
    } else {
      console.log(`    [dry-run] Would create`);
    }
  }

  console.log(`\n[advance] ${dryRun ? 'Would advance' : 'Advanced'} ${ready.length} series`);
}

main().catch(e => { console.error(e); process.exit(1); });
