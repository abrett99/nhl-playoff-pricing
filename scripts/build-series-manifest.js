#!/usr/bin/env node
// ============================================================================
// BUILD SERIES MANIFEST
// ============================================================================
// Scans data/derived/series_state/*.json and writes a manifest that the UI
// fetches to know which series to load. Runs in the GitHub Pages deploy
// workflow after any state update.
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';

const STATE_DIR = path.resolve(process.cwd(), 'data', 'derived', 'series_state');
const OUT_PATH = path.resolve(process.cwd(), 'data', 'derived', 'series_manifest.json');

async function main() {
  try {
    const files = await fs.readdir(STATE_DIR);
    const seriesIds = files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));

    // Include summary info for each series so the UI can render a skeleton
    // view before loading full state
    const entries = await Promise.all(seriesIds.map(async id => {
      try {
        const txt = await fs.readFile(path.join(STATE_DIR, `${id}.json`), 'utf-8');
        const state = JSON.parse(txt);
        return {
          seriesId: id,
          teamA: state.teamA,
          teamB: state.teamB,
          round: state.round,
          status: state.status,
          winsA: state.winsA,
          winsB: state.winsB,
        };
      } catch {
        return null;
      }
    }));

    const manifest = {
      generatedAt: new Date().toISOString(),
      count: seriesIds.length,
      seriesIds,
      summary: entries.filter(Boolean),
    };

    await fs.writeFile(OUT_PATH, JSON.stringify(manifest, null, 2));
    console.log(`[manifest] Wrote ${OUT_PATH} with ${seriesIds.length} series`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // State dir doesn't exist yet — write empty manifest
      await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
      await fs.writeFile(OUT_PATH, JSON.stringify({
        generatedAt: new Date().toISOString(),
        count: 0,
        seriesIds: [],
        summary: [],
      }, null, 2));
      console.log(`[manifest] No state files yet; wrote empty manifest`);
    } else {
      throw e;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
