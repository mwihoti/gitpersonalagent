'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function loadRunScanWithStubs(t, stubs) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-scan-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  process.env.DAN_AGENT_DATA_DIR = tmpDir;

  const modulePath = path.resolve(__dirname, '..', 'src', 'run-scan.js');
  const dependencyPaths = {
    github: path.resolve(__dirname, '..', 'src', 'github.js'),
    gemma: path.resolve(__dirname, '..', 'src', 'gemma.js'),
    news: path.resolve(__dirname, '..', 'src', 'news.js'),
    airtable: path.resolve(__dirname, '..', 'src', 'airtable.js'),
    repositories: path.resolve(__dirname, '..', 'src', 'repositories.js'),
    whatsapp: path.resolve(__dirname, '..', 'src', 'whatsapp.js'),
    scanState: path.resolve(__dirname, '..', 'src', 'scan-state.js'),
    issueAnalysis: path.resolve(__dirname, '..', 'src', 'issue-analysis.js'),
  };

  const previous = new Map();
  for (const moduleFile of [modulePath, ...Object.values(dependencyPaths)]) {
    previous.set(moduleFile, require.cache[moduleFile]);
    delete require.cache[moduleFile];
  }

  const effectiveStubs = {
    issueAnalysis: { analyzeIssue: async () => { throw new Error('no analysis in tests'); } },
    ...stubs,
  };
  const queueRefreshPath = path.resolve(__dirname, '..', 'src', 'queue-refresh.js');
  if (!stubs.queueRefresh) {
    previous.set(queueRefreshPath, require.cache[queueRefreshPath]);
    delete require.cache[queueRefreshPath];
    require.cache[queueRefreshPath] = { id: queueRefreshPath, filename: queueRefreshPath, loaded: true, exports: { planQueueRefresh: async () => ({ actions: [], counts: { archive: 0, close: 0, note: 0 }, checked: 0, candidates: 0 }) } };
  }
  if (stubs.gemma && !stubs.gemma.triageIssues) {
    stubs.gemma.triageIssues = async () => new Map();
    stubs.gemma.hasCloudProvider = () => false;
  }
  for (const [key, moduleFile] of Object.entries(dependencyPaths)) {
    if (!effectiveStubs[key]) continue;
    require.cache[moduleFile] = {
      id: moduleFile,
      filename: moduleFile,
      loaded: true,
      exports: effectiveStubs[key],
    };
  }

  t.after(() => {
    for (const [moduleFile, cached] of previous.entries()) {
      if (cached) require.cache[moduleFile] = cached;
      else delete require.cache[moduleFile];
    }
  });

  return require(modulePath);
}

test('runScan reuses the in-flight scan instead of starting a second one', async t => {
  let scanCalls = 0;
  let saveCalls = 0;
  let notifyCalls = 0;
  let scanOptions = null;
  let analysisOptions = null;

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async (_repos, options) => {
        scanCalls += 1;
        scanOptions = options;
        await new Promise(resolve => setTimeout(resolve, 40));
        return [{ issues: [{ number: 1 }], repo: 'owner/repo' }];
      },
    },
    gemma: {
      analyzeWithGemma: async (_repoData, _news, options) => {
        analysisOptions = options;
        return ({
        date: '2026-05-16',
        contest_digest: [{
          opportunity: 'Ship fix',
          repo: 'owner/repo',
          issue_url: 'https://github.com/owner/repo/issues/1',
          why_it_qualifies: 'good',
          suggested_action: 'do work',
          code_skeleton: '// code',
          clarity_tip: 'npm test',
          why_it_matters: 'impact',
          effort: 'low',
        }],
        quick_plan: 'Do the thing',
        tech_news_summary: ['news'],
      });
      },
    },
    news: {
      fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }),
    },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ seen: new Map(), records: [] }),
      recordIssueEvents: async () => 0,
      saveDigest: async () => {
        saveCalls += 1;
      },
    },
    repositories: {
      getScanTargets: async () => ({
        source: 'watchlist',
        repos: ['owner/repo'],
        issues: [],
      }),
    },
    whatsapp: {
      sendNotification: async () => {
        notifyCalls += 1;
      },
      buildDigestMessages: () => ['digest'],
      DIGEST_PARSE_MODE: 'HTML',
    },
  });

  const [first, second] = await Promise.all([
    runScan({ trigger: 'manual-a' }),
    runScan({ trigger: 'manual-b' }),
  ]);

  assert.equal(scanCalls, 1);
  assert.equal(scanOptions.mode, 'prioritized');
  assert.equal(analysisOptions.opportunityLimit, 8);
  assert.equal(saveCalls, 1);
  assert.equal(notifyCalls, 1);
  assert.equal(first.digest.contest_digest.length, 1);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
});

