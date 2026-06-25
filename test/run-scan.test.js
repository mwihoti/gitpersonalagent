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
  };

  const previous = new Map();
  for (const moduleFile of [modulePath, ...Object.values(dependencyPaths)]) {
    previous.set(moduleFile, require.cache[moduleFile]);
    delete require.cache[moduleFile];
  }

  for (const [key, moduleFile] of Object.entries(dependencyPaths)) {
    if (!stubs[key]) continue;
    require.cache[moduleFile] = {
      id: moduleFile,
      filename: moduleFile,
      loaded: true,
      exports: stubs[key],
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
    },
  });

  await runScan({ scanMode: 'all', dedupe: false });

  assert.equal(scanOptions.mode, 'all-open');
  assert.equal(analysisOptions.scanMode, 'all');
  assert.equal(analysisOptions.opportunityLimit, 24);
  assert.equal(analysisOptions.issuesPerRepo, 20);
});

test('runScan sends current best opportunities when dedupe removes every item', async t => {
  let savedDigest = null;
  let notifiedMessages = null;

  const { runScan } = await loadRunScanWithStubs(t, {
    github: {
      scanRepos: async () => [{
        repo: 'owner/repo',
        issues: [{
          number: 1,
          url: 'https://github.com/owner/repo/issues/1',
          updatedAt: '2026-05-16T00:00:00Z',
        }],
      }],
    },
    gemma: {
      analyzeWithGemma: async () => ({
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
      }),
    },
    news: {
      fetchNews: async () => ({ hackerNews: [], githubReleases: [], rssFeeds: [] }),
    },
    airtable: {
      filterUnchangedDigest: async digest => ({
        ...digest,
        contest_digest: [],
        deduped_opportunities: digest.contest_digest.length,
      }),
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
      sendNotification: async messages => {
        notifiedMessages = messages;
      },
      buildDigestMessages: digest => [`count:${digest.contest_digest.length}`],
    },
  });

  const result = await runScan({ trigger: 'scheduled-test' });

  assert.equal(result.digest.contest_digest.length, 1);
  assert.equal(result.digest.repeated_digest, true);
  assert.equal(savedDigest.contest_digest.length, 1);
  assert.deepEqual(notifiedMessages, ['count:1']);
});
