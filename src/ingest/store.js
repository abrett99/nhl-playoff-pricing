// ============================================================================
// APPEND-ONLY TIMESTAMPED DATA STORE
// ============================================================================
// Every external data pull writes an IMMUTABLE, timestamped file. Nothing
// ever overwrites. If the same source gives a different value tomorrow, it's
// a new record. This is the single most important architectural decision for
// eliminating leakage.
//
// Layout:
//   data/raw/<source>/<YYYY-MM-DD>T<HH-MM-SS>Z_<variant>.<ext>
//   data/manifest/store.json  ← pointer to most recent good pull per source
//
// The store never deletes. The manifest distinguishes `raw/`, `quarantined/`,
// and `stale/` states for each source.
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { filenameTimestamp, isoTimestamp } from '../engine/util.js';

const ROOT = path.resolve(process.cwd(), 'data');
const RAW = path.join(ROOT, 'raw');
const MANIFEST = path.join(ROOT, 'manifest', 'store.json');

// ============================================================================
// Manifest shape
// ============================================================================
/*
{
  "lastGoodPulls": {
    "nst_team_sva":       { "path": "raw/nst/...csv", "timestamp": "2026-04-14T06:12:14Z", "layersPassed": [1,2,3,4], "rowCount": 32 },
    "moneypuck_skaters":  { "path": "raw/moneypuck/...csv", ... },
    ...
  },
  "quarantined": [
    { "source": "nst_team_pp", "path": "raw/nst/...csv", "timestamp": "2026-04-14T06:14:00Z",
      "failedChecks": [...] }
  ],
  "stats": {
    "totalPulls": 1234,
    "totalQuarantined": 12
  },
  "lastUpdated": "2026-04-14T11:30:00Z"
}
*/

// ============================================================================
// Manifest operations
// ============================================================================

async function loadManifest() {
  try {
    const text = await fs.readFile(MANIFEST, 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        lastGoodPulls: {},
        quarantined: [],
        stats: { totalPulls: 0, totalQuarantined: 0 },
        lastUpdated: null,
      };
    }
    throw e;
  }
}

async function saveManifest(manifest) {
  manifest.lastUpdated = isoTimestamp();
  await fs.mkdir(path.dirname(MANIFEST), { recursive: true });
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
}

// ============================================================================
// Writing a new pull
// ============================================================================

/**
 * Commit a new pull. Runs sanity checks; writes to `raw/` if all pass,
 * to `quarantined/` if any fail.
 *
 * @param {object} params
 * @param {string} params.source         - Source identifier e.g. "nst_team_sva"
 * @param {string} params.variant        - Optional variant e.g. "stype3_gpf410"
 * @param {string} params.extension      - File extension e.g. "csv", "json"
 * @param {string|Buffer} params.body    - Raw content to write
 * @param {object} params.metadata       - { rowCount, size, additional fields }
 * @param {import('../sanity/checks.js').CheckReport} params.report - Result of all checks
 */
export async function commitPull({ source, variant = '', extension, body, metadata = {}, report }) {
  const ts = filenameTimestamp();
  const filename = variant
    ? `${ts}_${variant}.${extension}`
    : `${ts}.${extension}`;

  const subdir = report.passed() ? 'raw' : 'quarantined';
  const relativePath = path.join(subdir, source, filename);
  const fullPath = path.join(ROOT, relativePath);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, body);

  const manifest = await loadManifest();
  manifest.stats.totalPulls++;

  if (report.passed()) {
    const prev = manifest.lastGoodPulls[source];
    manifest.lastGoodPulls[source] = {
      path: relativePath,
      timestamp: isoTimestamp(),
      variant,
      layersPassed: [1, 2, 3, 4],
      ...metadata,
      previousPath: prev?.path || null,
    };
  } else {
    manifest.stats.totalQuarantined++;
    manifest.quarantined.push({
      source,
      path: relativePath,
      timestamp: isoTimestamp(),
      variant,
      failedChecks: report.allFailures().map(c => ({
        layer: c.layer,
        checkName: c.checkName,
        message: c.message,
      })),
    });
    // Keep quarantine log bounded
    if (manifest.quarantined.length > 100) {
      manifest.quarantined = manifest.quarantined.slice(-100);
    }
  }

  await saveManifest(manifest);

  return {
    path: relativePath,
    committed: report.passed(),
    manifest: manifest.lastGoodPulls[source] || null,
  };
}