test('runScan broadens GitHub and model limits for all scan mode', async t => {
  let scanOptions = null;
  let analysisOptions = null;

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async (_repos, options) => {
        scanOptions = options;
        return [{ issues: [{ number: 1 }], repo: 'owner/repo' }];
      },
    },
    gemma: {
      analyzeWithGemma: async (_repoData, _news, options) => {
        analysisOptions = options;
        return {
          date: '2026-05-16',
          contest_digest: [],
          quick_plan: 'Do the thing',
          tech_news_summary: ['news'],
        };
      },
    },
    news: {
      fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }),
    },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ seen: new Map(), records: [] }),
      recordIssueEvents: async () => 0,
      saveDigest: async () => {},
    },
    repositories: {
      getScanTargets: async () => ({
        source: 'watchlist',
        repos: ['owner/repo'],
        issues: [],
      }),
    },
    whatsapp: {
      sendNotification: async () => {},
      buildDigestMessages: () => ['digest'],
      DIGEST_PARSE_MODE: 'HTML',
    },
  });

  await runScan({ scanMode: 'all', dedupe: false });

  assert.equal(scanOptions.mode, 'all-open');
  assert.equal(analysisOptions.scanMode, 'all');
  assert.equal(analysisOptions.opportunityLimit, 24);
  assert.equal(analysisOptions.issuesPerRepo, 20);
});

test('runScan skips the model and reports still-open issues when nothing changed', async t => {
  const { buildSeenMap } = require('../src/issue-tracking');
  let modelCalls = 0;
  let savedDigest = null;
  let notifiedDigest = null;
  let recordedEvents = null;

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async () => [{
        repo: 'owner/repo',
        issues: [{
          number: 1,
          title: 'Same issue',
          url: 'https://github.com/owner/repo/issues/1',
          updatedAt: '2026-05-16T00:00:00Z',
          issueFitScore: 80,
        }],
      }],
      fetchIssueStatus: async () => null,
      parseIssueUrl: () => null,
    },
    gemma: {
      analyzeWithGemma: async () => {
        modelCalls += 1;
        throw new Error('model should not be called');
      },
    },
    news: {
      fetchNews: async () => ({ hackerNews: [{ title: 'headline' }], githubReleases: [], rssFeeds: [] }),
    },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ records: [], seen: buildSeenMap([{
        id: 'rec1',
        issueUrl: 'https://github.com/owner/repo/issues/1',
        repo: 'owner/repo',
        opportunity: 'Same issue',
        status: 'New',
        issueUpdatedAt: '2026-05-16T00:00:00Z',
        date: '2026-05-15',
      }]) }),
      recordIssueEvents: async events => {
        recordedEvents = events;
        return 0;
      },
      saveDigest: async digest => {
        savedDigest = digest;
      },
    },
    repositories: {
      getScanTargets: async () => ({
        source: 'watchlist',
        repos: ['owner/repo'],
        issues: [],
      }),
    },
    whatsapp: {
      sendNotification: async () => {},
      buildDigestMessages: digest => {
        notifiedDigest = digest;
        return ['digest'];
      },
      DIGEST_PARSE_MODE: 'HTML',
    },
  });

  const result = await runScan({ trigger: 'scheduled-test' });

  assert.equal(modelCalls, 0);
  assert.equal(result.digest.contest_digest.length, 0);
  assert.equal(result.digest.changes.still_open.length, 1);
  assert.equal(result.digest.changes.still_open[0].tracked_since, '2026-05-15');
  assert.equal(savedDigest.contest_digest.length, 0);
  assert.deepEqual(recordedEvents, []);
  assert.deepEqual(notifiedDigest.tech_news_summary, ['headline']);
});

