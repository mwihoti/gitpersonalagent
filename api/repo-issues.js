'use strict';
const { scanRepo } = require('../src/github');
const { requireApiAuth } = require('../src/auth');
const { allowOptions, readJsonBody, sendJson } = require('../src/http');

function parseRepo(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';

  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/#?]+)/i);
  if (urlMatch) return urlMatch[1].replace(/\.git$/i, '');

  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : '';
}

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    const repo = parseRepo(body.repo);
    if (!repo) {
      return sendJson(res, 400, { error: 'Enter a valid GitHub repo URL or owner/repo value.' });
    }

    const result = await scanRepo(repo);
    return sendJson(res, 200, { repo: result });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
