#!/usr/bin/env node
// ============================================================================
// Add Tandem-v1 option to model toggle + fix goalie dropdown name lookups
// ============================================================================

import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';

// Goalie ID -> name map (for dropdown rendering)
const GOALIE_NAMES = {
  '8480045': 'Ukko-Pekka Luukkonen',
  'unknown': 'Levi',
  '8480280': 'Jeremy Swayman',
  '8476999': 'Linus Ullmark',
  '8479979': 'Joonas Korpisalo',
  '8476883': 'Andrei Vasilevskiy',
  '8476347': 'Jonas Johansson',
  '8483434': 'Jakub Dobes',
  '8482245': 'Samuel Montembeault',
  '8475883': 'Frederik Andersen',
  '8480888': 'Brandon Bussi',
  '8475790': 'James Reimer',
  '8477293': 'Tristan Jarry',
  '8477979': 'Stuart Skinner',
  '8480046': 'Arturs Silovs',
  '8479193': 'Dan Vladar',
  '8479360': 'Samuel Ersson',
  '8478406': 'Mackenzie Blackwood',
  '8477465': 'Scott Wedgewood',
  '8475311': 'Darcy Kuemper',
  '8476341': 'Anton Forsberg',
  '8479973': 'Jake Oettinger',
  '8478024': 'Casey DeSmith',
  '8483432': 'Jesper Wallstedt',
  '8479406': 'Filip Gustavsson',
  '8479882': 'Carter Hart',
  '8478492': 'Adin Hill',
  '8478075': 'Karel Vejmelka',
  '8477970': 'Vitek Vanecek',
  '8478233': 'Connor Ingram',
  '8477293-EDM': 'Tristan Jarry',
  '8475717': 'Lukas Dostal',
  '8476905': 'Ville Husso',
};

async function main() {
  let html = await fs.readFile(HTML_PATH, 'utf-8');
  await fs.writeFile(HTML_PATH + '.bak_tandem', html);
  console.log('[tandem-ui] Backup saved');
  
  // 1. Add 'tandem' option to the model <select>
  const oldSelect = '<option value="goals">Goals-v2</option></select>';
  const newSelect = '<option value="goals">Goals-v2</option><option value="tandem">Tandem-v1</option></select>';
  if (html.includes(oldSelect)) {
    html = html.replace(oldSelect, newSelect);
    console.log('[tandem-ui] Added Tandem-v1 to dropdown');
  } else {
    console.warn('[tandem-ui] Could not find select to add tandem option - trying alt pattern');
    // Alt: look for <option value="goals">
    const altOld = '<option value="goals">Goals-v2</option>';
    if (html.includes(altOld)) {
      html = html.replace(altOld, altOld + '<option value="tandem">Tandem-v1</option>');
      console.log('[tandem-ui] Added via alt pattern');
    }
  }
  
  // 2. Update the ensemble hint text
  html = html.replace(
    '60% xG + 40% goals',
    '40% xG + 30% Goals + 30% Tandem'
  );
  
  // 3. Inject goalie name lookup - add a constant near top of script
  const goalieNamesConst = `\nconst GOALIE_NAME_LOOKUP = ${JSON.stringify(GOALIE_NAMES, null, 2)};\n`;
  
  // Find a safe place to inject - right after VENUE_SEQUENCE declaration
  const anchor = "const VENUE_SEQUENCE = ['A','A','B','B','A','B','A'];";
  if (!html.includes('GOALIE_NAME_LOOKUP')) {
    html = html.replace(anchor, anchor + goalieNamesConst);
    console.log('[tandem-ui] Added GOALIE_NAME_LOOKUP constant');
  }
  
  // 4. Update the dropdown option rendering to use GOALIE_NAME_LOOKUP
  // Find current option render and replace the fallback from "Goalie ${id}" to lookup
  
  const oldFallback1 = "series.currentStarters[series.teamA].playerId == id ? series.currentStarters[series.teamA].name : 'Goalie ' + id";
  const newFallback1 = "series.currentStarters[series.teamA].playerId == id ? series.currentStarters[series.teamA].name : (series.backupGoalies && series.backupGoalies[series.teamA] && series.backupGoalies[series.teamA].playerId == id ? series.backupGoalies[series.teamA].name : (series.backupGoalies && series.backupGoalies[series.teamB] && series.backupGoalies[series.teamB].playerId == id ? series.backupGoalies[series.teamB].name : (series.currentStarters[series.teamB].playerId == id ? series.currentStarters[series.teamB].name : (GOALIE_NAME_LOOKUP[id] || ('Goalie ' + id)))))";
  
  const oldFallback2 = "series.currentStarters[series.teamB].playerId == id ? series.currentStarters[series.teamB].name : 'Goalie ' + id";
  const newFallback2 = "series.currentStarters[series.teamB].playerId == id ? series.currentStarters[series.teamB].name : (series.backupGoalies && series.backupGoalies[series.teamB] && series.backupGoalies[series.teamB].playerId == id ? series.backupGoalies[series.teamB].name : (series.backupGoalies && series.backupGoalies[series.teamA] && series.backupGoalies[series.teamA].playerId == id ? series.backupGoalies[series.teamA].name : (series.currentStarters[series.teamA].playerId == id ? series.currentStarters[series.teamA].name : (GOALIE_NAME_LOOKUP[id] || ('Goalie ' + id)))))";
  
  let fixed = 0;
  if (html.includes(oldFallback1)) { html = html.split(oldFallback1).join(newFallback1); fixed++; }
  if (html.includes(oldFallback2)) { html = html.split(oldFallback2).join(newFallback2); fixed++; }
  console.log(`[tandem-ui] Fixed ${fixed} dropdown name fallback(s)`);
  
  await fs.writeFile(HTML_PATH, html);
  console.log('[tandem-ui] \u2713 Done');
}

main().catch(err => {
  console.error('[tandem-ui] FAILED:', err.message);
  process.exit(1);
});
