'use strict';
// API access control.
//
// Two kinds of credential open the dashboard API:
//   - the owner key (DAN_AGENT_API_KEY), if one is set, and
//   - personal keys the Telegram bot issues with /dashboard, one per
//     subscriber, stored hashed on their subscriber row.
// With no owner key and no cloud storage configured (local development),
// everything stays open, as it always did.
const config = require('./config');
const db = require('./db');
const { sendJson } = require('./http');

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // token → { at, access }

function getApiKey() {
  return String(config.dashboard.apiKey || '').trim();
}

function getRequestApiKey(req) {
  const headerValue = req.headers['x-api-key'];
  if (headerValue) return String(headerValue).trim();

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

// Who this request is, or null: { role: 'owner' } for the configured key and
// open local development, { role: 'subscriber', chatId, username } for a key
// the bot issued.
async function resolveAccess(req) {
  const ownerKey = getApiKey();
  const token = getRequestApiKey(req);

  if (!ownerKey && !db.isConfigured()) return { role: 'owner', open: true };
  if (ownerKey && token === ownerKey) return { role: 'owner' };
  if (!token) return null;

  const cached = cache.get(token);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.access;

  let access = null;
  try {
    const { findSubscriberByDashboardKey } = require('./subscribers');
    const subscriber = await findSubscriberByDashboardKey(token);
    if (subscriber) {
      access = { role: 'subscriber', chatId: subscriber.chatId, username: subscriber.username || '' };
    }
  } catch (error) {
    console.warn(`  Auth: key lookup failed (${error.message})`);
    return null; // storage trouble must fail closed, not open
  }
  // Both hits and misses are cached, so a flood of bad keys cannot turn into a
  // flood of database lookups.
  cache.set(token, { at: Date.now(), access });
  if (cache.size > 500) cache.clear();
  return access;
}

async function isAuthorizedRequest(req) {
  return Boolean(await resolveAccess(req));
}

// Returns the access object, or false after answering 401.
async function requireApiAuth(req, res) {
  const access = await resolveAccess(req);
  if (access) return access;

  res.setHeader('WWW-Authenticate', 'Bearer realm="Dan Agent API"');
  sendJson(res, 401, {
    error: 'Unauthorized. Send /dashboard to the Telegram bot to get your personal key, then enter it under Workspace access.',
  });
  return false;
}

module.exports = {
  getApiKey,
  getRequestApiKey,
  isAuthorizedRequest,
  requireApiAuth,
  resolveAccess,
};
