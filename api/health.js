'use strict';
const { isAirtableConfigured } = require('../src/airtable');
const { readBitcoinDevsDiscoveries } = require('../src/bitcoindevs');
const { getCurrentRun, getRecentRuns } = require('../src/scan-state');
const { isDispatchConfigured } = require('../src/scan-dispatch');
const { listBots, publicBotUsername } = require('../src/bots');
const { sendJson } = require('../src/http');
const { describeProviders } = require('../src/providers');
const { checkGitHubAuth } = require('../src/github');
const config = require('../src/config');

// Which settings this deployment actually received. Booleans and counts only —
// never a secret's value — so it is safe on the public health endpoint and
// answers "did that env var reach production?" without a redeploy-and-guess loop.
function configStatus() {
  const bots = listBots();
  return {
    telegramBots: bots.length,
    webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    adminChat: Boolean(process.env.TELEGRAM_CHAT_ID),
    storage: isAirtableConfigured() ? 'postgres' : 'local',
    scanDispatch: isDispatchConfigured(),
    modelProvider: describeProviders().length > 0,
    modelChain: describeProviders().map(provider => `${provider.name}: ${provider.models.join(' > ')}`),
    githubToken: Boolean(process.env.GITHUB_TOKEN),
  };
}

module.exports = async function handler(_req, res) {
  const recentRuns = await getRecentRuns().catch(() => []);
  const discoveries = await readBitcoinDevsDiscoveries().catch(() => []);
  return sendJson(res, 200, {
    ok: true,
    storage: isAirtableConfigured() ? 'airtable' : 'local',
    config: {
      ...configStatus(),
      githubAuth: await checkGitHubAuth().catch(() => ({ status: 'unknown' })),
      // Public by design: it is the handle anyone uses to talk to the bot.
      botUsername: await publicBotUsername().catch(() => ''),
    },
    timestamp: new Date().toISOString(),
    currentRun: getCurrentRun(),
    recentRuns: recentRuns.slice(0, 30),
    schedule: { cron: process.env.VERCEL ? '0 5 * * *' : config.schedule, timezone: process.env.VERCEL ? 'UTC' : 'Africa/Nairobi', managed: true },
    recentDiscoveries: discoveries.slice(0, 3),
  });
};
