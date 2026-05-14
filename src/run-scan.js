'use strict';
const { scanRepos } = require('./github');
const { analyzeWithGemma } = require('./gemma');
const { fetchNews } = require('./news');
const { saveDigest } = require('./airtable');
const { getScanRepositories } = require('./repositories');
const { sendNotification, buildDigestMessage } = require('./whatsapp');

async function runScan(options = {}) {
  const {
    notify = true,
    persist = true,
    logger = console,
  } = options;

  const startedAt = new Date().toISOString();
  logger.log(`\n[${startedAt}] Starting repository intelligence scan...`);

  const repos = await getScanRepositories();
  if (!repos.length) {
    throw new Error('No repositories configured. Add at least one GitHub repo from the dashboard watchlist.');
  }

  logger.log('\n1/3 Scanning GitHub repos + news...');
  const [repoData, news] = await Promise.all([
    scanRepos(repos),
    fetchNews(),
  ]);
  const totalIssues = repoData.reduce((n, r) => n + r.issues.length, 0);
  logger.log(`     Found ${totalIssues} issues across ${repoData.length} repos`);

  logger.log('\n2/3 Analyzing with Gemma...');
  const digest = await analyzeWithGemma(repoData, news);
  const count = digest.contest_digest?.length || 0;
  logger.log(`     Got ${count} contest opportunities`);

  logger.log('\n3/3 Saving and notifying...');
  const tasks = [];
  if (persist) {
    tasks.push(saveDigest(digest).catch(e => logger.warn(`  Persistence skipped: ${e.message}`)));
  }
  if (notify) {
    tasks.push(sendNotification(buildDigestMessage(digest)).catch(e => logger.warn(`  Notification skipped: ${e.message}`)));
  }
  await Promise.all(tasks);

  logger.log(`\nDone! Scan completed at ${new Date().toISOString()}`);
  return digest;
}

module.exports = { runScan };
