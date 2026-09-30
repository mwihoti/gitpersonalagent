'use strict';
const fs = require('fs/promises');
const { scanRepos, fetchIssueStatus, parseIssueUrl } = require('./github');
const { analyzeWithGemma, triageIssues, hasCloudProvider } = require('./gemma');
const { fetchNews } = require('./news');
const { filterUnchangedDigest, saveDigest, loadTrackedRecords, recordIssueEvents } = require('./airtable');
const feedback = require('./feedback');
const { buildEngineeringReport } = require('./pr-tracking');
const { getScanTargets } = require('./repositories');
const { runWithLock } = require('./scan-state');
const { sendNotification, buildDigestMessages, DIGEST_PARSE_MODE } = require('./whatsapp');
const tracking = require('./issue-tracking');
const { analyzeIssue } = require('./issue-analysis');

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
      issueMap.set(tracking.normalizeUrl(issue.url), {
        source: issue.source || '',
        source_url: issue.sourceUrl || '',
        issue_updated_at: issue.updatedAt || '',
        score: Number(issue.issueFitScore || 0),
        issue_created_at: issue.createdAt || '',
        assignees: issue.assignees || [],
        latest_comment: issue.latestComment || null,
        labels: issue.labels || [],
        language: issue.repositoryLanguage || '',
        linked_prs: issue.linkedPRs || [],
        claim: issue.claim || null,
        seen_before: Boolean(issue.seenBefore),
        record_id: issue.trackedRecordId || '',
        tracked_since: issue.trackedSince || '',
        previous_updated_at: issue.previousUpdatedAt || '',
      });
    }
  }

  return {
    ...digest,
    contest_digest: (digest.contest_digest || []).map(item => {
      const meta = issueMap.get(tracking.normalizeUrl(item.issue_url)) || {};
      return {
        ...meta,
        ...item,
        source: item.source || meta.source || 'model',
        source_url: item.source_url || meta.source_url || '',
        issue_updated_at: item.issue_updated_at || meta.issue_updated_at || '',
        score: item.score || meta.score || 0,
      };
    }),
  };
}

function emptyDigest(news) {
  const titles = [
    ...(news.githubReleases || []),
    ...(news.hackerNews || []),
    ...(news.rssFeeds || []),
  ].map(item => item.title).filter(Boolean).slice(0, 5);

  return {
    date: new Date().toISOString().slice(0, 10),
    contest_digest: [],
    quick_plan: 'No new or updated issues since the last digest.',
    tech_news_summary: titles,
  };
}

const TAKEN_STATES = new Set(['claimed', 'has_open_pr', 'likely_done']);

// Model ranking over every candidate, blended with the heuristic score so a
// bad model day cannot wreck the order. Skipped when there is nothing to rank.
async function applyTriage(repoData, options = {}) {
  const { logger = console, triage = triageIssues, opportunityLimit = 8 } = options;
  const total = repoData.reduce((n, r) => n + (r.issues || []).length, 0);
  const forced = process.env.DIGEST_TRIAGE === 'true';
  if (process.env.DIGEST_TRIAGE === 'false') return repoData;
  if (!forced && (total <= opportunityLimit || !hasCloudProvider())) return repoData;

  let scores;
  try {
    scores = await triage(repoData);
  } catch (error) {
    logger.warn(`     Triage skipped: ${error.message}`);
    return repoData;
  }
  if (!scores.size) return repoData;
  logger.log(`     Triage ranked ${scores.size} of ${total} candidates`);

  return repoData.map(repo => ({
    ...repo,
    issues: (repo.issues || []).map(issue => {
      const hit = scores.get(tracking.normalizeUrl(issue.url));
      if (!hit) return issue;
      return {
        ...issue,
        triageScore: hit.score,
        triageReason: hit.reason,
        issueFitScore: Math.round((Number(issue.issueFitScore || 0) + hit.score) / 2),
      };
    }).sort((a, b) => Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0)),
  }));
}

