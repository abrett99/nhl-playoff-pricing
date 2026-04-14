// ============================================================================
// BRACKET PROGRESSION
// ============================================================================
// When R1 series complete, the bracket advances. This module handles:
//   - R1 winners → R2 matchups (re-seeding rules per NHL bracket)
//   - R2 winners → Conference Finals
//   - CF winners → Stanley Cup Final
//
// The NHL uses a FIXED BRACKET (not re-seeded after each round). The top
// seed DOES NOT automatically play the lowest-seeded remaining team; the
// matchups were locked when R1 was set.
//
// Bracket structure per conference:
//   R1 matchups:    A1-WC1,  A2-A3,  M1-WC2,  M2-M3
//   R2 matchups:    [A1/WC1 winner] vs [A2/A3 winner]
//                   [M1/WC2 winner] vs [M2/M3 winner]
//   CF:             [top R2 winner] vs [bottom R2 winner]
//   SCF:            [East CF winner] vs [West CF winner]
// ============================================================================

import { createSeries, loadState, saveState, listActiveSeries } from '../state/series.js';
import { isoTimestamp } from '../engine/util.js';

// ============================================================================
// Bracket topology: which R1 series feed which R2 series
// ============================================================================
// Key: child series ID. Value: { parent1: id, parent2: id, label }
export const BRACKET_2026 = {
  // EAST R2
  '2025-R2-E1': {
    parents: ['2025-R1-E1', '2025-R1-E2'],  // (A1/WC1) vs (A2/A3)
    conference: 'EAST',
    round: 2,
    label: 'Atlantic R2',
  },
  '2025-R2-E2': {
    parents: ['2025-R1-E3', '2025-R1-E4'],  // (M1/WC2) vs (M2/M3)
    conference: 'EAST',
    round: 2,
    label: 'Metro R2',
  },
  // WEST R2
  '2025-R2-W1': {
    parents: ['2025-R1-W1', '2025-R1-W2'],  // (C1/WC2) vs (C2/C3)
    conference: 'WEST',
    round: 2,
    label: 'Central R2',
  },
  '2025-R2-W2': {
    parents: ['2025-R1-W3', '2025-R1-W4'],  // (P1/WC1) vs (P2/P3)
    conference: 'WEST',
    round: 2,
    label: 'Pacific R2',
  },
  // Conference Finals
  '2025-R3-E1': {
    parents: ['2025-R2-E1', '2025-R2-E2'],
    conference: 'EAST',
    round: 3,
    label: 'Eastern Conference Final',
  },
  '2025-R3-W1': {
    parents: ['2025-R2-W1', '2025-R2-W2'],
    conference: 'WEST',
    round: 3,
    label: 'Western Conference Final',
  },
  // Stanley Cup Final
  '2025-R4-1': {
    parents: ['2025-R3-E1', '2025-R3-W1'],
    conference: null,
    round: 4,
    label: 'Stanley Cup Final',
  },
};

// ============================================================================
// Determine who has home ice in a next-round matchup
// ============================================================================
// NHL rule: whichever parent series had the higher regular-season points
// earner gets home ice. We track this via team "seed points" carried in
// state metadata. If missing, fall back to teamA (higher seed within parent).

function chooseHomeIceTeam(series1, series2) {
  const winner1 = series1.seriesWinner;
  const winner2 = series2.seriesWinner;

  // Points on each winner, fetched from series metadata if available
  const p1 = series1.metadata?.seedPoints?.[winner1] ?? null;
  const p2 = series2.metadata?.seedPoints?.[winner2] ?? null;

  if (p1 !== null && p2 !== null) {
    return p1 >= p2
      ? { teamA: winner1, teamB: winner2 }
      : { teamA: winner2, teamB: winner1 };
  }

  // Fallback: use division seed ordering — whichever winner was teamA in R1
  // (top seed) is favored over the WC team. If both were teamA's, use first.
  const w1WasTopSeed = winner1 === series1.teamA;
  const w2WasTopSeed = winner2 === series2.teamA;

  if (w1WasTopSeed && !w2WasTopSeed) return { teamA: winner1, teamB: winner2 };
  if (w2WasTopSeed && !w1WasTopSeed) return { teamA: winner2, teamB: winner1 };
  // Both top seeds or both WCs: default to first-listed parent
  return { teamA: winner1, teamB: winner2 };
}

