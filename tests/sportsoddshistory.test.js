// ============================================================================
// SPORTSODDSHISTORY PARSER TESTS
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSohPlayoffs,
  normalizeSohTeam,
} from '../src/ingest/sportsoddshistory.js';

const MOCK_HTML = `
<html><body>
<h2>First Round</h2>
<table>
  <thead>
    <tr><th>Date</th><th>Matchup</th><th>Favorite</th><th>Dog</th><th>Total</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>April 20, 2024</td>
      <td>Boston Bruins @ Toronto Maple Leafs</td>
      <td>-150</td>
      <td>+130</td>
      <td>6.5</td>
    </tr>
    <tr>
      <td>April 21, 2024</td>
      <td>New York Rangers vs New Jersey Devils</td>
      <td>-180</td>
      <td>+160</td>
      <td>5.5</td>
    </tr>
  </tbody>
</table>

<h2>Second Round</h2>
<table>
  <tr><th>Date</th><th>Matchup</th></tr>
  <tr>
    <td>2024-05-01</td>
    <td>Florida Panthers at Carolina Hurricanes</td>
    <td>+110</td>
    <td>-130</td>
    <td>6.0</td>
  </tr>
</table>
</body></html>
`;

test('parseSohPlayoffs: extracts series rows across multiple tables', () => {
  const results = parseSohPlayoffs(MOCK_HTML);
  assert.ok(results.length >= 3);

  const bosTor = results.find(r =>
    r.teamA.includes('Boston') && r.teamB.includes('Toronto')
  );
  assert.ok(bosTor);
  assert.equal(bosTor.date, '2024-04-20');
});

test('parseSohPlayoffs: parses dates in multiple formats', () => {
  const results = parseSohPlayoffs(MOCK_HTML);
  const dates = results.map(r => r.date);
  assert.ok(dates.includes('2024-04-20'));
  assert.ok(dates.includes('2024-04-21'));
  assert.ok(dates.includes('2024-05-01'));
});

test('parseSohPlayoffs: handles separator variations (@, vs, at)', () => {
  const results = parseSohPlayoffs(MOCK_HTML);
  assert.equal(results.length, 3);
  // All three should have extracted team A and team B
  for (const r of results) {
    assert.ok(r.teamA.length > 0);
    assert.ok(r.teamB.length > 0);
  }
});

test('parseSohPlayoffs: extracts numeric odds values', () => {
  const results = parseSohPlayoffs(MOCK_HTML);
  const bosTor = results.find(r => r.teamA.includes('Boston'));
  assert.ok(bosTor.numericValues.includes(-150));
  assert.ok(bosTor.numericValues.includes(130));
  assert.ok(bosTor.numericValues.includes(6.5));
});

test('parseSohPlayoffs: handles empty input gracefully', () => {
  assert.deepEqual(parseSohPlayoffs(''), []);
  assert.deepEqual(parseSohPlayoffs(null), []);
  assert.deepEqual(parseSohPlayoffs('<html></html>'), []);
});

test('normalizeSohTeam: maps full names to abbrevs', () => {
  assert.equal(normalizeSohTeam('Boston Bruins'), 'BOS');
  assert.equal(normalizeSohTeam('Toronto Maple Leafs'), 'TOR');
  assert.equal(normalizeSohTeam('St. Louis Blues'), 'STL');
  assert.equal(normalizeSohTeam('St Louis Blues'), 'STL');
});

test('normalizeSohTeam: handles relocated franchises', () => {
  // Phoenix Coyotes and Arizona Coyotes both become Utah
  assert.equal(normalizeSohTeam('Phoenix Coyotes'), 'UTA');
  assert.equal(normalizeSohTeam('Arizona Coyotes'), 'UTA');
  assert.equal(normalizeSohTeam('Utah Hockey Club'), 'UTA');
});

test('normalizeSohTeam: accepts 3-char abbrevs directly', () => {
  assert.equal(normalizeSohTeam('BOS'), 'BOS');
  assert.equal(normalizeSohTeam('bos'), 'BOS');
});

test('normalizeSohTeam: returns null for unknown', () => {
  assert.equal(normalizeSohTeam(''), null);
  assert.equal(normalizeSohTeam('Hartford Whalers'), null); // defunct
  assert.equal(normalizeSohTeam(null), null);
});