test('runScan updates tracked records instead of saving duplicates when an issue has new activity', async t => {
  const { buildSeenMap } = require('../src/issue-tracking');
  let modelInput = null;
  let savedDigest = null;
  let recordedEvents = null;

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async () => [{
        repo: 'owner/repo',
        issues: [
          {
            number: 1,
            title: 'Tracked issue with a new comment',
            url: 'https://github.com/owner/repo/issues/1',
            updatedAt: '2026-05-17T00:00:00Z',
            latestComment: { author: 'maintainer', createdAt: '2026-05-17T00:00:00Z', body: 'Go ahead' },
          },
          {
            number: 2,
            title: 'Claimed issue',
            url: 'https://github.com/owner/repo/issues/2',
            updatedAt: '2026-05-17T00:00:00Z',
            claim: { claimed: true, reason: 'assigned to bob', by: 'bob', prUrl: '' },
          },
          {
            number: 3,
            title: 'Brand new issue',
            url: 'https://github.com/owner/repo/issues/3',
            updatedAt: '2026-05-17T00:00:00Z',
          },
        ],
      }],
      fetchIssueStatus: async () => null,
      parseIssueUrl: () => null,
    },
    gemma: {
      analyzeWithGemma: async repoData => {
        modelInput = repoData;
        const item = url => ({
          opportunity: 'Do it',
          repo: 'owner/repo',
          issue_url: url,
          why_it_qualifies: 'good',
          suggested_action: 'do work',
          code_skeleton: '// code',
          clarity_tip: 'npm test',
          why_it_matters: 'impact',
          effort: 'low',
        });
        return {
          date: '2026-05-17',
          contest_digest: [
            item('https://github.com/owner/repo/issues/1'),
            item('https://github.com/owner/repo/issues/3'),
          ],
          quick_plan: 'Do the thing',
          tech_news_summary: ['news'],
        };
      },
    },
    news: {
      fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }),
    },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ records: [], seen: buildSeenMap([{
        id: 'rec1',
        issueUrl: 'https://github.com/owner/repo/issues/1',
        repo: 'owner/repo',
        opportunity: 'Tracked issue',
        status: 'New',
        issueUpdatedAt: '2026-05-16T00:00:00Z',
        date: '2026-05-15',
        activityLog: 'looked at it',
      }]) }),
      recordIssueEvents: async events => {
        recordedEvents = events;
        return events.length;
      },
      saveDigest: async digest => {
        savedDigest = digest;
      },
    },
    repositories: {
      getScanTargets: async () => ({
        source: 'watchlist',
        repos: ['owner/repo'],
        issues: [],
      }),
    },
    whatsapp: {
      sendNotification: async () => {},
      buildDigestMessages: () => ['digest'],
      DIGEST_PARSE_MODE: 'HTML',
    },
  });

  const result = await runScan({ trigger: 'scheduled-test' });

  // Claimed issue never reaches the model; the tracked one does because it changed.
  assert.deepEqual(modelInput[0].issues.map(issue => issue.number), [1, 3]);
  assert.deepEqual(result.digest.changes.new, ['https://github.com/owner/repo/issues/3']);
  assert.equal(result.digest.changes.updated.length, 1);
  assert.equal(result.digest.changes.updated[0].latest_comment.author, 'maintainer');
  assert.equal(result.digest.changes.skipped_claimed, 1);
  assert.deepEqual(savedDigest.contest_digest.map(item => item.issue_url), ['https://github.com/owner/repo/issues/3']);
  assert.equal(recordedEvents.length, 1);
  assert.equal(recordedEvents[0].recordId, 'rec1');
  assert.equal(recordedEvents[0].issueUpdatedAt, '2026-05-17T00:00:00Z');
  assert.match(recordedEvents[0].line, /maintainer/);
});

