// ============================================================================
// 4-LAYER SANITY CHECK FRAMEWORK
// ============================================================================
// Every data pull runs through these four layers before it touches the store:
//   Layer 1: FETCH    — response level (HTTP, size, content-type)
//   Layer 2: PARSE    — schema shape matches expectations
//   Layer 3: SEMANTIC — values are in valid ranges, cross-field consistent
//   Layer 4: DRIFT    — compared to previous pulls, changes are reasonable
//
// Failure at ANY layer blocks the commit to `data/raw/` and fires an alert.
// Old data is ALWAYS preferable to corrupt data — bad data must never reach
// the model.
// ============================================================================

import { SEMANTIC_RANGES, NHL_TEAMS } from '../config.js';

// ============================================================================
// Check result types
// ============================================================================

export class CheckResult {
  constructor(passed, layer, checkName, message = '', details = {}) {
    this.passed = passed;
    this.layer = layer;
    this.checkName = checkName;
    this.message = message;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  static ok(layer, checkName, details = {}) {
    return new CheckResult(true, layer, checkName, '', details);
  }

  static fail(layer, checkName, message, details = {}) {
    return new CheckResult(false, layer, checkName, message, details);
  }
}

export class CheckReport {
  constructor(source) {
    this.source = source;
    this.checks = [];
    this.startedAt = new Date().toISOString();
  }

  add(result) {
    this.checks.push(result);
    return result;
  }

  passed() {
    return this.checks.every(c => c.passed);
  }

  passedLayers() {
    const layers = new Set();
    for (const c of this.checks) {
      if (c.passed) layers.add(c.layer);
    }
    return [...layers];
  }

  firstFailure() {
    return this.checks.find(c => !c.passed) || null;
  }

  allFailures() {
    return this.checks.filter(c => !c.passed);
  }

