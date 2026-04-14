// ============================================================================
// LEFTWINGLOCK PARSER TESTS
// ============================================================================
// Uses realistic HTML snippets modeled after the screenshot layout
// (Date | Team | Player | Change | New Role | Prev Role)
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLwlChanges,
  byTeam,
  latestChangeForPlayer,
  currentPowerPlayUnits,
} from '../src/ingest/lwl.js';

// ============================================================================
// Realistic HTML mock matching the screenshot format
// ============================================================================

const SAMPLE_HTML = `
<html><body>
<h2>Even-Strength Line Changes</h2>
<table class="line-changes">
  <thead>
    <tr><th>Date</th><th>Team</th><th>Player</th><th>Change</th><th>New Role</th><th>Prev Role</th></tr>
  </thead>
  <tbody>
    <tr><td>2025-12-23</td><td>LA</td><td>Alex Laferriere</td><td>↑</td><td>Line 1</td><td>Line 2</td></tr>
    <tr><td>2025-12-23</td><td>LA</td><td>Warren Foegele</td><td>↓</td><td>Line 2</td><td>Line 1</td></tr>
    <tr><td>2025-12-23</td><td>VGK</td><td>Alexander Holtz</td><td>↑↑↑</td><td>Line 2</td><td>—</td></tr>
    <tr><td>2025-12-23</td><td>CHI</td><td>Jason Dickinson</td><td>↑</td><td>Line 1</td><td>Line 2</td></tr>
    <tr><td>2025-12-22</td><td>TOR</td><td>Matthew Knies</td><td>↑↑</td><td>Line 1</td><td>Line 3</td></tr>
  </tbody>
</table>

<h2>Power Play Unit Changes</h2>
<table class="pp-changes">
  <thead>
    <tr><th>Date</th><th>Team</th><th>Player</th><th>Change</th><th>New Role</th><th>Prev Role</th></tr>
  </thead>
  <tbody>
    <tr><td>2025-12-23</td><td>SEA</td><td>Ryker Evans</td><td>↑</td><td>PP 1</td><td>PP 2</td></tr>
    <tr><td>2025-12-23</td><td>CHI</td><td>Teuvo Teravainen</td><td>↑</td><td>PP 1</td><td>PP 2</td></tr>
    <tr><td>2025-12-23</td><td>CHI</td><td>Colton Dach</td><td>↓</td><td>PP 2</td><td>PP 1</td></tr>
    <tr><td>2025-12-22</td><td>TOR</td><td>Matthew Knies</td><td>↑</td><td>PP 1</td><td>PP 2</td></tr>
  </tbody>
</table>
</body></html>
`;

// ============================================================================
// Parsing tests
// ============================================================================

test('parses Even-Strength Line Changes table', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  assert.equal(parsed.evenStrength.length, 5);
  assert.equal(parsed.evenStrength[0].player, 'Alex Laferriere');
  assert.equal(parsed.evenStrength[0].team, 'LA');
  assert.equal(parsed.evenStrength[0].changeDirection, 'promotion');
  assert.equal(parsed.evenStrength[0].newRole.type, 'line');
  assert.equal(parsed.evenStrength[0].newRole.n, 1);
  assert.equal(parsed.evenStrength[0].prevRole.n, 2);
});

test('parses Power Play Unit Changes table', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  assert.equal(parsed.powerPlay.length, 4);
  assert.equal(parsed.powerPlay[0].player, 'Ryker Evans');
  assert.equal(parsed.powerPlay[0].newRole.type, 'power_play_unit');
  assert.equal(parsed.powerPlay[0].newRole.n, 1);
});

test('detects demotion arrows correctly', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  const foegele = parsed.evenStrength.find(r => r.player === 'Warren Foegele');
  assert.equal(foegele.changeDirection, 'demotion');
  assert.equal(foegele.changeMagnitude, 1);
});

test('multi-line jumps detected via arrow count', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  const holtz = parsed.evenStrength.find(r => r.player === 'Alexander Holtz');
  assert.equal(holtz.changeDirection, 'promotion');
  assert.equal(holtz.changeMagnitude, 3);
});

test('handles dash for missing previous role', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  const holtz = parsed.evenStrength.find(r => r.player === 'Alexander Holtz');
  assert.equal(holtz.prevRole, null);
});

test('byTeam aggregates per-team changes', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  const grouped = byTeam(parsed);
  assert.ok(grouped.LA);
  assert.equal(grouped.LA.evenStrength.length, 2);
  assert.ok(grouped.CHI);
  assert.equal(grouped.CHI.evenStrength.length, 1);
  assert.equal(grouped.CHI.powerPlay.length, 2);
});

test('latestChangeForPlayer finds most recent', () => {
  const extra = SAMPLE_HTML.replace(
    '<tr><td>2025-12-22</td><td>TOR</td><td>Matthew Knies</td><td>↑↑</td>',
    '<tr><td>2025-12-20</td><td>TOR</td><td>Matthew Knies</td><td>↑</td><td>Line 2</td><td>Line 3</td></tr>' +
    '<tr><td>2025-12-22</td><td>TOR</td><td>Matthew Knies</td><td>↑↑</td>'
  );
  const parsed = parseLwlChanges(extra);
  const latest = latestChangeForPlayer(parsed, 'Matthew Knies');
  assert.equal(latest.date, '2025-12-22');
});

test('currentPowerPlayUnits aggregates by team', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  const units = currentPowerPlayUnits(parsed);
  assert.ok(units.CHI);
  assert.ok(units.CHI.pp1.includes('Teuvo Teravainen'));
  assert.ok(units.CHI.pp2.includes('Colton Dach'));
  assert.ok(units.TOR.pp1.includes('Matthew Knies'));
});

test('handles empty / missing sections gracefully', () => {
  const parsed = parseLwlChanges('<html><body>no tables here</body></html>');
  assert.equal(parsed.evenStrength.length, 0);
  assert.equal(parsed.powerPlay.length, 0);
});

test('skips header rows', () => {
  const parsed = parseLwlChanges(SAMPLE_HTML);
  // Header row has 'date', 'team', etc. Should never show up as data
  for (const row of parsed.evenStrength) {
    assert.notEqual(row.team.toLowerCase(), 'team');
    assert.notEqual(row.player.toLowerCase(), 'player');
  }
});
