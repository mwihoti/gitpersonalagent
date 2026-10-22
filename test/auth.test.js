'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const KEYS = ['DAN_AGENT_API_KEY', 'DATABASE_URL', 'DAN_AGENT_DATA_DIR', 'AIRTABLE_API_KEY'];

async function load(t, { ownerKey = '', dbStub = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-auth-'));
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { DAN_AGENT_DATA_DIR: dir, DATABASE_URL: '', AIRTABLE_API_KEY: '' });
  if (ownerKey) process.env.DAN_AGENT_API_KEY = ownerKey;

  const dbPath = path.resolve(__dirname, '..', 'src', 'db.js');
  const savedDb = require.cache[dbPath];
  for (const mod of ['config', 'auth', 'subscribers']) delete require.cache[path.resolve(__dirname, '..', 'src', `${mod}.js`)];
  if (dbStub) {
    delete require.cache[dbPath];
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { isConfigured: () => true, isNetworkError: () => false, query: dbStub } };
  }
  t.after(async () => {
    if (dbStub) { if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath]; }
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { auth: require('../src/auth'), subscribers: require('../src/subscribers') };
}

function res() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = JSON.parse(body); } };
}

test('local development with no owner key and no database stays open', async t => {
  const { auth } = await load(t);
  const access = await auth.resolveAccess({ headers: {} });
  assert.equal(access.role, 'owner');
  assert.equal(await auth.isAuthorizedRequest({ headers: {} }), true);
});

test('the owner key works via X-API-Key and Bearer; a wrong key answers 401 pointing at the bot', async t => {
  const { auth } = await load(t, { ownerKey: 'secret-key' });

  assert.deepEqual(await auth.resolveAccess({ headers: { 'x-api-key': 'secret-key' } }), { role: 'owner' });
  assert.deepEqual(await auth.resolveAccess({ headers: { authorization: 'Bearer secret-key' } }), { role: 'owner' });

  const r = res();
  assert.equal(await auth.requireApiAuth({ headers: { authorization: 'Bearer wrong-key' } }, r), false);
  assert.match(r.body.error, /Send \/dashboard to the Telegram bot/);
  assert.equal(await auth.requireApiAuth({ headers: {} }, res()), false, 'no key is not open once an owner key exists');
});

test('a key issued by the bot opens the API as that subscriber, and reissuing revokes the old one', async t => {
  const { auth, subscribers } = await load(t, { ownerKey: 'owner-key' });
  await subscribers.upsertSubscriber({ chatId: '42', botId: '111', username: 'ada' });

  const token = await subscribers.issueDashboardKey('42', '111');
  assert.match(token, /^wk_[0-9a-f]{32}$/);

  const access = await auth.resolveAccess({ headers: { 'x-api-key': token } });
  assert.deepEqual(access, { role: 'subscriber', chatId: '42', username: 'ada' });

  const second = await subscribers.issueDashboardKey('42', '111');
  assert.notEqual(second, token);
  assert.equal(await subscribers.findSubscriberByDashboardKey(token), null, 'the old key is revoked');
  assert.equal((await subscribers.findSubscriberByDashboardKey(second)).chatId, '42');
  // The auth cache may remember the old key for up to a minute; the stored
  // truth is what the revocation test above asserts.
});

test('keys are stored hashed, and lookups reject junk without touching storage', async t => {
  const { subscribers } = await load(t);
  await subscribers.upsertSubscriber({ chatId: '7', botId: '111' });
  const token = await subscribers.issueDashboardKey('7', '111');

  const raw = JSON.parse(await fs.readFile(path.join(process.env.DAN_AGENT_DATA_DIR, 'telegram-subscribers.json'), 'utf8'));
  assert.ok(!JSON.stringify(raw).includes(token), 'the plaintext key is nowhere in storage');
  assert.match(raw[0].dashboardKey, /^[0-9a-f]{64}$/);

  assert.equal(await subscribers.findSubscriberByDashboardKey('nonsense'), null);
  assert.equal(await subscribers.findSubscriberByDashboardKey(''), null);
  await assert.rejects(() => subscribers.issueDashboardKey('999', '111'), error => error.code === 'not_subscribed');
});

test('on the database, issuing updates one column and lookup queries by hash', async t => {
  const calls = [];
  const ROW = { chat_id: '42', bot_id: '111', username: 'ada' };
  const { auth, subscribers } = await load(t, {
    ownerKey: 'owner-key',
    dbStub: async (text, params) => {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT \* FROM subscribers WHERE chat_id/.test(text)) return [ROW];
      if (/^SELECT \* FROM subscribers WHERE dashboard_key/.test(text)) return [{ ...ROW, dashboard_key: params[0] }];
      return [];
    },
  });

  const token = await subscribers.issueDashboardKey('42', '111');
  const update = calls.find(call => /^UPDATE subscribers SET dashboard_key/.test(call.text));
  assert.match(update.params[0], /^[0-9a-f]{64}$/);
  assert.ok(update.params[0] !== token);

  const access = await auth.resolveAccess({ headers: { 'x-api-key': token } });
  assert.equal(access.role, 'subscriber');
  const lookup = calls.find(call => /WHERE dashboard_key = \$1 LIMIT 1/.test(call.text));
  assert.ok(lookup, 'lookup goes through the indexed column');

  // Storage failure fails closed.
  const broken = await load(t, { ownerKey: 'k', dbStub: async () => { throw new Error('boom'); } });
  const prevWarn = console.warn; console.warn = () => {};
  try {
    assert.equal(await broken.auth.resolveAccess({ headers: { 'x-api-key': 'wk_' + 'a'.repeat(32) } }), null);
  } finally { console.warn = prevWarn; }
});
