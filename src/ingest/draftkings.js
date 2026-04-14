// ============================================================================
// DRAFTKINGS SERIES PROPS SCRAPER
// ============================================================================
// DK exposes a JSON API that powers the series futures page. Eventgroup
// 42133 is NHL Stanley Cup playoff series props (winner, total games,
// goes to 7, correct score).
//
// The Odds API doesn't reliably cover series-level markets, so scraping
// DK directly is our primary source for series prices.
//
// API shape (as of 2025):
//   https://sportsbook-nash.draftkings.com/sites/US-SB/api/v5/eventgroups/42133?format=json
//     → { eventGroup: { offerCategories: [ { offerSubcategoryDescriptors: [
//           { offerSubcategory: { offers: [ [ { outcomes: [...] } ] ] } }
//        ] } ] } }
// ============================================================================

import { SEMANTIC_RANGES } from '../config.js';
import { americanToProb } from '../engine/odds.js';

const DK_URL = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/v5/eventgroups/42133?format=json';

// ============================================================================
// Top-level fetch + normalize
// ============================================================================

/**
 * Fetch the current DK playoff-series JSON and normalize into per-series
 * price objects suitable for feeding into computeEdges().
 *
 * @param {Function} [fetchImpl] - override for testing
 * @returns {Promise<{ capturedAt, series: Array }>}
 */
export async function fetchDkSeriesPrices(fetchImpl = fetch) {
  const resp = await fetchImpl(DK_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`DK fetch failed: ${resp.status}`);
  }
  const data = await resp.json();
  return {
    capturedAt: new Date().toISOString(),
    rawSize: JSON.stringify(data).length,
    series: parseDkResponse(data),
  };
}

// ============================================================================
// Parser (pure function for testability)
// ============================================================================

/**
 * Parse a DK eventgroup JSON payload into structured series price objects.
 * @param {Object} data
 * @returns {Array<SeriesPriceObject>}
 */
export function parseDkResponse(data) {
  const offers = flattenOffers(data);
  const bySeriesKey = {};

  for (const offer of offers) {
    const classification = classifyOffer(offer);
    if (!classification) continue;

    const { seriesKey, market } = classification;
    bySeriesKey[seriesKey] = bySeriesKey[seriesKey] || {
      seriesKey,
      teamA: null,
      teamB: null,
      markets: {},
    };

    // Populate teams from the offer
    if (classification.teamA && !bySeriesKey[seriesKey].teamA) {
      bySeriesKey[seriesKey].teamA = classification.teamA;
      bySeriesKey[seriesKey].teamB = classification.teamB;
    }

    // Stash the market prices
    bySeriesKey[seriesKey].markets[market] = extractPrices(offer, market);
  }

  return Object.values(bySeriesKey);
}

// ============================================================================
// Helpers
// ============================================================================

function flattenOffers(data) {
  const result = [];
  const categories = data?.eventGroup?.offerCategories || [];
  for (const cat of categories) {
    const subs = cat.offerSubcategoryDescriptors || [];
    for (const sub of subs) {
      const offerGroups = sub.offerSubcategory?.offers || [];
      for (const group of offerGroups) {
        if (Array.isArray(group)) result.push(...group);
        else if (group) result.push(group);
      }
    }
  }
  return result;
}

/**
 * Inspect an offer's label to determine which market it represents.
 * Returns null if unrecognized (we only care about 4-5 specific markets).
 */
function classifyOffer(offer) {
  const label = String(offer.label || '').toLowerCase();
  const event = String(offer.eventId || '');
  const outcomes = offer.outcomes || [];

  // Series winner: label includes "series winner" or "to win series"
  if (/series winner|to win series/.test(label) && outcomes.length === 2) {
    return {
      seriesKey: `dk-${event}`,
      market: 'seriesWinner',
      teamA: outcomes[0].label,
      teamB: outcomes[1].label,
    };
  }

  // Total games: label includes "total games" or has over/under pattern
  if (/total games|games.*over\/under/.test(label)) {
    return {
      seriesKey: `dk-${event}`,
      market: 'totalGames',
      teamA: null,
      teamB: null,
    };
  }

  // Goes to 7: label includes "games to 7" or "will go 7 games"
  if (/go(es)?.*7|seven games/.test(label) && outcomes.length === 2) {
    return {
      seriesKey: `dk-${event}`,
      market: 'goesSeven',
      teamA: null,
      teamB: null,
    };
  }

  // Exact series length / correct score
  if (/correct score|exact.*games|series.*result/.test(label)) {
    return {
      seriesKey: `dk-${event}`,
      market: 'correctScore',
      teamA: null,
      teamB: null,
    };
  }

  return null;
}

function extractPrices(offer, market) {
  const outcomes = offer.outcomes || [];

  if (market === 'seriesWinner' && outcomes.length === 2) {
    return {
      [outcomes[0].label]: outcomes[0].oddsAmerican,
      [outcomes[1].label]: outcomes[1].oddsAmerican,
    };
  }

  if (market === 'totalGames') {
    // Outcomes typically come in Over/Under pairs per line
    const prices = {};
    for (const o of outcomes) {
      const line = o.line ?? o.point;
      const side = String(o.label || '').toLowerCase().includes('over') ? 'over' : 'under';
      if (line !== undefined) {
        prices[`${side}${String(line).replace('.', '_')}`] = o.oddsAmerican;
      }
    }
    return prices;
  }

  if (market === 'goesSeven' && outcomes.length === 2) {
    const yes = outcomes.find(o => /yes/i.test(o.label)) || outcomes[0];
    const no = outcomes.find(o => /no/i.test(o.label)) || outcomes[1];
    return {
      yes: yes?.oddsAmerican,
      no: no?.oddsAmerican,
    };
  }

  if (market === 'correctScore') {
    const result = {};
    for (const o of outcomes) {
      // Label format like "CAR in 5" or "NJD in 6"
      const key = String(o.label || '').replace(/\s+/g, '_');
      result[key] = o.oddsAmerican;
    }
    return result;
  }

  return {};
}

// ============================================================================
// Sanity validation on a parsed series
// ============================================================================

export function validateDkSeries(series) {
  const issues = [];

  if (series.markets.seriesWinner) {
    const prices = Object.values(series.markets.seriesWinner);
    if (prices.length === 2) {
      const vig = americanToProb(prices[0]) + americanToProb(prices[1]) - 1;
      const [minVig, maxVig] = SEMANTIC_RANGES.vig;
      if (vig < minVig || vig > maxVig) {
        issues.push({
          market: 'seriesWinner',
          issue: 'vig_out_of_range',
          vig,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
