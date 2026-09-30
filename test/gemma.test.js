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

test('triageIssues maps ranked model output back to issue URLs', async () => {
  const { triageIssues } = require('../src/gemma');
  let prompt = null;
  const scores = await triageIssues([{
    repo: 'o/r',
    issues: [
      { url: 'https://github.com/o/r/issues/1', title: 'A', labels: ['bug'], issueFitScore: 60 },
      { url: 'https://github.com/o/r/issues/2', title: 'B', labels: [], issueFitScore: 50 },
    ],
  }], {
    request: async ({ user }) => {
      prompt = user;
      return { ranked: [
        { url: 'https://github.com/o/r/issues/2', score: 90, reason: 'clear ask' },
        { url: 'https://github.com/o/r/issues/1', score: '30', reason: 'vague' },
        { url: 'https://github.com/o/r/issues/9', score: 'nan' },
      ] };
    },
  });

  assert.match(prompt, /"title": "A"/);
  assert.equal(scores.size, 2);
  assert.equal(scores.get('https://github.com/o/r/issues/2').score, 90);
  assert.equal(scores.get('https://github.com/o/r/issues/1').score, 30);

  const single = await triageIssues([{ repo: 'o/r', issues: [{ url: 'u', title: 't' }] }], { request: async () => { throw new Error('should not call'); } });
  assert.equal(single.size, 0);
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
