'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../public/queue-model');

test('queue distinguishes dismissals, finished work, and upstream closures', () => {
  const history = 'Dismissed [dismiss reason: too big] [outcome dismissed]';
  assert.equal(Q.displayStatus({ status: 'Done', activityLog: history }), 'Dismissed');
  assert.equal(Q.displayStatus({ status: 'New', activityLog: history }), 'New');
  assert.equal(Q.displayStatus({ status: 'Done', activityLog: `${history}\n[outcome completed]` }), 'Done');
  assert.equal(Q.displayStatus({ status: 'Done', activityLog: '[outcome closed-upstream]' }), 'Closed');
  assert.equal(Q.isOpen({ status: 'In Progress' }), true);
  assert.equal(Q.isOpen({ status: 'Done' }), false);
});

test('detail controls preserve legacy status spelling when editing a record', () => {
  for (const status of ['In Progress', 'In progress', 'in progress', 'Working']) {
    assert.equal(Q.editableStatus({ status }), 'In Progress');
  }
  assert.equal(Q.editableStatus({ status: 'done' }), 'Done');
  assert.equal(Q.editableStatus({ status: 'New' }), 'New');
});

test('saved checklists retain completion and accept existing plain-text plans', () => {
  const steps = Q.parsePlan('1. Reproduce the issue\n- [x] Add a failing test\n- [ ] Fix the calculation');
  assert.deepEqual(steps, [{ text: 'Reproduce the issue', done: false }, { text: 'Add a failing test', done: true }, { text: 'Fix the calculation', done: false }]);
  assert.deepEqual(Q.parsePlan(Q.serializePlan(steps)), steps);
});

test('activity presents readable notes without internal ranking markers', () => {
  const [entry] = Q.activityEntries('[dashboard 2026-10-01T07:00:00Z] Marked done [outcome completed]');
  assert.equal(entry.text, 'Marked done');
  assert.equal(entry.who, 'Dashboard');
  assert.equal(Q.activityEntries('[bot 2026-10-01] Closed upstream [outcome closed-upstream]')[0].text, 'Closed upstream');
});

test('queue filters combine repo, priority, and search while keeping active work first', () => {
  const items = [
    { id: 'highest', repo: 'a/b', status: 'New', score: 99, priority: 'High', labels: ['wallet'] },
    { id: 'active', repo: 'a/b', status: 'In Progress', score: 50, priority: 'High', opportunity: 'Wallet fix' },
    { id: 'done', repo: 'a/b', status: 'Done', score: 100, priority: 'High', labels: ['wallet'] },
    { id: 'other', repo: 'c/d', status: 'New', score: 90, priority: 'Low', labels: ['wallet'] },
  ];
  const result = Q.filterIssues(items, { status: 'Open', repo: 'a/b', priority: 'High', search: 'wallet', sort: 'fit' });
  assert.deepEqual(result.map(item => item.id), ['active', 'highest']);
  assert.equal(items[0].id, 'highest');
});

test('repository choices stay available without a watchlist and deduplicate every source', () => {
  const choices = Q.repositoryChoices([
    { repo: 'Owner/Wallet', status: 'New', score: 88 },
    { repo: 'owner/wallet', status: 'Done', score: 99 },
    { repo: 'a/library', status: 'In Progress', score: 75 },
    { repo: '', status: 'New' },
  ], [], [{ repo: 'OWNER/WALLET', language: 'Rust' }, { repo: 'b/node', language: 'Go' }]);
  assert.equal(choices.length, 3);
  const wallet = choices.find(choice => choice.repo.toLowerCase() === 'owner/wallet');
  assert.equal(wallet.totalIssues, 2);
  assert.equal(wallet.openMatches, 1);
  assert.equal(wallet.bestScore, 88);
  assert.equal(wallet.watching, false);
  assert.equal(wallet.project.language, 'Rust');
  const watched = Q.repositoryChoices([{ repo: 'Owner/Wallet', status: 'New' }], [{ id: 'saved', repo: 'owner/wallet', enabled: false }], [{ repo: 'OWNER/WALLET' }]);
  assert.equal(watched.length, 1);
  assert.equal(watched[0].id, 'saved');
  assert.equal(watched[0].watching, true);
  assert.equal(watched[0].enabled, false);
  assert.equal(Q.filterIssues([{ repo: 'Owner/Wallet', status: 'New' }], { repo: watched[0].repo, status: 'Open' }).length, 1);
});

