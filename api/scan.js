'use strict';
const { runScan } = require('../src/run-scan');
const { requireApiAuth } = require('../src/auth');
const { allowOptions, sendJson } = require('../src/http');

module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = req.headers['user-agent'] === 'vercel-cron/1.0';
  const isAuthorizedCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const allowManual = req.method === 'POST';

  if ((req.method === 'GET' || isVercelCron) && !isAuthorizedCron) {
    return sendJson(res, 401, {
      error: cronSecret
        ? 'Unauthorized'
        : 'Set CRON_SECRET to secure this endpoint on Vercel.',
    });
  }

  if (!allowManual && !isAuthorizedCron) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  if (allowManual && !(await requireApiAuth(req, res))) {
    return;
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const scanMode = url.searchParams.get('scanMode') || 'default';
    // Interactive scans (a specific mode) default to no dedupe so the requester
    // always gets a digest back; the daily cron keeps dedupe on.
    const dedupeParam = url.searchParams.get('dedupe');
    const dedupe = dedupeParam !== null
      ? dedupeParam !== 'false'
      : scanMode === 'default';
    const baseTrigger = isVercelCron ? 'vercel-cron' : (req.method === 'POST' ? 'manual-api' : 'cron');
    const trigger = scanMode === 'default' ? baseTrigger : `${baseTrigger}-${scanMode}`;
    const result = await runScan({ trigger, scanMode, dedupe });
    return sendJson(res, 200, {
      ok: true,
      digest: result.digest,
      reused: result.reused,
      run: result.run,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