test('runScan folds deep analysis into the digest and drops items that turn out to be taken', async t => {
  let savedDigest = null;
  let notifiedDigest = null;
  const analyzed = [];

  const analysisFor = (url, state) => ({
    issueUrl: url,
    issueUpdatedAt: '2026-05-17T00:00:00Z',
    analyzedAt: '2026-05-17T01:00:00Z',
    model: 'model',
    analysis: {
      summary: 'sum',
      maintainerWants: 'Mirror the u64 fix.',
      evidence: [],
      currentState: state,
      stateReason: state === 'available' ? 'nobody owns it' : 'open PR #9 by bob',
      openQuestions: ['Reject negative hex?'],
      filesToChange: [{ path: 'common/json_parse.c', why: 'strict check', verified: true }],
      plan: ['Edit common/json_parse.c', 'Add test'],
      validation: 'make check',
      effort: 'low',
      impact: 'high',
      confidence: 80,
      codeSkeleton: '// common/json_parse.c',
      firstCommentDraft: '',
    },
    context: {},
    cached: false,
  });

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async () => [{
        repo: 'owner/repo',
        issues: [
          { number: 1, title: 'A', url: 'https://github.com/owner/repo/issues/1', updatedAt: '2026-05-17T00:00:00Z' },
          { number: 2, title: 'B', url: 'https://github.com/owner/repo/issues/2', updatedAt: '2026-05-17T00:00:00Z' },
        ],
      }],
      fetchIssueStatus: async () => null,
      parseIssueUrl: () => null,
    },
    gemma: {
      analyzeWithGemma: async () => {
        const item = url => ({
          opportunity: 'Do it',
          repo: 'owner/repo',
          issue_url: url,
          why_it_qualifies: 'good',
          suggested_action: 'do work',
          code_skeleton: '// generic',
          clarity_tip: 'npm test',
          why_it_matters: 'impact',
          effort: 'medium',
        });
        return {
          date: '2026-05-17',
          contest_digest: [item('https://github.com/owner/repo/issues/1'), item('https://github.com/owner/repo/issues/2')],
          quick_plan: 'Global plan',
          tech_news_summary: [],
        };
      },
    },
    news: { fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }) },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ seen: new Map(), records: [] }),
      recordIssueEvents: async () => 0,
      saveDigest: async digest => { savedDigest = digest; },
    },
    repositories: { getScanTargets: async () => ({ source: 'watchlist', repos: ['owner/repo'], issues: [] }) },
    whatsapp: {
      sendNotification: async () => {},
      buildDigestMessages: digest => { notifiedDigest = digest; return ['digest']; },
      DIGEST_PARSE_MODE: 'HTML',
    },
    issueAnalysis: {
      analyzeIssue: async ({ url }, options) => {
        analyzed.push({ url, knownUpdatedAt: options.knownUpdatedAt });
        return analysisFor(url, url.endsWith('/2') ? 'has_open_pr' : 'available');
      },
    },
  });

  const result = await runScan({ trigger: 'scheduled-test' });

  assert.equal(analyzed.length, 2);
  assert.equal(analyzed[0].knownUpdatedAt, '2026-05-17T00:00:00Z');
  assert.equal(result.digest.contest_digest.length, 1);
  const [item] = result.digest.contest_digest;
  assert.equal(item.effort, 'low');
  assert.equal(item.impact, 'high');
  assert.equal(item.clarity_tip, 'make check');
  assert.equal(item.code_skeleton, '// common/json_parse.c');
  assert.equal(item.quick_plan, '1. Edit common/json_parse.c\n2. Add test');
  assert.equal(item.maintainer_wants, 'Mirror the u64 fix.');
  assert.deepEqual(item.files_to_change.map(file => file.path), ['common/json_parse.c']);
  assert.equal(result.digest.dropped_after_analysis.length, 1);
  assert.equal(result.digest.dropped_after_analysis[0].current_state, 'has_open_pr');
  assert.equal(savedDigest.contest_digest.length, 1);
  assert.equal(notifiedDigest.contest_digest.length, 1);
});

