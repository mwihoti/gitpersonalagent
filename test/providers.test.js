'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const KEYS = ['GROQ_TPM', 'MODEL_RATE_LIMIT_WAIT_SECONDS', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'FALLBACK_API_KEY', 'FALLBACK_API_URL',
  'FALLBACK_MODELS', 'MODEL_PROVIDERS', 'GEMINI_MODELS', 'GROQ_MODELS', 'XAI_MODELS', 'GROK_MODELS'];

function setup(t, env, handler) {
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const prevFetch = global.fetch;
  const calls = [];
  require('../src/providers').resetProviderState();
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), model: body.model, body, auth: opts.headers.Authorization });
    return handler({ url: String(url), model: body.model, body });
  };
  t.after(() => {
    global.fetch = prevFetch;
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return calls;
}

const ok = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const fail = (status, text = 'nope') => ({ ok: false, status, text: async () => text });
const quiet = { log() {}, warn() {} };
const providers = require('../src/providers');

test('chain walks fallback models, then the next provider', async t => {
  const calls = setup(t, {
    GROQ_API_KEY: 'g',
    GROQ_MODELS: 'retired-model, second-model',
    XAI_API_KEY: 'x',
    XAI_MODELS: 'grok-a',
  }, ({ model }) => {
    if (model === 'retired-model') return fail(404, 'The model has been decommissioned');
    if (model === 'second-model') return fail(429, 'rate limited');
    return ok('{"answer":42}');
  });

  const result = await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });

  assert.deepEqual(calls.map(c => c.model), ['retired-model', 'second-model', 'grok-a']);
  assert.equal(result.provider, 'xai');
  assert.equal(result.model, 'grok-a');
  assert.deepEqual(result.value, { answer: 42 });
  assert.match(calls[2].url, /api\.x\.ai/);
  assert.equal(calls[2].auth, 'Bearer x');
  assert.deepEqual(calls[2].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.response_format, undefined);
});

test('a rejected key skips the whole provider; bad JSON moves to the next model', async t => {
  const calls = setup(t, {
    GEMINI_API_KEY: 'blocked',
    GEMINI_MODELS: 'gem-1,gem-2',
    GROQ_API_KEY: 'g',
    GROQ_MODELS: 'm1,m2',
  }, ({ url, model }) => {
    if (url.includes('googleapis')) return fail(403, 'Your project has been denied access');
    return model === 'm1' ? ok('not json at all') : ok('{"fine":true}');
  });

  const result = await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });

  assert.deepEqual(calls.map(c => c.model), ['gem-1', 'm1', 'm2']);
  assert.equal(result.model, 'm2');
});

test('MODEL_PROVIDERS reorders the chain and the generic fallback slot works', async t => {
  const calls = setup(t, {
    MODEL_PROVIDERS: 'fallback, grok, groq',
    GROK_API_KEY: 'x',
    GROQ_API_KEY: 'g',
    FALLBACK_API_KEY: 'or',
    FALLBACK_API_URL: 'https://openrouter.ai/api/v1/chat/completions',
    FALLBACK_MODELS: 'vendor/model-a',
  }, ({ url }) => (url.includes('openrouter') ? fail(500) : ok('{"from":"grok"}')));

  assert.deepEqual(providers.describeProviders().map(p => p.name), ['fallback', 'xai', 'groq']);
  const result = await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });

  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].model, 'vendor/model-a');
  assert.equal(result.provider, 'xai');
  assert.equal(calls.length, 2);
});

test('413 retries once with a compact payload; total failure lists every attempt', async t => {
  let first = true;
  const calls = setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'm1' }, () => {
    if (first) { first = false; return fail(413, 'too large'); }
    return fail(500, 'boom');
  });

  await assert.rejects(
    () => providers.runChain({ system: 's', user: 'line\n      indented '.repeat(2000), parse: JSON.parse, logger: quiet }),
    /All model providers failed: Groq\/m1: 500 boom/,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.messages[1].content.length <= 9000);
});

test('a fallback key without URL or models is ignored, and no keys means no cloud provider', async t => {
  setup(t, { FALLBACK_API_KEY: 'k' }, () => ok('{}'));
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = message => warnings.push(message);
  t.after(() => { console.warn = prevWarn; });

  assert.equal(providers.hasCloudProvider(), false);
  assert.match(warnings[0], /FALLBACK_API_URL is missing/);
  await assert.rejects(() => providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet }), /No cloud model provider/);
});

test('probeModels reports which configured models answer', async t => {
  setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'good,dead' }, ({ model }) => (model === 'good' ? ok('{"ok":true}') : fail(404, 'model not found')));
  const results = await providers.probeModels();
  assert.deepEqual(results.map(r => [r.model, r.ok, r.status]), [['good', true, 200], ['dead', false, 404]]);
});

test('Groq gpt-oss requests use low reasoning effort, and a 400 retries without optional parameters', async t => {
  let n = 0;
  const calls = setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'openai/gpt-oss-120b' }, () => {
    n += 1;
    return n === 1 ? fail(400, 'property reasoning_effort is unsupported') : ok('{"ok":true}');
  });

  const result = await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });

  assert.equal(calls[0].body.reasoning_effort, 'low');
  assert.equal(calls[1].body.reasoning_effort, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.value, { ok: true });
});

