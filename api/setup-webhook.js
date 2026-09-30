'use strict';
// Lets the deployment register its own Telegram webhooks.
//
//   GET  /api/setup-webhook   → current registration per bot (no secrets)
//   POST /api/setup-webhook   → (re)register every bot to this deployment
//
// Useful when the bot tokens and webhook secret are stored as sensitive
// variables that cannot be copied to another machine: nothing leaves the host.
// Protected by DAN_AGENT_API_KEY like the rest of the dashboard API.
const { registerWebhooks, webhookInfo } = require('../src/webhook-setup');
const { setTelegramCommands } = require('../src/whatsapp');
const { requireApiAuth } = require('../src/auth');
const { allowOptions, sendJson } = require('../src/http');

// Prefer the configured public URL; otherwise use the host the request was
// routed on. Forwarded-host headers are ignored on purpose: a caller must not
// be able to point the bots (and their secret) at a URL of their choosing.
function resolveBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\//i.test(configured)) return configured;
  const host = String(req.headers.host || '').trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `https://${host}` : '';
}

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  const baseUrl = resolveBaseUrl(req);

  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        baseUrl,
        secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
        bots: await webhookInfo({ baseUrl }),
      });
    }

    if (req.method === 'POST') {
      if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
        return sendJson(res, 409, { error: `Refusing to register webhooks from a ${process.env.VERCEL_ENV} deployment. Call the production URL.` });
      }
      if (!baseUrl) {
        return sendJson(res, 400, { error: 'Could not determine the deployment URL. Set PUBLIC_BASE_URL.' });
      }
      // Pending updates are kept: an open endpoint must not be able to make the bot drop messages.
      const result = await registerWebhooks({ baseUrl, keepPending: true, setCommands: setTelegramCommands });
      return sendJson(res, result.ok ? 200 : 502, { baseUrl, ...result });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
