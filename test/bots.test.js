'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN_2', 'TELEGRAM_BOTS'];

function load(t, env, getMe) {
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKEN_2: '', TELEGRAM_BOTS: '' }, env);
  for (const mod of ['config', 'bots']) delete require.cache[path.resolve(__dirname, '..', 'src', `${mod}.js`)];
  const calls = [];
  const prevFetch = global.fetch;
  global.fetch = async url => {
    calls.push(String(url));
    return getMe(String(url));
  };
  t.after(() => {
    global.fetch = prevFetch;
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });
  return { bots: require('../src/bots'), calls };
}

test('publicBotUsername asks getMe once for the primary bot and caches the answer', async t => {
  const { bots, calls } = load(t, { TELEGRAM_BOT_TOKEN: '111:AAA', TELEGRAM_BOT_TOKEN_2: '222:BBB' },
    async () => ({ ok: true, json: async () => ({ ok: true, result: { username: 'btc_opensource_projects_bot' } }) }));

  assert.equal(await bots.publicBotUsername(), 'btc_opensource_projects_bot');
  assert.equal(await bots.publicBotUsername(), 'btc_opensource_projects_bot');
  assert.equal(calls.length, 1, 'cached after the first call');
  assert.match(calls[0], /bot111:AAA\/getMe$/, 'the primary bot, not the second');
});

test('publicBotUsername returns empty for no token, failures, and odd values, without caching them', async t => {
  const none = load(t, {}, async () => { throw new Error('should not be called'); });
  assert.equal(await none.bots.publicBotUsername(), '');
  assert.equal(none.calls.length, 0);

  let answer = async () => { throw new Error('network down'); };
  const flaky = load(t, { TELEGRAM_BOT_TOKEN: '111:AAA' }, url => answer(url));
  assert.equal(await flaky.bots.publicBotUsername(), '');
  answer = async () => ({ ok: true, json: async () => ({ ok: true, result: { username: 'bad name!' } }) });
  assert.equal(await flaky.bots.publicBotUsername(), '', 'suspicious usernames are dropped');
  answer = async () => ({ ok: true, json: async () => ({ ok: true, result: { username: 'good_bot' } }) });
  assert.equal(await flaky.bots.publicBotUsername(), 'good_bot', 'a failure is not cached, so recovery works');
  assert.equal(flaky.calls.length, 3);
});
