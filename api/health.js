'use strict';
const { isAirtableConfigured } = require('../src/airtable');
const { getCurrentRun, getRecentRuns } = require('../src/scan-state');
const { sendJson } = require('../src/http');

module.exports = async function handler(_req, res) {
  const recentRuns = await getRecentRuns().catch(() => []);
  return sendJson(res, 200, {
    ok: true,
    storage: isAirtableConfigured() ? 'airtable' : 'local',
    timestamp: new Date().toISOString(),
    currentRun: getCurrentRun(),
    recentRuns: recentRuns.slice(0, 5),
  });
};
