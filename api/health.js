'use strict';
const { isAirtableConfigured } = require('../src/airtable');
const { sendJson } = require('../src/http');

module.exports = function handler(_req, res) {
  return sendJson(res, 200, {
    ok: true,
    storage: isAirtableConfigured() ? 'airtable' : 'local',
    timestamp: new Date().toISOString(),
  });
};