test('an empty answer is a failure in both the chain and the probe', async t => {
  const calls = setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'silent,talks' }, ({ model }) => ok(model === 'silent' ? '' : '{"ok":true}'));

  const result = await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });
  assert.equal(result.model, 'talks');
  assert.equal(calls.length, 2);

  const probe = await providers.probeModels();
  assert.deepEqual(probe.map(r => [r.model, r.ok]), [['silent', false], ['talks', true]]);
  assert.match(probe[0].detail, /empty answer/);
});

test('listAvailableModels reads each provider\'s /models endpoint', async t => {
  setup(t, { GROQ_API_KEY: 'g', XAI_API_KEY: 'x' }, () => ok('{}'));
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push([String(url), opts.headers.Authorization]);
    if (String(url).includes('x.ai')) return { ok: false, status: 401, text: async () => 'bad key' };
    return { ok: true, json: async () => ({ data: [{ id: 'openai/gpt-oss-20b' }, { id: 'openai/gpt-oss-120b' }] }) };
  };

  const listed = await providers.listAvailableModels();

  assert.deepEqual(seen[0], ['https://api.groq.com/openai/v1/models', 'Bearer g']);
  assert.equal(seen[1][0], 'https://api.x.ai/v1/models');
  assert.deepEqual(listed[0].models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.match(listed[1].error, /401 bad key/);
});

test('a rate-limited chain tries the other model, then waits for the reset and succeeds', async t => {
  let n = 0;
  const calls = setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'big,small', MODEL_RATE_LIMIT_WAIT_SECONDS: '10' }, () => {
    n += 1;
    if (n <= 2) return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'Rate limit reached. Please try again in 50ms.' };
    return ok('{"done":true}');
  });
  const logs = [];
  const started = Date.now();

  const result = await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: { log() {}, warn: m => logs.push(m) } });

  assert.deepEqual(calls.map(c => c.model), ['big', 'small', 'big']);
  assert.equal(result.model, 'big');
  assert.ok(Date.now() - started >= 1000, 'waited for the quota to reset');
  assert.ok(logs.some(m => /Every model is rate limited — waiting/.test(m)));
});

test('with no wait budget a fully rate-limited chain fails fast', async t => {
  const calls = setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'big,small', MODEL_RATE_LIMIT_WAIT_SECONDS: '0' },
    () => ({ ok: false, status: 429, headers: { get: () => '30' }, text: async () => 'slow down' }));
  await assert.rejects(() => providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet }), /429 rate limited/);
  assert.equal(calls.length, 2);
});

test('a rejected key is remembered for the rest of the run', async t => {
  const calls = setup(t, { GEMINI_API_KEY: 'blocked', GEMINI_MODELS: 'gem', GROQ_API_KEY: 'g', GROQ_MODELS: 'm' },
    ({ url }) => (url.includes('googleapis') ? fail(403, 'denied') : ok('{"ok":1}')));

  await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });
  await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });
  await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });

  assert.equal(calls.filter(c => c.url.includes('googleapis')).length, 1);
  assert.equal(calls.length, 4);
  assert.equal(providers.isTightBudget(), true, 'budget now follows Groq, the live provider');
});

test('requests are sized to a tokens-per-minute budget and keep the closing instruction', async t => {
  const calls = setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'm', GROQ_TPM: '8000' }, () => ok('{"ok":1}'));
  const user = `${'data '.repeat(20000)}\nFINAL INSTRUCTION: return JSON.`;

  assert.equal(providers.promptBudget({ system: 'x'.repeat(1000), maxTokens: 12000 }), (8000 - 2800 - 200) * 3 - 1000);
  await providers.runChain({ system: 'x'.repeat(1000), user, parse: JSON.parse, maxTokens: 12000, logger: quiet });

  const sent = calls[0].body;
  assert.equal(sent.max_tokens, 2800);
  assert.ok(sent.messages[1].content.length <= 14000, `prompt ${sent.messages[1].content.length}`);
  assert.match(sent.messages[1].content, /trimmed to fit the model rate limit/);
  assert.match(sent.messages[1].content, /FINAL INSTRUCTION: return JSON\.$/);

  process.env.GROQ_TPM = '0';
  assert.equal(providers.promptBudget({ system: '', maxTokens: 12000 }), Infinity);
  assert.equal(providers.isTightBudget(), false);
});

test('the rate limit reported by the API replaces the default budget unless an env override is set', async t => {
  const calls = setup(t, { GROQ_API_KEY: 'g', GROQ_MODELS: 'm' }, () => ({
    ok: true,
    headers: { get: name => (name === 'x-ratelimit-limit-tokens' ? '300000' : null) },
    json: async () => ({ choices: [{ message: { content: '{"ok":1}' } }] }),
  }));
  const prevLog = console.log;
  const logs = [];
  console.log = m => logs.push(m);
  t.after(() => { console.log = prevLog; });

  assert.equal(providers.isTightBudget(), true, 'before any call the free-tier default applies');
  await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });
  assert.equal(providers.isTightBudget(), false, 'after one response the real limit is known');
  assert.equal(providers.describeProviders()[0].tpm, 300000);
  assert.ok(logs.some(m => /rate limit is 300000 tokens\/min/.test(m)));

  const probe = await providers.probeModels();
  assert.equal(probe[0].limitTokens, 300000);

  process.env.GROQ_TPM = '8000';
  providers.resetProviderState();
  await providers.runChain({ system: 's', user: 'u', parse: JSON.parse, logger: quiet });
  assert.equal(providers.isTightBudget(), true, 'an explicit override is respected');
  assert.equal(calls.length, 3);
});
