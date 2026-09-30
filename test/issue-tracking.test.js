'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  annotateRepoData,
  buildChanges,
  buildWeeklyReview,
  isStale,
  buildSeenMap,
  capPerRepo,
  formatAge,
  isDoneStatus,
  pickTrackedForStatusCheck,
  selectIssuesForModel,
} = require('../src/issue-tracking');
const { detectClaim, buildIssueFitScore } = require('../src/repo-insights');

const URL1 = 'https://github.com/owner/repo/issues/1';
const URL2 = 'https://github.com/owner/repo/issues/2';

function seenWith(records) {
  return buildSeenMap(records.map(record => ({
    id: 'rec-' + record.issueUrl.split('/').pop(),
    repo: 'owner/repo',
    opportunity: 'Tracked',
    status: 'New',
    date: '2026-08-21',
    lastUpdated: new Date().toISOString(),
    ...record,
  })));
}

test('buildSeenMap collapses duplicate rows and keeps the earliest scan date', () => {
  const seen = buildSeenMap([
    { id: 'new', issueUrl: URL1, date: '2026-08-23', issueUpdatedAt: 'b' },
    { id: 'old', issueUrl: URL1.toUpperCase(), date: '2026-08-21', issueUpdatedAt: 'a' },
    { id: 'none', issueUrl: '' },
  ]);

  assert.equal(seen.size, 1);
  const entry = seen.get(URL1);
  assert.equal(entry.recordId, 'new');
  assert.equal(entry.issueUpdatedAt, 'b');
  assert.equal(entry.trackedSince, '2026-08-21');
  assert.equal(entry.duplicates, 1);
});

test('selectIssuesForModel drops unchanged, done, and claimed issues but keeps fresh activity', () => {
  const seen = seenWith([
    { issueUrl: URL1, issueUpdatedAt: '2026-08-20T00:00:00Z' },
    { issueUrl: URL2, issueUpdatedAt: '2026-08-20T00:00:00Z', status: 'Done' },
  ]);
  const repoData = annotateRepoData([{
    repo: 'owner/repo',
    issues: [
      { number: 1, url: URL1, updatedAt: '2026-08-20T00:00:00Z' },
      { number: 2, url: URL2, updatedAt: '2026-08-25T00:00:00Z' },
      { number: 3, url: 'https://github.com/owner/repo/issues/3', updatedAt: '2026-08-25T00:00:00Z', claim: { claimed: true, reason: 'assigned to x' } },
      { number: 4, url: 'https://github.com/owner/repo/issues/4', updatedAt: '2026-08-25T00:00:00Z' },
    ],
  }], seen);

  const { repoData: selected, skipped } = selectIssuesForModel(repoData, { dedupe: true, includeClaimed: false });

  assert.deepEqual(selected[0].issues.map(issue => issue.number), [4]);
  assert.equal(skipped.unchanged.length, 1);
  assert.equal(skipped.trackedDone.length, 1);
  assert.equal(skipped.claimed.length, 1);

  const noDedupe = selectIssuesForModel(repoData, { dedupe: false, includeClaimed: false });
  assert.deepEqual(noDedupe.repoData[0].issues.map(issue => issue.number), [1, 2, 4]);
});

test('annotateRepoData flags tracked issues with new activity', () => {
  const seen = seenWith([{ issueUrl: URL1, issueUpdatedAt: '2026-08-20T00:00:00Z' }]);
  const [repo] = annotateRepoData([{
    repo: 'owner/repo',
    issues: [{ number: 1, url: URL1, updatedAt: '2026-08-22T00:00:00Z' }],
  }], seen);

  assert.equal(repo.issues[0].seenBefore, true);
  assert.equal(repo.issues[0].hasNewActivity, true);
  assert.equal(repo.issues[0].trackedRecordId, 'rec-1');
  assert.equal(repo.issues[0].trackedSince, '2026-08-21');
});

test('capPerRepo keeps order and limits items per repository', () => {
  const items = [
    { repo: 'a/a', n: 1 }, { repo: 'a/a', n: 2 }, { repo: 'A/a', n: 3 },
    { repo: 'b/b', n: 4 }, { repo: 'c/c', n: 5 },
  ];
  assert.deepEqual(capPerRepo(items, 2).map(item => item.n), [1, 2, 4, 5]);
  assert.deepEqual(capPerRepo(items, 0).map(item => item.n), [1, 2, 3, 4, 5]);
});

