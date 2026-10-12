'use strict';
// Durable subscriber storage.
//
// Uses Airtable when AIRTABLE_API_KEY + AIRTABLE_BASE_ID are set (required for
// serverless/webhook deployments where the filesystem is ephemeral), and falls
// back to a local JSON file for local development or when Airtable is briefly
// unreachable.
//
// Airtable table: `Subscribers` (override with AIRTABLE_SUBSCRIBERS_TABLE)
//   ChatId (single line text)  ← unique key
//   Type (single line text)
//   Title (single line text)
//   Username (single line text)
//   First Name (single line text)
//   Last Name (single line text)
//   Subscribed At (single line text — ISO timestamp)
//   Last Seen At (single line text — ISO timestamp)
//   Profile (long text — JSON, optional): GitHub-derived skills and anything the
//     person set with /skills. Written with PATCH only, so it works even when
//     the base cannot create new records. Create the column with
//     `npm run setup -- --subscribers`.
const config = require('./config');

// `fs`/`path` are pulled in lazily so the Airtable path stays runtime-agnostic
// (Cloudflare Workers and other edge runtimes have no filesystem). Only the
// local-development fallback touches them.
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

function airtableEnabled() {
  return Boolean(config.airtable.apiKey && config.airtable.baseId);
}

function isNetworkError(error) {
  const code = error && typeof error === 'object' ? error.code : '';
  const name = error && typeof error === 'object' ? error.name : '';
  return (
    name === 'TimeoutError' ||
    ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
  );
}

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

// ─── Record <-> Airtable field mapping ───────────────────────────────────────

function toRecord(recordId, fields = {}) {
  return {
    recordId,
    chatId: normalizeChatId(fields.ChatId),
    botId: String(fields.BotId || '').trim(),
    type: fields.Type || '',
    title: fields.Title || '',
    username: fields.Username || '',
    firstName: fields['First Name'] || '',
    lastName: fields['Last Name'] || '',
    subscribedAt: fields['Subscribed At'] || '',
    lastSeenAt: fields['Last Seen At'] || '',
    profile: parseProfile(fields.Profile),
  };
}

function toFields(record) {
  const fields = {
    ChatId: normalizeChatId(record.chatId),
    BotId: String(record.botId || '').trim(),
    Type: record.type || '',
    Title: record.title || '',
    Username: record.username || '',
    'First Name': record.firstName || '',
    'Last Name': record.lastName || '',
    'Subscribed At': record.subscribedAt || '',
    'Last Seen At': record.lastSeenAt || '',
  };
  // Only sent when the caller supplies one, so tables without the column keep
  // working and re-subscribing never wipes a profile.
  if (record.profile !== undefined) fields.Profile = record.profile ? JSON.stringify(record.profile) : '';
  return fields;
}

// A chat is identified by (botId, chatId): the same person messaging two bots is
// two separate subscriptions, and each bot may only message its own.
function sameSubscription(record, chatId, botId) {
  if (normalizeChatId(record.chatId) !== normalizeChatId(chatId)) return false;
  const recordBot = String(record.botId || '').trim();
  const wantedBot = String(botId || '').trim();
  // Records written before multi-bot support have no BotId; they belong to the
  // primary bot, which is the only bot that existed when they were created.
  if (!recordBot) return true;
  if (!wantedBot) return true;
  return recordBot === wantedBot;
}

// ─── Airtable REST helpers ────────────────────────────────────────────────────

function airtableUrl(suffix = '') {
  const table = encodeURIComponent(config.airtable.subscribersTable);
  return `https://api.airtable.com/v0/${config.airtable.baseId}/${table}${suffix}`;
}