test('runScan blends triage scores into ranking and attaches record ids for buttons', async t => {
  process.env.DIGEST_TRIAGE = 'true';
  t.after(() => { delete process.env.DIGEST_TRIAGE; });
  let modelInput = null;
  let notifiedDigest = null;

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async () => [{
        repo: 'owner/repo',
        issues: [
          { number: 1, title: 'A', url: 'https://github.com/owner/repo/issues/1', updatedAt: '2026-05-17T00:00:00Z', issueFitScore: 80 },
          { number: 2, title: 'B', url: 'https://github.com/owner/repo/issues/2', updatedAt: '2026-05-17T00:00:00Z', issueFitScore: 40 },
        ],
      }],
      fetchIssueStatus: async () => null,
      parseIssueUrl: () => null,
    },
    gemma: {
      hasCloudProvider: () => true,
      triageIssues: async () => new Map([
        ['https://github.com/owner/repo/issues/2', { score: 100, reason: 'great' }],
        ['https://github.com/owner/repo/issues/1', { score: 0, reason: 'meh' }],
      ]),
      analyzeWithGemma: async repoData => {
        modelInput = repoData;
        return {
          date: '2026-05-17',
          contest_digest: [{
            opportunity: 'B',
            repo: 'owner/repo',
            issue_url: 'https://github.com/owner/repo/issues/2',
            why_it_qualifies: 'g',
            suggested_action: 'd',
            code_skeleton: '',
            clarity_tip: '',
            why_it_matters: 'm',
            effort: 'low',
          }],
          quick_plan: 'p',
          tech_news_summary: [],
        };
      },
    },
    news: { fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }) },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ seen: new Map(), records: [] }),
      recordIssueEvents: async () => 0,
      saveDigest: async digest => digest.contest_digest.map((item, i) => ({ id: `rec${i}`, issueUrl: item.issue_url })),
    },
    repositories: { getScanTargets: async () => ({ source: 'watchlist', repos: ['owner/repo'], issues: [] }) },
    whatsapp: {
      sendNotification: async () => {},
      buildDigestMessages: digest => { notifiedDigest = digest; return ['digest']; },
      DIGEST_PARSE_MODE: 'HTML',
    },
  });

  await runScan({ trigger: 'scheduled-test', scanMode: 'default' });

  // opportunityLimit is 8 and there are only 2 candidates, so triage is skipped
  // unless forced; DIGEST_TRIAGE=true forces it.
  assert.deepEqual(modelInput[0].issues.map(issue => issue.number), [2, 1]);
  assert.equal(modelInput[0].issues[0].issueFitScore, 70);
  assert.equal(modelInput[0].issues[0].triageReason, 'great');
  assert.equal(notifiedDigest.contest_digest[0].record_id, 'rec0');
});

