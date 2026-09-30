'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN_2', 'TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_BASE_URL', 'DAN_AGENT_API_KEY', 'VERCEL_ENV', 'TELEGRAM_BOTS'];

function load(t, env, telegram) {
  const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  for (const key of ENV) delete process.env[key];
  Object.assign(process.env, env);
  for (const mod of ['config', 'bots', 'webhook-setup', 'auth', 'whatsapp']) {
    delete require.cache[path.resolve(__dirname, '..', 'src', `${mod}.js`)];
  }
  delete require.cache[path.resolve(__dirname, '..', 'api', 'setup-webhook.js')];

  const calls = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const [, token, method] = String(url).match(/bot([^/]+)\/(\w+)$/) || [];
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ token, method, body });
    return { ok: true, json: async () => telegram({ token, method, body }) };
  };
  t.after(() => {
    global.fetch = prevFetch;
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return { calls, handler: require('../api/setup-webhook'), setup: require('../src/webhook-setup') };
}

function respond() {
  const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  return res;
}

const twoBots = { TELEGRAM_BOT_TOKEN: '111:AAA', TELEGRAM_BOT_TOKEN_2: '222:BBB', TELEGRAM_WEBHOOK_SECRET: 's3cret' };

test('POST registers every bot to the deployment with the secret and callback queries', async t => {
  const { calls, handler } = load(t, { ...twoBots, PUBLIC_BASE_URL: 'https://app.example.com/' }, ({ method, token }) => {
    if (method === 'getMe') return { ok: true, result: { username: `bot${token.slice(0, 3)}` } };
    return { ok: true, result: true };
  });
  const res = respond();

  await handler({ method: 'POST', headers: { host: 'evil.example.net', 'x-forwarded-host': 'attacker.example' }, url: '/api/setup-webhook' }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.signed, true);
  assert.equal(res.body.baseUrl, 'https://app.example.com');
  const sets = calls.filter(c => c.method === 'setWebhook');
  assert.deepEqual(sets.map(c => c.body.url), [
    'https://app.example.com/api/telegram?bot=111',
    'https://app.example.com/api/telegram?bot=222',
  ]);
  assert.ok(sets.every(c => c.body.secret_token === 's3cret'));
  assert.ok(sets.every(c => c.body.drop_pending_updates === false));
  assert.deepEqual(sets[0].body.allowed_updates, ['message', 'callback_query']);
  assert.ok(calls.some(c => c.method === 'setMyCommands'));
  assert.ok(!JSON.stringify(res.body).includes('AAA'), 'tokens never appear in the response');
  assert.ok(!JSON.stringify(res.body).includes('s3cret'), 'the secret never appears in the response');
});

test('without PUBLIC_BASE_URL the routed host is used and forwarded-host is ignored', async t => {
  const { calls, handler } = load(t, { TELEGRAM_BOT_TOKEN: '111:AAA' }, () => ({ ok: true, result: {} }));
  const res = respond();
  await handler({ method: 'POST', headers: { host: 'danpersonalagent.vercel.app', 'x-forwarded-host': 'attacker.example' }, url: '/' }, res);

  assert.equal(calls.find(c => c.method === 'setWebhook').body.url, 'https://danpersonalagent.vercel.app/api/telegram?bot=111');
  assert.equal(res.body.signed, false);
});

test('GET reports registration health; preview deployments and wrong keys are refused', async t => {
  const { handler } = load(t, { ...twoBots, PUBLIC_BASE_URL: 'https://app.example.com', DAN_AGENT_API_KEY: 'key', VERCEL_ENV: 'preview' }, ({ method, token }) => {
    if (method === 'getMe') return { ok: true, result: { username: 'b' } };
    if (method === 'getWebhookInfo') {
      return token.startsWith('111')
        ? { ok: true, result: { url: 'https://app.example.com/api/telegram?bot=111', allowed_updates: ['message'], pending_update_count: 3, last_error_message: 'Wrong response from the webhook: 401 Unauthorized', last_error_date: 1790000000 } }
        : { ok: true, result: { url: 'https://old.example.com/api/telegram?bot=222', allowed_updates: ['message', 'callback_query'] } };
    }
    return { ok: true, result: true };
  });

  const denied = respond();
  await handler({ method: 'GET', headers: { host: 'h' }, url: '/' }, denied);
  assert.equal(denied.statusCode, 401);

  const info = respond();
  await handler({ method: 'GET', headers: { host: 'h', 'x-api-key': 'key' }, url: '/' }, info);
  assert.equal(info.statusCode, 200);
  assert.equal(info.body.secretConfigured, true);
  const [first, second] = info.body.bots;
  assert.equal(first.pointsHere, true);
  assert.equal(first.buttonsEnabled, false);
  assert.equal(first.pendingUpdates, 3);
  assert.match(first.lastError, /401/);
  assert.equal(second.pointsHere, false);
  assert.equal(second.buttonsEnabled, true);

  const preview = respond();
  await handler({ method: 'POST', headers: { host: 'h', 'x-api-key': 'key' }, url: '/' }, preview);
  assert.equal(preview.statusCode, 409);
});

test('a Telegram failure for one bot is reported without hiding the other', async t => {
  const { setup } = load(t, twoBots, ({ method, token }) => {
    if (method === 'setWebhook' && token.startsWith('222')) return { ok: false, description: 'Unauthorized' };
    if (method === 'getMe') return { ok: true, result: { username: 'b' } };
    return { ok: true, result: true };
  });

  const result = await setup.registerWebhooks({ baseUrl: 'https://app.example.com' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.bots.map(b => [b.botId, b.ok, b.error]), [['111', true, ''], ['222', false, 'Unauthorized']]);
  await assert.rejects(() => setup.registerWebhooks({ baseUrl: '' }), /deployment URL is required/);
});
