#!/usr/bin/env node
// ============================================================================
// TEST: Telegram Alerts
// ============================================================================
// Sends one of each alert type to verify Telegram integration works.
//
// ENV:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//
// Usage:
//   node scripts/test-telegram.js
//   node scripts/test-telegram.js --type edge
// ============================================================================

import {
  sendTelegram,
  alertEdge,
  alertGoalieChange,
  alertSavedScenario,
  alertPipelineHealth,
  alertBetLogged,
} from '../src/alerts/telegram.js';

const types = {
  basic: async () => sendTelegram('🏒 *Telegram integration test* — OK', {
    priority: 'medium',
  }),

  edge: async () => alertEdge({
    seriesId: '2025-R1-M1',
    teamA: 'BOS',
    teamB: 'TOR',
    marketName: 'Series Total Games O 5.5',
    modelProb: 0.614,
    bookAmerican: -110,
    edgePct: 0.082,
    currentState: '1-0 BOS',
    dashboardUrl: 'https://example.github.io/series/bos-tor',
  }),

  goalie: async () => alertGoalieChange({
    seriesId: '2025-R1-M1',
    team: 'TOR',
    gameNum: 3,
    previousGoalie: 'Stolarz',
    newGoalie: 'Woll',
    priceImpact: {
      'Series': { before: +130, after: +180 },
      'O 5.5': { before: -110, after: -130 },
    },
    newEdges: [
      { marketName: 'U 5.5', edgePct: 0.067 },
      { marketName: 'BOS series', edgePct: 0.048 },
    ],
    dashboardUrl: 'https://example.github.io/series/bos-tor',
  }),

  scenario: async () => alertSavedScenario({
    scenarioId: 'bos-tor-if-woll-starts',
    scenarioName: 'If Woll gets the net in Game 4',
    marketName: 'TOR series winner',
    edgePct: 0.073,
    bookAmerican: +180,
    dashboardUrl: 'https://example.github.io/series/bos-tor',
  }),

  health: async () => alertPipelineHealth({
    source: 'nst_team_sva',
    status: 'stale',
    detail: 'Last successful pull more than 18 hours ago',
    ageHours: 18.4,
  }),

  bet: async () => alertBetLogged({
    seriesLabel: 'BOS vs TOR R1M1',
    marketName: 'Series Total Games',
    side: 'OVER 5.5',
    odds: -110,
    stake: 125,
    edgeAtPlacement: 0.082,
    book: 'DraftKings',
  }),
};

async function main() {
  const args = process.argv.slice(2);
  const typeFlag = args.findIndex(a => a === '--type');
  const wanted = typeFlag >= 0 ? [args[typeFlag + 1]] : Object.keys(types);

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('⛔ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env var');
    console.error('');
    console.error('Setup:');
    console.error('  1. Open @BotFather in Telegram');
    console.error('  2. /newbot → pick a name → get your bot token');
    console.error('  3. Start a chat with your bot, send any message');
    console.error('  4. Visit https://api.telegram.org/bot<TOKEN>/getUpdates');
    console.error('  5. Find your chat.id in the response');
    console.error('  6. export TELEGRAM_BOT_TOKEN=...  TELEGRAM_CHAT_ID=...');
    process.exit(1);
  }

  for (const name of wanted) {
    const fn = types[name];
    if (!fn) {
      console.error(`Unknown type: ${name}. Valid: ${Object.keys(types).join(', ')}`);
      continue;
    }
    console.log(`Sending ${name}...`);
    const result = await fn();
    console.log(`  → ${result?.suppressed ? 'suppressed (dedup)' : result ? 'sent' : 'failed'}`);
    // Pause between to avoid rate limits
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('\nDone. Check Telegram for messages.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
