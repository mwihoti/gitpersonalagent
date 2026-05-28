'use strict';
const { scanRepos } = require('./github');
const { analyzeWithGemma } = require('./gemma');
const { fetchNews } = require('./news');
const { saveDigest } = require('./airtable');
const { getScanRepositories } = require('./repositories');
const { runWithLock } = require('./scan-state');
const { sendNotification, buildDigestMessage } = require('./whatsapp');

async function runScan(options = {}) {
  const {
    notify = true,
    persist = true,
    logger = console,
    trigger = 'manual',
  } = options;

  return runWithLock(async run => {
    const startedAt = new Date().toISOString();
    logger.log(`\n[${startedAt}] Starting repository intelligence scan...`);

    const repos = await getScanRepositories();
    run.repositories = repos.length;
    if (!repos.length) {
      throw new Error('No repositories configured and BitcoinDevs discovery returned no repos. Add a dashboard watchlist repo or check BITCOINDEVS_ISSUES_URL.');
    }

    logger.log('\n1/3 Scanning GitHub repos + news...');
    const fetchStarted = Date.now();
    const [repoData, news] = await Promise.all([
      scanRepos(repos),
      fetchNews(),
    ]);
    run.timingsMs.fetchSignals = Date.now() - fetchStarted;
    const totalIssues = repoData.reduce((n, r) => n + r.issues.length, 0);
    run.totalIssues = totalIssues;
    logger.log(`     Found ${totalIssues} issues across ${repoData.length} repos`);

    logger.log('\n2/3 Analyzing with model...');
    const analysisStarted = Date.now();
    const digest = await analyzeWithGemma(repoData, news);
    run.timingsMs.analysis = Date.now() - analysisStarted;
    const count = digest.contest_digest?.length || 0;
    run.opportunities = count;
    logger.log(`     Got ${count} contest opportunities`);

    logger.log('\n3/3 Saving and notifying...');
    const publishStarted = Date.now();
    const tasks = [];
    if (persist) {
      tasks.push(saveDigest(digest).catch(e => logger.warn(`  Persistence skipped: ${e.message}`)));
    }
    if (notify) {
      tasks.push(sendNotification(buildDigestMessage(digest)).catch(e => logger.warn(`  Notification skipped: ${e.message}`)));
    }
    await Promise.all(tasks);
    run.timingsMs.publish = Date.now() - publishStarted;

    logger.log(`\nDone! Scan completed at ${new Date().toISOString()}`);
    return digest;
  }, {
    trigger,
    notify,
    persist,
  });
}

module.exports = { runScan };