test('buildChanges separates new, updated, closed, claimed, and still-open issues', () => {
  const seen = seenWith([
    { issueUrl: URL1, issueUpdatedAt: '2026-08-20T00:00:00Z' },
    { issueUrl: URL2, issueUpdatedAt: '2026-08-20T00:00:00Z', opportunity: 'Unchanged one' },
    { issueUrl: 'https://github.com/owner/repo/issues/7', opportunity: 'Closed one' },
    { issueUrl: 'https://github.com/owner/repo/issues/8', opportunity: 'Assigned one' },
    { issueUrl: 'https://github.com/owner/repo/issues/9', opportunity: 'Already done', status: 'Done' },
  ]);
  const digest = {
    contest_digest: [
      { issue_url: 'https://github.com/owner/repo/issues/3', repo: 'owner/repo' },
      { issue_url: URL1, repo: 'owner/repo', latest_comment: { author: 'm', body: 'hi', createdAt: '2026-08-25T00:00:00Z' } },
    ],
  };
  const repoData = [{
    repo: 'owner/repo',
    issues: [{ number: 2, title: 'Unchanged one', url: URL2, updatedAt: '2026-08-20T00:00:00Z', issueFitScore: 70, trackedSince: '2026-08-21' }],
  }];
  const skipped = { unchanged: repoData[0].issues, claimed: [{}] };
  const statusResults = [
    { url: 'https://github.com/owner/repo/issues/7', state: 'closed', stateReason: 'completed', closedAt: '2026-08-30T00:00:00Z', assignees: [] },
    { url: 'https://github.com/owner/repo/issues/8', state: 'open', assignees: ['bob'] },
    { url: 'https://github.com/owner/repo/issues/9', state: 'closed', assignees: [] },
    null,
  ];

  const changes = buildChanges({ digest, repoData, seen, statusResults, skipped });

  assert.deepEqual(changes.new, ['https://github.com/owner/repo/issues/3']);
  assert.equal(changes.updated.length, 1);
  assert.equal(changes.updated[0].previous_updated_at, '2026-08-20T00:00:00Z');
  assert.equal(changes.closed.length, 1);
  assert.equal(changes.closed[0].title, 'Closed one');
  assert.equal(changes.closed[0].record_id, 'rec-7');
  assert.equal(changes.claimed.length, 1);
  assert.equal(changes.claimed[0].reason, 'assigned to bob');
  assert.deepEqual(changes.still_open.map(entry => entry.title), ['Unchanged one']);
  assert.equal(changes.still_open[0].tracked_since, '2026-08-21');
  assert.equal(changes.skipped_claimed, 1);
});

test('buildChanges reports a tracked issue that got claimed inside today\'s scan', () => {
  const seen = seenWith([{ issueUrl: URL1, issueUpdatedAt: 'x', opportunity: 'Now taken' }]);
  const repoData = [{
    repo: 'owner/repo',
    issues: [{ number: 1, url: URL1, claim: { claimed: true, reason: 'open PR #5 by alice', by: 'alice', prUrl: 'https://github.com/owner/repo/pull/5' } }],
  }];

  const changes = buildChanges({ digest: { contest_digest: [] }, repoData, seen, statusResults: [], skipped: {} });

  assert.equal(changes.claimed.length, 1);
  assert.equal(changes.claimed[0].pr_url, 'https://github.com/owner/repo/pull/5');
});

test('pickTrackedForStatusCheck skips done, stale, and already-scanned records', () => {
  const now = Date.parse('2026-09-04T00:00:00Z');
  const seen = seenWith([
    { issueUrl: URL1, lastUpdated: '2026-09-01T00:00:00Z' },
    { issueUrl: URL2, lastUpdated: '2026-09-02T00:00:00Z' },
    { issueUrl: 'https://github.com/owner/repo/issues/3', lastUpdated: '2026-06-01T00:00:00Z' },
    { issueUrl: 'https://github.com/owner/repo/issues/4', lastUpdated: '2026-09-03T00:00:00Z', status: 'Done' },
  ]);

  const picked = pickTrackedForStatusCheck(seen, { now, maxDays: 21, limit: 10, skipUrls: new Set([URL2]) });
  assert.deepEqual(picked.map(entry => entry.issueUrl), [URL1]);
});