test('runScan learns from outcomes, passes the profile to the model, and reports PR state', async t => {
  let analysisOptions = null;
  let notifiedDigest = null;
  let recordedEvents = null;
  const prSnapshotPath = path.resolve(__dirname, '..', 'src', 'pr-tracking.js');
  const prevPr = require.cache[prSnapshotPath];
  delete require.cache[prSnapshotPath];
  require.cache[prSnapshotPath] = {
    id: prSnapshotPath, filename: prSnapshotPath, loaded: true,
    exports: {
      buildEngineeringReport: async records => ({
        prs: [{ recordId: 'rec-pr', title: 'Shipped', prUrl: 'https://github.com/o/r/pull/9', state: 'merged', detail: 'merged today', yourMove: false }],
        nudges: [],
        events: [{ recordId: 'rec-pr', status: 'Done', line: '[bot] PR merged [outcome merged]', activityLog: '' }],
        counts: { active: records.length, yourMove: 0, merged: 1 },
      }),
    },
  };
  t.after(() => { if (prevPr) require.cache[prSnapshotPath] = prevPr; else delete require.cache[prSnapshotPath]; });

  const tracked = [
    { id: 'rec-pr', repo: 'owner/repo', status: 'In Progress', owner: 'dan', prUrl: 'https://github.com/o/r/pull/9', issueUrl: 'https://github.com/owner/repo/issues/9', lastUpdated: '2026-09-29T00:00:00Z' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, repo: 'owner/repo', status: 'Done', prUrl: 'p', activityLog: '[outcome merged]', issueUrl: `https://github.com/owner/repo/issues/${100 + i}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, repo: 'other/repo', status: 'Done', activityLog: 'dismissed\n[dismiss reason: too big]', effort: 'high', issueUrl: `https://github.com/other/repo/issues/${i}` })),
  ];

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async () => [
        { repo: 'other/repo', issues: [{ number: 1, title: 'X', url: 'https://github.com/other/repo/issues/50', updatedAt: '2026-09-29T00:00:00Z', issueFitScore: 70, labels: [] }] },
        { repo: 'owner/repo', issues: [{ number: 2, title: 'Y', url: 'https://github.com/owner/repo/issues/50', updatedAt: '2026-09-29T00:00:00Z', issueFitScore: 60, labels: [] }] },
      ],
      fetchIssueStatus: async () => null,
      parseIssueUrl: () => null,
    },
    gemma: {
      analyzeWithGemma: async (repoData, _news, options) => {
        analysisOptions = { ...options, scores: repoData.map(r => [r.repo, r.issues[0].issueFitScore]) };
        return { date: '2026-09-30', contest_digest: [], quick_plan: 'p', tech_news_summary: [] };
      },
    },
    news: { fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }) },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ records: tracked, seen: new Map() }),
      recordIssueEvents: async events => { recordedEvents = events; return events.length; },
      saveDigest: async () => [],
    },
    repositories: { getScanTargets: async () => ({ source: 'watchlist', repos: ['owner/repo', 'other/repo'], issues: [] }) },
    whatsapp: {
      sendNotification: async () => {},
      buildDigestMessages: digest => { notifiedDigest = digest; return ['d']; },
      DIGEST_PARSE_MODE: 'HTML',
    },
  });

  await runScan({ trigger: 'test' });

  assert.match(analysisOptions.contributorProfile, /4 merged/);
  assert.match(analysisOptions.contributorProfile, /Ships in: owner\/repo/);
  const scores = Object.fromEntries(analysisOptions.scores);
  assert.ok(scores['owner/repo'] > 60, 'merged history boosts the repo');
  assert.ok(scores['other/repo'] < 70, 'dismissals penalise the repo');
  assert.equal(notifiedDigest.engineering.prs[0].state, 'merged');
  assert.equal(notifiedDigest.learning.counts.merged, 4);
  assert.ok(recordedEvents.some(e => e.recordId === 'rec-pr' && e.status === 'Done'));
});

test('a heuristic analysis never replaces the model write-up, and a full Airtable base is surfaced', async t => {
  let notifiedDigest = null;
  const result = state => ({
    issueUrl: 'u',
    issueUpdatedAt: '2026-05-17T00:00:00Z',
    model: 'heuristic',
    analysis: {
      maintainerWants: 'Read the issue carefully, confirm the intended outcome from the discussion.',
      currentState: state,
      stateReason: state === 'available' ? '' : 'open PR #9 by bob',
      plan: ['Read the issue and related files'],
      filesToChange: [{ path: 'real.c', why: 'mentioned', verified: true }, { path: 'guess.c', why: '', verified: false }],
      openQuestions: [],
      effort: 'medium',
      impact: 'medium',
      codeSkeleton: '',
      validation: '',
    },
    context: {},
  });

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async () => [{ repo: 'owner/repo', issues: [
        { number: 1, title: 'A', url: 'https://github.com/owner/repo/issues/1', updatedAt: '2026-05-17T00:00:00Z' },
        { number: 2, title: 'B', url: 'https://github.com/owner/repo/issues/2', updatedAt: '2026-05-17T00:00:00Z' },
      ] }],
      fetchIssueStatus: async () => null,
      parseIssueUrl: () => null,
    },
    gemma: {
      analyzeWithGemma: async () => {
        const item = url => ({ opportunity: 'Do it', repo: 'owner/repo', issue_url: url, why_it_qualifies: 'good', suggested_action: 'model action', code_skeleton: '// model', clarity_tip: 'npm test', why_it_matters: 'm', effort: 'low' });
        return { date: '2026-05-17', contest_digest: [item('https://github.com/owner/repo/issues/1'), item('https://github.com/owner/repo/issues/2')], quick_plan: 'p', tech_news_summary: [] };
      },
    },
    news: { fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }) },
    airtable: {
      filterUnchangedDigest: async digest => digest,
      loadTrackedRecords: async () => ({ seen: new Map(), records: [] }),
      recordIssueEvents: async () => 0,
      saveDigest: async () => { throw new Error('This base is or will be over its record limits with new records added.'); },
    },
    repositories: { getScanTargets: async () => ({ source: 'watchlist', repos: ['owner/repo'], issues: [] }) },
    whatsapp: {
      sendNotification: async () => {},
      buildDigestMessages: digest => { notifiedDigest = digest; return ['d']; },
      DIGEST_PARSE_MODE: 'HTML',
    },
    issueAnalysis: { analyzeIssue: async ({ url }) => result(url.endsWith('/2') ? 'has_open_pr' : 'available') },
  });

  await runScan({ trigger: 'test' });

  assert.equal(notifiedDigest.contest_digest.length, 1, 'the taken issue is still dropped');
  const [item] = notifiedDigest.contest_digest;
  assert.equal(item.maintainer_wants, undefined);
  assert.equal(item.suggested_action, 'model action');
  assert.equal(item.code_skeleton, '// model');
  assert.equal(item.effort, 'low');
  assert.equal(item.analysis, undefined);
  assert.deepEqual(item.files_to_change.map(file => file.path), ['real.c']);
  assert.equal(notifiedDigest.persistence_error, 'Airtable base is at its record limit');
});

