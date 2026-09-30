'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEngineeringReport, classifyPullRequest } = require('../src/pr-tracking');

const NOW = Date.parse('2026-09-30T00:00:00Z');

test('classifyPullRequest picks the most actionable state', () => {
  assert.equal(classifyPullRequest({ merged: true, mergedAt: '2026-09-29T00:00:00Z' }).state, 'merged');
  assert.equal(classifyPullRequest({ state: 'closed' }).state, 'closed');
  assert.equal(classifyPullRequest({ state: 'open', draft: true }).state, 'draft');
  assert.equal(classifyPullRequest({ state: 'open', mergeableState: 'dirty', ci: 'failure' }).state, 'needs_rebase');
  assert.equal(classifyPullRequest({ state: 'open', ci: 'failure', ciDetail: 'clippy' }).detail, 'CI failing (clippy)');
  assert.equal(classifyPullRequest({ state: 'open', reviewState: 'changes_requested', reviewer: 'm', ci: 'success' }).state, 'changes_requested');
  assert.equal(classifyPullRequest({ state: 'open', reviewState: 'approved', ci: 'success' }).state, 'approved');
  assert.equal(classifyPullRequest({ state: 'open', ci: 'pending' }).state, 'ci_pending');
  assert.equal(classifyPullRequest({ state: 'open', reviewComments: 2 }).state, 'in_review');
  assert.equal(classifyPullRequest({ state: 'open' }).state, 'awaiting_review');
  assert.equal(classifyPullRequest(null).state, 'unknown');
});

test('buildEngineeringReport tracks PRs, marks merges done, nudges stalls, and auto-links your PRs', async () => {
  const records = [
    { id: 'r1', status: 'In Progress', opportunity: 'Merged one', issueUrl: 'https://github.com/o/r/issues/1', prUrl: 'https://github.com/o/r/pull/10', lastUpdated: '2026-09-29T00:00:00Z', activityLog: 'x' },
    { id: 'r2', status: 'In Progress', opportunity: 'Needs work', issueUrl: 'https://github.com/o/r/issues/2', prUrl: 'https://github.com/o/r/pull/11', lastUpdated: '2026-09-29T00:00:00Z' },
    { id: 'r3', status: 'In Progress', opportunity: 'No PR yet', issueUrl: 'https://github.com/o/r/issues/3', lastUpdated: '2026-09-20T00:00:00Z' },
    { id: 'r4', status: 'In Progress', opportunity: 'Auto-linked', issueUrl: 'https://github.com/o/r/issues/4', lastUpdated: '2026-09-29T00:00:00Z' },
    { id: 'r5', status: 'New', opportunity: 'Not started', issueUrl: 'https://github.com/o/r/issues/5' },
    { id: 'r6', status: 'Done', opportunity: 'Finished', issueUrl: 'https://github.com/o/r/issues/6', prUrl: 'https://github.com/o/r/pull/12' },
  ];
  const snapshots = {
    10: { state: 'closed', merged: true, mergedAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', title: 'Fix' },
    11: { state: 'open', reviewState: 'changes_requested', reviewer: 'maint', updatedAt: '2026-09-20T00:00:00Z', title: 'WIP' },
    13: { state: 'open', updatedAt: '2026-09-29T00:00:00Z', title: 'Mine' },
  };
  const fetched = [];

  const report = await buildEngineeringReport(records, {
    now: NOW,
    githubLogins: ['mwihoti'],
    linkedPRsByIssue: new Map([
      ['https://github.com/o/r/issues/4', [
        { number: 99, author: 'someone', state: 'open', url: 'https://github.com/o/r/pull/99' },
        { number: 13, author: 'Mwihoti', state: 'open', url: 'https://github.com/o/r/pull/13' },
      ]],
    ]),
    fetchPullRequest: async (_repo, number) => { fetched.push(number); return snapshots[number]; },
    logger: { warn() {} },
  });

  assert.deepEqual(fetched.sort(), [10, 11, 13]);
  assert.deepEqual(report.prs.map(pr => pr.state), ['changes_requested', 'awaiting_review', 'merged']);
  assert.equal(report.prs[0].yourMove, true);
  assert.equal(report.counts.active, 4);
  assert.equal(report.counts.yourMove, 1);
  assert.equal(report.counts.merged, 1);

  const merged = report.events.find(e => e.recordId === 'r1');
  assert.equal(merged.status, 'Done');
  assert.match(merged.line, /\[outcome merged\]/);
  const linked = report.events.find(e => e.recordId === 'r4');
  assert.equal(linked.prUrl, 'https://github.com/o/r/pull/13');

  assert.deepEqual(report.nudges.map(n => n.recordId).sort(), ['r2', 'r3']);
  assert.match(report.nudges.find(n => n.recordId === 'r3').detail, /no PR linked/);
  assert.match(report.nudges.find(n => n.recordId === 'r2').detail, /changes requested by maint, untouched for 10 days/);
});
