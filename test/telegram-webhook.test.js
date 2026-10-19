'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

const BOT_A = '111111:AAAA';   // botId 111111
const BOT_B = '222222:BBBB';   // botId 222222

async function withHandler(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-webhook-'));
  const saved = {};
  for (const key of [
    'DAN_AGENT_DATA_DIR',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'AIRTABLE_API_KEY',
    'AIRTABLE_BASE_ID',
  ]) {
    saved[key] = process.env[key];
  }
  const prevFetch = global.fetch;

  process.env.DAN_AGENT_DATA_DIR = dir;
  // Pin to empty strings rather than deleting: src/config.js loads .env at
  // require time and only fills variables that are absent, so a developer's
  // real Airtable key must not leak into the test run.
  process.env.AIRTABLE_API_KEY = '';
  process.env.DATABASE_URL = '';
  process.env.AIRTABLE_BASE_ID = '';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'topsecret';
  if (!process.env.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = BOT_A;

  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  for (const mod of [
    '../src/config',
    '../src/bots',
    '../src/subscribers',
    '../src/whatsapp',
    '../api/telegram',
  ]) {
    delete require.cache[require.resolve(mod)];
  }
  const handler = require('../api/telegram');

  try {
    await fn(handler, calls);
  } finally {
    global.fetch = prevFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('webhook rejects requests with a wrong secret token', async () => {
  await withHandler(async (handler) => {
    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      body: { message: { chat: { id: 1, type: 'private' }, text: '/status' } },
    };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  });
});

test('webhook accepts a valid update and always answers 200', async () => {
  await withHandler(async (handler, calls) => {
    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'topsecret' },
      body: { message: { chat: { id: 42, type: 'private' }, text: '/status' } },
    };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
  });
});

test('webhook rejects non-POST methods', async () => {
  await withHandler(async (handler) => {
    const res = mockRes();
    await handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 405);
  });
});

test('/scan is handed to GitHub Actions instead of running in the request', async () => {
  const prevRepo = process.env.GITHUB_DISPATCH_REPO;
  const prevToken = process.env.GITHUB_DISPATCH_TOKEN;
  const prevChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.GITHUB_DISPATCH_REPO = 'someone/danagent';
  process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test';
  // Admin chat, so the subscriber check passes without hitting Airtable. Must be
  // set before withHandler() re-requires config, which caches it at load time.
  process.env.TELEGRAM_CHAT_ID = '42';

  try {
    await withHandler(async (handler, calls) => {
      const req = {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'topsecret' },
        body: {
          message: {
            chat: { id: 42, type: 'private' },
            text: '/scan goodfirst',
          },
        },
      };
      const res = mockRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);

      // workflow_dispatch is preferred: it needs only Actions: write, whereas
      // repository_dispatch needs the broader Contents: write.
      const dispatch = calls.find((c) =>
        c.url.includes(
          '/repos/someone/danagent/actions/workflows/telegram-scan.yml/dispatches',
        ),
      );
      assert.ok(dispatch, 'expected a workflow_dispatch call');

      const payload = JSON.parse(dispatch.opts.body);
      assert.equal(payload.ref, 'main');
      assert.equal(payload.inputs.scan_mode, 'goodfirst');
      assert.equal(payload.inputs.chat_id, '42');

      // The broader-permission endpoint must not be touched once the first
      // attempt succeeds.
      assert.equal(
        calls.filter((c) => c.url.endsWith('/repos/someone/danagent/dispatches')).length,
        0,
        'repository_dispatch should not be called when workflow_dispatch works',
      );
    });
  } finally {
    if (prevRepo === undefined) delete process.env.GITHUB_DISPATCH_REPO;
    else process.env.GITHUB_DISPATCH_REPO = prevRepo;
    if (prevToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = prevToken;
    if (prevChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChatId;
  }
});

test('each bot replies through its own token', async () => {
  const prevToken2 = process.env.TELEGRAM_BOT_TOKEN_2;
  process.env.TELEGRAM_BOT_TOKEN_2 = BOT_B;

  try {
    await withHandler(async (handler, calls) => {
      const send = (botParam) =>
        handler(
          {
            method: 'POST',
            url: `/api/telegram?bot=${botParam}`,
            headers: { 'x-telegram-bot-api-secret-token': 'topsecret' },
            body: {
              message: { chat: { id: 7, type: 'private' }, text: '/status' },
            },
          },
          mockRes(),
        );

      await send('222222');
      const viaB = calls.filter((c) => c.url.includes(`/bot${BOT_B}/sendMessage`));
      assert.equal(viaB.length, 1, 'bot B should answer with bot B token');
      assert.equal(
        calls.filter((c) => c.url.includes(`/bot${BOT_A}/sendMessage`)).length,
        0,
        'bot A must not answer a message sent to bot B',
      );

      calls.length = 0;
      await send('111111');
      assert.equal(
        calls.filter((c) => c.url.includes(`/bot${BOT_A}/sendMessage`)).length,
        1,
        'bot A should answer with bot A token',
      );
    });
  } finally {
    if (prevToken2 === undefined) delete process.env.TELEGRAM_BOT_TOKEN_2;
    else process.env.TELEGRAM_BOT_TOKEN_2 = prevToken2;
  }
});

test('subscriptions are scoped per bot', async () => {
  const prevToken2 = process.env.TELEGRAM_BOT_TOKEN_2;
  process.env.TELEGRAM_BOT_TOKEN_2 = BOT_B;

  try {
    await withHandler(async (handler) => {
      // Subscribe chat 9 to bot B only.
      await handler(
        {
          method: 'POST',
          url: '/api/telegram?bot=222222',
          headers: { 'x-telegram-bot-api-secret-token': 'topsecret' },
          body: { message: { chat: { id: 9, type: 'private' }, text: '/start' } },
        },
        mockRes(),
      );

      const { readSubscribers } = require('../src/subscribers');
      const onB = await readSubscribers('222222');
      const onA = await readSubscribers('111111');

      assert.equal(onB.length, 1, 'bot B should have the subscriber');
      assert.equal(onB[0].chatId, '9');
      assert.equal(onA.length, 0, 'bot A must not inherit bot B subscribers');
    });
  } finally {
    if (prevToken2 === undefined) delete process.env.TELEGRAM_BOT_TOKEN_2;
    else process.env.TELEGRAM_BOT_TOKEN_2 = prevToken2;
  }
});
