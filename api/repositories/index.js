'use strict';
const { addRepository, listRepositories } = require('../../src/repositories');
const { requireApiAuth } = require('../../src/auth');
const { allowOptions, readJsonBody, sendJson } = require('../../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, { repositories: await listRepositories() });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const repository = await addRepository(body.repo);
      return sendJson(res, 201, { repository });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    const status = /valid GitHub repo|not found/i.test(error.message) ? 400 : 500;
    return sendJson(res, status, { error: error.message });
  }
};
