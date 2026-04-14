#!/usr/bin/env node
// ============================================================================
// INGEST: Odds from The Odds API
// ============================================================================
// Captures H2H, totals, spreads from US books (DK, FD, MGM, Caesars) and
// Pinnacle separately via EU region. Pinnacle is the ground truth for CLV.
//
// ENV:
//   ODDS_API_KEY    - required
//
// Usage:
//   node scripts/ingest-odds.js           (pulls h2h/totals/spreads + pinnacle)
//   node scripts/ingest-odds.js --outrights    (adds futures/outrights pull)
// ============================================================================

import { ODDS_API, SEMANTIC_RANGES } from '../src/config.js';
import {
  CheckReport,
  checkFetch,
  checkParse,
  CheckResult,
} from '../src/sanity/checks.js';
import { commitPull } from '../src/ingest/store.js';
import { americanToProb } from '../src/engine/odds.js';
import { alertPipelineHealth } from '../src/alerts/telegram.js';

const KEY = process.env.ODDS_API_KEY;
if (!KEY) {
  console.error('[ingest-odds] Missing ODDS_API_KEY env var');
  process.exit(1);
}

async function fetchAndCommit({ source, variant, url, checkVigs = true }) {
  console.log(`[ingest-odds] ${source}: fetching`);
  const report = new CheckReport(source);

  let resp, body, parsed;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'nhl-playoff-pricing/0.1' },
    });
    body = await resp.text();
  } catch (e) {
    console.error(`[ingest-odds] ${source}: network error ${e.message}`);
    await alertPipelineHealth({
      source, status: 'network_error', detail: e.message,
    });
    return false;
  }

  // Layer 1
  for (const c of checkFetch({
    status: resp.status,
    headers: resp.headers,
    size: body.length,
    body,
  }, {
    minSize: 50,
    expectedContentType: 'application/json',
  })) report.add(c);

  // Also log API quota info from response headers
  const quota = resp.headers.get('x-requests-remaining');
  if (quota !== null) {
    console.log(`[ingest-odds] API quota remaining: ${quota}`);
  }

  // Layer 2
  try {
    parsed = JSON.parse(body);
    for (const c of checkParse(parsed, {
      type: 'array',
      minRows: 0,
      maxRows: 200,
    })) report.add(c);
  } catch (e) {
    report.add(CheckResult.fail(2, 'json_parse', e.message));
  }

  // Layer 3: vig check on a sample of H2H odds
  if (checkVigs && Array.isArray(parsed)) {
    const vigs = [];
    const violations = [];
    for (const game of parsed) {
      const books = game.bookmakers || [];
      for (const book of books) {
        const h2h = book.markets?.find(m => m.key === 'h2h');
        if (!h2h || !h2h.outcomes || h2h.outcomes.length !== 2) continue;
        const [a, b] = h2h.outcomes;
        if (a.price && b.price) {
          const pA = americanToProb(a.price);
          const pB = americanToProb(b.price);
          const vig = pA + pB - 1;
          vigs.push(vig);
          const [minVig, maxVig] = SEMANTIC_RANGES.vig;
          if (vig < minVig || vig > maxVig) {
            violations.push({ book: book.key, game: game.id, vig });
          }
        }
      }
    }
    if (vigs.length === 0) {
      report.add(CheckResult.ok(3, 'vig_check', { note: 'no h2h markets to check' }));
    } else if (violations.length === 0) {
      report.add(CheckResult.ok(3, 'vig_check', {
        samples: vigs.length,
        avgVig: (vigs.reduce((s, v) => s + v, 0) / vigs.length).toFixed(4),
      }));
    } else {
      report.add(CheckResult.fail(3, 'vig_check',
        `${violations.length} vigs outside range`,
        { violations: violations.slice(0, 5) }));
    }
  }

  // Commit
  const result = await commitPull({
    source,
    variant,
    extension: 'json',
    body,
    metadata: {
      rowCount: Array.isArray(parsed) ? parsed.length : 0,
      size: body.length,
      quotaRemaining: quota,
    },
    report,
  });

  if (result.committed) {
    console.log(`[ingest-odds] ${source}: ✅ ${result.path}`);
    return true;
  } else {
    console.error(`[ingest-odds] ${source}: ⛔ quarantined`);
    console.error(`  Failures: ${report.allFailures().map(f => f.checkName).join(', ')}`);
    await alertPipelineHealth({
      source, status: 'sanity_fail',
      detail: report.allFailures().map(f => f.checkName).join(', '),
    });
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantOutrights = args.includes('--outrights');

  // US books (H2H, totals, spreads)
  await fetchAndCommit({
    source: 'odds_us_books',
    variant: 'h2h_totals_spreads',
    url: ODDS_API.h2hTotalsSpreads(KEY),
  });

  // Pinnacle (via EU region) - our ground truth for CLV
  await fetchAndCommit({
    source: 'odds_pinnacle',
    variant: 'h2h_totals',
    url: ODDS_API.pinnacle(KEY),
  });

  // Outrights / futures (Stanley Cup winner, division winner, etc.)
  if (wantOutrights) {
    await fetchAndCommit({
      source: 'odds_outrights',
      variant: 'scwinner',
      url: ODDS_API.outrights(KEY),
      checkVigs: false, // multi-way markets, different vig semantics
    });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
