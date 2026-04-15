import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameToAbbrev,
  abbrevToName,
  historicalAbbrev,
  ALL_ABBREVS,
} from '../src/ingest/kaggle/teamNames.js';

test('nameToAbbrev: maps common current teams', () => {
  assert.equal(nameToAbbrev('Toronto Maple Leafs'), 'TOR');
  assert.equal(nameToAbbrev('Boston Bruins'), 'BOS');
  assert.equal(nameToAbbrev('Vegas Golden Knights'), 'VGK');
  assert.equal(nameToAbbrev('Seattle Kraken'), 'SEA');
});

test('nameToAbbrev: handles accented Montreal variant', () => {
  assert.equal(nameToAbbrev('Montréal Canadiens'), 'MTL');
  assert.equal(nameToAbbrev('Montreal Canadiens'), 'MTL');
});

test('nameToAbbrev: handles St. Louis with and without period', () => {
  assert.equal(nameToAbbrev('St. Louis Blues'), 'STL');
  assert.equal(nameToAbbrev('St Louis Blues'), 'STL');
});

test('nameToAbbrev: maps Atlanta Thrashers to current franchise WPG', () => {
  // Default mapping rolls historical franchise forward to current
  assert.equal(nameToAbbrev('Atlanta Thrashers'), 'WPG');
});

test('nameToAbbrev: maps Phoenix/Arizona to current franchise UTA', () => {
  assert.equal(nameToAbbrev('Phoenix Coyotes'), 'ARI');
  assert.equal(nameToAbbrev('Arizona Coyotes'), 'UTA');
  assert.equal(nameToAbbrev('Utah Hockey Club'), 'UTA');
});

test('nameToAbbrev: returns null for unknown teams', () => {
  assert.equal(nameToAbbrev('Hartford Whalers'), null);
  assert.equal(nameToAbbrev('Completely Fake Team'), null);
  assert.equal(nameToAbbrev(''), null);
  assert.equal(nameToAbbrev(null), null);
  assert.equal(nameToAbbrev(undefined), null);
});

test('nameToAbbrev: handles leading/trailing whitespace', () => {
  assert.equal(nameToAbbrev('  Toronto Maple Leafs  '), 'TOR');
  assert.equal(nameToAbbrev('Boston Bruins\n'), 'BOS');
});

test('abbrevToName: maps common abbrevs to canonical names', () => {
  assert.equal(abbrevToName('TOR'), 'Toronto Maple Leafs');
  assert.equal(abbrevToName('BOS'), 'Boston Bruins');
  assert.equal(abbrevToName('VGK'), 'Vegas Golden Knights');
});

test('abbrevToName: handles lowercase input', () => {
  assert.equal(abbrevToName('tor'), 'Toronto Maple Leafs');
  assert.equal(abbrevToName('StL'), 'St. Louis Blues');
});

test('abbrevToName: returns null for unknown abbrevs', () => {
  assert.equal(abbrevToName('XXX'), null);
  assert.equal(abbrevToName(''), null);
  assert.equal(abbrevToName(null), null);
});

test('historicalAbbrev: Atlanta pre-2012 returns ATL', () => {
  assert.equal(historicalAbbrev('Atlanta Thrashers', 2010), 'ATL');
  assert.equal(historicalAbbrev('Atlanta Thrashers', 2011), 'ATL');
});

test('historicalAbbrev: Atlanta 2012+ returns WPG (franchise moved)', () => {
  assert.equal(historicalAbbrev('Atlanta Thrashers', 2012), 'WPG');
  assert.equal(historicalAbbrev('Atlanta Thrashers', 2020), 'WPG');
});

test('historicalAbbrev: Phoenix pre-2015 returns PHX', () => {
  assert.equal(historicalAbbrev('Phoenix Coyotes', 2010), 'PHX');
  assert.equal(historicalAbbrev('Phoenix Coyotes', 2014), 'PHX');
});

test('historicalAbbrev: Phoenix 2015+ returns ARI (renamed)', () => {
  assert.equal(historicalAbbrev('Phoenix Coyotes', 2015), 'ARI');
});

test('historicalAbbrev: Arizona pre-2025 returns ARI', () => {
  assert.equal(historicalAbbrev('Arizona Coyotes', 2020), 'ARI');
  assert.equal(historicalAbbrev('Arizona Coyotes', 2024), 'ARI');
});

test('historicalAbbrev: Arizona 2025+ returns UTA (franchise moved)', () => {
  assert.equal(historicalAbbrev('Arizona Coyotes', 2025), 'UTA');
});

test('historicalAbbrev: current teams unchanged across seasons', () => {
  assert.equal(historicalAbbrev('Toronto Maple Leafs', 2005), 'TOR');
  assert.equal(historicalAbbrev('Toronto Maple Leafs', 2024), 'TOR');
  assert.equal(historicalAbbrev('Boston Bruins', 2010), 'BOS');
});

test('ALL_ABBREVS contains 30 current teams plus historical', () => {
  assert.ok(ALL_ABBREVS.length >= 30, 'should have at least 30 teams');
  assert.ok(ALL_ABBREVS.includes('TOR'), 'missing TOR');
  assert.ok(ALL_ABBREVS.includes('UTA'), 'missing UTA');
  assert.ok(ALL_ABBREVS.includes('ARI'), 'missing ARI for historical');
  assert.ok(ALL_ABBREVS.includes('SEA'), 'missing SEA');
  assert.ok(ALL_ABBREVS.includes('VGK'), 'missing VGK');
});

test('ALL_ABBREVS has no duplicates', () => {
  const unique = new Set(ALL_ABBREVS);
  assert.equal(unique.size, ALL_ABBREVS.length);
});

test('round-trip: every abbrev maps back to a valid name', () => {
  const currentEraAbbrevs = ALL_ABBREVS.filter(a => a !== 'ARI'); // ARI only for historical
  for (const abbrev of currentEraAbbrevs) {
    const name = abbrevToName(abbrev);
    assert.ok(name, `abbrevToName(${abbrev}) returned null`);
    // Note: not all names round-trip to the same abbrev (Atlanta -> WPG) so
    // we don't test nameToAbbrev(name) === abbrev here.
  }
});

