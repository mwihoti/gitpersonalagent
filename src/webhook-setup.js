'use strict';
// Registers and inspects Telegram webhooks for every configured bot.
//
// Shared by scripts/set-webhook.js (run from a shell with a .env) and
// api/setup-webhook.js (run inside the deployment, using its own env). The
// second path exists because hosts such as Vercel can mark variables as
// sensitive: they cannot be downloaded, so the only place that knows both the
// bot tokens and the webhook secret is the deployment itself.

const { listBots } = require('./bots');

const ALLOWED_UPDATES = ['message', 'callback_query'];

function api(token, method, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  }).then(res => res.json());
}

async function describeBot(bot) {
  try {
    const me = await api(bot.token, 'getMe');
    return me.ok && me.result ? `@${me.result.username}` : `bot ${bot.botId}`;
  } catch {
    return `bot ${bot.botId}`;
  }
}

function webhookUrl(baseUrl, bot) {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/telegram?bot=${bot.botId}`;
}

// Current registration per bot. Never includes tokens or the secret.
async function webhookInfo({ baseUrl = '' } = {}) {
  const bots = listBots();
  const out = [];
  for (const bot of bots) {
    const info = await api(bot.token, 'getWebhookInfo').catch(error => ({ ok: false, description: error.message }));
    const result = info.result || {};
    const expected = baseUrl ? webhookUrl(baseUrl, bot) : '';
    const allowed = result.allowed_updates || [];
    out.push({
      bot: await describeBot(bot),
      botId: bot.botId,
      isPrimary: bot.isPrimary,
      url: result.url || '',
      pointsHere: expected ? result.url === expected : null,
      allowedUpdates: allowed,
      // Buttons need callback_query; an empty list means Telegram's default, which excludes nothing we need.
      buttonsEnabled: !allowed.length || allowed.includes('callback_query'),
      pendingUpdates: result.pending_update_count || 0,
      lastError: result.last_error_message || '',
      lastErrorAt: result.last_error_date ? new Date(result.last_error_date * 1000).toISOString() : '',
      error: info.ok === false ? info.description || 'getWebhookInfo failed' : '',
    });
  }
  return out;
}

// Point every bot at <baseUrl>/api/telegram?bot=<id>, signed with the secret.
async function registerWebhooks({ baseUrl, secret = process.env.TELEGRAM_WEBHOOK_SECRET, keepPending = true, setCommands = null } = {}) {
  if (!baseUrl) throw new Error('A deployment URL is required to register webhooks');
  const bots = listBots();
  if (!bots.length) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const results = [];
  for (const bot of bots) {
    const url = webhookUrl(baseUrl, bot);
    let result;
    try {
      result = await api(bot.token, 'setWebhook', {
        url,
        secret_token: secret || undefined,
        allowed_updates: ALLOWED_UPDATES,
        drop_pending_updates: !keepPending,
      });
    } catch (error) {
      result = { ok: false, description: error.message };
    }
    if (result.ok && typeof setCommands === 'function') {
      await Promise.resolve(setCommands(bot.token)).catch(() => null);
    }
    results.push({
      bot: await describeBot(bot),
      botId: bot.botId,
      url,
      ok: Boolean(result.ok),
      error: result.ok ? '' : result.description || 'setWebhook failed',
    });
  }

  return {
    ok: results.every(item => item.ok),
    signed: Boolean(secret),
    allowedUpdates: ALLOWED_UPDATES,
    bots: results,
  };
}

module.exports = {
  ALLOWED_UPDATES,
  describeBot,
  registerWebhooks,
  webhookInfo,
  webhookUrl,
};
