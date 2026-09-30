'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDigest } = require('../src/gemma');

test('validateDigest accepts a well-formed digest', () => {
  const digest = validateDigest({
    date: '2026-05-16',
    contest_digest: [{
      opportunity: 'Add regression test for API auth',
      repo: 'openai/openai-node',
      issue_url: 'https://github.com/openai/openai-node/issues/123',
      why_it_qualifies: 'Scoped issue with clear repro steps.',
      suggested_action: 'Add a failing test first, then patch the auth path.',
      code_skeleton: '// test/auth.test.js\nassert.equal(true, true);',
      clarity_tip: 'npm test',
      why_it_matters: 'Protects the API surface from auth regressions.',
      effort: 'low',
    }],
    quick_plan: 'Start with the test, then patch the auth handler.',
    tech_news_summary: ['API tooling is improving quickly.'],
  });

  assert.equal(digest.contest_digest[0].effort, 'low');
  assert.equal(digest.contest_digest[0].repo, 'openai/openai-node');
});

test('validateDigest rejects malformed model output', () => {
  assert.throws(() => validateDigest({
    date: '2026-05-16',
    contest_digest: [{
      opportunity: 'Broken suggestion',
      repo: 'not-a-repo',
      issue_url: 'javascript:alert(1)',
      why_it_qualifies: 'bad',
      suggested_action: 'bad',
      code_skeleton: '// bad',
      clarity_tip: '',
      why_it_matters: 'bad',
      effort: 'urgent',
    }],
    quick_plan: 'bad',
    tech_news_summary: ['bad'],
  }), /repo must be owner\/repo|effort must be low, medium, or high|issue_url must be an http/i);
});

test('triageIssues sends one compact line per candidate and maps ids back to URLs', async () => {
  const { triageIssues } = require('../src/gemma');
  let prompt = null;
  const repoData = [{
    repo: 'o/r',
    issues: [
      { number: 1, url: 'https://github.com/o/r/issues/1', title: 'A | with pipe', labels: ['bug'], issueFitScore: 60, body: 'first body' },
      { number: 2, url: 'https://github.com/o/r/issues/2', title: 'B', labels: [], issueFitScore: 90, body: 'second body' },
    ],
  }];
  const scores = await triageIssues(repoData, {
    request: async ({ user }) => {
      prompt = user;
      return { ranked: [
        { id: 0, score: 90, reason: 'clear ask' },
        { id: '1', score: '30', reason: 'vague' },
        { id: 9, score: 50 },
        { url: 'https://github.com/o/r/issues/1', score: 'nan' },
      ] };
    },
  });

  // Highest heuristic fit is listed first, so id 0 is issue #2.
  assert.match(prompt, /^Candidates \(2\), one per line:/);
  assert.match(prompt, /\n0\|o\/r#2\|B\|\|/);
  assert.match(prompt, /\n1\|o\/r#1\|A \/ with pipe\|bug\|/);
  assert.equal(scores.size, 2);
  assert.equal(scores.get('https://github.com/o/r/issues/2').score, 90);
  assert.equal(scores.get('https://github.com/o/r/issues/1').score, 30);

  const single = await triageIssues([{ repo: 'o/r', issues: [{ url: 'u', title: 't' }] }], { request: async () => { throw new Error('should not call'); } });
  assert.equal(single.size, 0);
});

test('triage and digest inputs shrink to fit a small prompt budget without dropping repos', async () => {
  const { triageIssues, fitDigestInput } = require('../src/gemma');
  const repoData = Array.from({ length: 12 }, (_, r) => ({
    repo: `org/repo-${r}`,
    repoUrl: `https://github.com/org/repo-${r}`,
    issues: Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
      url: `https://github.com/org/repo-${r}/issues/${i + 1}`,
      title: `Issue ${i + 1} about a fairly specific thing in repo ${r}`,
      body: 'Long body text. '.repeat(200),
      labels: ['good first issue', 'bug'],
      updatedAt: '2026-09-29T00:00:00Z',
      comments: 3,
      issueFitScore: 50 + i,
      issueFitReason: 'reason '.repeat(20),
      recentConversation: [{ author: 'm', createdAt: '2026-09-01', body: 'comment '.repeat(60) }],
      linkedPRs: [{ number: 5, state: 'open', author: 'x', title: 'a pr title' }],
    })),
  }));

  let prompt = '';
  await triageIssues(repoData, { budgetChars: 12000, request: async ({ user }) => { prompt = user; return { ranked: [] }; } });
  assert.ok(prompt.length <= 12000, `triage prompt ${prompt.length}`);
  assert.match(prompt, /^Candidates \(96\)/, 'every candidate still fits');

  const fitted = fitDigestInput(repoData, { issuesPerRepo: 4, budgetChars: 12000 });
  assert.ok(JSON.stringify(fitted).length <= 12000, `digest input ${JSON.stringify(fitted).length}`);
  assert.equal(fitted.length, 12, 'all repos are still represented');
  assert.ok(fitted.every(repo => repo.issues.length >= 2));

  const roomy = fitDigestInput(repoData, { issuesPerRepo: 4, budgetChars: Infinity });
  assert.equal(roomy[0].issues.length, 4);
  assert.equal(roomy[0].issues[0].body.length, 1500);
});

test('a Gemini 403 falls through to Groq, and a dead provider chain still yields a digest', async t => {
  const gemmaPath = require.resolve('../src/gemma');
  const prevFetch = global.fetch;
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevGroq = process.env.GROQ_API_KEY;
  process.env.GEMINI_API_KEY = 'blocked';
  process.env.GROQ_API_KEY = 'groq';
  delete require.cache[gemmaPath];
  const { analyzeDigestWithModel } = require(gemmaPath);
  const calls = [];
  t.after(() => {
    global.fetch = prevFetch;
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGemini;
    if (prevGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prevGroq;
    delete require.cache[gemmaPath];
  });

  global.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).includes('googleapis')) {
      return { ok: false, status: 403, text: async () => '{"error":{"status":"PERMISSION_DENIED"}}' };
    }
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        date: '2026-09-30',
        contest_digest: [],
        quick_plan: `groq saw ${body.model}`,
        tech_news_summary: [],
      }) } }] }),
    };
  };

  const repoData = [{ repo: 'o/r', issues: [{ number: 1, title: 't', url: 'https://github.com/o/r/issues/1', labels: [] }] }];
  const news = { hackerNews: [], githubReleases: [], rssFeeds: [] };
  const digest = await analyzeDigestWithModel(repoData, news, {});

  assert.equal(calls.filter(u => u.includes('googleapis')).length, 1, 'stops after the first Gemini 403');
  assert.match(digest.quick_plan, /groq saw openai\/gpt-oss-120b/);

  // Every provider down: deterministic digest, not a crash.
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'down' });
  const fallback = await analyzeDigestWithModel(repoData, news, {});
  assert.equal(fallback.model_fallback, true);
  assert.equal(fallback.contest_digest.length, 1);
});
