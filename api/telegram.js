'use strict';
// Telegram webhook endpoint.
//
// Telegram POSTs each incoming message here, so the bot responds without a
// persistent long-polling process — no always-on host required.
//
// Every command path is designed to finish in milliseconds:
//   /start /stop /status /help  → a couple of Telegram API calls + Airtable
//   /scan                       → handed to GitHub Actions (6h budget), never
//                                 run inside the request
//
// Required env:
//   TELEGRAM_BOT_TOKEN        the bot token
//   TELEGRAM_WEBHOOK_SECRET   shared secret; Telegram echoes it in a header
// For /scan (recommended):
//   GITHUB_DISPATCH_REPO      owner/repo holding .github/workflows/telegram-scan.yml
//   GITHUB_DISPATCH_TOKEN     PAT with contents:write
const { handleTelegramUpdate } = require('../src/whatsapp');
const { isDispatchConfigured, dispatchScan } = require('../src/scan-dispatch');
const { resolveBot } = require('../src/bots');
const { allowOptions, readJsonBody, sendJson } = require('../src/http');

// Vercel freezes the sandbox once the response is sent; waitUntil keeps
// background work alive. Optional so local/dev and other hosts still work.
let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch {
  vercelWaitUntil = null;
}

function background(promise) {
  const guarded = Promise.resolve(promise).catch((e) =>
    console.error('Background task failed:', e.message),
  );
  if (typeof vercelWaitUntil === 'function') {
    try {
      vercelWaitUntil(guarded);
    } catch {
      /* not in a Vercel request context — the promise still runs */
    }
  }
  return guarded;
}

function scanModeLabel(mode) {
  if (mode === 'all') return 'all open issues';
  if (mode === 'goodfirst') return 'good first issues';
  if (mode === 'medium') return 'medium-effort issues';
  return 'top prioritized issues';
}

// Called by handleTelegramUpdate for /scan. Returns a status message that is
// relayed to the requester.
async function triggerScan({ scanMode = 'default', chatId = '', botId = '', opportunityLimit = 0 } = {}) {
  if (isDispatchConfigured()) {
    await dispatchScan({ scanMode, chatId, botId, limit: opportunityLimit });
    return {
      message: `Queued a ${scanModeLabel(scanMode)} scan on GitHub Actions. The digest lands here when it finishes — usually a few minutes.`,
    };
  }

  // Fallback when Actions dispatch isn't configured: run in the background,
  // bounded by the function's maxDuration. Long scans can be cut short here,
  // which is exactly why dispatch is the recommended setup.
  const { runScan } = require('../src/run-scan');
  background(
    runScan({ trigger: `telegram-${scanMode}`, scanMode, dedupe: false, opportunityLimit }),
  );
  return {
    message:
      'Running the scan now. Note: set GITHUB_DISPATCH_REPO and GITHUB_DISPATCH_TOKEN so long scans run on GitHub Actions instead of timing out.',
  };
}

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== expectedSecret) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
  }

  // Each bot registers its own webhook URL (…/api/telegram?bot=<botId>), which
  // is how one deployment can serve several bots and still reply through the
  // right one. No ?bot= means the primary bot, so single-bot setups are
  // unaffected.
  const url = new URL(req.url, 'http://localhost');
  const bot = resolveBot(url.searchParams.get('bot'));
  if (!bot) {
    console.error(`Telegram webhook: unknown bot "${url.searchParams.get('bot')}"`);
    return sendJson(res, 200, { ok: true });
  }

  let update;
  try {
    update = await readJsonBody(req);
  } catch {
    // Malformed body — ack so Telegram stops retrying, but do nothing.
    return sendJson(res, 200, { ok: true });
  }

  try {
    await handleTelegramUpdate(update, triggerScan, bot);
  } catch (e) {
    // Never turn an error into a non-200: Telegram would retry the update and
    // the user would get duplicate replies. Log and acknowledge instead.
    console.error('Telegram webhook error:', e.message);
  }

  return sendJson(res, 200, { ok: true });
};

module.exports.triggerScan = triggerScan;