// ============================================================================
// Check which downstream series are ready to be created
// ============================================================================

/**
 * Given a bracket topology and the set of complete series, return the list
 * of downstream series that can now be created.
 *
 * @param {Object} bracket - { [childId]: { parents, conference, round, label } }
 * @returns {Promise<Array>} newly creatable series descriptions
 */
export async function findReadyAdvancements(bracket = BRACKET_2026) {
  const allSeries = await listActiveSeries({ includeComplete: true });
  const byId = Object.fromEntries(allSeries.map(s => [s.seriesId, s]));
  const ready = [];

  for (const [childId, config] of Object.entries(bracket)) {
    // Skip if child already exists
    if (byId[childId]) continue;

    // Both parents must exist and be complete
    const p1 = byId[config.parents[0]];
    const p2 = byId[config.parents[1]];
    if (!p1 || !p2) continue;
    if (p1.status !== 'complete' || p2.status !== 'complete') continue;
    if (!p1.seriesWinner || !p2.seriesWinner) continue;

    const { teamA, teamB } = chooseHomeIceTeam(p1, p2);
    ready.push({
      childId,
      config,
      parents: { [config.parents[0]]: p1, [config.parents[1]]: p2 },
      proposedTeamA: teamA,
      proposedTeamB: teamB,
    });
  }

  return ready;
}

// ============================================================================
// Create next-round series from a ready advancement
// ============================================================================

/**
 * Build and save a new series state for the next round.
 *
 * @param {Object} advancement - result of findReadyAdvancements
 * @returns {Promise<Object>} the newly created series state
 */
export async function createNextRoundSeries(advancement) {
  const { childId, config, parents, proposedTeamA, proposedTeamB } = advancement;

  // Preserve the winning goalies from each parent as the R2 starters.
  // (Teams might switch later, but this is the correct starting point.)
  const currentStarters = {};
  for (const parent of Object.values(parents)) {
    const winner = parent.seriesWinner;
    const starter = parent.currentStarters?.[winner];
    if (starter) {
      currentStarters[winner] = { ...starter, since: 'G1' };
    }
  }

  const newState = createSeries({
    seriesId: childId,
    teamA: proposedTeamA,
    teamB: proposedTeamB,
    round: config.round,
    currentStarters,
    metadata: {
      conference: config.conference,
      label: config.label,
      parents: config.parents,
      advancedAt: isoTimestamp(),
      // Preserve any regular-season points context for future rounds
      seedPoints: {
        ...(parents[config.parents[0]]?.metadata?.seedPoints || {}),
        ...(parents[config.parents[1]]?.metadata?.seedPoints || {}),
      },
    },
  });

  await saveState(newState);
  return newState;
}

// ============================================================================
// Bracket state summary (for dashboard rendering)
// ============================================================================

/**
 * Build a complete bracket-summary object showing which series are done,
 * in progress, or pending. Useful for the UI bracket view.
 */
export async function summarizeBracket(bracket = BRACKET_2026) {
  const allSeries = await listActiveSeries({ includeComplete: true });
  const byId = Object.fromEntries(allSeries.map(s => [s.seriesId, s]));

  const byRound = { 1: [], 2: [], 3: [], 4: [] };
  for (const s of allSeries) {
    if (byRound[s.round]) byRound[s.round].push(s);
  }

  const pending = [];
  for (const [childId, config] of Object.entries(bracket)) {
    if (!byId[childId]) {
      const p1 = byId[config.parents[0]];
      const p2 = byId[config.parents[1]];
      const p1Done = p1?.status === 'complete';
      const p2Done = p2?.status === 'complete';
      pending.push({
        childId,
        config,
        parentsComplete: [p1Done, p2Done],
        readyToCreate: p1Done && p2Done,
      });
    }
  }

  return { byRound, pending };
}
