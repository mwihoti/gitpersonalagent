'use strict';
const { scanRepo } = require('../src/github');
const { requireApiAuth, resolveAccess } = require('../src/auth');
const { findProject } = require('../src/bitcoin-ecosystem');
const { TRIAL_SCANS, reserveTrialScan, trialStatus } = require('../src/trial');
const { allowOptions, readJsonBody, sendJson } = require('../src/http');

function parseRepo(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';

  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/#?]+)/i);
  if (urlMatch) return urlMatch[1].replace(/\.git$/i, '');

  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : '';
}

const GET_KEY = 'Send /dashboard to the Telegram bot for a free key to keep going.';

function locked(res, error, trial) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="Dan Agent API"');
  return sendJson(res, 401, { error, trial });
}

// Visitors without a key: a few free checks of directory projects, then the
// key prompt. Only the first page of detail is free; reading deeper needs a key.
async function trialScan(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { trial: await trialStatus(req) });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  const repo = parseRepo(body.repo);
  if (!repo) return sendJson(res, 400, { error: 'Enter a valid GitHub repo URL or owner/repo value.' });

  const project = findProject(repo);
  if (!project) {
    return locked(res, `Free scans cover the Bitcoin projects listed under “Browse Bitcoin projects”. ${GET_KEY}`, await trialStatus(req));
  }
  if (Number(body.skip) > 0) {
    return locked(res, `Reading more issues in detail needs a key. ${GET_KEY}`, await trialStatus(req));
  }

  const reservation = await reserveTrialScan(req);
  if (!reservation.ok) {
    return reservation.reason === 'busy'
      ? sendJson(res, 429, { error: `Free scans are used up for today. ${GET_KEY}`, trial: reservation.trial })
      : locked(res, `You’ve used your ${TRIAL_SCANS} free scans. ${GET_KEY}`, reservation.trial);
  }

  try {
    const result = await scanRepo(project.repo, { mode: 'all-open', detail: 20, skip: 0 });
    return sendJson(res, 200, { repo: result, trial: reservation.trial });
  } catch (error) {
    await reservation.release().catch(() => {});
    return sendJson(res, 500, { error: error.message });
  }
}

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;

  let access;
  try {
    access = await resolveAccess(req);
    if (!access && !req.headers?.['x-api-key'] && !req.headers?.authorization) {
      return await trialScan(req, res);
    }
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
  // A key was sent but not accepted: answer as before so the page asks again.
  if (!access && !(await requireApiAuth(req, res))) return;

  if (req.method === 'GET') return sendJson(res, 200, { trial: null });
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    const repo = parseRepo(body.repo);
    if (!repo) {
      return sendJson(res, 400, { error: 'Enter a valid GitHub repo URL or owner/repo value.' });
    }

    // detail = how many issues to read closely (comments, linked PRs); skip =
    // how many of the best-ranked to pass over because the caller already has
    // them. Every open issue is listed either way.
    const result = await scanRepo(repo, {
      mode: 'all-open',
      detail: Number(body.detail) > 0 ? Number(body.detail) : 20,
      skip: Number(body.skip) > 0 ? Number(body.skip) : 0,
    });
    return sendJson(res, 200, { repo: result });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