test('DIGEST_OPPORTUNITY_LIMIT changes how many picks a plain scan asks for', async t => {
  process.env.DIGEST_OPPORTUNITY_LIMIT = '15';
  t.after(() => { delete process.env.DIGEST_OPPORTUNITY_LIMIT; });
  let analysisOptions = null;
  const { runScan } = await loadRunScanWithStubs(t, {
    github: { scanRepos: async () => [{ issues: [{ number: 1, url: 'https://github.com/o/r/issues/1' }], repo: 'o/r' }], fetchIssueStatus: async () => null, parseIssueUrl: () => null },
    gemma: { analyzeWithGemma: async (_r, _n, options) => { analysisOptions = options; return { date: '2026-10-01', contest_digest: [], quick_plan: 'p', tech_news_summary: [] }; } },
    news: { fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }) },
    airtable: { filterUnchangedDigest: async d => d, loadTrackedRecords: async () => ({ seen: new Map(), records: [] }), recordIssueEvents: async () => 0, saveDigest: async () => [] },
    repositories: { getScanTargets: async () => ({ source: 'watchlist', repos: ['o/r'], issues: [] }) },
    whatsapp: { sendNotification: async () => {}, buildDigestMessages: () => ['d'], DIGEST_PARSE_MODE: 'HTML' },
  });

  await runScan({ trigger: 'test' });
  assert.equal(analysisOptions.opportunityLimit, 15);
  assert.equal(analysisOptions.issuesPerRepo, 4);

  const all = await loadRunScanWithStubs(t, {
    github: { scanRepos: async () => [{ issues: [{ number: 2, url: 'https://github.com/o/r/issues/2' }], repo: 'o/r' }], fetchIssueStatus: async () => null, parseIssueUrl: () => null },
    gemma: { analyzeWithGemma: async (_r, _n, options) => { analysisOptions = options; return { date: '2026-10-01', contest_digest: [], quick_plan: 'p', tech_news_summary: [] }; } },
    news: { fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }) },
    airtable: { filterUnchangedDigest: async d => d, loadTrackedRecords: async () => ({ seen: new Map(), records: [] }), recordIssueEvents: async () => 0, saveDigest: async () => [] },
    repositories: { getScanTargets: async () => ({ source: 'watchlist', repos: ['o/r'], issues: [] }) },
    whatsapp: { sendNotification: async () => {}, buildDigestMessages: () => ['d'], DIGEST_PARSE_MODE: 'HTML' },
  });
  await all.runScan({ trigger: 'test', scanMode: 'all', dedupe: false });
  assert.equal(analysisOptions.opportunityLimit, 24, 'explicit modes keep their own limit');
});
