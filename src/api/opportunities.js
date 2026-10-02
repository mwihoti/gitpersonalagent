'use strict';
const { listOpportunities, isAirtableConfigured } = require('../airtable');
const { buildPreferenceModel, describePreferences } = require('../feedback');
const { requireApiAuth } = require('../auth');
const { allowOptions, sendJson } = require('../http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const result = await listOpportunities();
    return sendJson(res, 200, {
      opportunities: result.opportunities,
      storage: result.storage || (isAirtableConfigured() ? 'airtable' : 'local'),
      learning: describePreferences(buildPreferenceModel(result.opportunities)),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
