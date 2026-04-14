// ============================================================================
// LEFTWINGLOCK LINE CHANGES PARSER
// ============================================================================
// Parses the Even-Strength Line Changes and Power Play Unit Changes tables
// from leftwinglock.com. These are the single best source of "who will
// actually be on the ice tonight" signals outside of team-confirmed lines.
//
// Page structure (as of 2025-12):
//   - One table per section: Date | Team | Player | Change | New Role | Prev Role
//   - Change column uses up-arrows (promotion) / down-arrows (demotion)
//   - Multi-arrow changes (↑↑↑) indicate multi-line jumps
//   - New/Prev Role: "Line 1" / "Line 2" / "Line 3" / "Line 4" / "PP 1" / "PP 2"
//
// We HTML-parse instead of DOM-parse because the page is simple and we
// want zero dependencies. If structure changes, the sanity checks will
// catch it before bad data lands in features.
// ============================================================================

import { SEASON } from '../config.js';

// ============================================================================
// Core parser
// ============================================================================

/**
 * Parse the LWL line changes HTML page.
 * @param {string} html - raw HTML from leftwinglock.com/line-changes
 * @returns {{ evenStrength: Array, powerPlay: Array }}
 */
export function parseLwlChanges(html) {
  const sections = splitSections(html);
  return {
    evenStrength: parseChangeTable(sections.evenStrength || '', 'even_strength'),
    powerPlay: parseChangeTable(sections.powerPlay || '', 'power_play'),
  };
}

// ============================================================================
// Split HTML into sections by heading
// ============================================================================

function splitSections(html) {
  const result = { evenStrength: '', powerPlay: '' };

  // Find Even-Strength Line Changes heading → table
  const esMatch = html.match(
    /Even-Strength Line Changes[\s\S]*?<table[\s\S]*?<\/table>/i
  );
  if (esMatch) result.evenStrength = esMatch[0];

  // Find Power Play Unit Changes heading → table
  const ppMatch = html.match(
    /Power Play Unit Changes[\s\S]*?<table[\s\S]*?<\/table>/i
  );
  if (ppMatch) result.powerPlay = ppMatch[0];

  return result;
}

// ============================================================================
// Parse a single table into structured rows
// ============================================================================

function parseChangeTable(tableHtml, section) {
  if (!tableHtml) return [];

  // Extract each <tr> row from the table
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows = [];
  let match;
  while ((match = rowRegex.exec(tableHtml)) !== null) {
    const cells = extractCells(match[1]);
    if (cells.length < 6) continue;

    // Skip header row
    const firstCell = cells[0].toLowerCase();
    if (firstCell.includes('date') || firstCell.includes('team') || firstCell === '') continue;

    const [date, team, player, change, newRole, prevRole] = cells;

    const arrows = parseArrows(change);
    if (!arrows.direction) continue; // malformed row

    rows.push({
      section,
      date: normalizeDate(date),
      team: team.trim().toUpperCase(),
      player: player.trim(),
      changeDirection: arrows.direction,   // 'promotion' | 'demotion' | 'mixed'
      changeMagnitude: arrows.magnitude,
      newRole: normalizeRole(newRole),
      prevRole: normalizeRole(prevRole),
      raw: { change, newRole, prevRole },
    });
  }

  return rows;
}

function extractCells(rowHtml) {
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const cells = [];
  let match;
  while ((match = cellRegex.exec(rowHtml)) !== null) {
    cells.push(stripHtml(match[1]));
  }
  return cells;
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// Arrow parsing
// ============================================================================

function parseArrows(changeCell) {
  if (!changeCell) return { direction: null, magnitude: 0 };

  // LWL uses ↑ and ↓ unicode arrows, or sometimes rendered as images
  // (alt="up"/"down"). Normalize both.
  const upCount = (changeCell.match(/↑|▲|\bup\b/gi) || []).length;
  const downCount = (changeCell.match(/↓|▼|\bdown\b/gi) || []).length;

  if (upCount && !downCount) {
    return { direction: 'promotion', magnitude: upCount };
  }
  if (downCount && !upCount) {
    return { direction: 'demotion', magnitude: downCount };
  }
  if (upCount && downCount) {
    return { direction: 'mixed', magnitude: upCount + downCount };
  }
  return { direction: null, magnitude: 0 };
}

// ============================================================================
// Role parsing ("Line 1", "Line 2", "PP 1", "PP 2", "—")
// ============================================================================

function normalizeRole(role) {
  if (!role) return null;
  const s = role.trim().toLowerCase();
  if (s === '—' || s === '-' || s === '' || s === 'n/a') return null;

  // "Line N"
  const lineMatch = s.match(/line\s*(\d+)/);
  if (lineMatch) {
    return { type: 'line', n: parseInt(lineMatch[1], 10) };
  }

  // "PP N"
  const ppMatch = s.match(/pp\s*(\d+)/);
  if (ppMatch) {
    return { type: 'power_play_unit', n: parseInt(ppMatch[1], 10) };
  }

  return { type: 'other', raw: role.trim() };
}

function normalizeDate(dateStr) {
  // LWL uses YYYY-MM-DD format
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return dateStr.trim();
}

// ============================================================================
// Summary helpers
// ============================================================================

/**
 * Group changes by team for easy lookup.
 * @returns {Object} { [team]: { evenStrength: [...], powerPlay: [...] } }
 */
export function byTeam(parsed) {
  const out = {};
  for (const row of parsed.evenStrength) {
    out[row.team] = out[row.team] || { evenStrength: [], powerPlay: [] };
    out[row.team].evenStrength.push(row);
  }
  for (const row of parsed.powerPlay) {
    out[row.team] = out[row.team] || { evenStrength: [], powerPlay: [] };
    out[row.team].powerPlay.push(row);
  }
  return out;
}

/**
 * Find the most recent line change for a specific player.
 * Useful for "is player X still on line 1?" lookups.
 */
export function latestChangeForPlayer(parsed, playerName, section = 'even_strength') {
  const rows = section === 'even_strength'
    ? parsed.evenStrength
    : parsed.powerPlay;
  const matches = rows.filter(r =>
    r.player.toLowerCase() === playerName.toLowerCase()
  );
  if (!matches.length) return null;
  return matches.sort((a, b) =>
    new Date(b.date) - new Date(a.date)
  )[0];
}

/**
 * Build the current Power Play 1 and Power Play 2 rosters per team based
 * on the most recent changes. This is the "PP1/PP2 unit" used by the
 * per-game model's special teams composite.
 */
export function currentPowerPlayUnits(parsed) {
  const byTeamMap = byTeam(parsed);
  const out = {};

  for (const [team, data] of Object.entries(byTeamMap)) {
    // For each player, find their most recent PP change
    const byPlayer = {};
    for (const row of data.powerPlay) {
      const existing = byPlayer[row.player];
      if (!existing || new Date(row.date) > new Date(existing.date)) {
        byPlayer[row.player] = row;
      }
    }

    const pp1 = [];
    const pp2 = [];
    for (const row of Object.values(byPlayer)) {
      if (row.newRole?.type === 'power_play_unit') {
        if (row.newRole.n === 1) pp1.push(row.player);
        else if (row.newRole.n === 2) pp2.push(row.player);
      }
    }

    out[team] = { pp1, pp2, lastUpdate: Object.values(byPlayer).reduce(
      (latest, r) => !latest || new Date(r.date) > new Date(latest)
        ? r.date : latest, null
    ) };
  }

  return out;
}
