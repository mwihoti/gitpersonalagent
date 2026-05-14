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
        parse_mode: 'Markdown',
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

// ─── Unified send (WhatsApp first, Telegram as fallback) ─────────────────────

async function sendNotification(message) {
  const sent = await sendWhatsApp(message);
  if (!sent) {
    await sendTelegram(message);
  }
}

// ─── Message formatter ────────────────────────────────────────────────────────

function buildDigestMessage(digest) {
  const count = digest.contest_digest.length;

  const items = digest.contest_digest
    .map((item, i) => `${i + 1}. [${(item.effort || 'med').toUpperCase()}] ${item.opportunity}\n   → ${item.repo}`)
    .join('\n');

  const news = Array.isArray(digest.tech_news_summary)
    ? digest.tech_news_summary.slice(0, 3).map(n => `• ${n}`).join('\n')
    : digest.tech_news_summary || '';

  return `*Repository Intelligence Digest* ${digest.date}

Found *${count} implementation opportunities*:

${items}

📌 *Plan:* ${digest.quick_plan}

📰 *Signal summary:*
${news}

Open the dashboard for code skeletons, issue context, and team notes.`;
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