test('formatAge and isDoneStatus produce compact labels', () => {
  const now = Date.parse('2026-09-04T12:00:00Z');
  assert.equal(formatAge('2026-09-04T01:00:00Z', now), 'today');
  assert.equal(formatAge('2026-09-03T01:00:00Z', now), '1d ago');
  assert.equal(formatAge('2026-08-20T00:00:00Z', now), '15d ago');
  assert.equal(formatAge('2026-06-01T00:00:00Z', now), '3mo ago');
  assert.equal(formatAge('2023-06-01T00:00:00Z', now), '3y ago');
  assert.equal(formatAge('nope', now), '');
  assert.equal(isDoneStatus('Done'), true);
  assert.equal(isDoneStatus('Closed upstream'), true);
  assert.equal(isDoneStatus('In progress'), false);
});

test('detectClaim recognises assignees, open PRs, and "I will take this" comments', () => {
  const author = { login: 'reporter' };

  assert.equal(detectClaim({ assignees: [{ login: 'alice' }], user: author }).reason, 'assigned to alice');

  const viaPR = detectClaim({ assignees: [], user: author }, [], [
    { number: 12, state: 'merged', author: 'x' },
    { number: 13, state: 'open', author: 'bob', url: 'https://github.com/o/r/pull/13' },
  ]);
  assert.equal(viaPR.claimed, true);
  assert.equal(viaPR.reason, 'open PR #13 by bob');
  assert.equal(viaPR.prUrl, 'https://github.com/o/r/pull/13');

  const viaComment = detectClaim({ assignees: [], user: author }, [
    { user: { login: 'reporter' }, body: "I'll take this myself later" },
    { user: { login: 'carol' }, body: "I'd like to pick this up if nobody minds" },
    { user: { login: 'github-actions[bot]' }, body: 'working on this' },
  ]);
  assert.equal(viaComment.claimed, true);
  assert.equal(viaComment.by, 'carol');

  const free = detectClaim({ assignees: [], user: author }, [
    { user: { login: 'dave' }, body: 'Is this still relevant? The docs changed.' },
    { user: { login: 'maintainer' }, body: "Thanks, I'll take a look at this next week." },
    { user: { login: 'maintainer' }, body: "I'll take a closer look tomorrow" },
  ]);
  assert.equal(free.claimed, false);

  const stab = detectClaim({ assignees: [], user: author }, [
    { user: { login: 'erin' }, body: "I'll take a stab at this" },
  ]);
  assert.equal(stab.claimed, true);
});

test('buildIssueFitScore penalises claimed issues', () => {
  const base = {
    title: 'Improve docs',
    body: 'Document the panels and add examples for users of this tool.',
    labels: [{ name: 'good first issue' }],
    comments: 1,
    updated_at: new Date().toISOString(),
  };
  const open = buildIssueFitScore(base, []);
  const claimed = buildIssueFitScore({ ...base, claim: { claimed: true, reason: 'assigned to alice' } }, []);

  assert.ok(claimed.issueFitScore < open.issueFitScore - 20);
  assert.match(claimed.issueFitReason, /assigned to alice/);
});

test('buildWeeklyReview groups the tracked queue by what happened this week', () => {
  const now = Date.parse('2026-09-07T09:00:00Z');
  const seen = seenWith([
    { issueUrl: URL1, opportunity: 'Added this week', date: '2026-09-03', lastUpdated: '2026-09-03T00:00:00Z' },
    { issueUrl: URL2, opportunity: 'Finished', status: 'Done', date: '2026-08-01', lastUpdated: '2026-09-05T00:00:00Z', owner: 'dan' },
    { issueUrl: 'https://github.com/owner/repo/issues/3', opportunity: 'Working', status: 'In Progress', date: '2026-08-20', lastUpdated: '2026-09-01T00:00:00Z' },
    { issueUrl: 'https://github.com/owner/repo/issues/4', opportunity: 'Quiet', date: '2026-08-01', lastUpdated: '2026-08-10T00:00:00Z' },
    { issueUrl: 'https://github.com/owner/repo/issues/5', opportunity: 'Old done', status: 'Done', date: '2026-07-01', lastUpdated: '2026-07-02T00:00:00Z' },
  ]);

  const review = buildWeeklyReview(seen, { now });

  assert.deepEqual(review.added.map(e => e.title), ['Added this week']);
  assert.deepEqual(review.done.map(e => e.title), ['Finished']);
  assert.equal(review.done[0].owner, 'dan');
  assert.deepEqual(review.in_progress.map(e => e.title), ['Working']);
  assert.deepEqual(review.stale.map(e => e.title), ['Quiet']);
  assert.equal(review.open_count, 3);
  assert.equal(isStale({ status: 'Done', lastUpdated: '2026-01-01T00:00:00Z' }, { now }), false);
});
