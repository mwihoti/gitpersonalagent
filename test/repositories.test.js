'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function loadRepositoriesModule(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-repos-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  process.env.DAN_AGENT_DATA_DIR = tmpDir;
  process.env.GITHUB_TOKEN = '';
  delete process.env.BITCOINDEVS_DISCOVERY;
  delete process.env.BITCOINDEVS_ISSUES_URL;
  delete process.env.BITCOINDEVS_MAX_REPOS;
  delete process.env.BITCOINDEVS_MODE;
  const modulePath = path.resolve(__dirname, '..', 'src', 'repositories.js');
  const githubPath = path.resolve(__dirname, '..', 'src', 'github.js');
  const bitcoinDevsPath = path.resolve(__dirname, '..', 'src', 'bitcoindevs.js');
  delete require.cache[modulePath];
  delete require.cache[githubPath];
  delete require.cache[bitcoinDevsPath];
  return require(modulePath);
}

test('addRepository normalizes URLs and persists unique repos', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ full_name: 'vercel/next.js' }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const repositories = await loadRepositoriesModule(t);

  const first = await repositories.addRepository('https://github.com/vercel/next.js/issues');
  assert.equal(first.repo, 'vercel/next.js');

  const second = await repositories.addRepository('vercel/next.js');
  assert.equal(second.repo, 'vercel/next.js');

  const all = await repositories.listRepositories();
  assert.equal(all.length, 1);
  assert.equal(all[0].repo, 'vercel/next.js');
});

test('removeRepository deletes saved entries', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ full_name: 'openai/openai-node' }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const repositories = await loadRepositoriesModule(t);

  const saved = await repositories.addRepository('openai/openai-node');
  await repositories.removeRepository(saved.id);

  const all = await repositories.listRepositories();
  assert.equal(all.length, 0);
});

test('addRepository rejects repositories GitHub cannot resolve', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 404,
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const repositories = await loadRepositoriesModule(t);

  await assert.rejects(
    repositories.addRepository('missing/repo'),
    /GitHub repository not found/i
  );
});

test('getScanRepositories falls back to BitcoinDevs when watchlist is empty', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => `
      {\\"url\\":\\"https://github.com/payjoin/rust-payjoin/issues/1522\\",\\"publishedAt\\":\\"2026-05-04T00:00:00Z\\",\\"title\\":\\"Add lcov.info\\",\\"labels\\":[\\"good first issue\\"],\\"number\\":1522}
      {\\"url\\":\\"https://github.com/bitcoin/bitcoin/issues/35399\\",\\"publishedAt\\":\\"2026-05-28T00:00:00Z\\",\\"title\\":\\"Remove template\\",\\"labels\\":[\\"good first issue\\"],\\"number\\":35399}
    `,
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const repositories = await loadRepositoriesModule(t);

  const repos = await repositories.getScanRepositories();
  assert.deepEqual(repos, ['bitcoin/bitcoin', 'payjoin/rust-payjoin']);
});

test('in fallback mode, pausing repositories persists and excludes them without falling back to discovery', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  t.after(() => { global.fetch = originalFetch; delete process.env.BITCOINDEVS_MODE; });
  const repositories = await loadRepositoriesModule(t);
  process.env.BITCOINDEVS_MODE = 'fallback';
  const first = await repositories.addRepository('bitcoin/bitcoin');
  const second = await repositories.addRepository('rust-bitcoin/rust-bitcoin');
  assert.equal(first.enabled, true);
  await repositories.updateRepository(first.id, { enabled: false });
  assert.deepEqual(await repositories.getScanRepositories(), [second.repo]);
  await repositories.updateRepository(second.id, { enabled: false });
  global.fetch = async () => { throw new Error('Paused watchlists must not fetch discovery'); };
  assert.deepEqual(await repositories.getScanRepositories(), []);
  assert.ok((await repositories.listRepositories()).every(repo => !repo.enabled));
  await repositories.updateRepository(first.id, { enabled: true });
  assert.deepEqual(await repositories.getScanRepositories(), [first.repo]);
  await assert.rejects(repositories.updateRepository(first.id, { enabled: 'false' }), /boolean/);
});

test('concurrent repository changes preserve additions and pause state', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  t.after(() => { global.fetch = originalFetch; });
  const repositories = await loadRepositoriesModule(t);
  const first = await repositories.addRepository('bitcoin/bitcoin');
  await Promise.all([
    repositories.updateRepository(first.id, { enabled: false }),
    repositories.addRepository('rust-bitcoin/rust-bitcoin'),
    repositories.addRepository('bitcoindevkit/bdk'),
  ]);
  const all = await repositories.listRepositories();
  assert.equal(all.length, 3);
  assert.equal(all.find(repo => repo.id === first.id).enabled, false);
  assert.equal(new Set(all.map(repo => repo.id)).size, 3);
});

// ── discovery merged with the watchlist ──────────────────────────────────────

