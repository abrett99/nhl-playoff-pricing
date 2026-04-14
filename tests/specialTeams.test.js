// ============================================================================
// SPECIAL TEAMS COMPOSITE TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePpPlus,
  computePkPlus,
  approximatePpPlus,
  approximatePkPlus,
  enrichWithSpecialTeamsComposite,
} from '../src/features/specialTeams.js';

// ============================================================================
// Full Berkeley formula
// ============================================================================

test('computePpPlus: league-average input produces ~100', () => {
  // Team playing at exactly league-average rates on 5v4
  const icetime = 3600; // 1 hour at 5v4
  const stats = {
    pp5v4_xgf: 6.45,  // league avg 6.45 per 60 * 1 hour = 6.45 xG
    pp5v4_gf: 6.45,   // same for actual
    pp5v4_icetime: icetime,
  };
  const { ppPlus } = computePpPlus(stats);
  assert.ok(Math.abs(ppPlus - 100) < 2, `Expected ~100, got ${ppPlus}`);
});

test('computePpPlus: strong PP produces >115 (1+ std dev above)', () => {
  // Team scoring 30% more than league avg
  const stats = {
    pp5v4_xgf: 6.45 * 1.30,
    pp5v4_gf: 6.45 * 1.30,
    pp5v4_icetime: 3600,
  };
  const { ppPlus } = computePpPlus(stats);
  assert.ok(ppPlus > 125, `Expected >125 for +30% team, got ${ppPlus}`);
});

test('computePpPlus: weak PP produces <85', () => {
  const stats = {
    pp5v4_xgf: 6.45 * 0.70,
    pp5v4_gf: 6.45 * 0.70,
    pp5v4_icetime: 3600,
  };
  const { ppPlus } = computePpPlus(stats);
  assert.ok(ppPlus < 80, `Expected <80 for -30% team, got ${ppPlus}`);
});

test('computePpPlus: 5v3 weighted separately with higher league avg', () => {
  // Team with only 5v3 icetime (very rare scenario)
  // League avg at 5v3 is 14.2 per 60. In 600s = 10 min, expected xG = 14.2 * (600/3600)
  const icetime = 600;
  const leagueAvgXgInWindow = 14.2 * (icetime / 3600);
  const stats = {
    pp5v4_icetime: 0,
    pp5v3_xgf: leagueAvgXgInWindow,
    pp5v3_gf: leagueAvgXgInWindow,
    pp5v3_icetime: icetime,
  };
  const { ppPlus } = computePpPlus(stats);
  assert.ok(Math.abs(ppPlus - 100) < 2, `Expected ~100, got ${ppPlus}`);
});

test('computePpPlus: returns 100 when no PP icetime', () => {
  const { ppPlus, breakdown } = computePpPlus({});
  assert.equal(ppPlus, 100);
  assert.ok(breakdown.note.includes('no PP icetime'));
});

test('computePpPlus: blends process and result per 60/40 weighting', () => {
  // xG ratio of 1.2, G ratio of 1.0 → composite = 0.60*1.2 + 0.40*1.0 = 1.12
  const stats = {
    pp5v4_xgf: 6.45 * 1.20,
    pp5v4_gf: 6.45 * 1.00,
    pp5v4_icetime: 3600,
  };
  const { ppPlus, breakdown } = computePpPlus(stats);
  // Expected: 100 * (0.6 * 1.2 + 0.4 * 1.0) = 100 * 1.12 = 112
  assert.ok(Math.abs(ppPlus - 112) < 2);
  assert.ok(Math.abs(breakdown.composite - 1.12) < 0.01);
});

// ============================================================================
// PK+ composite
// ============================================================================

test('computePkPlus: league-average input produces ~100', () => {
  const stats = {
    pk4v5_xga: 6.45,
    pk4v5_ga: 6.45,
    pk4v5_icetime: 3600,
  };
  const { pkPlus } = computePkPlus(stats);
  assert.ok(Math.abs(pkPlus - 100) < 3);
});

test('computePkPlus: elite PK (low xGA) produces >115', () => {
  // Team allows 30% less than league avg
  const stats = {
    pk4v5_xga: 6.45 * 0.70,
    pk4v5_ga: 6.45 * 0.70,
    pk4v5_icetime: 3600,
  };
  const { pkPlus } = computePkPlus(stats);
  assert.ok(pkPlus > 125, `Expected >125 for elite PK, got ${pkPlus}`);
});

test('computePkPlus: weak PK produces <85', () => {
  const stats = {
    pk4v5_xga: 6.45 * 1.30,
    pk4v5_ga: 6.45 * 1.30,
    pk4v5_icetime: 3600,
  };
  const { pkPlus } = computePkPlus(stats);
  assert.ok(pkPlus < 85, `Expected <85 for weak PK, got ${pkPlus}`);
});

// ============================================================================
// Legacy approximation
// ============================================================================

test('approximatePpPlus: league-avg percentage maps to 100', () => {
  assert.equal(approximatePpPlus(21.0), 100);
});

test('approximatePpPlus: +1 std dev above avg maps to ~115', () => {
  // +4.0% PP (1 std dev above) should give ~115
  assert.ok(Math.abs(approximatePpPlus(25.0) - 115) < 1);
});

test('approximatePpPlus: handles null input', () => {
  assert.equal(approximatePpPlus(null), 100);
  assert.equal(approximatePpPlus(undefined), 100);
});

test('approximatePkPlus: league-avg percentage maps to 100', () => {
  assert.equal(approximatePkPlus(79.0), 100);
});

test('approximatePkPlus: strong PK (higher %) maps above 100', () => {
  assert.ok(approximatePkPlus(85.0) > 115);
});

// ============================================================================
// Feature enrichment
// ============================================================================

test('enrichWithSpecialTeamsComposite: falls back to approximation when no detail', () => {
  const features = {
    BOS: { pp_pct: 25.0, pk_pct: 85.0 },
    TOR: { pp_pct: 19.0, pk_pct: 76.0 },
  };
  const enriched = enrichWithSpecialTeamsComposite(features);
  // BOS should have elite PP+ and PK+
  assert.ok(enriched.BOS.ppPlus > 110);
  assert.ok(enriched.BOS.pkPlus > 110);
  // TOR should have below-avg
  assert.ok(enriched.TOR.ppPlus < 100);
  assert.ok(enriched.TOR.pkPlus < 100);
  // Should be flagged as approximated
  assert.equal(enriched.BOS.ppPlusBreakdown.approximated, true);
});

test('enrichWithSpecialTeamsComposite: uses full formula when per-situation data present', () => {
  const features = {
    BOS: {
      pp5v4_xgf: 6.45 * 1.2, pp5v4_gf: 6.45 * 1.2, pp5v4_icetime: 3600,
      pk4v5_xga: 6.45 * 0.85, pk4v5_ga: 6.45 * 0.85, pk4v5_icetime: 3600,
    },
  };
  const enriched = enrichWithSpecialTeamsComposite(features);
  assert.ok(!enriched.BOS.ppPlusBreakdown.approximated);
  assert.ok(enriched.BOS.ppPlus > 115);
  assert.ok(enriched.BOS.pkPlus > 110);
});

test('enrichWithSpecialTeamsComposite: preserves original fields', () => {
  const features = {
    BOS: { xgf_per_60: 3.0, xga_per_60: 2.5, pp_pct: 21, pk_pct: 79 },
  };
  const enriched = enrichWithSpecialTeamsComposite(features);
  assert.equal(enriched.BOS.xgf_per_60, 3.0);
  assert.equal(enriched.BOS.xga_per_60, 2.5);
});
