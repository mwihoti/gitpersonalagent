'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function loadGithubModule() {
  const configPath = path.resolve(__dirname, '..', 'src', 'config.js');
  const githubPath = path.resolve(__dirname, '..', 'src', 'github.js');
  delete require.cache[configPath];
  delete require.cache[githubPath];
  return require(githubPath);
}

test('fetchRepoDetails retries public repo lookup without auth after 401', async t => {
  process.env.GITHUB_TOKEN = 'bad-token';
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (_url, options = {}) => {
    calls.push(options.headers || {});
    const usedAuth = Boolean(options.headers && options.headers.Authorization);
    if (usedAuth) {
      return { ok: false, status: 401 };
    }

    return {
      ok: true,
      json: async () => ({ full_name: 'peer-observer/peer-observer' }),
    };
  };

  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.GITHUB_TOKEN;
  });

  const { assertRepositoryAccessible } = loadGithubModule();
  await assert.doesNotReject(() => assertRepositoryAccessible('peer-observer/peer-observer'));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].Authorization);
  assert.equal(calls[1].Authorization, undefined);
});

test('scanRepos skips repositories that GitHub refuses instead of throwing', async t => {
  process.env.GITHUB_TOKEN = 'bad-token';
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ message: 'API rate limit exceeded' }),
  });

  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.GITHUB_TOKEN;
  });

  const { scanRepos } = loadGithubModule();
  const results = await scanRepos(['owner/repo']);

  assert.equal(results.length, 1);
  assert.equal(results[0].repo, 'owner/repo');
  assert.equal(results[0].labelSummary, 'skipped');
  assert.match(results[0].error, /GitHub repo lookup failed/);
});
