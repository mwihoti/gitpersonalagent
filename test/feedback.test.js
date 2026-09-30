'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { applyPreferences, buildPreferenceModel, deriveOutcome, scoreAdjustment, summarizePreferences, describePreferences } = require('../src/feedback');

const NOW = Date.parse('2026-09-30T00:00:00Z');

function record(overrides) {
  return { id: 'r', repo: 'payjoin/rust-payjoin', effort: 'low', status: 'New', labels: 'good first issue, ffi', language: 'Rust', lastUpdated: '2026-09-29T00:00:00Z', date: '2026-09-29', ...overrides };
}

test('deriveOutcome reads merged, dismissed with reason, PR open, claimed, and ignored', () => {
  assert.equal(deriveOutcome(record({ status: 'Done', activityLog: '[bot 2026-09-20] PR merged x [outcome merged]' }), NOW).outcome, 'merged');
  assert.equal(deriveOutcome(record({ status: 'Done', prUrl: 'https://github.com/o/r/pull/1' }), NOW).outcome, 'merged');
  assert.deepEqual(deriveOutcome(record({ status: 'Done', activityLog: '[telegram 2026-09-20] dismissed by dan\n[telegram 2026-09-20] [dismiss reason: too big]' }), NOW), { outcome: 'dismissed', reason: 'too big' });
  assert.equal(deriveOutcome(record({ status: 'In Progress', prUrl: 'https://github.com/o/r/pull/2' }), NOW).outcome, 'pr_opened');
  assert.equal(deriveOutcome(record({ status: 'In Progress', owner: 'dan' }), NOW).outcome, 'claimed');
  assert.equal(deriveOutcome(record({ status: 'Done' }), NOW).outcome, 'dismissed');
  assert.equal(deriveOutcome(record({ lastUpdated: '2026-08-01T00:00:00Z' }), NOW).outcome, 'ignored');
  assert.equal(deriveOutcome(record({}), NOW).outcome, 'pending');
});

test('buildPreferenceModel turns outcomes into repo, label, and language weights', () => {
  const model = buildPreferenceModel([
    record({ status: 'Done', activityLog: '[outcome merged]', prUrl: 'p' }),
    record({ status: 'Done', activityLog: '[outcome merged]', prUrl: 'p' }),
    record({ repo: 'jamaljsr/polar', language: 'TypeScript', labels: 'ui', status: 'Done', activityLog: 'dismissed by dan\n[dismiss reason: not my stack]' }),
    record({ repo: 'jamaljsr/polar', language: 'TypeScript', labels: 'ui', status: 'Done', activityLog: 'dismissed by dan\n[dismiss reason: not my stack]' }),
    record({ repo: 'a/b', effort: 'high', status: 'Done', activityLog: 'dismissed\n[dismiss reason: too big]' }),
    record({}),
  ], { now: NOW });

  assert.equal(model.counts.merged, 2);
  assert.equal(model.counts.dismissed, 3);
  assert.equal(model.counts.pending, 1);
  assert.ok(model.repos.get('payjoin/rust-payjoin') > 0);
  assert.ok(model.repos.get('jamaljsr/polar') < 0);
  assert.ok(model.languages.get('typescript') < model.languages.get('rust'));
  assert.ok(model.efforts.get('high') < 0);
  assert.equal(model.dismissReasons.get('not my stack'), 2);
  assert.equal(model.sampleSize, 5);

  const summary = summarizePreferences(model);
  assert.match(summary, /Track record: 2 merged/);
  assert.match(summary, /Ships in: payjoin\/rust-payjoin/);
  assert.match(summary, /Skips: jamaljsr\/polar/);
  assert.match(summary, /not my stack \(2\)/);

  const described = describePreferences(model);
  assert.deepEqual(described.boostedRepos, ['payjoin/rust-payjoin']);
  assert.ok(described.confidence > 0 && described.confidence <= 100);
});

test('applyPreferences nudges scores within bounds and re-sorts', () => {
  const model = buildPreferenceModel(Array.from({ length: 12 }, (_, i) => record(
    i < 8
      ? { status: 'Done', activityLog: '[outcome merged]', prUrl: 'p' }
      : { repo: 'jamaljsr/polar', language: 'TypeScript', status: 'Done', activityLog: 'dismissed\n[dismiss reason: not my stack]' },
  )), { now: NOW });

  const [repoA, repoB] = applyPreferences([
    { repo: 'payjoin/rust-payjoin', issues: [{ number: 1, issueFitScore: 60, labels: ['good first issue'], repositoryLanguage: 'Rust', issueFitReason: 'base' }] },
    { repo: 'jamaljsr/polar', issues: [
      { number: 2, issueFitScore: 70, labels: [], repositoryLanguage: 'TypeScript' },
      { number: 3, issueFitScore: 40, labels: [], repositoryLanguage: 'Go' },
    ] },
  ], model);

  assert.ok(repoA.issues[0].issueFitScore > 60);
  assert.ok(repoA.issues[0].preferenceDelta <= 24);
  assert.match(repoA.issues[0].issueFitReason, /^base\. you have shipped/);
  assert.ok(repoB.issues.find(i => i.number === 2).issueFitScore < 70);
  assert.equal(scoreAdjustment(null, {}).delta, 0);
  assert.deepEqual(applyPreferences([{ repo: 'x', issues: [] }], buildPreferenceModel([])), [{ repo: 'x', issues: [] }]);
});