function listing(overrides = {}) {
  const issue = (number, extra = {}) => ({ number, title: `Issue ${number}`, url: `https://github.com/o/r/issues/${number}`, labels: [], issueFitScore: 50, updatedAt: `2026-09-${String(10 + number).padStart(2, '0')}T00:00:00Z`, detailChecked: false, ...extra });
  return {
    repo: 'o/r',
    issues: [
      issue(1, { issueFitScore: 90, detailChecked: true, labels: ['good first issue'] }),
      issue(2, { issueFitScore: 80, labels: ['bug', 'good first issue'] }),
      issue(3, { issueFitScore: 40, claim: { claimed: true, reason: 'assigned to busy' }, labels: [] }),
      issue(4, { issueFitScore: 72 }),
      issue(5, { issueFitScore: 30, title: 'Parser rewrite' }),
    ],
    detailChecked: 1,
    ...overrides,
  };
}

test('inspection view lists every issue, pages the rows, and links to queue records', () => {
  const queue = [{ id: 'rec9', issueUrl: 'https://github.com/o/r/issues/4/', status: 'New' }, { id: 'rec8', issueUrl: '', status: 'New' }];

  const first = Q.inspectionView(listing(), queue, { limit: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.matching, 5);
  assert.equal(first.rows.length, 2);
  assert.equal(first.remaining, 3);
  assert.equal(first.claimed, 1);
  assert.equal(first.goodFirst, 2);
  assert.equal(first.strong, 3, 'unclaimed issues scoring 70 or more');
  assert.equal(first.checked, 1);
  assert.equal(first.queuedCount, 1);

  const all = Q.inspectionView(listing(), queue, { limit: 100 });
  assert.equal(all.rows.length, 5, 'every issue is reachable');
  assert.equal(all.remaining, 0);
  assert.equal(all.rows.find(row => row.issue.number === 4).queued.id, 'rec9');
  assert.equal(all.rows.find(row => row.issue.number === 3).claimed, true);
});

test('inspection view filters by text, label, number, and claimed state', () => {
  const view = options => Q.inspectionView(listing(), [], { limit: 100, ...options });
  assert.deepEqual(view({ hideClaimed: true }).rows.map(row => row.issue.number), [1, 2, 4, 5]);
  assert.deepEqual(view({ query: 'parser' }).rows.map(row => row.issue.number), [5]);
  assert.deepEqual(view({ query: 'GOOD FIRST' }).rows.map(row => row.issue.number), [1, 2]);
  assert.deepEqual(view({ query: '#3' }).rows.map(row => row.issue.number), [3]);
  assert.deepEqual(view({ query: 'busy' }).rows.map(row => row.issue.number), [3], 'claim reasons are searchable');
  assert.equal(view({ query: 'parser' }).total, 5, 'total ignores the filter');
});

test('reading the next batch keeps detail already loaded and re-ranks', () => {
  const before = listing();
  const checkedOne = { ...before.issues[0], conversationSummary: 'kept' };
  before.issues[0] = checkedOne;
  // The API skipped the first batch, so issue 1 comes back with only its quick score.
  const after = listing({
    detailChecked: 1,
    issues: listing().issues.map(issue => {
      if (issue.number === 1) return { ...issue, detailChecked: false };
      return issue.number === 2 ? { ...issue, detailChecked: true, issueFitScore: 95 } : issue;
    }),
  });

  const merged = Q.mergeInspection(before, after);

  assert.equal(merged.issues[0].number, 2, 're-ranked by the new score');
  assert.equal(merged.issues.find(issue => issue.number === 1).conversationSummary, 'kept');
  assert.equal(merged.detailChecked, 2);
  assert.equal(merged.issues.length, 5);

  assert.equal(Q.mergeInspection(before, { ...after, repo: 'other/repo' }).repo, 'other/repo');
  assert.equal(Q.mergeInspection(null, after), after);
});