// Deep-analyze the picked opportunities so the digest carries what the
// maintainer actually wants, real file paths, and a grounded plan.
async function deepenDigest(digest, options = {}) {
  const {
    logger = console,
    limit = Number(process.env.DIGEST_ANALYZE_LIMIT) || 8,
    concurrency = 2,
    analyze = analyzeIssue,
  } = options;
  if (process.env.DIGEST_DEEP_ANALYSIS === 'false') return digest;
  // Inside a Vercel function there is no time for it; GitHub Actions is the
  // place for deep analysis unless explicitly forced.
  if (process.env.VERCEL && process.env.DIGEST_DEEP_ANALYSIS !== 'true') {
    logger.log('     Skipping deep analysis inside a serverless function (set DIGEST_DEEP_ANALYSIS=true to force)');
    return digest;
  }

  const items = digest.contest_digest || [];
  const targets = items.slice(0, limit).filter(item => item.issue_url);
  if (!targets.length) return digest;

  logger.log(`     Deep-analyzing ${targets.length} opportunities...`);
  const results = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      try {
        const result = await analyze({ url: item.issue_url }, { knownUpdatedAt: item.issue_updated_at, logger });
        results.set(tracking.normalizeUrl(item.issue_url), result);
      } catch (error) {
        logger.warn(`     Analysis skipped for ${item.issue_url}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  const dropped = [];
  const merged = items.map(item => {
    const result = results.get(tracking.normalizeUrl(item.issue_url));
    if (!result) return item;
    const a = result.analysis;
    if (TAKEN_STATES.has(a.currentState)) {
      dropped.push({ ...item, current_state: a.currentState, state_reason: a.stateReason });
      return null;
    }
    const plan = (a.plan || []).map((step, index) => `${index + 1}. ${step}`).join('\n');
    return {
      ...item,
      effort: a.effort || item.effort,
      impact: a.impact || '',
      clarity_tip: a.validation || item.clarity_tip,
      code_skeleton: a.codeSkeleton || item.code_skeleton,
      quick_plan: plan || '',
      maintainer_wants: a.maintainerWants || '',
      current_state: a.currentState,
      state_reason: a.stateReason,
      open_questions: a.openQuestions || [],
      files_to_change: a.filesToChange || [],
      evidence: a.evidence || [],
      confidence: a.confidence || 0,
      analysis: result,
    };
  }).filter(Boolean);

  if (dropped.length) {
    logger.log(`     Dropped ${dropped.length} after analysis (already taken): ${dropped.map(item => item.issue_url).join(', ')}`);
  }
  return { ...digest, contest_digest: merged, dropped_after_analysis: dropped };
}

// Re-check tracked issues that did not show up in today's scan, so the digest
// can report closures and claims. Sequential on purpose: keeps the GitHub
// request burst small.
async function checkTrackedIssues(seen, repoData, logger) {
  const inScan = new Set();
  for (const repo of repoData) {
    for (const issue of repo.issues || []) inScan.add(tracking.normalizeUrl(issue.url));
  }
  const entries = tracking.pickTrackedForStatusCheck(seen, { skipUrls: inScan });
  const results = [];
  for (const entry of entries) {
    const ref = parseIssueUrl(entry.issueUrl);
    if (!ref) continue;
    try {
      results.push(await fetchIssueStatus(ref.repo, ref.number));
    } catch (error) {
      logger.warn(`  Status check skipped for ${entry.issueUrl}: ${error.message}`);
    }
  }
  return results;
}

// Turn the changelog into Airtable follow-ups: log new activity, mark closed
// issues done, note claims.
function buildRecordEvents(digest, seen) {
  const date = digest.date;
  const changes = digest.changes || {};
  const events = [];
  const tracked = url => seen.get(tracking.normalizeUrl(url)) || {};

  for (const item of digest.contest_digest || []) {
    if (!item.record_id || !item.seen_before) continue;
    const comment = item.latest_comment;
    const detail = comment && comment.body
      ? `: ${comment.author || 'someone'} — ${String(comment.body).slice(0, 160)}`
      : '';
    events.push({
      recordId: item.record_id,
      activityLog: tracked(item.issue_url).activityLog,
      issueUpdatedAt: item.issue_updated_at,
      line: `[bot ${date}] new activity on the issue${detail}`,
    });
  }
  for (const entry of changes.closed || []) {
    events.push({
      recordId: entry.record_id,
      activityLog: tracked(entry.issue_url).activityLog,
      status: 'Done',
      line: `[bot ${date}] issue ${entry.reason} upstream`,
    });
  }
  for (const entry of changes.claimed || []) {
    events.push({
      recordId: entry.record_id,
      activityLog: tracked(entry.issue_url).activityLog,
      line: `[bot ${date}] ${entry.reason}${entry.pr_url ? ` (${entry.pr_url})` : ''}`,
    });
  }
  return events;
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
| Unchanged (skipped) | ${run.dedupedOpportunities || 0} |
| Claimed (skipped) | ${run.skippedClaimed || 0} |
| Closed upstream | ${run.closedUpstream || 0} |
| Claimed upstream | ${run.claimedUpstream || 0} |
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
    const includeNews = process.env.DIGEST_INCLUDE_NEWS !== 'false';
    const [rawRepoData, news] = await Promise.all([
      scanRepos(repos, {
        seedIssuesByRepo: groupSeedIssues(targets.issues),
        mode: scanConfig.githubMode,
      }),
      includeNews ? fetchNews({ repos }) : Promise.resolve({ hackerNews: [], githubReleases: [], rssFeeds: [] }),
    ]);
    const repoData = filterRepoDataForMode(rawRepoData, normalizedScanMode);
    run.timingsMs.fetchSignals = Date.now() - fetchStarted;
    const totalIssues = repoData.reduce((n, r) => n + r.issues.length, 0);
    run.totalIssues = totalIssues;
    logger.log(`     Found ${totalIssues} issues across ${repoData.length} repos`);

    logger.log('\n2/3 Analyzing with model...');
    const analysisStarted = Date.now();

    let seen = new Map();
    let trackedRecords = [];
    try {
      ({ seen, records: trackedRecords } = await loadTrackedRecords());
    } catch (error) {
      logger.warn(`     Could not load tracked issues (${error.message}); treating everything as new`);
    }
    const preferences = feedback.buildPreferenceModel(trackedRecords);
    const contributorProfile = feedback.summarizePreferences(preferences);
    if (contributorProfile) logger.log(`     Learned profile: ${contributorProfile}`);
    const annotated = feedback.applyPreferences(tracking.annotateRepoData(repoData, seen), preferences);
    const selection = tracking.selectIssuesForModel(annotated, { dedupe });
    const skipped = selection.skipped;
    const modelInput = await applyTriage(selection.repoData, { logger, opportunityLimit: scanConfig.opportunityLimit });
    const candidateCount = modelInput.reduce((n, r) => n + r.issues.length, 0);
    run.skippedUnchanged = skipped.unchanged.length;
    run.skippedClaimed = skipped.claimed.length;
    logger.log(`     ${candidateCount} candidates for the model (skipped ${skipped.unchanged.length} unchanged, ${skipped.claimed.length} claimed, ${skipped.trackedDone.length} already done)`);

    const maxPerRepo = tracking.perRepoLimit();
    let rawDigest;
    if (candidateCount > 0) {
      rawDigest = await analyzeWithGemma(modelInput, news, {
        scanMode: normalizedScanMode,
        scanLabel: scanConfig.scanLabel,
        opportunityLimit: scanConfig.opportunityLimit,
        issuesPerRepo: scanConfig.issuesPerRepo,
        maxPerRepo,
        contributorProfile,
      });
    } else {
      logger.log('     No new or updated issues; skipping the model call');
      rawDigest = emptyDigest(news);
    }

    let digest = enrichDigestWithIssueMetadata(rawDigest, annotated);
    digest.contest_digest = tracking.capPerRepo(digest.contest_digest, maxPerRepo);
    if (dedupe) {
      // Safety net: the model only sees filtered input, but never trust it blindly.
      digest = await filterUnchangedDigest(digest, seen);
    }

    digest = await deepenDigest(digest, { logger });

    const statusResults = dedupe ? await checkTrackedIssues(seen, annotated, logger) : [];
    digest.changes = tracking.buildChanges({ digest, repoData: annotated, seen, statusResults, skipped });
    for (const item of digest.dropped_after_analysis || []) {
      const entry = seen.get(tracking.normalizeUrl(item.issue_url));
      if (entry && !tracking.isDoneStatus(entry.status)) {
        digest.changes.claimed.push({
          issue_url: entry.issueUrl,
          repo: entry.repo,
          title: entry.opportunity,
          record_id: entry.recordId,
          tracked_since: entry.trackedSince,
          reason: item.state_reason || item.current_state,
          by: '',
          pr_url: '',
        });
      }
    }
    digest.deduped_opportunities = skipped.unchanged.length;
    if (process.env.DIGEST_MODE === 'weekly') {
      digest.weekly_review = tracking.buildWeeklyReview(seen);
    }

    // Engineering loop: follow the PRs behind claimed items, nudge stalled ones.
    const linkedPRsByIssue = new Map();
    for (const repo of annotated) {
      for (const issue of repo.issues || []) {
        if (issue.url && Array.isArray(issue.linkedPRs)) linkedPRsByIssue.set(tracking.normalizeUrl(issue.url), issue.linkedPRs);
      }
    }
    try {
      digest.engineering = await buildEngineeringReport(trackedRecords, { logger, linkedPRsByIssue });
      run.activePRs = digest.engineering.prs.length;
      run.mergedPRs = digest.engineering.counts.merged;
    } catch (error) {
      logger.warn(`     Engineering report skipped: ${error.message}`);
      digest.engineering = { prs: [], nudges: [], events: [], counts: { active: 0, yourMove: 0, merged: 0 } };
    }
    digest.learning = feedback.describePreferences(preferences);

    run.timingsMs.analysis = Date.now() - analysisStarted;
    const count = digest.contest_digest?.length || 0;
    run.opportunities = count;
    run.dedupedOpportunities = digest.deduped_opportunities || 0;
    run.closedUpstream = digest.changes.closed.length;
    run.claimedUpstream = digest.changes.claimed.length;
    logger.log(`     Got ${count} opportunities (${digest.changes.new.length} new, ${digest.changes.updated.length} updated); ${digest.changes.closed.length} closed and ${digest.changes.claimed.length} claimed upstream`);

    logger.log('\n3/3 Saving and notifying...');
    const publishStarted = Date.now();
    const tasks = [];
    if (persist) {
      const fresh = (digest.contest_digest || []).filter(item => !item.record_id);
      try {
        const created = await saveDigest({ ...digest, contest_digest: fresh });
        const idsByUrl = new Map((created || []).map(record => [tracking.normalizeUrl(record.issueUrl), record.id]));
        digest.contest_digest = digest.contest_digest.map(item => (
          item.record_id ? item : { ...item, record_id: idsByUrl.get(tracking.normalizeUrl(item.issue_url)) || '' }
        ));
      } catch (e) {
        logger.warn(`  Persistence skipped: ${e.message}`);
      }
      const baselines = tracking.baselineEvents(annotated);
      if (baselines.length) logger.log(`  Recording a first activity baseline for ${baselines.length} older records`);
      tasks.push(recordIssueEvents([...buildRecordEvents(digest, seen), ...(digest.engineering?.events || []), ...baselines])
        .catch(e => logger.warn(`  Record updates skipped: ${e.message}`)));
    }
    if (notify) {
      tasks.push(sendNotification(buildDigestMessages(digest), { parseMode: DIGEST_PARSE_MODE })
        .catch(e => logger.warn(`  Notification skipped: ${e.message}`)));
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