// ============================================================================
// Reading from the store
// ============================================================================

/** Get the most recent successful pull for a source */
export async function getLatestGood(source) {
  const manifest = await loadManifest();
  const entry = manifest.lastGoodPulls[source];
  if (!entry) return null;
  const fullPath = path.join(ROOT, entry.path);
  try {
    const body = await fs.readFile(fullPath);
    return { ...entry, body };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Get the N most recent pulls for a source (newest first), regardless of status */
export async function getRecentPulls(source, n = 10) {
  const dir = path.join(RAW, source);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  // Filenames start with ISO timestamp so alphabetical = chronological
  const sorted = files.sort().reverse().slice(0, n);
  return Promise.all(sorted.map(async f => ({
    filename: f,
    path: path.join('raw', source, f),
    body: await fs.readFile(path.join(dir, f)),
  })));
}

/**
 * Get the snapshot that was current at a specific point in time.
 * This is the CORE function for point-in-time feature building.
 *
 * Returns the most recent pull whose timestamp is strictly BEFORE `asOf`.
 */
export async function getSnapshotAsOf(source, asOf) {
  const targetTime = asOf instanceof Date ? asOf : new Date(asOf);
  const dir = path.join(RAW, source);

  let files;
  try {
    files = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }

  // Parse timestamps from filenames (2026-04-14T06-12-14Z_variant.csv)
  const candidates = files
    .map(f => {
      const match = f.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(_.+)?\.\w+$/);
      if (!match) return null;
      // Convert back: "2026-04-14T06-12-14Z" -> "2026-04-14T06:12:14Z"
      const isoFriendly = match[1].replace(
        /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z$/,
        '$1$2:$3:$4Z'
      );
      return {
        filename: f,
        timestamp: new Date(isoFriendly),
      };
    })
    .filter(c => c && c.timestamp < targetTime)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (!candidates.length) return null;

  const chosen = candidates[0];
  const fullPath = path.join(dir, chosen.filename);
  const body = await fs.readFile(fullPath);
  return {
    filename: chosen.filename,
    timestamp: chosen.timestamp.toISOString(),
    path: path.join('raw', source, chosen.filename),
    body,
    ageMs: targetTime - chosen.timestamp,
  };
}

/** Inspection: list all sources and their most recent good pull */
export async function describeManifest() {
  const manifest = await loadManifest();
  return {
    sources: Object.entries(manifest.lastGoodPulls).map(([source, entry]) => ({
      source,
      lastGood: entry.timestamp,
      rowCount: entry.rowCount ?? null,
      path: entry.path,
    })),
    quarantineCount: manifest.quarantined.length,
    recentQuarantine: manifest.quarantined.slice(-5),
    stats: manifest.stats,
  };
}

/** Health check: is every critical source fresh? */
export async function healthCheck(requirements = {}) {
  const manifest = await loadManifest();
  const now = Date.now();
  const issues = [];

  for (const [source, maxAgeHours] of Object.entries(requirements)) {
    const entry = manifest.lastGoodPulls[source];
    if (!entry) {
      issues.push({ source, status: 'missing', message: 'No successful pull ever recorded' });
      continue;
    }
    const ageHours = (now - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60);
    if (ageHours > maxAgeHours) {
      issues.push({
        source,
        status: 'stale',
        ageHours: Math.round(ageHours * 10) / 10,
        maxAllowedHours: maxAgeHours,
      });
    }
  }

  return {
    healthy: issues.length === 0,
    issues,
    checkedAt: isoTimestamp(),
  };
}