const record = (repo, number, labels, date = '2026-09-01T00:00:00Z') =>
  `{\\"url\\":\\"https://github.com/${repo}/issues/${number}\\",\\"publishedAt\\":\\"${date}\\",\\"title\\":\\"Issue ${number}\\",\\"labels\\":[${labels.map(l => `\\"${l}\\"`).join(',')}],\\"number\\":${number}}`;

function mockWorld(t, { page, fail = false } = {}) {
  const originalFetch = global.fetch;
  const pageRequests = [];
  global.fetch = async url => {
    if (String(url).includes('bitcoindevs.xyz')) {
      pageRequests.push(String(url));
      if (fail) throw new Error('site down');
      return { ok: true, text: async () => page };
    }
    return { ok: true, json: async () => ({ full_name: 'x/y' }) };
  };
  t.after(() => { global.fetch = originalFetch; delete process.env.BITCOINDEVS_MODE; delete process.env.BITCOINDEVS_MAX_REPOS; });
  return pageRequests;
}

const PAGE = [
  record('lightningnetwork/lnd', 1, ['good first issue']),
  record('lightningnetwork/lnd', 2, ['bug']),
  record('bitcoin/bitcoin', 3, ['bug'], '2026-09-02T00:00:00Z'),
  record('bitcoindevkit/bdk', 4, ['enhancement'], '2026-09-03T00:00:00Z'),
  record('payjoin/rust-payjoin', 5, ['good first issue', 'ffi'], '2026-09-04T00:00:00Z'),
].join('\n');

test('scan targets cover every project on the BitcoinDevs page, not only those with good first issues', async t => {
  mockWorld(t, { page: PAGE });
  const repositories = await loadRepositoriesModule(t);

  const targets = await repositories.getScanTargets();

  assert.equal(targets.source, 'bitcoindevs');
  assert.deepEqual([...targets.repos].sort(), ['bitcoin/bitcoin', 'bitcoindevkit/bdk', 'lightningnetwork/lnd', 'payjoin/rust-payjoin']);
  assert.deepEqual(targets.issues.map(issue => issue.number).sort(), [1, 5], 'only good first issues are seeded');
});

test('watching a repo adds to the scan instead of replacing it, and a paused repo stays out', async t => {
  mockWorld(t, { page: PAGE });
  const repositories = await loadRepositoriesModule(t);
  await repositories.addRepository('rust-bitcoin/rust-bitcoin');
  const lnd = await repositories.addRepository('LightningNetwork/LND');
  await repositories.updateRepository(lnd.id, { enabled: false });

  const targets = await repositories.getScanTargets();

  assert.equal(targets.source, 'watchlist+bitcoindevs');
  assert.ok(targets.repos.includes('rust-bitcoin/rust-bitcoin'), 'the watched repo is scanned');
  assert.ok(targets.repos.includes('bitcoin/bitcoin') && targets.repos.includes('payjoin/rust-payjoin'), 'the page is still scanned');
  assert.ok(!targets.repos.some(repo => repo.toLowerCase() === 'lightningnetwork/lnd'), 'a paused repo is excluded even though the page lists it');
  assert.ok(targets.issues.every(issue => issue.repo.toLowerCase() !== 'lightningnetwork/lnd'), 'and so are its seeds');
  assert.equal(new Set(targets.repos.map(repo => repo.toLowerCase())).size, targets.repos.length, 'no duplicates');
});

test('BITCOINDEVS_MAX_REPOS still caps the scan when you want it to', async t => {
  mockWorld(t, { page: PAGE });
  process.env.BITCOINDEVS_MAX_REPOS = '2';
  const repositories = await loadRepositoriesModule(t);
  process.env.BITCOINDEVS_MAX_REPOS = '2';

  const targets = await repositories.getScanTargets();
  assert.equal(targets.repos.length, 2);
});

test('when the page is down the watchlist still scans, and an empty watchlist uses the curated list', async t => {
  mockWorld(t, { page: '', fail: true });
  const repositories = await loadRepositoriesModule(t);

  const curated = await repositories.getScanTargets();
  assert.equal(curated.source, 'bitcoin-ecosystem');
  assert.ok(curated.repos.length > 0);

  await repositories.addRepository('bitcoin/bitcoin');
  const watched = await repositories.getScanTargets();
  assert.equal(watched.source, 'watchlist');
  assert.deepEqual(watched.repos, ['bitcoin/bitcoin']);
});

test('pausing everything while the page lists projects does not silently scan the page', async t => {
  mockWorld(t, { page: record('payjoin/rust-payjoin', 5, ['good first issue']) });
  const repositories = await loadRepositoriesModule(t);
  const only = await repositories.addRepository('payjoin/rust-payjoin');
  await repositories.updateRepository(only.id, { enabled: false });

  const targets = await repositories.getScanTargets();
  assert.deepEqual(targets.repos, [], 'the one listed project is paused, so nothing is scanned and no catalogue fallback appears');
  assert.equal(targets.source, 'none');
});
