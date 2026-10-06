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

// ── full issue listing ────────────────────────────────────────────────────────

function mockRepoWithIssues(t, { total = 130, env = {} } = {}) {
  const saved = {};
  for (const [key, value] of Object.entries({ GITHUB_TOKEN: undefined, ...env })) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const prevFetch = global.fetch;
  const log = { pages: [], comments: [], timelines: [] };

  const items = Array.from({ length: total }, (_, index) => {
    const number = index + 1;
    const item = {
      number,
      title: `Issue ${number}`,
      body: `Body of issue ${number}. Please add examples for the bindings so users can learn.`,
      html_url: `https://github.com/o/r/issues/${number}`,
      labels: number === 7 ? [{ name: 'good first issue' }, { name: 'help wanted' }] : [],
      user: { login: 'reporter' },
      assignees: number === 9 ? [{ login: 'busy' }] : [],
      comments: 0,
      comments_url: `https://api.github.com/repos/o/r/issues/${number}/comments`,
      created_at: '2026-01-01T00:00:00Z',
      // Higher numbers were updated more recently, as GitHub's default sort returns them.
      updated_at: new Date(Date.now() - (total - number) * 3600_000).toISOString(),
    };
    if (number % 5 === 0) item.pull_request = { url: `https://api.github.com/repos/o/r/pulls/${number}` };
    return item;
  }).reverse(); // most recently updated first

  global.fetch = async url => {
    const target = String(url);
    const respond = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    if (/\/repos\/o\/r$/.test(target)) {
      return respond(200, { full_name: 'o/r', html_url: 'https://github.com/o/r', language: 'Rust', default_branch: 'main', open_issues_count: total, stargazers_count: 3, topics: [] });
    }
    const list = target.match(/\/repos\/o\/r\/issues\?(.*)$/);
    if (list) {
      const params = new URLSearchParams(list[1]);
      const page = Number(params.get('page') || 1);
      const perPage = Number(params.get('per_page') || 30);
      log.pages.push(page);
      if (env.FAIL_LIST) return respond(403, { message: 'API rate limit exceeded' });
      return respond(200, items.slice((page - 1) * perPage, page * perPage));
    }
    const comments = target.match(/\/issues\/(\d+)\/comments/);
    if (comments) { log.comments.push(Number(comments[1])); return respond(200, []); }
    const timeline = target.match(/\/issues\/(\d+)\/timeline/);
    if (timeline) { log.timelines.push(Number(timeline[1])); return respond(200, []); }
    return respond(404, { message: 'not mocked' });
  };

  t.after(() => {
    global.fetch = prevFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return log;
}

test('all-open lists every issue across pages, drops pull requests, and reads only one batch in detail', async t => {
  const log = mockRepoWithIssues(t);
  const { scanRepo } = loadGithubModule();

  const result = await scanRepo('o/r', { mode: 'all-open' });

  assert.deepEqual(log.pages, [1, 2], 'two pages of 100 and 30 items');
  assert.equal(result.openItems, 130);
  assert.equal(result.totalOpenIssues, 104, '130 items minus 26 pull requests');
  assert.equal(result.issues.length, 104);
  assert.equal(result.truncated, false);
  assert.ok(result.issues.every(issue => issue.number % 5 !== 0), 'no pull requests');

  assert.equal(result.detailChecked, 20);
  assert.equal(result.issues.filter(issue => issue.detailChecked).length, 20);
  assert.equal(log.timelines.length, 20, 'only the batch pays for the timeline lookup');

  // The best issue by labels is read in detail even though it is far from the newest.
  const best = result.issues.find(issue => issue.number === 7);
  assert.equal(best.detailChecked, true);
  assert.equal(result.issues[0].number, 7);
  assert.ok(best.issueFitScore > result.issues.find(issue => issue.number === 6).issueFitScore);

  // An assignee is visible without reading the thread, so the issue sinks and is marked.
  const taken = result.issues.find(issue => issue.number === 9);
  assert.equal(taken.claim.claimed, true);
  assert.match(taken.claim.reason, /assigned to busy/);
  assert.ok(result.issues.indexOf(taken) > result.issues.indexOf(best));

  const unchecked = result.issues.find(issue => !issue.detailChecked);
  assert.ok(unchecked.body.length <= 160);
  assert.equal(typeof unchecked.issueFitScore, 'number');
  assert.deepEqual(unchecked.linkedPRs, []);
});

test('skip and detail pick the next batch without repeating the first', async t => {
  const log = mockRepoWithIssues(t);
  const { scanRepo } = loadGithubModule();

  const first = await scanRepo('o/r', { mode: 'all-open', detail: 10 });
  const firstBatch = [...log.timelines];
  log.timelines.length = 0;
  const second = await scanRepo('o/r', { mode: 'all-open', detail: 10, skip: 10 });

  assert.equal(second.detailChecked, 10);
  assert.equal(second.detailDepth, 20);
  assert.equal(first.issues.length, second.issues.length);
  assert.equal(log.timelines.filter(number => firstBatch.includes(number)).length, 0, 'no overlap with the first batch');
  assert.equal(new Set([...firstBatch, ...log.timelines]).size, 20);
});

test('a very large repository is bounded by INSPECT_MAX_ITEMS and says so', async t => {
  const log = mockRepoWithIssues(t, { env: { INSPECT_MAX_ITEMS: '100' } });
  const { scanRepo } = loadGithubModule();

  const result = await scanRepo('o/r', { mode: 'all-open', detail: 0 });

  assert.deepEqual(log.pages, [1]);
  assert.equal(result.openItems, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.detailChecked, 0);
  assert.equal(log.timelines.length, 0);
  assert.equal(result.issues.length, 80);
});

test('a failed issue list raises a clear error instead of showing an empty repo', async t => {
  mockRepoWithIssues(t, { env: { FAIL_LIST: '1' } });
  const { scanRepo } = loadGithubModule();
  await assert.rejects(() => scanRepo('o/r', { mode: 'all-open' }), /GitHub issue list failed for o\/r: 403 API rate limit exceeded/);
});

test('scheduled scans keep only the issues that were read in detail', async t => {
  mockRepoWithIssues(t);
  const { scanRepos } = loadGithubModule();

  const [result] = await scanRepos(['o/r'], { mode: 'all-open' });

  assert.equal(result.issues.length, 20);
  assert.ok(result.issues.every(issue => issue.detailChecked));
  assert.ok(result.issues.some(issue => issue.number === 7), 'the best issue overall is included, not just the newest');
  assert.equal(result.totalOpenIssues, 104);
});
