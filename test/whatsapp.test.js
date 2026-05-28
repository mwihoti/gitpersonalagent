'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDigestMessage } = require('../src/whatsapp');

test('buildDigestMessage formats a readable mobile digest', () => {
  const message = buildDigestMessage({
    date: '2026-05-28',
    contest_digest: [{
      opportunity: 'Add regression coverage for descriptor parsing',
      repo: 'bitcoindevkit/bdk-ffi',
      issue_url: 'https://github.com/bitcoindevkit/bdk-ffi/issues/1002',
      why_it_qualifies: 'Clear test-only task with a scoped expected behavior.',
      suggested_action: 'Add a failing descriptor fixture, assert the unsupported descriptor error, then run the package tests.',
      clarity_tip: 'cargo test',
      effort: 'low',
    }],
    quick_plan: 'Start with the low-risk test issue, then pick one Rust documentation issue.',
    tech_news_summary: ['Bitcoin tooling continues to improve contributor onboarding.'],
  });

  assert.match(message, /^Repository Intelligence Digest/);
  assert.match(message, /Date: 2026-05-28/);
  assert.match(message, /Top opportunities/);
  assert.match(message, /Repo: bitcoindevkit\/bdk-ffi/);
  assert.match(message, /Issue: https:\/\/github.com\/bitcoindevkit\/bdk-ffi\/issues\/1002/);
  assert.match(message, /Execution plan/);
  assert.ok(message.length < 3900);
});
