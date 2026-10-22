'use strict';
// Durable subscriber storage: Neon Postgres, with the local JSON fallback for
// development and network blips. (Previously Airtable; the interface and the
// local file format are unchanged.)
//
// Table `subscribers`:
//   chat_id + bot_id  the key: the same person on two bots is two
//                     subscriptions, and each bot may only message its own
//   profile           JSON: GitHub-derived skills and what the person set with
//                     /skills — written only by setSubscriberProfile, so
//                     re-subscribing never wipes it
const crypto = require('crypto');
const db = require('./db');

function nodeFs() {
  return require('fs/promises');
}

function localPaths() {
  const path = require('path');
  const dir =
    process.env.DAN_AGENT_DATA_DIR ||
    (process.env.VERCEL
      ? path.join('/tmp', 'danagent-data')
      : path.join(__dirname, '..', 'data'));
  return { dir, file: path.join(dir, 'telegram-subscribers.json') };
}

let localWriteQueue = Promise.resolve();

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

function parseProfile(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Thrown when a profile cannot be saved for a reason the caller can act on.
class ProfileStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A chat is identified by (botId, chatId). Records written before multi-bot
// support have no botId; they belong to the primary bot.
function sameSubscription(record, chatId, botId) {
  if (normalizeChatId(record.chatId) !== normalizeChatId(chatId)) return false;
  const recordBot = String(record.botId || '').trim();
  const wantedBot = String(botId || '').trim();
  if (!recordBot) return true;
  if (!wantedBot) return true;
  return recordBot === wantedBot;
}

function recordFromRow(row) {
  return {
    chatId: normalizeChatId(row.chat_id),
    botId: String(row.bot_id || '').trim(),
    type: row.type || '',
    title: row.title || '',
    username: row.username || '',
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    subscribedAt: row.subscribed_at || '',
    lastSeenAt: row.last_seen_at || '',
    ...(row.profile ? { profile: parseProfile(row.profile) } : {}),
  };
}

async function dbReadAll() {
  const rows = await db.query('SELECT * FROM subscribers');
  return rows.map(recordFromRow).filter((item) => item.chatId);
}

async function dbFind(chatId, botId) {
  const rows = await db.query('SELECT * FROM subscribers WHERE chat_id = $1', [normalizeChatId(chatId)]);
  return rows.map(recordFromRow).find((row) => sameSubscription(row, chatId, botId)) || null;
}

// ─── Local file fallback ──────────────────────────────────────────────────────

async function ensureLocalStore() {
  const fs = nodeFs();
  const { dir, file } = localPaths();
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, '[]\n', 'utf8');
  }
}