async function airtableRequest(method, suffix, body) {
  const res = await fetch(airtableUrl(suffix), {
    method,
    headers: {
      Authorization: `Bearer ${config.airtable.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`Airtable ${method} ${res.status}: ${text.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  if (method === 'DELETE') return res.json().catch(() => ({}));
  return res.json();
}

async function airtableReadAll() {
  const records = [];
  let offset;
  do {
    const query = new URLSearchParams({ pageSize: '100' });
    if (offset) query.set('offset', offset);
    const data = await airtableRequest('GET', `?${query.toString()}`);
    for (const row of data.records || []) {
      records.push(toRecord(row.id, row.fields));
    }
    offset = data.offset;
  } while (offset);
  return records.filter((item) => item.chatId);
}

async function airtableFind(chatId, botId) {
  const normalized = normalizeChatId(chatId);
  const formula = `{ChatId}="${normalized.replace(/"/g, '\\"')}"`;
  const query = new URLSearchParams({
    filterByFormula: formula,
    // The same chat can be subscribed to several bots, so filter by chat in
    // Airtable and pick the right bot's row here.
    pageSize: '100',
  });
  const data = await airtableRequest('GET', `?${query.toString()}`);
  const rows = (data.records || []).map((row) => toRecord(row.id, row.fields));
  return rows.find((row) => sameSubscription(row, normalized, botId)) || null;
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
  if (airtableEnabled()) {
    try {
      records = await airtableReadAll();
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      console.warn(`  Subscribers: Airtable unavailable, reading local store (${error.message})`);
    }
  }
  if (!records) records = await localReadAll();

  const wanted = String(botId || '').trim();
  if (!wanted) return records;
  return records.filter((item) => sameSubscription(item, item.chatId, wanted));
}

async function upsertSubscriber(record) {
  const chatId = normalizeChatId(record.chatId);
  if (!chatId) throw new Error('Cannot subscribe a chat without an id');

  const now = new Date().toISOString();

  if (airtableEnabled()) {
    try {
      const existing = await airtableFind(chatId, record.botId);
      const merged = {
        ...record,
        chatId,
        subscribedAt: existing?.subscribedAt || record.subscribedAt || now,
        lastSeenAt: now,
      };
      const fields = toFields(merged);
      if (existing) {
        const updated = await airtableRequest('PATCH', `/${existing.recordId}`, {
          fields,
          typecast: true,
        });
        return toRecord(updated.id, updated.fields);
      }
      const created = await airtableRequest('POST', '', {
        records: [{ fields }],
        typecast: true,
      });
      const row = created.records[0];
      return toRecord(row.id, row.fields);
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      console.warn(`  Subscribers: Airtable write failed, using local store (${error.message})`);
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

  if (airtableEnabled()) {
    try {
      const existing = await airtableFind(normalized, botId);
      if (!existing) return false;
      await airtableRequest('DELETE', `/${existing.recordId}`);
      return true;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      console.warn(`  Subscribers: Airtable delete failed, using local store (${error.message})`);
    }
  }

  return localRemove(normalized, botId);
}

async function getSubscriber(chatId, botId) {
  const chat = normalizeChatId(chatId);
  if (!chat) return null;
  if (airtableEnabled()) {
    try {
      return await airtableFind(chat, botId);
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }
  const records = await localReadAll();
  return records.find((item) => sameSubscription(item, chat, botId)) || null;
}

// Saves (or, with null, clears) a subscriber's profile. The subscriber must
// already exist; this never creates a row, so it keeps working when the base is
// at its record limit.
async function setSubscriberProfile(chatId, botId, profile) {
  const chat = normalizeChatId(chatId);
  const value = profile && typeof profile === 'object' ? { ...profile, updatedAt: new Date().toISOString() } : null;

  if (airtableEnabled()) {
    try {
      const existing = await airtableFind(chat, botId);
      if (!existing) throw new ProfileStorageError('not_subscribed', 'Subscribe first');
      await airtableRequest('PATCH', `/${existing.recordId}`, {
        fields: { Profile: value ? JSON.stringify(value) : '' },
        typecast: true,
      });
      return value;
    } catch (error) {
      if (error instanceof ProfileStorageError) throw error;
      if (/UNKNOWN_FIELD_NAME|Unknown field name/i.test(String(error.message))) {
        throw new ProfileStorageError('missing_column', 'The Subscribers table has no "Profile" column');
      }
      if (!isNetworkError(error)) throw error;
      console.warn(`  Subscribers: Airtable profile write failed, using local store (${error.message})`);
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
  getSubscriber,
  setSubscriberProfile,
  readSubscribers,
  upsertSubscriber,
  removeSubscriber,
  normalizeChatId,
};
