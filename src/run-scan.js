'use strict';
const fs = require('fs/promises');
const { scanRepos } = require('./github');
const { analyzeWithGemma } = require('./gemma');
const { fetchNews } = require('./news');
const { filterUnchangedDigest, saveDigest } = require('./airtable');
const { getScanTargets } = require('./repositories');
const { runWithLock } = require('./scan-state');
const { sendNotification, buildDigestMessages } = require('./whatsapp');

function groupSeedIssues(issues = []) {
  return issues.reduce((acc, issue) => {
    if (!issue.repo || !issue.number) return acc;
    acc[issue.repo] = acc[issue.repo] || [];
    acc[issue.repo].push(issue);
    return acc;
  }, {});
}

const SCAN_MODES = {
  default: {
    label: 'top prioritized issues',
    githubMode: 'prioritized',
    opportunityLimit: 8,
    issuesPerRepo: 4,
    scanLabel: 'top prioritized issues per repo',
  },
  all: {
    label: 'all open issues',
    githubMode: 'all-open',
    opportunityLimit: 24,
    issuesPerRepo: 20,
    scanLabel: 'all open issues per repo',
  },
  goodfirst: {
    label: 'good first issues',
    githubMode: 'prioritized',
    opportunityLimit: 16,
    issuesPerRepo: 12,
    scanLabel: 'good first issues only',
  },
  medium: {
    label: 'medium effort issues',
    githubMode: 'prioritized',
    opportunityLimit: 12,
    issuesPerRepo: 12,
    scanLabel: 'medium effort implementation issues',
  },
};

function normalizeScanMode(mode) {
  const value = String(mode || 'default').trim().toLowerCase();
  if (value === 'good-first' || value === 'good_first' || value === 'good') return 'goodfirst';
  return SCAN_MODES[value] ? value : 'default';
}

function issueHasLabel(issue, label) {
  return (issue.labels || []).some(item => String(item).toLowerCase() === label);
}

function filterRepoDataForMode(repoData, mode) {
  if (mode === 'goodfirst') {
    return repoData.map(repo => ({
      ...repo,
      issues: (repo.issues || []).filter(issue =>
        issueHasLabel(issue, 'good first issue') || issue.source === 'bitcoindevs'
      ),
      labelSummary: 'good first issues',
    }));
  }

  if (mode === 'medium') {
    return repoData.map(repo => ({
      ...repo,
      issues: (repo.issues || []).filter(issue => {
        const score = Number(issue.issueFitScore || 0);
        return score >= 52 && score < 72;
      }),
      labelSummary: 'medium effort candidates',
    }));
  }

  return repoData;
}

function enrichDigestWithIssueMetadata(digest, repoData) {
  const issueMap = new Map();
  for (const repo of repoData) {
    for (const issue of repo.issues || []) {
      if (!issue.url) continue;
      issueMap.set(String(issue.url).toLowerCase(), {
        source: issue.source || '',
        source_url: issue.sourceUrl || '',
        issue_updated_at: issue.updatedAt || '',
        score: Number(issue.issueFitScore || 0),
      });
    }
  }

  return {
    ...digest,
    contest_digest: (digest.contest_digest || []).map(item => {
      const meta = issueMap.get(String(item.issue_url || '').toLowerCase()) || {};
      return {
        ...item,
        source: item.source || meta.source || 'model',
        source_url: item.source_url || meta.source_url || '',
        issue_updated_at: item.issue_updated_at || meta.issue_updated_at || '',
        score: item.score || meta.score || 0,
      };
    }),
  };
}

