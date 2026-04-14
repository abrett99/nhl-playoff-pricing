// ============================================================================
// ID HELPERS & DATE UTILITIES
// ============================================================================

import { GAME_TYPE } from '../config.js';

/**
 * Parse an NHL API game ID into its components.
 * Format: YYYYTTNNNN
 *   YYYY = season start year (2025 = 2025-26)
 *   TT   = game type (02 = regular, 03 = playoff)
 *   NNNN = specific game number. For playoffs:
 *          N[0]  = unused
 *          N[1]  = round (1-4)
 *          N[2]  = matchup within round (1-8 for R1, 1-4 for R2, etc.)
 *          N[3]  = game number in series (1-7)
 */
export function parseGameId(gameId) {
  const s = String(gameId);
  if (!/^\d{10}$/.test(s)) {
    throw new Error(`Invalid game ID format: ${gameId} (expected 10 digits)`);
  }
  const seasonStartYear = parseInt(s.slice(0, 4), 10);
  const gameType = parseInt(s.slice(4, 6), 10);
  const specific = s.slice(6);

  const result = {
    raw: s,
    seasonStartYear,
    gameType,
    isRegularSeason: gameType === GAME_TYPE.REGULAR,
    isPlayoff: gameType === GAME_TYPE.PLAYOFF,
    specific,
  };

  if (gameType === GAME_TYPE.PLAYOFF) {
    result.round = parseInt(specific[1], 10);
    result.matchup = parseInt(specific[2], 10);
    result.gameInSeries = parseInt(specific[3], 10);
  }

  return result;
}

export function isPlayoffGame(gameId) {
  try {
    return parseGameId(gameId).isPlayoff;
  } catch {
    return false;
  }
}

/**
 * Build a series ID from season + round + matchup.
 * Round 1 matchup 1 in season 20252026 = "2025-R1-M1"
 */
export function seriesIdFromGameId(gameId) {
  const parsed = parseGameId(gameId);
  if (!parsed.isPlayoff) throw new Error(`Not a playoff game: ${gameId}`);
  return `${parsed.seasonStartYear}-R${parsed.round}-M${parsed.matchup}`;
}

// ============================================================================
// DATE HELPERS
// ============================================================================

/** ISO date string (YYYY-MM-DD) for a Date object, UTC */
export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** ISO timestamp string for filenames (2026-04-14T11-30-00Z format, safe on all FS) */
export function filenameTimestamp(date = new Date()) {
  return date.toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
}

/** Full ISO timestamp */
export function isoTimestamp(date = new Date()) {
  return date.toISOString();
}

/** Days between two date-ish values */
export function daysBetween(a, b) {
  const d1 = a instanceof Date ? a : new Date(a);
  const d2 = b instanceof Date ? b : new Date(b);
  return Math.abs(d2 - d1) / (1000 * 60 * 60 * 24);
}

/** Hours between two date-ish values */
export function hoursBetween(a, b) {
  return daysBetween(a, b) * 24;
}

/** Is `target` strictly before `reference`? (for point-in-time filters) */
export function isBefore(target, reference) {
  const t = target instanceof Date ? target : new Date(target);
  const r = reference instanceof Date ? reference : new Date(reference);
  return t.getTime() < r.getTime();
}

// ============================================================================
// DETERMINISTIC SEEDING (reproducible MC runs)
// ============================================================================

/**
 * Simple seeded RNG (mulberry32). Good enough for Monte Carlo, fast, and
 * deterministic across runs — critical for reproducible backtests.
 */
export function seededRng(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// SMALL MATH HELPERS
// ============================================================================

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const mean = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Poisson PMF: P(k events | rate λ) */
export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

/** Sample from Poisson(λ) using Knuth's algorithm — fine for small λ */
export function samplePoisson(lambda, rng = Math.random) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}
