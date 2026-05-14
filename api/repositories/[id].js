'use strict';
const { removeRepository } = require('../../src/repositories');
const { requireApiAuth } = require('../../src/auth');
const { allowOptions, sendJson } = require('../../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  if (req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    await removeRepository(req.query.id);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    return sendJson(res, status, { error: error.message });
  }
};
