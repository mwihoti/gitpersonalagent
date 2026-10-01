'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { planQueueRefresh, hasHumanInput } = require('../src/queue-refresh');
const { deriveOutcome, buildPreferenceModel } = require('../src/feedback');

const NOW = Date.parse('2026-10-01T00:00:00Z');
const rec = (id, overrides) => ({ id, opportunity: `Item ${id}`, repo: 'o/r', issueUrl: `https://github.com/o/r/issues/${id}`, status: 'New', date: '2026-09-20', ...overrides });

test('hasHumanInput ignores bot bookkeeping lines', () => {
  assert.equal(hasHumanInput({ activityLog: '[bot 2026-09-30] new activity\n[bot 2026-09-30] assigned to x' }), false);
  assert.equal(hasHumanInput({ activityLog: '[bot 2026-09-30] x\nlooked at it, seems easy' }), true);
  assert.equal(hasHumanInput({ nextStep: 'open PR' }), true);
});

test('planQueueRefresh archives untouched old items without a GitHub call, closes and notes the rest', async () => {
  const fetched = [];
  const records = [
    rec(1, { date: '2026-04-15' }),                                   // old, untouched → archive
    rec(2, { date: '2026-04-15', nextStep: 'started reading' }),      // old but touched → check GitHub → closed
    rec(3),                                                           // recent → check → assigned
    rec(4, { activityLog: '[bot 2026-09-29] assigned to bob' }),      // already noted → nothing
    rec(5, { status: 'In Progress', owner: 'dan' }),                  // mine → skip
    rec(6, { status: 'Done' }),                                       // done → skip
    rec(7),                                                           // recent, open, unassigned → keep
    rec(8, { issueUrl: 'https://github.com/o/r/issues/7' }),          // duplicate row → skipped
  ];
  const statuses = {
    2: { state: 'closed', stateReason: 'completed', assignees: [] },
    3: { state: 'open', assignees: ['bob'] },
    4: { state: 'open', assignees: ['bob'] },
    7: { state: 'open', assignees: [] },
  };

  const plan = await planQueueRefresh(records, {
    now: NOW,
    archiveDays: 90,
    fetchStatus: async (_repo, number) => { fetched.push(number); return statuses[number]; },
    logger: { warn() {} },
  });

  assert.deepEqual(fetched.sort(), [2, 3, 4, 7]);
  assert.deepEqual(plan.actions.map(a => [a.recordId, a.action]), [[1, 'archive'], [2, 'close'], [3, 'note']]);
  assert.deepEqual(plan.counts, { archive: 1, close: 1, note: 1 });
  assert.equal(plan.actions[0].event.status, 'Done');
  assert.match(plan.actions[0].event.line, /auto-archived: untouched for 169 days \[outcome archived\]/);
  assert.equal(plan.actions[0].event.touch, false);
  assert.match(plan.actions[1].event.line, /closed upstream \[outcome closed-upstream\]/);
  assert.equal(plan.actions[2].event.status, undefined);

  const capped = await planQueueRefresh(records, { now: NOW, archiveDays: 90, maxChecks: 1, fetchStatus: async () => statuses[2], logger: { warn() {} } });
  assert.equal(capped.checked, 1);
});

test('archived and closed-upstream outcomes carry no preference weight', () => {
  assert.equal(deriveOutcome({ status: 'Done', activityLog: '[bot 2026-10-01] auto-archived: untouched for 169 days [outcome archived]' }, NOW).outcome, 'archived');
  assert.equal(deriveOutcome({ status: 'Done', activityLog: '[bot 2026-10-01] issue closed upstream [outcome closed-upstream]' }, NOW).outcome, 'archived');
  const model = buildPreferenceModel(Array.from({ length: 10 }, (_, i) => ({ id: i, repo: 'o/r', effort: 'low', status: 'Done', activityLog: '[outcome archived]' })), { now: NOW });
  assert.equal(model.counts.archived, 10);
  assert.equal(model.repos.get('o/r') || 0, 0);
  assert.equal(model.sampleSize, 0);
});
