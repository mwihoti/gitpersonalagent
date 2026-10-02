'use strict';
const { removeRepository, updateRepository } = require('../../src/repositories');
const { requireApiAuth } = require('../../src/auth');
const { allowOptions, readJsonBody, sendJson } = require('../../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  if (req.method !== 'DELETE' && req.method !== 'PUT') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (req.method === 'PUT') {
      const repository = await updateRepository(req.query.id, await readJsonBody(req));
      return sendJson(res, 200, { repository });
    }
    await removeRepository(req.query.id);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : /must be a boolean/i.test(error.message) ? 400 : 500;
    return sendJson(res, status, { error: error.message });
  }
};
