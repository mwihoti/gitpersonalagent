'use strict';
const { isAirtableConfigured } = require('../src/airtable');
const { readBitcoinDevsDiscoveries } = require('../src/bitcoindevs');
const { getCurrentRun, getRecentRuns } = require('../src/scan-state');
const { isDispatchConfigured } = require('../src/scan-dispatch');
const { listBots } = require('../src/bots');
const { sendJson } = require('../src/http');
const { describeProviders } = require('../src/providers');

// Which settings this deployment actually received. Booleans and counts only —
// never a secret's value — so it is safe on the public health endpoint and
// answers "did that env var reach production?" without a redeploy-and-guess loop.
function configStatus() {
  const bots = listBots();
  return {
    telegramBots: bots.length,
    webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    adminChat: Boolean(process.env.TELEGRAM_CHAT_ID),
    airtable: isAirtableConfigured(),
    subscribersTable: process.env.AIRTABLE_SUBSCRIBERS_TABLE || 'Subscribers',
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
    config: configStatus(),
    timestamp: new Date().toISOString(),
    currentRun: getCurrentRun(),
    recentRuns: recentRuns.slice(0, 5),
    recentDiscoveries: discoveries.slice(0, 3),
  });
};
