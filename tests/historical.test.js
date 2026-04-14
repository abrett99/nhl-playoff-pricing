// ============================================================================
// HISTORICAL SERIES LOADER TESTS
// ============================================================================
// Mocks fetch() to verify parsing logic without hitting the live NHL API.
// ============================================================================

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeSeries } from '../src/ingest/historical.js';

// ============================================================================
// summarizeSeries
// ============================================================================

test('summarizeSeries: computes accurate aggregate stats', () => {
  const series = [
    {
      seriesId: '2023-R1-A', seasonStartYear: 2023, round: 1,
      teamA: 'BOS', teamB: 'TOR',
      actualWinner: 'BOS', actualTotalGames: 4, winsA: 4, winsB: 0,
      games: [
        { gameNum: 1, winner: 'BOS', homeTeam: 'BOS', awayTeam: 'TOR' },
        { gameNum: 2, winner: 'BOS', homeTeam: 'BOS', awayTeam: 'TOR' },
        { gameNum: 3, winner: 'BOS', homeTeam: 'TOR', awayTeam: 'BOS' },
        { gameNum: 4, winner: 'BOS', homeTeam: 'TOR', awayTeam: 'BOS' },
      ],
    },
    {
      seriesId: '2023-R1-B', seasonStartYear: 2023, round: 1,
      teamA: 'NYR', teamB: 'NJD',
      actualWinner: 'NYR', actualTotalGames: 7, winsA: 4, winsB: 3,
      games: [
        { gameNum: 7, winner: 'NYR', homeTeam: 'NYR', awayTeam: 'NJD' },
      ],
    },
    {
      seriesId: '2023-R1-C', seasonStartYear: 2023, round: 1,
      teamA: 'FLA', teamB: 'CAR',
      actualWinner: 'CAR', actualTotalGames: 7, winsA: 3, winsB: 4,
      games: [
        { gameNum: 7, winner: 'CAR', homeTeam: 'FLA', awayTeam: 'CAR' },
      ],
    },
  ];

  const s = summarizeSeries(series);
  assert.equal(s.totalSeries, 3);
  assert.equal(s.totalGames, 4 + 7 + 7);
  assert.equal(s.seriesByRound[1], 3);
  assert.equal(s.lengthDistribution[4], 1);
  assert.equal(s.lengthDistribution[7], 2);
  // Top seed wins: 2 of 3 (BOS + NYR)
  assert.equal(Math.round(s.topSeedWinRate * 100), 67);
  // Game 7 home: NYR was home (won), FLA was home (lost) → 50%
  assert.equal(s.game7Count, 2);
  assert.equal(s.game7HomeWinRate, 0.5);
});

test('summarizeSeries: handles empty array', () => {
  const s = summarizeSeries([]);
  assert.equal(s.totalSeries, 0);
  assert.equal(s.totalGames, 0);
  assert.equal(s.game7HomeWinRate, null);
  assert.equal(s.seasonsSpan, null);
});

// ============================================================================
// Integration test with mocked fetch (loads series detail correctly)
// ============================================================================

const originalFetch = globalThis.fetch;

function mockFetch(urlToResponse) {
  globalThis.fetch = async (url) => {
    const response = urlToResponse[url];
    if (!response) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => response,
    };
  };
}

test('loadPlayoffSeason: parses carousel response and fetches series details', async () => {
  const carouselResponse = {
    rounds: [{
      roundNumber: 1,
      series: [{
        seriesLetter: 'A',
        topSeedTeam: { abbrev: 'BOS' },
        bottomSeedTeam: { abbrev: 'TOR' },
      }],
    }],
  };

  const seriesDetailResponse = {
    topSeedTeam: { abbrev: 'BOS' },
    bottomSeedTeam: { abbrev: 'TOR' },
    topSeedRank: 1,
    bottomSeedRank: 4,
    games: [
      {
        id: 2023030111,
        homeTeam: { abbrev: 'BOS', score: 5 },
        awayTeam: { abbrev: 'TOR', score: 1 },
        periodDescriptor: { number: 3 },
        startTimeUTC: '2024-04-20T23:00:00Z',
        gameState: 'OFF',
      },
      {
        id: 2023030112,
        homeTeam: { abbrev: 'BOS', score: 3 },
        awayTeam: { abbrev: 'TOR', score: 2 },
        periodDescriptor: { number: 4 },
        startTimeUTC: '2024-04-22T23:00:00Z',
        gameState: 'OFF',
      },
      {
        id: 2023030113,
        homeTeam: { abbrev: 'TOR', score: 1 },
        awayTeam: { abbrev: 'BOS', score: 4 },
        periodDescriptor: { number: 3 },
        startTimeUTC: '2024-04-24T23:00:00Z',
        gameState: 'OFF',
      },
      {
        id: 2023030114,
        homeTeam: { abbrev: 'TOR', score: 2 },
        awayTeam: { abbrev: 'BOS', score: 3 },
        periodDescriptor: { number: 3 },
        startTimeUTC: '2024-04-26T23:00:00Z',
        gameState: 'OFF',
      },
    ],
  };

  mockFetch({
    'https://api-web.nhle.com/v1/playoff-series/carousel/20232024': carouselResponse,
    'https://api-web.nhle.com/v1/schedule/playoff-series/20232024/A': seriesDetailResponse,
  });

  try {
    const { loadPlayoffSeason } = await import('../src/ingest/historical.js');
    const seasons = await loadPlayoffSeason(2023);
    assert.equal(seasons.length, 1);

    const series = seasons[0];
    assert.equal(series.teamA, 'BOS');
    assert.equal(series.teamB, 'TOR');
    assert.equal(series.round, 1);
    assert.equal(series.actualWinner, 'BOS');
    assert.equal(series.actualTotalGames, 4);
    assert.equal(series.winsA, 4);
    assert.equal(series.winsB, 0);
    assert.equal(series.games.length, 4);
    // G2 was OT (periodDescriptor.number === 4)
    assert.equal(series.games[1].ot, true);
    assert.equal(series.games[0].ot, false);
    // Series ID format
    assert.equal(series.seriesId, '2023-R1-A');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
