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

test('pausing repositories persists and excludes them without falling back to discovery', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  t.after(() => { global.fetch = originalFetch; });
  const repositories = await loadRepositoriesModule(t);
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
