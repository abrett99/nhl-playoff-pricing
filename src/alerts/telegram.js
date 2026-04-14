// ============================================================================
// TELEGRAM ALERTS
// ============================================================================
// High-priority: edges, goalie changes, saved scenarios trigger → sound
// Medium:        routine updates                                 → silent
// Low:           pipeline health warnings                         → silent + rate-limited
//
// Built-in dedup: max 1 alert per series per 30min unless edge changes >2%.
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { ALERT_THRESHOLDS } from '../config.js';
import { isoTimestamp } from '../engine/util.js';

const ALERT_LOG_PATH = path.resolve(process.cwd(), 'data', 'derived', 'alert_log.json');

// ============================================================================
// Core send
// ============================================================================

/**
 * Send a Telegram message. Returns the response or null on failure.
 * Never throws — failed alerts shouldn't crash the pipeline.
 */
export async function sendTelegram(text, { priority = 'normal', markdown = true } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — alert dropped');
    return null;
  }

  const body = {
    chat_id: chatId,
    text,
    disable_notification: priority === 'low' || priority === 'medium',
    disable_web_page_preview: true,
  };
  if (markdown) body.parse_mode = 'MarkdownV2';

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[telegram] sendMessage failed: ${resp.status} ${text}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error('[telegram] network error:', e.message);
    return null;
  }
}

