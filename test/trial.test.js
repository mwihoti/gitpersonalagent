'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ENV = ['DATABASE_URL', 'DAN_AGENT_API_KEY', 'TRIAL_SALT'];
const src = name => path.resolve(__dirname, '..', 'src', `${name}.js`);
const handlerPath = path.resolve(__dirname, '..', 'api', 'repo-issues.js');

// Loads api/repo-issues with an owner key set, no database (in-memory trial
// counts), and a stub scanRepo that records what it was asked to scan.
function load(t, { fail = false } = {}) {
  const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: '', DAN_AGENT_API_KEY: 'owner-key', TRIAL_SALT: 'test' });
  for (const name of ['config', 'db', 'auth', 'trial', 'github']) delete require.cache[src(name)];
  delete require.cache[handlerPath];

  const scans = [];
  const github = require(src('github'));
  require.cache[src('github')].exports = {
    ...github,
    scanRepo: async (repo, options) => {
      scans.push({ repo, ...options });
      if (fail) throw new Error('GitHub is down');
      return { repo, issues: [], totalOpenIssues: 0 };
    },
  };
  t.after(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const name of ['trial', 'github']) delete require.cache[src(name)];
    delete require.cache[handlerPath];
  });
  const handler = require(handlerPath);

  async function call({ method = 'POST', body = {}, ip = '203.0.113.7', key = '' } = {}) {
    const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
    const headers = { 'x-real-ip': ip, ...(key ? { 'x-api-key': key } : {}) };
    await handler({ method, headers, body, url: '/api/repo-issues' }, res);
    return res;
  }
  return { call, scans, trial: require(src('trial')) };
}

test('a visitor without a key gets two free scans, then the key prompt', async t => {
  const { call, scans } = load(t);

  assert.deepEqual((await call({ method: 'GET' })).body.trial, { used: 0, limit: 2, remaining: 2 });

  const first = await call({ body: { repo: 'payjoin/rust-payjoin' } });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body.trial, { used: 1, limit: 2, remaining: 1 });

  const second = await call({ body: { repo: 'https://github.com/bitcoindevkit/bdk' } });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.trial.remaining, 0);

  const third = await call({ body: { repo: 'payjoin/rust-payjoin' } });
  assert.equal(third.statusCode, 401);
  assert.match(third.body.error, /used your 2 free scans/);
  assert.match(third.body.error, /\/dashboard/);
  assert.equal(third.body.trial.remaining, 0);
  assert.equal(scans.length, 2, 'the third request never reached GitHub');

  assert.equal((await call({ method: 'GET' })).body.trial.remaining, 0);
  assert.equal((await call({ body: { repo: 'payjoin/rust-payjoin' }, ip: '198.51.100.4' })).statusCode, 200, 'another visitor has their own count');
});

test('free scans are limited to the directory and to the first page of detail', async t => {
  const { call, scans } = load(t);

  const outside = await call({ body: { repo: 'facebook/react' } });
  assert.equal(outside.statusCode, 401);
  assert.match(outside.body.error, /Bitcoin projects/);

  const deeper = await call({ body: { repo: 'payjoin/rust-payjoin', skip: 20, detail: 20 } });
  assert.equal(deeper.statusCode, 401);
  assert.match(deeper.body.error, /needs a key/);

  assert.equal(scans.length, 0);
  assert.equal((await call({ method: 'GET' })).body.trial.remaining, 2, 'refusals cost nothing');

  await call({ body: { repo: 'PAYJOIN/Rust-Payjoin', detail: 500 } });
  assert.equal(scans[0].repo, 'payjoin/rust-payjoin', 'the directory spelling is used');
  assert.equal(scans[0].detail, 20, 'visitors cannot ask for a deeper scan');
});

test('a scan that fails does not use up a free scan', async t => {
  const { call } = load(t, { fail: true });
  const res = await call({ body: { repo: 'payjoin/rust-payjoin' } });
  assert.equal(res.statusCode, 500);
  assert.equal((await call({ method: 'GET' })).body.trial.remaining, 2);
});

test('keys skip the trial: the owner scans anything, a wrong key is refused', async t => {
  const { call, scans } = load(t);

  for (let i = 0; i < 3; i += 1) {
    const res = await call({ body: { repo: 'facebook/react', skip: 20 }, key: 'owner-key' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.trial, undefined);
  }
  assert.equal(scans.length, 3);
  assert.deepEqual((await call({ method: 'GET', key: 'owner-key' })).body, { trial: null });

  const wrong = await call({ body: { repo: 'payjoin/rust-payjoin' }, key: 'wrong-key' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.body.trial, undefined, 'a rejected key is not silently turned into a free scan');
  assert.equal((await call({ method: 'GET' })).body.trial.remaining, 2);
});

test('the daily cap stops free scans for everyone and refunds the visitor', async t => {
  const { call, trial } = load(t);
  for (let i = 0; i < trial.DAILY_TRIAL_CAP; i += 1) {
    assert.equal((await call({ body: { repo: 'payjoin/rust-payjoin' }, ip: `10.0.${Math.floor(i / 2)}.${i % 2}` })).statusCode, 200);
  }
  const res = await call({ body: { repo: 'payjoin/rust-payjoin' }, ip: '192.0.2.1' });
  assert.equal(res.statusCode, 429);
  assert.equal((await call({ method: 'GET', ip: '192.0.2.1' })).body.trial.remaining, 2);
});

test('visitors are identified by a salted hash, never the raw address', () => {
  const trial = require(src('trial'));
  const id = trial.visitorId({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
  assert.match(id, /^ip:[0-9a-f]{32}$/);
  assert.ok(!id.includes('203.0.113.7'));
  assert.equal(trial.clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }), '203.0.113.7');
  assert.equal(trial.clientIp({ headers: { 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '1.2.3.4' } }), '198.51.100.4');
});
