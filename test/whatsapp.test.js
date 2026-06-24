'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  buildDigestMessage,
  buildDigestMessages,
  listTelegramSubscribers,
  normalizeCommand,
  parseScanMode,
  subscribeTelegramChat,
  unsubscribeTelegramChat,
} = require('../src/whatsapp');

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

test('buildDigestMessages splits summary and opportunity details', () => {
  const digest = {
    date: '2026-05-28',
    contest_digest: [{
      opportunity: 'Remove stale issue template',
      repo: 'bitcoin/bitcoin',
      issue_url: 'https://github.com/bitcoin/bitcoin/issues/35399',
      why_it_qualifies: 'BitcoinDevs source and high local fit score.',
      suggested_action: 'Patch the template and update contributor docs.',
      clarity_tip: 'Run docs checks.',
      effort: 'low',
      source: 'bitcoindevs',
      score: 91,
    }],
    quick_plan: 'Start with the narrow template cleanup.',
    tech_news_summary: [],
  };

  const messages = buildDigestMessages(digest);

  assert.equal(messages.length, 2);
  assert.match(messages[0], /Repository Intelligence Digest/);
  assert.match(messages[1], /Opportunity 1 of 1/);
  assert.match(messages[1], /Source: bitcoindevs/);
});

test('buildDigestMessages sends up to 8 opportunity details by default', () => {
  const digest = {
    date: '2026-05-28',
    contest_digest: Array.from({ length: 10 }, (_, index) => ({
      opportunity: `Opportunity ${index + 1}`,
      repo: 'bitcoin/bitcoin',
      issue_url: `https://github.com/bitcoin/bitcoin/issues/${index + 1}`,
      why_it_qualifies: 'Clear scoped work.',
      suggested_action: 'Make the smallest useful change.',
      clarity_tip: 'Run tests.',
      effort: 'low',
    })),
    quick_plan: 'Start with the first item.',
    tech_news_summary: [],
  };

  const messages = buildDigestMessages(digest);

  assert.equal(messages.length, 9);
  assert.match(messages[8], /Opportunity 8 of 8/);
});

test('Telegram subscribers can opt in and out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-subscribers-'));
  const previousDataDir = process.env.DAN_AGENT_DATA_DIR;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.DAN_AGENT_DATA_DIR = dir;
  process.env.TELEGRAM_CHAT_ID = '';

  try {
    const whatsappPath = require.resolve('../src/whatsapp');
    const configPath = require.resolve('../src/config');
    delete require.cache[whatsappPath];
    delete require.cache[configPath];
    const fresh = require('../src/whatsapp');

    await fresh.subscribeTelegramChat({
      id: 12345,
      type: 'private',
      username: 'ada',
      first_name: 'Ada',
    });

    assert.deepEqual(await fresh.listTelegramSubscribers(), ['12345']);
    assert.equal(await fresh.unsubscribeTelegramChat(12345), true);
    assert.deepEqual(await fresh.listTelegramSubscribers(), []);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.DAN_AGENT_DATA_DIR;
    } else {
      process.env.DAN_AGENT_DATA_DIR = previousDataDir;
    }
    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId;
    }
  }
});

test('normalizeCommand accepts slash, plain, and bot-addressed commands', () => {
  assert.equal(normalizeCommand('/start'), 'start');
  assert.equal(normalizeCommand('start'), 'start');
  assert.equal(normalizeCommand('/status@dan_sentinel_bot'), 'status');
  assert.equal(normalizeCommand('/scan now'), 'scan');
});

test('parseScanMode recognizes admin scan modes', () => {
  assert.equal(parseScanMode('/scan'), 'default');
  assert.equal(parseScanMode('/scan all'), 'all');
  assert.equal(parseScanMode('/scan good-first'), 'goodfirst');
  assert.equal(parseScanMode('/scan medium'), 'medium');
});
