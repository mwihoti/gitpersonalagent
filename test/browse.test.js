'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { browseView, parseCallback, SORTS } = require('../src/browse');

const issue = (number, overrides = {}) => ({
  number, title: `Issue ${number}`, url: `https://github.com/o/r/issues/${number}`,
  labels: [], issueFitScore: 50 + number, updatedAt: `2026-10-${String(number).padStart(2, '0')}T00:00:00Z`, ...overrides,
});
const record = (overrides = {}) => ({
  repo: 'o/r', opportunity: 'Queued thing', issueUrl: 'https://github.com/o/r/issues/9',
  status: 'New', priority: 'Medium', effort: 'low', score: 70, labels: 'bug', ...overrides,
});

test('callback data round-trips and rejects junk', () => {
  assert.deepEqual(parseCallback('b:l'), { view: 'list' });
  assert.deepEqual(parseCallback('b:a:g'), { view: 'all', sort: 'g' });
  assert.deepEqual(parseCallback('b:r:p:payjoin/rust-payjoin'), { view: 'repo', sort: 'p', repo: 'payjoin/rust-payjoin' });
  assert.deepEqual(parseCallback('b:r:zz:o/r'), { view: 'repo', sort: 'f', repo: 'o/r' }, 'unknown sorts fall back to fit');
  assert.equal(parseCallback('claim:rec1'), null);
  assert.equal(parseCallback('b:r:f:not a repo'), null);
  assert.equal(parseCallback(`b:r:f:${'a'.repeat(60)}/b`), null);
  for (const [key, repo] of [['f', 'bitcoin-dev-project/sim-ln'], ['g', 'lightningdevkit/rust-lightning']]) {
    assert.ok(`b:r:${key}:${repo}`.length <= 64, 'callback data fits the Telegram limit');
  }
});

test('the repo list shows every scan target as buttons plus the all-repos switch', async () => {
  const view = await browseView({ view: 'list' }, {
    targets: async () => ['payjoin/rust-payjoin', 'lightningnetwork/lnd', 'bitcoin/bitcoin'],
    queue: async () => [record({ repo: 'payjoin/rust-payjoin' }), record({ repo: 'lightningnetwork/lnd', issueUrl: 'u2' }), record({ status: 'Done', issueUrl: 'u3' })],
  });

  assert.match(view.text, /<b>Repos in the daily scan<\/b> \(3\)/);
  assert.match(view.text, /payjoin\/rust-payjoin<\/code> · 1 in the queue/);
  const buttons = view.replyMarkup.inline_keyboard.flat();
  assert.deepEqual(buttons.slice(0, 2).map(b => b.callback_data), ['b:r:f:payjoin/rust-payjoin', 'b:r:f:lightningnetwork/lnd']);
  assert.equal(buttons[0].text, 'rust-payjoin', 'short names on the buttons');
  assert.deepEqual(buttons.at(-1), { text: '🌐 All repos (2 in the queue)', callback_data: 'b:a:f' });
});

test('a repo view lists ten unclaimed issues by fit and re-sorts by label filters', async () => {
  const issues = [
    issue(1, { labels: [{ name: 'good first issue' }], issueFitScore: 60 }),
    issue(2, { labels: ['bug'], issueFitScore: 90 }),
    issue(3, { claim: { claimed: true, reason: 'assigned' }, issueFitScore: 99 }),
    ...Array.from({ length: 12 }, (_, i) => issue(10 + i, { issueFitScore: 40 + i })),
  ];
  const scan = async (repo, options) => {
    assert.equal(repo, 'o/r');
    assert.deepEqual(options, { mode: 'all-open', detail: 0, maxItems: 300 });
    return { repo, totalOpenIssues: issues.length, issues };
  };

  const fit = await browseView({ view: 'repo', sort: 'f', repo: 'o/r' }, { scan });
  assert.match(fit.text, /<b>o\/r<\/b> · 15 open issues · Best fit/);
  assert.equal((fit.text.match(/href=/g) || []).length, 10, 'ten issues');
  assert.ok(!fit.text.includes('#3'), 'claimed issues are never shown');
  assert.ok(fit.text.indexOf('#2') < fit.text.indexOf('#21'), 'best fit first');
  assert.match(fit.replyMarkup.inline_keyboard[0][0].text, /✓ Best fit/);
  assert.deepEqual(fit.replyMarkup.inline_keyboard[1].map(b => b.callback_data), ['b:l', 'b:a:f']);

  const good = await browseView({ view: 'repo', sort: 'g', repo: 'o/r' }, { scan });
  assert.equal((good.text.match(/href=/g) || []).length, 1);
  assert.match(good.text, /#1 Issue 1/);
  assert.match(good.text, /good first issue/);
  assert.match(good.replyMarkup.inline_keyboard[0][1].text, /✓ Good first/);

  const pri = await browseView({ view: 'repo', sort: 'p', repo: 'o/r' }, { scan });
  assert.equal((pri.text.match(/href=/g) || []).length, 1);
  assert.match(pri.text, /#2 Issue 2/);

  const none = await browseView({ view: 'repo', sort: 'g', repo: 'o/r' }, { scan: async repo => ({ repo, totalOpenIssues: 0, issues: [] }) });
  assert.match(none.text, /No unclaimed good first issues open here right now/);
});

test('the all-repos view reads the queue with the same sorts', async () => {
  const queue = async () => [
    record({ opportunity: 'High one', priority: 'High', score: 88, issueUrl: 'https://github.com/a/b/issues/1' }),
    record({ opportunity: 'Good one', labels: 'good first issue, docs', score: 70, issueUrl: 'https://github.com/a/b/issues/2' }),
    record({ opportunity: 'Done one', status: 'Done', issueUrl: 'https://github.com/a/b/issues/3' }),
    record({ opportunity: 'No url', issueUrl: '' }),
  ];

  const all = await browseView({ view: 'all', sort: 'f' }, { queue });
  assert.match(all.text, /<b>All repos<\/b> · 2 open in the queue · Best fit/);
  assert.ok(all.text.indexOf('High one') < all.text.indexOf('Good one'));
  assert.ok(!all.text.includes('Done one'));
  assert.match(all.text, /high priority/);

  const good = await browseView({ view: 'all', sort: 'g' }, { queue });
  assert.ok(good.text.includes('Good one') && !good.text.includes('High one'));

  const pri = await browseView({ view: 'all', sort: 'p' }, { queue });
  assert.ok(pri.text.includes('High one') && !pri.text.includes('Good one'));
  assert.deepEqual(pri.replyMarkup.inline_keyboard[1], [{ text: '« Repos', callback_data: 'b:l' }]);

  const empty = await browseView({ view: 'all', sort: 'f' }, { queue: async () => [] });
  assert.match(empty.text, /The queue is empty/);
});

test('an empty target list explains itself instead of showing dead buttons', async () => {
  const view = await browseView({ view: 'list' }, { targets: async () => [], queue: async () => [] });
  assert.match(view.text, /No repositories are configured yet/);
  assert.equal(view.replyMarkup, null);
  assert.equal(Object.keys(SORTS).length, 3);
});
