'use strict';
const { updateOpportunity } = require('../../src/airtable');
const { allowOptions, readJsonBody, sendJson } = require('../../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;

  if (req.method !== 'PUT' && req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) {
    return sendJson(res, 400, { error: 'Missing record id' });
  }

  try {
    const body = await readJsonBody(req);
    const updated = await updateOpportunity(id, body);
    return sendJson(res, 200, { opportunity: updated });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    return sendJson(res, status, { error: error.message });
  }
};