  summary() {
    const failures = this.allFailures();
    return {
      source: this.source,
      passed: this.passed(),
      passedLayers: this.passedLayers(),
      checkCount: this.checks.length,
      failureCount: failures.length,
      firstFailure: failures[0] || null,
      timestamp: this.startedAt,
    };
  }
}

// ============================================================================
// LAYER 1: FETCH CHECKS
// ============================================================================

/**
 * @param {Response|object} response - fetch Response or { status, size, contentType, body }
 * @param {object} expectations - { minSize, expectedContentType, maxResponseMs }
 */
export function checkFetch(response, expectations = {}) {
  const results = [];

  const status = response.status;
  const contentType = response.headers?.get?.('content-type') || response.contentType || '';
  const size = response.size ?? (response.body?.length ?? 0);

  // HTTP status
  if (status >= 200 && status < 300) {
    results.push(CheckResult.ok(1, 'http_status', { status }));
  } else {
    results.push(CheckResult.fail(1, 'http_status', `HTTP ${status}`, { status }));
  }

  // Response size
  if (expectations.minSize !== undefined) {
    if (size >= expectations.minSize) {
      results.push(CheckResult.ok(1, 'response_size', { size, min: expectations.minSize }));
    } else {
      results.push(CheckResult.fail(1, 'response_size',
        `Response size ${size} below minimum ${expectations.minSize} — likely CAPTCHA page or empty response`,
        { size, min: expectations.minSize }));
    }
  }

  // Content type
  if (expectations.expectedContentType) {
    const expected = Array.isArray(expectations.expectedContentType)
      ? expectations.expectedContentType
      : [expectations.expectedContentType];
    const matches = expected.some(e => contentType.includes(e));
    if (matches) {
      results.push(CheckResult.ok(1, 'content_type', { contentType }));
    } else {
      results.push(CheckResult.fail(1, 'content_type',
        `Content-type ${contentType} doesn't match expected ${expected.join(', ')}`,
        { contentType, expected }));
    }
  }

  // Anti-bot markers in HTML bodies (NST, LWL)
  if (typeof response.body === 'string') {
    const body = response.body.slice(0, 2000).toLowerCase();
    const botMarkers = ['cloudflare', 'enable javascript', 'captcha', 'access denied'];
    const found = botMarkers.find(m => body.includes(m));
    if (found) {
      results.push(CheckResult.fail(1, 'anti_bot',
        `Response looks like bot-challenge page (${found})`, { marker: found }));
    } else {
      results.push(CheckResult.ok(1, 'anti_bot', {}));
    }
  }

  return results;
}

// ============================================================================
// LAYER 2: PARSE CHECKS
// ============================================================================

/** Check that a parsed dataset has the expected row count and columns */
export function checkParse(data, expectations = {}) {
  const results = [];

  // Array vs object
  if (expectations.type === 'array') {
    if (!Array.isArray(data)) {
      results.push(CheckResult.fail(2, 'is_array', 'Expected array, got non-array'));
      return results;
    }
    results.push(CheckResult.ok(2, 'is_array', { length: data.length }));

    // Row count range
    if (expectations.minRows !== undefined && data.length < expectations.minRows) {
      results.push(CheckResult.fail(2, 'row_count_min',
        `${data.length} rows below minimum ${expectations.minRows}`,
        { got: data.length, min: expectations.minRows }));
    } else if (expectations.minRows !== undefined) {
      results.push(CheckResult.ok(2, 'row_count_min', { got: data.length }));
    }

    if (expectations.maxRows !== undefined && data.length > expectations.maxRows) {
      results.push(CheckResult.fail(2, 'row_count_max',
        `${data.length} rows above maximum ${expectations.maxRows}`,
        { got: data.length, max: expectations.maxRows }));
    } else if (expectations.maxRows !== undefined) {
      results.push(CheckResult.ok(2, 'row_count_max', { got: data.length }));
    }

    // Exact row count (e.g. 32 teams)
    if (expectations.exactRows !== undefined) {
      if (data.length === expectations.exactRows) {
        results.push(CheckResult.ok(2, 'row_count_exact', { got: data.length }));
      } else {
        results.push(CheckResult.fail(2, 'row_count_exact',
          `Expected exactly ${expectations.exactRows} rows, got ${data.length}`,
          { got: data.length, expected: expectations.exactRows }));
      }
    }

    // Required columns on each row
    if (expectations.requiredColumns?.length) {
      const sample = data[0] || {};
      const missing = expectations.requiredColumns.filter(col => !(col in sample));
      if (missing.length === 0) {
        results.push(CheckResult.ok(2, 'required_columns', { checked: expectations.requiredColumns }));
      } else {
        results.push(CheckResult.fail(2, 'required_columns',
          `Missing required columns: ${missing.join(', ')}`,
          { missing, checked: expectations.requiredColumns }));
      }
    }
  }

  // Object with required keys
  if (expectations.type === 'object') {
    if (typeof data !== 'object' || Array.isArray(data) || data === null) {
      results.push(CheckResult.fail(2, 'is_object', 'Expected object, got non-object'));
      return results;
    }
    results.push(CheckResult.ok(2, 'is_object', {}));

    if (expectations.requiredKeys?.length) {
      const missing = expectations.requiredKeys.filter(k => !(k in data));
      if (missing.length === 0) {
        results.push(CheckResult.ok(2, 'required_keys', { checked: expectations.requiredKeys }));
      } else {
        results.push(CheckResult.fail(2, 'required_keys',
          `Missing required keys: ${missing.join(', ')}`, { missing }));
      }
    }
  }

  return results;
}

// ============================================================================
// LAYER 3: SEMANTIC CHECKS
// ============================================================================

/**
 * Check that numeric fields are within SEMANTIC_RANGES.
 * rows: array of objects
 * fieldMap: { rangeName: fieldName, ... }
 *   e.g. { team_xgf_per_60: 'xGF/60', goalie_save_pct: 'SV%' }
 */
export function checkSemanticRanges(rows, fieldMap, identifier = 'row') {
  const results = [];
  const violations = [];

  for (const row of rows) {
    for (const [rangeName, fieldName] of Object.entries(fieldMap)) {
      const range = SEMANTIC_RANGES[rangeName];
      if (!range) continue;
      const value = row[fieldName];
      if (value === undefined || value === null) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) {
        violations.push({
          identifier: row[identifier] ?? '<no-id>',
          field: fieldName,
          value,
          reason: 'not_finite',
        });
        continue;
      }
      const [lo, hi] = range;
      if (num < lo || num > hi) {
        violations.push({
          identifier: row[identifier] ?? '<no-id>',
          field: fieldName,
          value: num,
          range,
          reason: 'out_of_range',
        });
      }
    }
  }

  if (violations.length === 0) {
    results.push(CheckResult.ok(3, 'semantic_ranges',
      { rowsChecked: rows.length, fieldsChecked: Object.keys(fieldMap) }));
  } else {
    results.push(CheckResult.fail(3, 'semantic_ranges',
      `${violations.length} semantic range violations`,
      { violations: violations.slice(0, 10), totalViolations: violations.length }));
  }

  return results;
}

