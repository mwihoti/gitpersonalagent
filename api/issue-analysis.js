'use strict';
const { analyzeIssue } = require('../src/issue-analysis');
const { updateOpportunity } = require('../src/airtable');
const { requireApiAuth } = require('../src/auth');
const { allowOptions, readJsonBody, sendJson } = require('../src/http');

// POST { url } or { repo, number }; optional { force, recordId }.
// Runs the deep issue analysis and, when a workbench record is given, stores
// the result on it so the next visit does not need to re-run it.
module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    const result = await analyzeIssue(
      { url: body.url, repo: body.repo, number: body.number },
      { force: Boolean(body.force) },
    );

    if (body.recordId && !result.cached) {
      await updateOpportunity(body.recordId, {
        analysis: result,
        issueUpdatedAt: result.issueUpdatedAt,
      }).catch(error => console.warn(`  Analysis not stored on ${body.recordId}: ${error.message}`));
    }

    return sendJson(res, 200, result);
  } catch (error) {
    const status = /Provide an issue URL|is a pull request|not found|404/i.test(error.message) ? 400 : 500;
    return sendJson(res, status, { error: error.message });
  }
};
