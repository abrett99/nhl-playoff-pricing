// ============================================================================
// COACHING CHANGE BLEND TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blendCoachingChange,
  applyCoachingChangeAdjustments,
  isPostCoachingChange,
  POST_CHANGE_WEIGHT_CAP,
} from '../src/features/coachingChange.js';

test('blendCoachingChange: no post-change data → returns season-long unchanged', () => {
  const season = { xgf_per_60: 3.0, xga_per_60: 2.8 };
  const result = blendCoachingChange(season, null, 0);
  assert.equal(result.xgf_per_60, 3.0);
  assert.equal(result._coachingChangeApplied, false);
});

test('blendCoachingChange: tiny sample (<4 games) → no blend applied', () => {
  const season = { xgf_per_60: 3.0 };
  const post = { xgf_per_60: 4.5 };
  const result = blendCoachingChange(season, post, 3);
  assert.equal(result.xgf_per_60, 3.0);
  assert.equal(result._coachingChangeApplied, false);
});

test('blendCoachingChange: 6-game sample → ~8.5% post-change weight', () => {
  const season = { xgf_per_60: 3.0 };
  const post = { xgf_per_60: 4.0 };
  const result = blendCoachingChange(season, post, 6);
  // Weight: 6/70 = 0.0857. Expected: 0.9143*3.0 + 0.0857*4.0 = 3.086
  assert.ok(Math.abs(result.xgf_per_60 - 3.086) < 0.01);
  assert.equal(result._coachingChangeApplied, true);
});

test('blendCoachingChange: large sample capped at 30%', () => {
  const season = { xgf_per_60: 3.0 };
  const post = { xgf_per_60: 4.0 };
  const result = blendCoachingChange(season, post, 100);
  // Weight cap: 0.30. Expected: 0.7*3.0 + 0.3*4.0 = 3.30
  assert.ok(Math.abs(result.xgf_per_60 - 3.30) < 0.01);
  assert.equal(result._blendWeights.postChange, POST_CHANGE_WEIGHT_CAP);
});

test('blendCoachingChange: preserves non-numeric fields', () => {
  const season = { xgf_per_60: 3.0, team: 'VGK', goalie: 'Hill' };
  const post = { xgf_per_60: 4.0, team: 'VGK', goalie: 'Hill' };
  const result = blendCoachingChange(season, post, 10);
  assert.equal(result.team, 'VGK');
  assert.equal(result.goalie, 'Hill');
});

test('applyCoachingChangeAdjustments: only affects VGK', () => {
  const features = {
    VGK: { xgf_per_60: 3.0 },
    EDM: { xgf_per_60: 3.5 },
  };
  const changes = {
    VGK: { postChange: { xgf_per_60: 4.0 }, postGames: 10 },
  };
  const adjusted = applyCoachingChangeAdjustments(features, changes);
  assert.ok(adjusted.VGK.xgf_per_60 !== features.VGK.xgf_per_60);
  assert.equal(adjusted.EDM.xgf_per_60, 3.5);  // unchanged
});

test('applyCoachingChangeAdjustments: preserves original features map when no data', () => {
  const features = { VGK: { xgf_per_60: 3.0 }, EDM: { xgf_per_60: 3.5 } };
  const adjusted = applyCoachingChangeAdjustments(features, {});
  assert.equal(adjusted.VGK.xgf_per_60, 3.0);
  assert.equal(adjusted.EDM.xgf_per_60, 3.5);
});

test('isPostCoachingChange: true for dates on or after March 30 2026', () => {
  assert.equal(isPostCoachingChange('2026-03-30'), true);
  assert.equal(isPostCoachingChange('2026-04-15'), true);
  assert.equal(isPostCoachingChange('2026-03-29'), false);
  assert.equal(isPostCoachingChange('2026-01-01'), false);
});

test('isPostCoachingChange: only applies to VGK', () => {
  assert.equal(isPostCoachingChange('2026-04-15', 'EDM'), false);
  assert.equal(isPostCoachingChange('2026-04-15', 'VGK'), true);
});
