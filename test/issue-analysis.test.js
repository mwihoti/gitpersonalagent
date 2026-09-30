'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function loadAnalysisModule(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-analysis-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  process.env.DAN_AGENT_DATA_DIR = tmpDir;
  const modulePath = path.resolve(__dirname, '..', 'src', 'issue-analysis.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

function sampleContext(overrides = {}) {
  return {
    repo: { name: 'owner/repo', url: 'https://github.com/owner/repo', description: 'A lib', language: 'Rust', defaultBranch: 'main', stars: 10, topics: [] },
    issue: {
      number: 42,
      title: 'Enforce strict decimal parsing in json_to_s64',
      url: 'https://github.com/owner/repo/issues/42',
      body: 'json_to_u64 was fixed in `common/json_parse.c`; `json_to_s64` still accepts hex.',
      bodyPlain: 'json_to_u64 was fixed; json_to_s64 still accepts hex.',
      labels: ['good first issue'],
      author: 'reporter',
      authorAssociation: 'MEMBER',
      assignees: [],
      state: 'open',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      commentsCount: 2,
      reactions: 1,
      milestone: '',
    },
    comments: [
      { id: 1, author: 'rustyrussell', authorAssociation: 'OWNER', createdAt: '2025-01-02T00:00:00Z', body: 'Yes, mirror what we did for u64 and add a test in tests/test_json.py.', reactions: 0 },
      { id: 2, author: 'someone', authorAssociation: 'NONE', createdAt: '2026-08-30T00:00:00Z', body: 'Is this still open?', reactions: 0 },
    ],
    claim: { claimed: false, reason: '', by: '', prUrl: '' },
    pullRequests: [{ number: 7, title: 'Fix u64 parsing', url: 'https://github.com/owner/repo/pull/7', author: 'x', state: 'merged', sameRepo: true, files: [{ path: 'common/json_parse.c' }] }],
    contributing: { path: 'CONTRIBUTING.md', url: 'https://github.com/owner/repo/blob/main/CONTRIBUTING.md', text: 'Run make check before opening a PR.' },
    files: [{ path: 'common/json_parse.c', url: 'https://github.com/owner/repo/blob/main/common/json_parse.c', reason: 'mentioned in the issue', totalLines: 300, startLine: 1, endLine: 120, text: 'bool json_to_s64(...) { strtoll(...) }' }],
    mentionedPaths: ['common/json_parse.c'],
    mentionedSymbols: ['json_to_s64'],
    fetchedAt: '2026-09-05T00:00:00Z',
    ...overrides,
  };
}

test('buildPrompt includes the thread in order, linked PRs, the guide, and source excerpts', async t => {
  const { buildPrompt } = await loadAnalysisModule(t);
  const prompt = buildPrompt(sampleContext());

  assert.match(prompt, /=== ISSUE ===/);
  assert.match(prompt, /#42: Enforce strict decimal parsing/);
  assert.match(prompt, /\[2025-01-02\] rustyrussell \(owner\):/);
  assert.ok(prompt.indexOf('rustyrussell') < prompt.indexOf('Is this still open?'));
  assert.match(prompt, /#7 \[merged\] by x: Fix u64 parsing\n {2}files: common\/json_parse\.c/);
  assert.match(prompt, /CONTRIBUTING GUIDE \(CONTRIBUTING\.md/);
  assert.match(prompt, /SOURCE common\/json_parse\.c \(lines 1-120 of 300/);
  assert.match(prompt, /strtoll/);
});

test('analyzeIssue normalizes model output, verifies file paths, and caches by updated_at', async t => {
  const { analyzeIssue } = await loadAnalysisModule(t);
  let requests = 0;
  let contextFetches = 0;
  const request = async ({ system, user }) => {
    requests += 1;
    assert.match(system, /Return ONLY a JSON object/);
    assert.match(user, /json_to_s64/);
    return {
      summary: 'Signed parser still accepts hex.',
      maintainer_wants: 'Mirror the u64 fix and add a regression test.',
      evidence: [{ who: 'rustyrussell', when: '2025-01-02', quote: 'mirror what we did for u64' }],
      current_state: 'Available',
      state_reason: 'Nobody has claimed it.',
      open_questions: ['Should negative hex be rejected too?'],
      files_to_change: [{ path: 'common/json_parse.c', why: 'add strict check' }, { path: 'made/up.c', why: 'nope' }],
      plan: ['Edit common/json_parse.c', 'Add test', 'Run make check'],
      validation: 'make check',
      effort: 'LOW',
      impact: 'medium',
      confidence: '85',
      code_skeleton: '// common/json_parse.c\nbool json_to_s64(...) {}',
      first_comment_draft: '',
    };
  };
  const fetchContext = async () => {
    contextFetches += 1;
    return sampleContext();
  };

  const first = await analyzeIssue({ url: 'https://github.com/owner/repo/issues/42' }, { request, fetchContext, logger: { warn() {} } });

  assert.equal(first.cached, false);
  assert.equal(first.model, 'model');
  assert.equal(first.issueUpdatedAt, '2026-09-01T00:00:00Z');
  assert.equal(first.analysis.currentState, 'available');
  assert.equal(first.analysis.effort, 'low');
  assert.equal(first.analysis.confidence, 85);
  assert.deepEqual(first.analysis.filesToChange.map(file => file.verified), [true, false]);
  assert.equal(first.analysis.plan.length, 3);
  assert.equal(first.context.files[0].path, 'common/json_parse.c');
  assert.equal(first.context.comments.length, 2);

  const second = await analyzeIssue(
    { url: 'https://github.com/owner/repo/issues/42' },
    { request, fetchContext, knownUpdatedAt: '2026-09-01T00:00:00Z' },
  );
  assert.equal(second.cached, true);
  assert.equal(requests, 1);
  assert.equal(contextFetches, 1);

  const third = await analyzeIssue(
    { url: 'https://github.com/owner/repo/issues/42' },
    { request, fetchContext, knownUpdatedAt: '2026-09-03T00:00:00Z' },
  );
  assert.equal(third.cached, false);
  assert.equal(requests, 2);

  const forced = await analyzeIssue(
    { repo: 'owner/repo', number: 42 },
    { request, fetchContext, force: true },
  );
  assert.equal(forced.cached, false);
  assert.equal(requests, 3);
});

test('analyzeIssue falls back to heuristics when the model is unavailable', async t => {
  const { analyzeIssue } = await loadAnalysisModule(t);
  const warnings = [];
  const result = await analyzeIssue(
    { url: 'https://github.com/owner/repo/issues/42' },
    {
      request: async () => { throw new Error('no provider'); },
      fetchContext: async () => sampleContext({ claim: { claimed: true, reason: 'open PR #9 by bob', by: 'bob', prUrl: 'https://github.com/owner/repo/pull/9' } }),
      logger: { warn: message => warnings.push(message) },
    },
  );

  assert.equal(result.model, 'heuristic');
  assert.equal(result.analysis.currentState, 'has_open_pr');
  assert.equal(result.analysis.stateReason, 'open PR #9 by bob');
  assert.equal(result.analysis.filesToChange[0].path, 'common/json_parse.c');
  assert.ok(result.analysis.plan.length >= 3);
  assert.equal(warnings.length, 1);
});

test('analyzeIssue rejects input without an issue reference', async t => {
  const { analyzeIssue } = await loadAnalysisModule(t);
  await assert.rejects(() => analyzeIssue({ url: 'https://example.com' }), /Provide an issue URL/);
});

test('analyzeIssue retries once when the model answer is malformed, but not on provider errors', async t => {
  const { analyzeIssue } = await loadAnalysisModule(t);
  let calls = 0;
  const result = await analyzeIssue(
    { url: 'https://github.com/owner/repo/issues/42' },
    {
      fetchContext: async () => sampleContext(),
      logger: { warn() {} },
      request: async ({ user }) => {
        calls += 1;
        if (calls === 1) return { nonsense: true };
        assert.match(user, /previous answer was not a valid JSON object/);
        return { summary: 'ok', maintainer_wants: 'x', plan: ['a'], current_state: 'available' };
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.model, 'model');
  assert.equal(result.analysis.summary, 'ok');

  let providerCalls = 0;
  const fallback = await analyzeIssue(
    { url: 'https://github.com/owner/repo/issues/43' },
    {
      fetchContext: async () => sampleContext(),
      logger: { warn() {} },
      request: async () => { providerCalls += 1; throw new Error('Gemini error: 503'); },
    },
  );
  assert.equal(providerCalls, 1);
  assert.equal(fallback.model, 'heuristic');
});

test('buildPrompt respects a prompt budget and keeps the newest comments', async t => {
  const { buildPrompt } = await loadAnalysisModule(t);
  const big = sampleContext({
    issue: { ...sampleContext().issue, body: 'B'.repeat(9000), commentsCount: 30 },
    comments: Array.from({ length: 30 }, (_, i) => ({ id: i, author: `user${i}`, authorAssociation: 'NONE', createdAt: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`, body: `comment ${i} `.repeat(80), reactions: 0 })),
    files: [
      { path: 'a.c', url: 'u', reason: 'r', totalLines: 900, startLine: 1, endLine: 120, text: 'x'.repeat(3500) },
      { path: 'b.c', url: 'u', reason: 'r', totalLines: 900, startLine: 1, endLine: 120, text: 'y'.repeat(3500) },
    ],
    contributing: { path: 'CONTRIBUTING.md', url: 'u', text: 'c'.repeat(4000) },
  });

  const prompt = buildPrompt(big, 12000);
  assert.ok(prompt.length <= 12600, `prompt is ${prompt.length}`);
  assert.match(prompt, /user29/, 'newest comment kept');
  assert.doesNotMatch(prompt, /user0 /, 'oldest comments dropped');
  assert.match(prompt, /SOURCE a\.c/);
  assert.match(prompt, /SOURCE b\.c/);
  assert.match(prompt, /Be concise: plan of at most 6 steps/);

  const full = buildPrompt(big);
  assert.ok(full.length > 30000);
});

test('heuristic results are not cached, and plan steps lose their own numbering', async t => {
  const { analyzeIssue } = await loadAnalysisModule(t);
  let calls = 0;
  const options = {
    fetchContext: async () => sampleContext(),
    logger: { warn() {} },
    knownUpdatedAt: '2026-09-01T00:00:00Z',
    request: async () => {
      calls += 1;
      if (calls === 1) throw new Error('All model providers failed: 429');
      return { summary: 's', maintainer_wants: 'w', plan: ['1. Open the file', 'Step 2: Edit it', '3) Test'], current_state: 'available' };
    },
  };

  const first = await analyzeIssue({ url: 'https://github.com/owner/repo/issues/77' }, options);
  assert.equal(first.model, 'heuristic');

  const second = await analyzeIssue({ url: 'https://github.com/owner/repo/issues/77' }, options);
  assert.equal(second.model, 'model', 'the model is asked again instead of serving the cached template');
  assert.equal(second.cached, false);
  assert.deepEqual(second.analysis.plan, ['Open the file', 'Edit it', 'Test']);

  const third = await analyzeIssue({ url: 'https://github.com/owner/repo/issues/77' }, options);
  assert.equal(third.cached, true);
  assert.equal(calls, 2);
});