/** Check that all team abbreviations are from the known NHL set */
export function checkKnownTeams(rows, teamField) {
  const known = new Set(NHL_TEAMS);
  const unknown = rows
    .map(r => r[teamField])
    .filter(t => t && !known.has(String(t).toUpperCase()));

  if (unknown.length === 0) {
    return [CheckResult.ok(3, 'known_teams', { rowsChecked: rows.length })];
  }
  return [CheckResult.fail(3, 'known_teams',
    `${unknown.length} unknown team abbrevs: ${[...new Set(unknown)].slice(0, 5).join(', ')}`,
    { unknown: [...new Set(unknown)] })];
}

/** Vig check for two-way odds — 1-8% is reasonable, outside that is suspicious */
export function checkVig(americanA, americanB, { minVig = 0.01, maxVig = 0.15 } = {}) {
  try {
    const { americanToProb } = { americanToProb: (o) => o < 0 ? -o / ((-o) + 100) : 100 / (o + 100) };
    const pA = americanToProb(americanA);
    const pB = americanToProb(americanB);
    const vig = pA + pB - 1;
    if (vig < minVig || vig > maxVig) {
      return [CheckResult.fail(3, 'vig_range',
        `Vig ${(vig * 100).toFixed(2)}% outside [${minVig * 100}%, ${maxVig * 100}%]`,
        { americanA, americanB, vig })];
    }
    return [CheckResult.ok(3, 'vig_range', { vig })];
  } catch (e) {
    return [CheckResult.fail(3, 'vig_range', `Could not compute vig: ${e.message}`)];
  }
}

// ============================================================================
// LAYER 4: DRIFT CHECKS
// ============================================================================

/**
 * Compare current pull to previous snapshot.
 * Catches: stale data, unexpected jumps in values, missing rows that were there yesterday.
 */
export function checkDrift(current, previous, opts = {}) {
  const results = [];

  if (!previous) {
    results.push(CheckResult.ok(4, 'drift_no_baseline',
      { message: 'No previous snapshot — drift check skipped' }));
    return results;
  }

  // Freshness: current timestamp must be newer
  if (current.timestamp && previous.timestamp) {
    const curT = new Date(current.timestamp);
    const prevT = new Date(previous.timestamp);
    if (curT <= prevT) {
      results.push(CheckResult.fail(4, 'drift_freshness',
        `Current timestamp ${current.timestamp} not newer than previous ${previous.timestamp}`,
        { current: current.timestamp, previous: previous.timestamp }));
    } else {
      const hoursDelta = (curT - prevT) / (1000 * 60 * 60);
      results.push(CheckResult.ok(4, 'drift_freshness', { hoursDelta }));
    }
  }

  // Row count didn't dramatically shrink
  if (opts.compareRowCounts && Array.isArray(current.rows) && Array.isArray(previous.rows)) {
    const curN = current.rows.length;
    const prevN = previous.rows.length;
    const shrinkPct = prevN > 0 ? (prevN - curN) / prevN : 0;
    if (shrinkPct > 0.2) {
      results.push(CheckResult.fail(4, 'drift_row_count',
        `Row count shrank from ${prevN} to ${curN} (${(shrinkPct * 100).toFixed(0)}% loss)`,
        { prev: prevN, cur: curN, shrinkPct }));
    } else {
      results.push(CheckResult.ok(4, 'drift_row_count', { prev: prevN, cur: curN }));
    }
  }

  // Per-field max-delta checks (e.g. xGF/60 shouldn't move >0.3 overnight for a team)
  if (opts.maxDeltas && current.byKey && previous.byKey) {
    const violations = [];
    for (const [key, curRow] of Object.entries(current.byKey)) {
      const prevRow = previous.byKey[key];
      if (!prevRow) continue;
      for (const [field, maxDelta] of Object.entries(opts.maxDeltas)) {
        const curV = Number(curRow[field]);
        const prevV = Number(prevRow[field]);
        if (!Number.isFinite(curV) || !Number.isFinite(prevV)) continue;
        const delta = Math.abs(curV - prevV);
        if (delta > maxDelta) {
          violations.push({ key, field, prev: prevV, cur: curV, delta, maxDelta });
        }
      }
    }
    if (violations.length === 0) {
      results.push(CheckResult.ok(4, 'drift_field_deltas', {}));
    } else {
      results.push(CheckResult.fail(4, 'drift_field_deltas',
        `${violations.length} fields moved more than expected between snapshots`,
        { violations: violations.slice(0, 10), totalViolations: violations.length }));
    }
  }

  return results;
}
