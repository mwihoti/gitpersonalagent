'use strict';
const config = require('./config');

// ─── WhatsApp via CallMeBot ───────────────────────────────────────────────────

async function sendWhatsApp(message) {
  const { phone, apiKey } = config.whatsapp;
  if (!phone || !apiKey) return false;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      console.log('  WhatsApp notification sent');
      return true;
    }
    console.warn(`  WhatsApp failed: ${res.status}`);
    return false;
  } catch (e) {
    console.warn(`  WhatsApp error: ${e.message}`);
    return false;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return false;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      console.log('  Telegram notification sent');
      return true;
    }
    const err = await res.json();
    console.warn(`  Telegram failed: ${err.description}`);
    return false;
  } catch (e) {
    console.warn(`  Telegram error: ${e.message}`);
    return false;
  }
}

// ─── Unified send (Telegram first, WhatsApp as fallback) ─────────────────────

async function sendNotification(message) {
  const sent = await sendTelegram(message);
  if (!sent) {
    await sendWhatsApp(message);
  }
}

// ─── Message formatter ────────────────────────────────────────────────────────

const TELEGRAM_MESSAGE_LIMIT = 3900;

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, limit) {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function effortLabel(value) {
  const effort = cleanText(value || 'medium').toLowerCase();
  if (effort === 'low') return 'LOW';
  if (effort === 'high') return 'HIGH';
  return 'MED';
}

function formatOpportunity(item, index) {
  const lines = [
    `${index + 1}. [${effortLabel(item.effort)}] ${truncate(item.opportunity, 90)}`,
    `Repo: ${cleanText(item.repo) || 'Unknown repo'}`,
  ];

  if (item.issue_url) {
    lines.push(`Issue: ${cleanText(item.issue_url)}`);
  }

  if (item.why_it_qualifies) {
    lines.push(`Why: ${truncate(item.why_it_qualifies, 180)}`);
  }

  if (item.suggested_action) {
    lines.push(`Next: ${truncate(item.suggested_action, 220)}`);
  }

  if (item.clarity_tip) {
    lines.push(`Check: ${truncate(item.clarity_tip, 100)}`);
  }

  return lines.join('\n');
}

function fitMessage(message, footer) {
  if (message.length <= TELEGRAM_MESSAGE_LIMIT) return message;

  const allowed = TELEGRAM_MESSAGE_LIMIT - footer.length - 2;
  return `${message.slice(0, Math.max(0, allowed)).trim()}\n\n${footer}`;
}

function buildDigestMessage(digest) {
  const opportunities = Array.isArray(digest.contest_digest)
    ? digest.contest_digest
    : [];
  const count = opportunities.length;
  const shown = opportunities.slice(0, 8);

  const items = shown.length
    ? shown.map(formatOpportunity).join('\n\n')
    : 'No implementation opportunities were returned in this scan.';

  const news = Array.isArray(digest.tech_news_summary)
    ? digest.tech_news_summary.slice(0, 4).map(n => `- ${truncate(n, 180)}`).join('\n')
    : truncate(digest.tech_news_summary || '', 500);

  const hiddenCount = count - shown.length;
  const hiddenLine = hiddenCount > 0
    ? `\n\nShowing top ${shown.length}. ${hiddenCount} more are saved in the dashboard.`
    : '';

  const footer = 'Open the dashboard for full code skeletons, issue context, and team notes.';
  const message = `Repository Intelligence Digest
Date: ${cleanText(digest.date) || new Date().toISOString().slice(0, 10)}
Opportunities found: ${count}

Top opportunities
${items}${hiddenLine}

Execution plan
${truncate(digest.quick_plan, 500)}

Signal summary
${news || '- No news summary returned.'}

${footer}`;

  return fitMessage(message, 'Message shortened. Open the dashboard for the full digest.');
}
// ─── Telegram command listener (long-polling) ────────────────────────────────
// Calls getUpdates in a loop. When it sees /scan from the authorized chatId,
// calls onScan(). Safe to run alongside the cron scheduler.

async function listenForCommands(onScan) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) {
    console.warn('Telegram bot not configured — command listener disabled');
    return;
  }

  let offset = 0;
  console.log(`Telegram bot listening for /scan in chat ${chatId}...`);
  await sendTelegram('Bot started. Send /scan to trigger a scan, /status to check.');

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
      if (!res.ok) { await sleep(5000); continue; }

      const { result } = await res.json();
      for (const update of result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || String(msg.chat.id) !== String(chatId)) continue;

        const text = (msg.text || '').trim().toLowerCase();
        if (text === '/scan' || text.startsWith('/scan ')) {
          await sendTelegram('Got it — starting scan now...');
          try {
            await onScan();
          } catch (e) {
            await sendTelegram(`Scan failed: ${e.message}`);
          }
        } else if (text === '/status') {
          await sendTelegram('Bot is running. Send /scan to trigger a scan.');
        } else if (text === '/start' || text === '/help') {
          await sendTelegram('Commands:\n/scan — run a scan now\n/status — check bot is alive');
        }
      }
    } catch (e) {
      if (e.name !== 'TimeoutError') console.warn('Poll error:', e.message);
      await sleep(3000);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { sendNotification, buildDigestMessage, listenForCommands };
