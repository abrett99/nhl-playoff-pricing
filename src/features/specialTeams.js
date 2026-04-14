// ============================================================================
// BERKELEY-STYLE PP+ / PK+ COMPOSITE METRICS
// ============================================================================
// Traditional PP% / PK% hide critical context:
//   • Not all power play opportunities are created equal (20s of 5-on-4 vs
//     100s of 5-on-3 scoring rate is 3x different)
//   • Shorthanded goals allowed/scored are completely ignored
//   • Percentage variance is heavy on small samples
//
// The Berkeley Sports Analytics Group's PP+/PK+ composites:
//   • Weight each special-teams situation by its league-average xG rate
//   • Blend expected goals (process) with actual goals (results) 60/40
//   • Apply 0.5x penalty/bonus for shorthanded goals
//   • Center output at 100 with std dev ~15 (analogous to wRC+ in baseball)
//
// All formulas reference the Berkeley article:
//   sportsanalytics.studentorg.berkeley.edu/articles/redefining-nhl-special-teams.html
// ============================================================================

// League-average xG rates per 60 minutes in each situation (from 2024-25)
const LEAGUE_AVG_XG_RATES = {
  pp_5v4: 6.45,   // dominant scenario, ~95% of PP time
  pp_5v3: 14.2,   // rare but very high rate
  pp_4v3: 8.8,
  pk_4v5: 6.45,   // symmetric to 5v4 from opposite perspective
  pk_3v5: 14.2,
  pk_3v4: 8.8,
};

const WEIGHTS = {
  process: 0.60,      // xG share
  result: 0.40,       // actual goals
  shortyPenaltyBonus: 0.5,  // reduced weight for SH goals given small sample
};

// ============================================================================
// PP+ Builder
// ============================================================================

/**
 * Compute PP+ for a team given special-teams statistics.
 *
 * @param {Object} stats
 * @param {number} stats.pp5v4_xgf  - xG for at 5v4
 * @param {number} stats.pp5v4_gf   - actual goals for at 5v4
 * @param {number} stats.pp5v4_icetime - seconds at 5v4
 * @param {number} [stats.pp5v3_xgf]
 * @param {number} [stats.pp5v3_gf]
 * @param {number} [stats.pp5v3_icetime]
 * @param {number} [stats.pp_shGoalsAllowed] - shorthanded goals allowed on PP
 * @param {Object} [leagueAvgs] - override defaults (for backtesting old seasons)
 * @returns {{ ppPlus: number, breakdown: Object }}
 */
export function computePpPlus(stats, leagueAvgs = LEAGUE_AVG_XG_RATES) {
  const situations = [];

  // 5v4 (primary)
  if (stats.pp5v4_icetime > 0) {
    const xgPer60 = (stats.pp5v4_xgf / stats.pp5v4_icetime) * 3600;
    const gPer60 = (stats.pp5v4_gf / stats.pp5v4_icetime) * 3600;
    situations.push({
      situation: '5v4',
      weight: stats.pp5v4_icetime,
      leagueAvg: leagueAvgs.pp_5v4,
      xgPer60,
      gPer60,
      xgRatio: xgPer60 / leagueAvgs.pp_5v4,
      gRatio: gPer60 / leagueAvgs.pp_5v4,
    });
  }

  // 5v3 (rare but impactful)
  if (stats.pp5v3_icetime > 0) {
    const xgPer60 = (stats.pp5v3_xgf / stats.pp5v3_icetime) * 3600;
    const gPer60 = (stats.pp5v3_gf / stats.pp5v3_icetime) * 3600;
    situations.push({
      situation: '5v3',
      weight: stats.pp5v3_icetime,
      leagueAvg: leagueAvgs.pp_5v3,
      xgPer60,
      gPer60,
      xgRatio: xgPer60 / leagueAvgs.pp_5v3,
      gRatio: gPer60 / leagueAvgs.pp_5v3,
    });
  }

  if (situations.length === 0) {
    return { ppPlus: 100, breakdown: { note: 'no PP icetime' } };
  }

  // Time-weighted average of ratios
  const totalWeight = situations.reduce((s, x) => s + x.weight, 0);
  let weightedXg = 0, weightedG = 0;
  for (const s of situations) {
    weightedXg += s.xgRatio * s.weight;
    weightedG += s.gRatio * s.weight;
  }
  const avgXgRatio = weightedXg / totalWeight;
  const avgGRatio = weightedG / totalWeight;

  // Blend process (xG) and result (actual G)
  let composite = WEIGHTS.process * avgXgRatio + WEIGHTS.result * avgGRatio;

  // Subtract SH-goal penalty
  if (stats.pp_shGoalsAllowed && totalWeight > 0) {
    const shPer60 = (stats.pp_shGoalsAllowed / totalWeight) * 3600;
    // A league-average PP allows ~0.4 SH/60. Penalize excess.
    const shPenalty = (shPer60 - 0.4) / 10; // normalize to similar scale
    composite -= shPenalty * WEIGHTS.shortyPenaltyBonus;
  }

  // Rescale to 100-centered (analogous to wRC+: 100 = league avg, each
  // +15 = 1 standard deviation). Since our ratio is already league-relative,
  // a ratio of 1.0 becomes 100 and each 15% above = +15.
  const ppPlus = 100 * composite;

  return {
    ppPlus,
    breakdown: {
      avgXgRatio,
      avgGRatio,
      situations,
      composite,
    },
  };
}

