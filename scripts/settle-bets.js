#!/usr/bin/env node
// ============================================================================
// SETTLE BETS
// ============================================================================
// For every OPEN bet in data/derived/bets/, checks if the relevant game or
// series has completed. If so, computes the outcome (won/lost/void) and
// PnL, and marks the bet settled.
//
// Runs on the same cron as the playoff results workflow.
//
// Usage:
//   node scripts/settle-bets.js
// ============================================================================

import { listOpenBets, settleBet, summarizeBets } from '../src/bets/logger.js';
import { loadState } from '../src/state/series.js';
import { americanToDecimal } from '../src/engine/odds.js';

// ============================================================================
// Determine outcome for a given market + side
// ============================================================================

function determineOutcome(bet, seriesState) {
  if (seriesState.status !== 'complete') {
    return { outcome: 'pending' };
  }

  const { market, side } = bet;
  const winner = seriesState.seriesWinner;
  const totalGames = seriesState.gamesPlayed.length;

  // Series winner markets
  if (market === 'seriesWinner' || market === 'series_winner') {
    if (side === winner) return { outcome: 'won' };
    return { outcome: 'lost' };
  }

  // Total games markets
  if (market === 'seriesTotalGames' || market === 'total_games') {
    // Side is like "over5.5" or "under6.5" or "over55"
    const m = String(side).match(/(over|under)[-_]?(\d+)[-_.]?(\d+)?/i);
    if (!m) return { outcome: 'void', note: `Unparseable side: ${side}` };
    const direction = m[1].toLowerCase();
    const line = parseFloat(m[3] ? `${m[2]}.${m[3]}` : `${m[2]}.5`);

    if (totalGames === line) return { outcome: 'void' }; // push
    const isOver = totalGames > line;
    const betWon = direction === 'over' ? isOver : !isOver;
    return { outcome: betWon ? 'won' : 'lost' };
  }

  // Goes 7
  if (market === 'goesSeven' || market === 'goes_seven') {
    const yes = totalGames === 7;
    const wantYes = String(side).toLowerCase().includes('yes');
    return { outcome: (yes === wantYes) ? 'won' : 'lost' };
  }

  // Correct score
  if (market === 'correctScore' || market === 'correct_score') {
    // Side: e.g. "BOS_4_3" or "TOR in 6"
    const winsA = seriesState.winsA;
    const winsB = seriesState.winsB;
    // Normalize side into (team, losingWins)
    const match = String(side).match(/(\w+)[_\s]+(?:in\s+)?(\d+)[_\s]*(\d+)?/i);
    if (!match) return { outcome: 'void', note: `Unparseable side: ${side}` };
    const sideTeam = match[1];
    const sideGames = match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10);
    const sideWinnerWins = 4;
    const sideLoserWins = match[3]
      ? parseInt(match[3], 10)
      : parseInt(match[2], 10) - 4;

    const actualLoserWins = seriesState.teamA === winner ? winsB : winsA;
    const won = sideTeam === winner && sideLoserWins === actualLoserWins;
    return { outcome: won ? 'won' : 'lost' };
  }

  return { outcome: 'void', note: `Unknown market: ${market}` };
}

function computePnl(bet, outcome) {
  if (outcome === 'won') {
    const decimal = americanToDecimal(bet.odds);
    return bet.stake * (decimal - 1);
  }
  if (outcome === 'lost') return -bet.stake;
  return 0; // void
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const openBets = await listOpenBets();
  if (openBets.length === 0) {
    console.log('[settle] No open bets');
    return;
  }

  console.log(`[settle] Checking ${openBets.length} open bet(s)...`);

  let settled = 0, stillPending = 0;
  for (const bet of openBets) {
    const seriesState = await loadState(bet.seriesId);
    if (!seriesState) {
      console.log(`[settle] ${bet.betId}: no series state found for ${bet.seriesId}`);
      continue;
    }

    const { outcome, note } = determineOutcome(bet, seriesState);

    if (outcome === 'pending') {
      stillPending++;
      continue;
    }

    const pnl = computePnl(bet, outcome);

    await settleBet({
      betId: bet.betId,
      outcome,
      pnl,
      actualResult: {
        winner: seriesState.seriesWinner,
        totalGames: seriesState.gamesPlayed.length,
      },
    });

    const pnlSign = pnl >= 0 ? '+' : '';
    console.log(
      `[settle] ${bet.betId}: ${outcome.toUpperCase()} ` +
      `(${pnlSign}$${pnl.toFixed(2)})${note ? ' — ' + note : ''}`
    );
    settled++;
  }

  console.log(`\n[settle] Settled ${settled}, still pending ${stillPending}`);

  // Summary
  const summary = await summarizeBets();
  if (summary.settled > 0) {
    const pnlSign = summary.totalPnl >= 0 ? '+' : '';
    console.log(
      `\n[settle] Lifetime: ${summary.settled} bets  ${summary.wins} W / ${summary.losses} L  ` +
      `hit=${(summary.hitRate * 100).toFixed(1)}%  ` +
      `ROI=${summary.roi >= 0 ? '+' : ''}${(summary.roi * 100).toFixed(1)}%  ` +
      `pnl=${pnlSign}$${summary.totalPnl.toFixed(2)}`
    );
    if (summary.avgClv !== null) {
      const clvSign = summary.avgClv >= 0 ? '+' : '';
      console.log(`[settle] Avg CLV vs Pinnacle: ${clvSign}${(summary.avgClv * 100).toFixed(2)}%`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