async function localReadAll() {
  await ensureLocalStore();
  const raw = await nodeFs().readFile(localPaths().file, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.map((item) => ({ ...item, chatId: normalizeChatId(item.chatId) }))
    : [];
}

async function localWriteAll(records) {
  await ensureLocalStore();
  await nodeFs().writeFile(
    localPaths().file,
    `${JSON.stringify(records, null, 2)}\n`,
    'utf8',
  );
}

function serializeLocalWrite(task) {
  const next = localWriteQueue.then(task, task);
  localWriteQueue = next.catch(() => {});
  return next;
}

async function localUpsert(record) {
  return serializeLocalWrite(async () => {
    const records = await localReadAll();
    const idx = records.findIndex((item) =>
      sameSubscription(item, record.chatId, record.botId),
    );
    if (idx === -1) {
      records.push(record);
    } else {
      records[idx] = { ...records[idx], ...record };
    }
    await localWriteAll(records);
    return record;
  });
}

async function localRemove(chatId, botId) {
  const normalized = normalizeChatId(chatId);
  return serializeLocalWrite(async () => {
    const records = await localReadAll();
    const next = records.filter(
      (item) => !sameSubscription(item, normalized, botId),
    );
    await localWriteAll(next);
    return next.length !== records.length;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

// botId scopes the result to one bot's audience. Omit it to get every
// subscription across all bots.
async function readSubscribers(botId) {
  let records;
  if (db.isConfigured()) {
    try {
      records = await dbReadAll();
    } catch (error) {
      if (!db.isNetworkError(error)) throw error;
      console.warn(`  Subscribers: database unavailable, reading local store (${error.message})`);
    }
  }
  if (!records) records = await localReadAll();

  const wanted = String(botId || '').trim();
  if (!wanted) return records;
  return records.filter((item) => sameSubscription(item, item.chatId, wanted));
}

async function getSubscriber(chatId, botId) {
  const chat = normalizeChatId(chatId);
  if (!chat) return null;
  if (db.isConfigured()) {
    try {
      return await dbFind(chat, botId);
    } catch (error) {
      if (!db.isNetworkError(error)) throw error;
    }
  }
  const records = await localReadAll();
  return records.find((item) => sameSubscription(item, chat, botId)) || null;
}

async function upsertSubscriber(record) {
  const chatId = normalizeChatId(record.chatId);
  if (!chatId) throw new Error('Cannot subscribe a chat without an id');

  const now = new Date().toISOString();

  if (db.isConfigured()) {
    try {
      const existing = await dbFind(chatId, record.botId);
      const merged = {
        ...record,
        chatId,
        botId: String(record.botId || '').trim(),
        subscribedAt: existing?.subscribedAt || record.subscribedAt || now,
        lastSeenAt: now,
      };
      const params = [
        merged.chatId, merged.botId, merged.type || '', merged.title || '',
        merged.username || '', merged.firstName || '', merged.lastName || '',
        merged.subscribedAt, merged.lastSeenAt,
      ];
      if (existing) {
        // The profile column is deliberately not touched: re-subscribing must
        // never wipe what the person taught the bot.
        await db.query(
          `UPDATE subscribers SET chat_id = $1, bot_id = $2, type = $3, title = $4, username = $5,
             first_name = $6, last_name = $7, subscribed_at = $8, last_seen_at = $9
           WHERE chat_id = $10 AND bot_id = $11`,
          [...params, existing.chatId, existing.botId],
        );
      } else {
        await db.query(
          `INSERT INTO subscribers (chat_id, bot_id, type, title, username, first_name, last_name, subscribed_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (chat_id, bot_id) DO UPDATE SET type = $3, title = $4, username = $5,
             first_name = $6, last_name = $7, last_seen_at = $9`,
          params,
        );
      }
      return (await dbFind(chatId, record.botId)) || merged;
    } catch (error) {
      if (!db.isNetworkError(error)) throw error;
      console.warn(`  Subscribers: database write failed, using local store (${error.message})`);
    }
  }

  return localUpsert({
    ...record,
    chatId,
    subscribedAt: record.subscribedAt || now,
    lastSeenAt: now,
  });
}

async function removeSubscriber(chatId, botId) {
  const normalized = normalizeChatId(chatId);
  if (!normalized) return false;

  if (db.isConfigured()) {
    try {
      const existing = await dbFind(normalized, botId);
      if (!existing) return false;
      await db.query('DELETE FROM subscribers WHERE chat_id = $1 AND bot_id = $2', [existing.chatId, existing.botId]);
      return true;
    } catch (error) {
      if (!db.isNetworkError(error)) throw error;
      console.warn(`  Subscribers: database delete failed, using local store (${error.message})`);
    }
  }

  return localRemove(normalized, botId);
}

// ─── Personal dashboard keys ──────────────────────────────────────────────────
// A subscriber asks the bot for a key (/dashboard); the key opens the web
// dashboard. Only a SHA-256 hash is stored, so a leaked database never leaks
// usable keys, and issuing a new key silently revokes the old one.

function hashDashboardKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function issueDashboardKey(chatId, botId) {
  const chat = normalizeChatId(chatId);
  const token = `wk_${crypto.randomBytes(16).toString('hex')}`;
  const hash = hashDashboardKey(token);

  if (db.isConfigured()) {
    try {
      const existing = await dbFind(chat, botId);
      if (!existing) throw new ProfileStorageError('not_subscribed', 'Subscribe first');
      await db.query(
        'UPDATE subscribers SET dashboard_key = $1 WHERE chat_id = $2 AND bot_id = $3',
        [hash, existing.chatId, existing.botId],
      );
      return token;
    } catch (error) {
      if (error instanceof ProfileStorageError) throw error;
      if (!db.isNetworkError(error)) throw error;
      console.warn(`  Subscribers: database key write failed, using local store (${error.message})`);
    }
  }

  return serializeLocalWrite(async () => {
    const records = await localReadAll();
    const index = records.findIndex((item) => sameSubscription(item, chat, botId));
    if (index === -1) throw new ProfileStorageError('not_subscribed', 'Subscribe first');
    records[index] = { ...records[index], dashboardKey: hash };
    await localWriteAll(records);
    return token;
  });
}

// The subscriber a dashboard key belongs to, or null. Used by the API auth.
async function findSubscriberByDashboardKey(token) {
  const clean = String(token || '').trim();
  if (!/^wk_[0-9a-f]{32}$/.test(clean)) return null;
  const hash = hashDashboardKey(clean);

  if (db.isConfigured()) {
    try {
      const rows = await db.query('SELECT * FROM subscribers WHERE dashboard_key = $1 LIMIT 1', [hash]);
      return rows.length ? recordFromRow(rows[0]) : null;
    } catch (error) {
      if (!db.isNetworkError(error)) throw error;
    }
  }

  const records = await localReadAll();
  const match = records.find((item) => item.dashboardKey === hash);
  return match ? { ...match, dashboardKey: undefined } : null;
}

// Saves (or, with null, clears) a subscriber's profile. The subscriber must
// already exist; this never creates a row.
async function setSubscriberProfile(chatId, botId, profile) {
  const chat = normalizeChatId(chatId);
  const value = profile && typeof profile === 'object' ? { ...profile, updatedAt: new Date().toISOString() } : null;

  if (db.isConfigured()) {
    try {
      const existing = await dbFind(chat, botId);
      if (!existing) throw new ProfileStorageError('not_subscribed', 'Subscribe first');
      await db.query(
        'UPDATE subscribers SET profile = $1 WHERE chat_id = $2 AND bot_id = $3',
        [value ? JSON.stringify(value) : null, existing.chatId, existing.botId],
      );
      return value;
    } catch (error) {
      if (error instanceof ProfileStorageError) throw error;
      if (!db.isNetworkError(error)) throw error;
      console.warn(`  Subscribers: database profile write failed, using local store (${error.message})`);
    }
  }

  return serializeLocalWrite(async () => {
    const records = await localReadAll();
    const index = records.findIndex((item) => sameSubscription(item, chat, botId));
    if (index === -1) throw new ProfileStorageError('not_subscribed', 'Subscribe first');
    if (value) records[index] = { ...records[index], profile: value };
    else delete records[index].profile;
    await localWriteAll(records);
    return value;
  });
}

module.exports = {
  ProfileStorageError,
  findSubscriberByDashboardKey,
  issueDashboardKey,
  getSubscriber,
  setSubscriberProfile,
  readSubscribers,
  upsertSubscriber,
  removeSubscriber,
  normalizeChatId,
};