// ============================================================================
// PK+ Builder
// ============================================================================

/**
 * Compute PK+ for a team. PK+ is 100 - (opponent's effective PP%-ish).
 * Higher PK+ = better defensive PK. Symmetric to PP+ from the defender's
 * perspective.
 */
export function computePkPlus(stats, leagueAvgs = LEAGUE_AVG_XG_RATES) {
  const situations = [];

  if (stats.pk4v5_icetime > 0) {
    const xgAgainstPer60 = (stats.pk4v5_xga / stats.pk4v5_icetime) * 3600;
    const gAgainstPer60 = (stats.pk4v5_ga / stats.pk4v5_icetime) * 3600;
    // For PK, LOWER xG against = BETTER, so invert the ratio
    situations.push({
      situation: '4v5',
      weight: stats.pk4v5_icetime,
      leagueAvg: leagueAvgs.pk_4v5,
      xgAgainstPer60,
      gAgainstPer60,
      xgRatio: leagueAvgs.pk_4v5 / Math.max(xgAgainstPer60, 0.1),
      gRatio: leagueAvgs.pk_4v5 / Math.max(gAgainstPer60, 0.1),
    });
  }

  if (stats.pk3v5_icetime > 0) {
    const xgAgainstPer60 = (stats.pk3v5_xga / stats.pk3v5_icetime) * 3600;
    const gAgainstPer60 = (stats.pk3v5_ga / stats.pk3v5_icetime) * 3600;
    situations.push({
      situation: '3v5',
      weight: stats.pk3v5_icetime,
      leagueAvg: leagueAvgs.pk_3v5,
      xgAgainstPer60,
      gAgainstPer60,
      xgRatio: leagueAvgs.pk_3v5 / Math.max(xgAgainstPer60, 0.1),
      gRatio: leagueAvgs.pk_3v5 / Math.max(gAgainstPer60, 0.1),
    });
  }

  if (situations.length === 0) {
    return { pkPlus: 100, breakdown: { note: 'no PK icetime' } };
  }

  const totalWeight = situations.reduce((s, x) => s + x.weight, 0);
  let weightedXg = 0, weightedG = 0;
  for (const s of situations) {
    weightedXg += s.xgRatio * s.weight;
    weightedG += s.gRatio * s.weight;
  }
  const avgXgRatio = weightedXg / totalWeight;
  const avgGRatio = weightedG / totalWeight;

  let composite = WEIGHTS.process * avgXgRatio + WEIGHTS.result * avgGRatio;

  // Add SH-goal BONUS (PK that scores shorthanded is elite)
  if (stats.pk_shGoalsFor && totalWeight > 0) {
    const shPer60 = (stats.pk_shGoalsFor / totalWeight) * 3600;
    const shBonus = (shPer60 - 0.4) / 10;
    composite += shBonus * WEIGHTS.shortyPenaltyBonus;
  }

  const pkPlus = 100 * composite;

  return {
    pkPlus,
    breakdown: {
      avgXgRatio,
      avgGRatio,
      situations,
      composite,
    },
  };
}

// ============================================================================
// Fallback: approximate PP+/PK+ from legacy PP% / PK% percentages
// ============================================================================
// Most historical NST/MoneyPuck data only has legacy percentages, not the
// per-situation breakdowns we need for the true Berkeley formula. This
// approximation centers PP%/PK% at 100 scaled by league std dev (~15).

export function approximatePpPlus(ppPct, leagueAvgPpPct = 21.0, stdDev = 4.0) {
  if (ppPct === null || ppPct === undefined) return 100;
  return 100 + ((ppPct - leagueAvgPpPct) / stdDev) * 15;
}

export function approximatePkPlus(pkPct, leagueAvgPkPct = 79.0, stdDev = 3.5) {
  if (pkPct === null || pkPct === undefined) return 100;
  return 100 + ((pkPct - leagueAvgPkPct) / stdDev) * 15;
}

// ============================================================================
// Feature enrichment helper
// ============================================================================

/**
 * Enrich a team features object with PP+ and PK+ scores. Uses the full
 * Berkeley formula when per-situation data is present, falls back to
 * approximation when only legacy pp_pct / pk_pct are available.
 */
export function enrichWithSpecialTeamsComposite(teamFeatures) {
  const enriched = {};
  for (const [team, row] of Object.entries(teamFeatures)) {
    const ppHasDetail = row.pp5v4_icetime > 0 || row.pp5v3_icetime > 0;
    const pkHasDetail = row.pk4v5_icetime > 0 || row.pk3v5_icetime > 0;

    const ppResult = ppHasDetail
      ? computePpPlus(row)
      : { ppPlus: approximatePpPlus(row.pp_pct), breakdown: { approximated: true } };

    const pkResult = pkHasDetail
      ? computePkPlus(row)
      : { pkPlus: approximatePkPlus(row.pk_pct), breakdown: { approximated: true } };

    enriched[team] = {
      ...row,
      ppPlus: ppResult.ppPlus,
      pkPlus: pkResult.pkPlus,
      ppPlusBreakdown: ppResult.breakdown,
      pkPlusBreakdown: pkResult.breakdown,
    };
  }
  return enriched;
}
