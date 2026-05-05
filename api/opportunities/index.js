'use strict';
const { listOpportunities, isAirtableConfigured } = require('../../src/airtable');
const { allowOptions, sendJson } = require('../../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const result = await listOpportunities();
    return sendJson(res, 200, {
      opportunities: result.opportunities,
      storage: result.storage || (isAirtableConfigured() ? 'airtable' : 'local'),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