/** Escape MarkdownV2 special characters */
export function escapeMarkdown(text) {
  // Chars that need escaping in MarkdownV2: _*[]()~`>#+-=|{}.!
  return String(text).replace(/([_*\[\]()~`>#+=\-|{}.!])/g, '\\$1');
}

// ============================================================================
// Dedup state (persisted across runs via JSON)
// ============================================================================

async function loadAlertLog() {
  try {
    return JSON.parse(await fs.readFile(ALERT_LOG_PATH, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { recentAlerts: {} };
    throw e;
  }
}

async function saveAlertLog(log) {
  await fs.mkdir(path.dirname(ALERT_LOG_PATH), { recursive: true });
  await fs.writeFile(ALERT_LOG_PATH, JSON.stringify(log, null, 2));
}

/**
 * Check dedup log. Returns true if the alert should fire, false if suppressed.
 * Updates the log if allowed.
 *
 * @param {string} key - Unique identifier for this alert category+target
 *                       e.g. "edge:2025-R1-M1:over55"
 * @param {number} [currentEdge] - For edge alerts, allows re-alert if edge changed >2%
 */
async function shouldAlert(key, currentEdge) {
  const log = await loadAlertLog();
  const now = Date.now();
  const cooldownMs = ALERT_THRESHOLDS.RE_ALERT_COOLDOWN_MINUTES * 60 * 1000;

  const prev = log.recentAlerts[key];

  if (prev) {
    const age = now - prev.timestamp;
    if (age < cooldownMs) {
      // Within cooldown. Allow re-alert only if edge changed significantly.
      if (currentEdge !== undefined && prev.edge !== undefined) {
        const edgeDelta = Math.abs(currentEdge - prev.edge);
        if (edgeDelta < ALERT_THRESHOLDS.EDGE_CHANGE_PCT_FOR_RE_ALERT) {
          return false;
        }
      } else {
        return false;
      }
    }
  }

  log.recentAlerts[key] = { timestamp: now, edge: currentEdge ?? null };

  // Bound log size
  const cutoff = now - 7 * 24 * 60 * 60 * 1000; // keep 7 days
  for (const [k, v] of Object.entries(log.recentAlerts)) {
    if (v.timestamp < cutoff) delete log.recentAlerts[k];
  }

  await saveAlertLog(log);
  return true;
}

// ============================================================================
// Alert formatters
// ============================================================================

/**
 * Edge detected on a series market.
 * @param {Object} params
 * @param {string} params.seriesId
 * @param {string} params.teamA
 * @param {string} params.teamB
 * @param {string} params.marketName  - "Series Total Games (O 5.5)"
 * @param {number} params.modelProb
 * @param {number} params.bookAmerican
 * @param {number} params.edgePct     - 0.082 = 8.2%
 * @param {string} params.currentState - "2-1 CAR"
 * @param {string} [params.dashboardUrl]
 */
export async function alertEdge(params) {
  const key = `edge:${params.seriesId}:${params.marketName}`;
  if (!(await shouldAlert(key, params.edgePct))) return { suppressed: true };

  const sign = params.edgePct >= 0 ? '+' : '';
  const emoji = params.edgePct >= 0.08 ? '🔥' : '🎯';

  const text = [
    `${emoji} *Edge detected*`,
    '',
    `${escapeMarkdown(params.teamA)} vs ${escapeMarkdown(params.teamB)} · ${escapeMarkdown(params.currentState)}`,
    `*${escapeMarkdown(params.marketName)}*`,
    `Book: ${escapeMarkdown(formatAmerican(params.bookAmerican))}`,
    `Fair: ${escapeMarkdown((params.modelProb * 100).toFixed(1))}%`,
    `Edge: *${escapeMarkdown(sign + (params.edgePct * 100).toFixed(1))}%*`,
    params.dashboardUrl ? `\n[Open dashboard](${params.dashboardUrl})` : '',
  ].filter(Boolean).join('\n');

  return sendTelegram(text, { priority: 'high' });
}

/**
 * Confirmed goalie change mid-series.
 */
export async function alertGoalieChange(params) {
  const key = `goalie:${params.seriesId}:${params.team}:${params.newGoalie}`;
  if (!(await shouldAlert(key))) return { suppressed: true };

  const lines = [
    `🥅 *Goalie change confirmed*`,
    '',
    `${escapeMarkdown(params.team)} G${params.gameNum} starter: *${escapeMarkdown(params.newGoalie)}* \\(was ${escapeMarkdown(params.previousGoalie)}\\)`,
    '',
  ];
  if (params.priceImpact) {
    lines.push('*Series price impact:*');
    for (const [market, { before, after }] of Object.entries(params.priceImpact)) {
      lines.push(`• ${escapeMarkdown(market)}: ${escapeMarkdown(formatAmerican(before))} → ${escapeMarkdown(formatAmerican(after))}`);
    }
    lines.push('');
  }
  if (params.newEdges?.length) {
    lines.push('*New edges unlocked:*');
    for (const e of params.newEdges) {
      const sign = e.edgePct >= 0 ? '+' : '';
      lines.push(`• ${escapeMarkdown(e.marketName)}: *${escapeMarkdown(sign + (e.edgePct * 100).toFixed(1))}%*`);
    }
  }
  if (params.dashboardUrl) {
    lines.push(`\n[Open dashboard](${params.dashboardUrl})`);
  }

  return sendTelegram(lines.join('\n'), { priority: 'high' });
}

/**
 * Saved scenario crossed its edge threshold.
 */
export async function alertSavedScenario(params) {
  const key = `scenario:${params.scenarioId}:${params.marketName}`;
  if (!(await shouldAlert(key, params.edgePct))) return { suppressed: true };

  const sign = params.edgePct >= 0 ? '+' : '';
  const text = [
    `💡 *Saved scenario triggered*`,
    '',
    `"${escapeMarkdown(params.scenarioName)}"`,
    `${escapeMarkdown(params.marketName)} now *${escapeMarkdown(sign + (params.edgePct * 100).toFixed(1))}%* edge at ${escapeMarkdown(formatAmerican(params.bookAmerican))}`,
    params.dashboardUrl ? `\n[Open dashboard](${params.dashboardUrl})` : '',
  ].filter(Boolean).join('\n');

  return sendTelegram(text, { priority: 'high' });
}

/**
 * Pipeline health warning.
 */
export async function alertPipelineHealth(params) {
  const key = `health:${params.source}:${params.status}`;
  if (!(await shouldAlert(key))) return { suppressed: true };

  const text = [
    `⚠️ *Pipeline warning*`,
    '',
    `Source: \`${escapeMarkdown(params.source)}\``,
    `Status: ${escapeMarkdown(params.status)}`,
    params.detail ? `Detail: ${escapeMarkdown(params.detail)}` : '',
    params.ageHours ? `Last successful pull: ${escapeMarkdown(params.ageHours.toFixed(1))}h ago` : '',
  ].filter(Boolean).join('\n');

  return sendTelegram(text, { priority: 'low' });
}

/**
 * Bet placed confirmation (user-triggered, not automatic).
 */
export async function alertBetLogged(params) {
  const text = [
    `✅ *Bet logged*`,
    '',
    `${escapeMarkdown(params.seriesLabel)}`,
    `${escapeMarkdown(params.marketName)} · ${escapeMarkdown(params.side)}`,
    `${escapeMarkdown(formatAmerican(params.odds))} · $${escapeMarkdown(String(params.stake))}`,
    `Edge at placement: *${escapeMarkdown(((params.edgeAtPlacement) * 100).toFixed(1))}%*`,
    `Book: ${escapeMarkdown(params.book)}`,
  ].join('\n');
  return sendTelegram(text, { priority: 'medium' });
}

// ============================================================================
// Helpers
// ============================================================================

function formatAmerican(odds) {
  if (odds === undefined || odds === null) return '—';
  const n = Math.round(Number(odds));
  return n > 0 ? `+${n}` : String(n);
}
