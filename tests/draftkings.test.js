// ============================================================================
// DRAFTKINGS PARSER TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDkResponse,
  validateDkSeries,
} from '../src/ingest/draftkings.js';

// ============================================================================
// Realistic DK eventgroup JSON mock
// ============================================================================

function mockDkResponse() {
  return {
    eventGroup: {
      offerCategories: [{
        offerSubcategoryDescriptors: [{
          offerSubcategory: {
            offers: [
              [
                // Series winner offer for BOS vs TOR
                {
                  eventId: 'ABC123',
                  label: 'Series Winner',
                  outcomes: [
                    { label: 'BOS', oddsAmerican: -150 },
                    { label: 'TOR', oddsAmerican: +130 },
                  ],
                },
                // Total games for same series
                {
                  eventId: 'ABC123',
                  label: 'Total Games',
                  outcomes: [
                    { label: 'Over', line: 5.5, oddsAmerican: -115 },
                    { label: 'Under', line: 5.5, oddsAmerican: -105 },
                    { label: 'Over', line: 6.5, oddsAmerican: +210 },
                    { label: 'Under', line: 6.5, oddsAmerican: -270 },
                  ],
                },
                // Goes to 7
                {
                  eventId: 'ABC123',
                  label: 'Will Series Go 7 Games?',
                  outcomes: [
                    { label: 'Yes', oddsAmerican: +240 },
                    { label: 'No', oddsAmerican: -320 },
                  ],
                },
                // Correct score (exact result)
                {
                  eventId: 'ABC123',
                  label: 'Correct Score',
                  outcomes: [
                    { label: 'BOS in 4', oddsAmerican: +750 },
                    { label: 'BOS in 5', oddsAmerican: +500 },
                    { label: 'BOS in 6', oddsAmerican: +450 },
                    { label: 'BOS in 7', oddsAmerican: +550 },
                    { label: 'TOR in 4', oddsAmerican: +1800 },
                    { label: 'TOR in 5', oddsAmerican: +900 },
                    { label: 'TOR in 6', oddsAmerican: +700 },
                    { label: 'TOR in 7', oddsAmerican: +650 },
                  ],
                },
              ],
            ],
          },
        }],
      }],
    },
  };
}

// ============================================================================
// Parsing tests
// ============================================================================

test('parseDkResponse: extracts series winner prices', () => {
  const parsed = parseDkResponse(mockDkResponse());
  assert.equal(parsed.length, 1);
  const series = parsed[0];
  assert.equal(series.teamA, 'BOS');
  assert.equal(series.teamB, 'TOR');
  assert.equal(series.markets.seriesWinner.BOS, -150);
  assert.equal(series.markets.seriesWinner.TOR, 130);
});

test('parseDkResponse: extracts total games prices by line', () => {
  const parsed = parseDkResponse(mockDkResponse());
  const tg = parsed[0].markets.totalGames;
  assert.equal(tg.over5_5, -115);
  assert.equal(tg.under5_5, -105);
  assert.equal(tg.over6_5, 210);
  assert.equal(tg.under6_5, -270);
});

test('parseDkResponse: extracts goes-to-7 market', () => {
  const parsed = parseDkResponse(mockDkResponse());
  assert.equal(parsed[0].markets.goesSeven.yes, 240);
  assert.equal(parsed[0].markets.goesSeven.no, -320);
});

test('parseDkResponse: extracts correct score grid', () => {
  const parsed = parseDkResponse(mockDkResponse());
  const cs = parsed[0].markets.correctScore;
  assert.equal(cs.BOS_in_4, 750);
  assert.equal(cs.TOR_in_7, 650);
});

test('parseDkResponse: handles empty eventgroup', () => {
  const parsed = parseDkResponse({ eventGroup: { offerCategories: [] } });
  assert.equal(parsed.length, 0);
});

test('parseDkResponse: ignores unrecognized market labels', () => {
  const data = mockDkResponse();
  data.eventGroup.offerCategories[0].offerSubcategoryDescriptors[0]
    .offerSubcategory.offers[0].push({
      eventId: 'ABC123',
      label: 'Some Random Prop',
      outcomes: [{ label: 'x', oddsAmerican: 100 }],
    });
  const parsed = parseDkResponse(data);
  // Still only series markets picked up
  assert.ok(!Object.values(parsed[0].markets).some(m =>
    m && Object.keys(m).includes('x')
  ));
});

// ============================================================================
// Validation
// ============================================================================

test('validateDkSeries: accepts reasonable vig', () => {
  const parsed = parseDkResponse(mockDkResponse());
  const v = validateDkSeries(parsed[0]);
  assert.equal(v.valid, true);
});

test('validateDkSeries: flags absurd vig', () => {
  const bad = {
    markets: {
      seriesWinner: { A: -500, B: -500 }, // both at -500 = ~83% each = 66% vig
    },
  };
  const v = validateDkSeries(bad);
  assert.equal(v.valid, false);
  assert.ok(v.issues.length > 0);
});

test('validateDkSeries: handles missing markets gracefully', () => {
  const v = validateDkSeries({ markets: {} });
  assert.equal(v.valid, true);
});
