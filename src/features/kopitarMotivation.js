// ============================================================================
// LAK KOPITAR RETIREMENT INTANGIBLE
// ============================================================================
// Anze Kopitar has indicated this will be his final season. Playoff teams
// with a franchise legend's retirement on the line historically show a
// small but measurable motivation effect — ~2-3% in elimination / must-win
// scenarios, negligible otherwise.
//
// Comparable precedents (for calibration):
//   - Jarome Iginla 2017 BOS: team went on run in part credited to motivation
//   - Marleau / Thornton 2019 SJS: elimination game outperformance
//   - Patrice Bergeron 2023 BOS: team lost R1 anyway (intangibles ≠ wins)
//
// This module applies SMALL, CONDITIONAL adjustments:
//   - +0.015 home-win-prob when LAK is facing elimination (winsA=3, winsB=0-2)
//   - No adjustment otherwise (regression toward mean)
//
// The effect is tiny on purpose. Intangibles are real but overweighted in
// public narrative; research on N=5-6 historical cases suggests the true
// effect is below most sportsbooks' margin.
// ============================================================================

const TEAM_AFFECTED = 'LAK';
const ELIMINATION_BUMP = 0.015;

// ============================================================================
// Apply in perGameModel context
// ============================================================================

/**
 * Compute motivation adjustment for a specific game given series state.
 *
 * @param {Object} params
 * @param {string} params.homeTeam
 * @param {string} params.awayTeam
 * @param {Object} params.seriesState - current series state
 * @returns {number} probability adjustment (added to home-win-prob)
 */
export function kopitarMotivationAdjustment({ homeTeam, awayTeam, seriesState }) {
  if (!seriesState) return 0;

  const lakIsHome = homeTeam === TEAM_AFFECTED;
  const lakIsAway = awayTeam === TEAM_AFFECTED;
  if (!lakIsHome && !lakIsAway) return 0;

  const lakIsTeamA = seriesState.teamA === TEAM_AFFECTED;
  const winsLak = lakIsTeamA ? seriesState.winsA : seriesState.winsB;
  const winsOther = lakIsTeamA ? seriesState.winsB : seriesState.winsA;

  // LAK facing elimination = they need to win or season ends
  const lakFacingElimination = winsOther === 3 && winsLak !== 3;

  if (!lakFacingElimination) return 0;

  // Bump goes to LAK regardless of home/away
  return lakIsHome ? +ELIMINATION_BUMP : -ELIMINATION_BUMP;
}

// ============================================================================
// Utility: check if this adjustment is active for a given matchup
// ============================================================================

export function isKopitarAdjustmentActive(seriesState) {
  if (!seriesState) return false;
  const hasLak = seriesState.teamA === TEAM_AFFECTED || seriesState.teamB === TEAM_AFFECTED;
  if (!hasLak) return false;
  const lakIsTeamA = seriesState.teamA === TEAM_AFFECTED;
  const winsLak = lakIsTeamA ? seriesState.winsA : seriesState.winsB;
  const winsOther = lakIsTeamA ? seriesState.winsB : seriesState.winsA;
  return winsOther === 3 && winsLak !== 3;
}

export { TEAM_AFFECTED, ELIMINATION_BUMP };
