'use strict';
const { listOpportunities, recordIssueEvents } = require('../src/airtable');
const { deriveOutcome } = require('../src/feedback');
const { requireApiAuth } = require('../src/auth');
const { allowOptions, readJsonBody, sendJson } = require('../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJsonBody(req);
    if (body.action !== 'reset') return sendJson(res, 400, { error: 'Unknown preference action' });
    const { opportunities } = await listOpportunities();
    const now = Date.now();
    const applied = await recordIssueEvents(opportunities.map(item => {
      const { outcome, reason } = deriveOutcome(item, now);
      return {
        recordId: item.id,
        touch: false,
        activityLog: item.activityLog || '',
        line: `[dashboard ${new Date(now).toISOString()}] Ranking adjustments reset [ranking baseline: ${outcome}|${reason}]`,
      };
    }));
    if (applied !== opportunities.length) return sendJson(res, 500, { error: 'Some ranking baselines could not be saved. Please retry.' });
    return sendJson(res, 200, { ok: true, reset: applied });
  } catch (error) { return sendJson(res, 500, { error: error.message }); }
};
