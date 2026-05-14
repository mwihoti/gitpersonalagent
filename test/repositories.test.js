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
  const modulePath = path.resolve(__dirname, '..', 'src', 'repositories.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('addRepository normalizes URLs and persists unique repos', async t => {
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
  const repositories = await loadRepositoriesModule(t);

  const saved = await repositories.addRepository('openai/openai-node');
  await repositories.removeRepository(saved.id);

  const all = await repositories.listRepositories();
  assert.equal(all.length, 0);
});
