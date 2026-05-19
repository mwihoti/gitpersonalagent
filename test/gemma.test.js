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
