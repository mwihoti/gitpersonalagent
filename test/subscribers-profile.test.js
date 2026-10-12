'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const KEYS = ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'AIRTABLE_SUBSCRIBERS_TABLE', 'DAN_AGENT_DATA_DIR'];

async function load(t, env) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-profile-'));
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { DAN_AGENT_DATA_DIR: dir }, env);
  for (const mod of ['config', 'subscribers']) delete require.cache[path.resolve(__dirname, '..', 'src', `${mod}.js`)];
  const prevFetch = global.fetch;
  t.after(async () => {
    global.fetch = prevFetch;
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

const AIRTABLE = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'app1', AIRTABLE_SUBSCRIBERS_TABLE: 'Subscribers' };

test('on Airtable the profile is saved with a PATCH of that one field, never a create', async t => {
  const subs = await load(t, AIRTABLE);
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: options.method, url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (options.method === 'GET') return { ok: true, json: async () => ({ records: [{ id: 'rec1', fields: { ChatId: '42', BotId: 'b1', Profile: JSON.stringify(PROFILE) } }] }) };
    return { ok: true, json: async () => ({ id: 'rec1', fields: {} }) };
  };

  await subs.setSubscriberProfile(42, 'b1', PROFILE);

  const patch = calls.find(call => call.method === 'PATCH');
  assert.match(patch.url, /\/Subscribers\/rec1$/);
  assert.deepEqual(Object.keys(patch.body.fields), ['Profile']);
  assert.equal(JSON.parse(patch.body.fields.Profile).github.login, 'ada');
  assert.ok(!calls.some(call => call.method === 'POST'), 'no record is created');

  const read = await subs.getSubscriber(42, 'b1');
  assert.equal(read.profile.github.login, 'ada', 'the stored JSON is parsed back');
});

test('re-subscribing on Airtable leaves the Profile column out of the write', async t => {
  const subs = await load(t, AIRTABLE);
  const writes = [];
  global.fetch = async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ records: [{ id: 'rec1', fields: { ChatId: '42', BotId: 'b1', 'Subscribed At': '2026-01-01T00:00:00Z' } }] }) };
    writes.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: 'rec1', fields: {} }) };
  };

  await subs.upsertSubscriber({ chatId: 42, botId: 'b1', username: 'ada' });
  assert.equal(writes.length, 1);
  assert.ok(!('Profile' in writes[0].fields), 'tables without the column keep working');
});

test('a missing Profile column is reported as such, and other Airtable errors surface', async t => {
  const subs = await load(t, AIRTABLE);
  let patchStatus = 422;
  let patchBody = '{"error":{"type":"UNKNOWN_FIELD_NAME","message":"Unknown field name: \\"Profile\\""}}';
  global.fetch = async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ records: [{ id: 'rec1', fields: { ChatId: '42', BotId: 'b1' } }] }) };
    return { ok: false, status: patchStatus, text: async () => patchBody };
  };

  await assert.rejects(() => subs.setSubscriberProfile(42, 'b1', PROFILE), error => error.code === 'missing_column');

  patchStatus = 500;
  patchBody = 'boom';
  await assert.rejects(() => subs.setSubscriberProfile(42, 'b1', PROFILE), /Airtable PATCH 500/);

  global.fetch = async (url, options) => (options.method === 'GET' ? { ok: true, json: async () => ({ records: [] }) } : { ok: true, json: async () => ({}) });
  await assert.rejects(() => subs.setSubscriberProfile(7, 'b1', PROFILE), error => error.code === 'not_subscribed');
});