async function writeActionsSummary(run, digest, repoData) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const topItems = (digest.contest_digest || []).slice(0, 8)
    .map(item => `- [${item.repo}](${item.issue_url || `https://github.com/${item.repo}`}) - ${item.opportunity}`)
    .join('\n') || '- No new opportunities after dedupe';
  const repoRows = repoData
    .map(repo => `| ${repo.repo} | ${repo.issues.length} | ${repo.labelSummary || ''} |`)
    .join('\n');

  await fs.appendFile(summaryPath, `## Repository Intelligence Scan

| Metric | Value |
|---|---:|
| Repositories | ${run.repositories || 0} |
| Issues scanned | ${run.totalIssues || 0} |
| Opportunities | ${run.opportunities || 0} |
| Deduped | ${run.dedupedOpportunities || 0} |
| Source | ${run.discoverySource || 'watchlist'} |

### Top Opportunities
${topItems}

### Repositories
| Repo | Issues | Signals |
|---|---:|---|
${repoRows}

`, 'utf8');
}

async function runScan(options = {}) {
  const {
    notify = true,
    persist = true,
    logger = console,
    trigger = 'manual',
    scanMode = 'default',
    dedupe = true,
  } = options;
  const normalizedScanMode = normalizeScanMode(scanMode);
  const scanConfig = SCAN_MODES[normalizedScanMode];

  return runWithLock(async run => {
    const startedAt = new Date().toISOString();
    run.scanMode = normalizedScanMode;
    logger.log(`\n[${startedAt}] Starting repository intelligence scan (${scanConfig.label})...`);

    const targets = await getScanTargets();
    const repos = targets.repos || [];
    run.discoverySource = targets.source || 'watchlist';
    run.discoverySourceUrl = targets.sourceUrl || '';
    run.discoveryIssues = (targets.issues || []).length;
    run.repositories = repos.length;
    if (!repos.length) {
      throw new Error('No repositories configured and BitcoinDevs discovery returned no repos. Add a dashboard watchlist repo or check BITCOINDEVS_ISSUES_URL.');
    }

    logger.log('\n1/3 Scanning GitHub repos + news...');
    const fetchStarted = Date.now();
    const [rawRepoData, news] = await Promise.all([
      scanRepos(repos, {
        seedIssuesByRepo: groupSeedIssues(targets.issues),
        mode: scanConfig.githubMode,
      }),
      fetchNews({ repos }),
    ]);
    const repoData = filterRepoDataForMode(rawRepoData, normalizedScanMode);
    run.timingsMs.fetchSignals = Date.now() - fetchStarted;
    const totalIssues = repoData.reduce((n, r) => n + r.issues.length, 0);
    run.totalIssues = totalIssues;
    logger.log(`     Found ${totalIssues} issues across ${repoData.length} repos`);

    logger.log('\n2/3 Analyzing with model...');
    const analysisStarted = Date.now();
    const rawDigest = await analyzeWithGemma(repoData, news, {
      scanMode: normalizedScanMode,
      scanLabel: scanConfig.scanLabel,
      opportunityLimit: scanConfig.opportunityLimit,
      issuesPerRepo: scanConfig.issuesPerRepo,
    });
    const enrichedDigest = enrichDigestWithIssueMetadata(rawDigest, repoData);
    const digest = dedupe ? await filterUnchangedDigest(enrichedDigest) : enrichedDigest;
    run.timingsMs.analysis = Date.now() - analysisStarted;
    const count = digest.contest_digest?.length || 0;
    run.opportunities = count;
    run.dedupedOpportunities = digest.deduped_opportunities || 0;
    logger.log(`     Got ${count} contest opportunities`);

    logger.log('\n3/3 Saving and notifying...');
    const publishStarted = Date.now();
    const tasks = [];
    if (persist) {
      tasks.push(saveDigest(digest).catch(e => logger.warn(`  Persistence skipped: ${e.message}`)));
    }
    if (notify) {
      tasks.push(sendNotification(buildDigestMessages(digest)).catch(e => logger.warn(`  Notification skipped: ${e.message}`)));
    }
    await Promise.all(tasks);
    run.timingsMs.publish = Date.now() - publishStarted;
    await writeActionsSummary(run, digest, repoData).catch(e => logger.warn(`  Actions summary skipped: ${e.message}`));

    logger.log(`\nDone! Scan completed at ${new Date().toISOString()}`);
    return digest;
  }, {
    trigger,
    notify,
    persist,
  });
}

module.exports = { runScan };
