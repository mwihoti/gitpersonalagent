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
