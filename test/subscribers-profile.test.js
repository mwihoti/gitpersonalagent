'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const KEYS = ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'AIRTABLE_SUBSCRIBERS_TABLE', 'DAN_AGENT_DATA_DIR'];

async function load(t, env, dbStub = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-profile-'));
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  // Empty strings, not deletions: config.js re-reads .env for absent keys.
  Object.assign(process.env, { DAN_AGENT_DATA_DIR: dir, AIRTABLE_API_KEY: '', AIRTABLE_BASE_ID: '', AIRTABLE_SUBSCRIBERS_TABLE: '', DATABASE_URL: '' }, env);
  const dbPath = path.resolve(__dirname, '..', 'src', 'db.js');
  const savedDb = require.cache[dbPath];
  for (const mod of ['config', 'subscribers']) delete require.cache[path.resolve(__dirname, '..', 'src', `${mod}.js`)];
  if (dbStub) {
    delete require.cache[dbPath];
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: { isConfigured: () => true, isNetworkError: error => Boolean(error && error.networkish), query: dbStub },
    };
  }
  const prevFetch = global.fetch;
  t.after(async () => {
    global.fetch = prevFetch;
    if (dbStub) {
      if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    }
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return require('../src/subscribers');
}

const PROFILE = { github: { login: 'ada', languages: { rust: 0.6 } }, manual: { areas: ['lightning'] } };

test('a profile is stored on the subscriber, survives re-subscribing, and can be cleared (local store)', async t => {
  const subs = await load(t, {});
  await subs.upsertSubscriber({ chatId: 42, botId: 'b1', username: 'ada' });

  const saved = await subs.setSubscriberProfile(42, 'b1', PROFILE);
  assert.equal(saved.github.login, 'ada');
  assert.ok(saved.updatedAt);
  assert.equal((await subs.getSubscriber(42, 'b1')).profile.manual.areas[0], 'lightning');

  await subs.upsertSubscriber({ chatId: 42, botId: 'b1', username: 'ada_new' });
  const after = await subs.getSubscriber(42, 'b1');
  assert.equal(after.username, 'ada_new');
  assert.equal(after.profile.github.login, 'ada', 're-subscribing does not wipe the profile');
  assert.equal((await subs.readSubscribers('b1'))[0].profile.github.login, 'ada');

  assert.equal(await subs.setSubscriberProfile(42, 'b1', null), null);
  assert.equal((await subs.getSubscriber(42, 'b1')).profile, undefined);
});

test('saving a profile never creates a subscriber', async t => {
  const subs = await load(t, {});
  await assert.rejects(() => subs.setSubscriberProfile(999, 'b1', PROFILE), error => error instanceof subs.ProfileStorageError && error.code === 'not_subscribed');
  assert.deepEqual(await subs.readSubscribers(), []);
});

// ─── Database path (stubbed db module) ────────────────────────────────────────

const ROW = { chat_id: '42', bot_id: 'b1', username: 'ada', subscribed_at: '2026-01-01T00:00:00Z', profile: JSON.stringify(PROFILE) };

test('on the database the profile is saved with an UPDATE of that one column, never an insert', async t => {
  const calls = [];
  const subs = await load(t, {}, async (text, params) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    return /^SELECT/i.test(text) ? [ROW] : [];
  });

  await subs.setSubscriberProfile(42, 'b1', PROFILE);

  const update = calls.find(call => /^UPDATE/i.test(call.text));
  assert.match(update.text, /^UPDATE subscribers SET profile = \$1 WHERE chat_id = \$2 AND bot_id = \$3$/);
  assert.equal(JSON.parse(update.params[0]).github.login, 'ada');
  assert.deepEqual(update.params.slice(1), ['42', 'b1']);
  assert.ok(!calls.some(call => /INSERT/i.test(call.text)), 'no row is created');

  const read = await subs.getSubscriber(42, 'b1');
  assert.equal(read.profile.github.login, 'ada', 'the stored JSON is parsed back');

  calls.length = 0;
  await subs.setSubscriberProfile(42, 'b1', null);
  assert.equal(calls.find(call => /^UPDATE/i.test(call.text)).params[0], null, 'clearing stores NULL');
});

test('re-subscribing on the database leaves the profile column out of the write', async t => {
  const calls = [];
  const subs = await load(t, {}, async (text, params) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    return /^SELECT/i.test(text) ? [ROW] : [];
  });

  await subs.upsertSubscriber({ chatId: 42, botId: 'b1', username: 'ada_new' });

  const write = calls.find(call => /^(UPDATE|INSERT)/i.test(call.text));
  assert.match(write.text, /^UPDATE subscribers SET/);
  assert.ok(!/profile/i.test(write.text), 'the profile column is never part of a subscription write');
  assert.ok(write.params.includes('ada_new'));
  assert.ok(write.params.includes('2026-01-01T00:00:00Z'), 'subscribed_at is preserved');
});

test('database errors surface, and saving for a stranger says not_subscribed', async t => {
  const broken = await load(t, {}, async text => {
    if (/^SELECT/i.test(text)) return [ROW];
    throw new Error('relation "subscribers" does not exist');
  });
  await assert.rejects(() => broken.setSubscriberProfile(42, 'b1', PROFILE), /relation "subscribers" does not exist/);

  const empty = await load(t, {}, async () => []);
  await assert.rejects(() => empty.setSubscriberProfile(7, 'b1', PROFILE), error => error instanceof empty.ProfileStorageError && error.code === 'not_subscribed');

  // A network failure falls back to the local store instead of erroring.
  const offline = await load(t, {}, async () => { throw Object.assign(new Error('fetch failed'), { networkish: true }); });
  await offline.upsertSubscriber({ chatId: 9, botId: 'b1', username: 'offline' });
  assert.equal((await offline.readSubscribers('b1'))[0].username, 'offline');
});
