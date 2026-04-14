// ============================================================================
// VGK TORTORELLA COACHING-CHANGE ADJUSTMENT
// ============================================================================
// Vegas fired Cassidy on March 30, 2026 and hired John Tortorella. The team
// went 5-0-1 in the 6 games since, climbing to the top of the Pacific.
//
// Problem: that 6-game sample is tiny and likely overstates true strength.
// At the same time, the coaching change is real — the team is playing
// differently (tighter defensive structure is Tortorella's trademark).
//
// Solution: weighted blend of pre-3/30 and post-3/30 stats, with weight
// on the post-change sample capped at ~30%. Regress toward the season-long
// mean aggressively given the sample size.
//
// Apply ONLY to VGK features. All other teams use their raw season stats.
// ============================================================================

import { SEASON } from '../config.js';

const COACHING_CHANGE_DATE = '2026-03-30';
const TEAM_AFFECTED = 'VGK';

// Weight given to the post-coaching-change sample. Tuned for 6-10 game
// samples — higher weight for larger sample sizes up to this cap.
const POST_CHANGE_WEIGHT_CAP = 0.30;
const MIN_GAMES_FOR_POST_SPLIT = 4;

// ============================================================================
// Core blend
// ============================================================================

/**
 * Blend pre-change and post-change stat rows for a single team.
 *
 * @param {Object} seasonLong  - stats from full season (pre+post combined)
 * @param {Object} postChange  - stats from coaching change onward
 * @param {number} postGames   - number of games in post-change sample
 * @returns {Object} blended feature row
 */
export function blendCoachingChange(seasonLong, postChange, postGames) {
  if (!postChange || postGames < MIN_GAMES_FOR_POST_SPLIT) {
    return { ...seasonLong, _coachingChangeApplied: false };
  }

  // Scale weight by sample size: 4 games → 0.10, 10 games → 0.20, 20+ → 0.30
  const rawWeight = Math.min(postGames / 70, POST_CHANGE_WEIGHT_CAP);
  const postWeight = Math.min(rawWeight, POST_CHANGE_WEIGHT_CAP);
  const preWeight = 1 - postWeight;

  const blended = {};
  for (const key of Object.keys(seasonLong)) {
    const s = seasonLong[key];
    const p = postChange[key];
    if (typeof s === 'number' && typeof p === 'number') {
      blended[key] = preWeight * s + postWeight * p;
    } else {
      blended[key] = s;
    }
  }

  blended._coachingChangeApplied = true;
  blended._blendWeights = { preChange: preWeight, postChange: postWeight };
  blended._postChangeSampleSize = postGames;
  return blended;
}

// ============================================================================
// Apply to full team features map
// ============================================================================

/**
 * Apply the coaching-change blend to a teamFeatures map. Only VGK is
 * modified (if postChange data is provided).
 */
export function applyCoachingChangeAdjustments(teamFeatures, coachingChangeData = {}) {
  const adjusted = { ...teamFeatures };

  // VGK — Tortorella
  if (teamFeatures[TEAM_AFFECTED] && coachingChangeData[TEAM_AFFECTED]) {
    adjusted[TEAM_AFFECTED] = blendCoachingChange(
      teamFeatures[TEAM_AFFECTED],
      coachingChangeData[TEAM_AFFECTED].postChange,
      coachingChangeData[TEAM_AFFECTED].postGames,
    );
  }

  return adjusted;
}

// ============================================================================
// Utility: check if a date is post-coaching-change
// ============================================================================

export function isPostCoachingChange(date, team = TEAM_AFFECTED) {
  if (team !== TEAM_AFFECTED) return false;
  return new Date(date) >= new Date(COACHING_CHANGE_DATE);
}

export { COACHING_CHANGE_DATE, TEAM_AFFECTED, POST_CHANGE_WEIGHT_CAP };
