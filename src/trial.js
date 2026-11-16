'use strict';
// Free scans for visitors without a dashboard key.
//
// A visitor may check TRIAL_SCANS repositories from the Bitcoin project
// directory before the dashboard asks for a key. The count is kept on the
// server, per visitor, so clearing the browser does not reset it. Visitors are
// told apart by a salted hash of their IP address; the address itself is never
// stored. A daily cap across all visitors bounds what rotating addresses can
// cost in GitHub API calls.

const crypto = require('crypto');
const db = require('./db');

const TRIAL_SCANS = 2;
const DAILY_TRIAL_CAP = 100;

const memory = new Map();
let schemaReady = null;

function clientIp(req) {
  const headers = req.headers || {};
  // Vercel sets both headers itself and overwrites anything the client sent.
  const real = String(headers['x-real-ip'] || '').trim();
  if (real) return real;
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return req.socket?.remoteAddress || 'unknown';
}

function salt() {
  return process.env.TRIAL_SALT || process.env.TELEGRAM_WEBHOOK_SECRET || process.env.DAN_AGENT_API_KEY || 'local-trial';
}

function visitorId(req) {
  return `ip:${crypto.createHash('sha256').update(`${salt()}:${clientIp(req)}`).digest('hex').slice(0, 32)}`;
}

function dayKey(now = new Date()) {
  return `day:${now.toISOString().slice(0, 10)}`;
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`CREATE TABLE IF NOT EXISTS trial_scans (
      visitor text PRIMARY KEY,
      used integer NOT NULL DEFAULT 0,
      first_at timestamptz NOT NULL DEFAULT now(),
      last_at timestamptz NOT NULL DEFAULT now()
    )`).catch(error => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

// Takes one unit from `key` if fewer than `limit` are used. Returns the new
// count, or 0 when the limit was already reached. Atomic in Postgres, so two
// requests at once cannot both take the last scan.
async function take(key, limit) {
  if (!db.isConfigured()) {
    const used = memory.get(key) || 0;
    if (used >= limit) return 0;
    memory.set(key, used + 1);
    return used + 1;
  }
  await ensureSchema();
  const rows = await db.query(
    `INSERT INTO trial_scans (visitor, used) VALUES ($1, 1)
     ON CONFLICT (visitor) DO UPDATE SET used = trial_scans.used + 1, last_at = now()
     WHERE trial_scans.used < $2
     RETURNING used`,
    [key, limit],
  );
  return rows[0] ? Number(rows[0].used) : 0;
}

async function giveBack(key) {
  if (!db.isConfigured()) {
    memory.set(key, Math.max(0, (memory.get(key) || 0) - 1));
    return;
  }
  await ensureSchema();
  await db.query('UPDATE trial_scans SET used = GREATEST(used - 1, 0) WHERE visitor = $1', [key]);
}

async function usedBy(key) {
  if (!db.isConfigured()) return memory.get(key) || 0;
  await ensureSchema();
  const rows = await db.query('SELECT used FROM trial_scans WHERE visitor = $1', [key]);
  return rows[0] ? Number(rows[0].used) : 0;
}

function summary(used) {
  const count = Math.min(TRIAL_SCANS, Math.max(0, Number(used) || 0));
  return { used: count, limit: TRIAL_SCANS, remaining: TRIAL_SCANS - count };
}

async function trialStatus(req) {
  return summary(await usedBy(visitorId(req)));
}

// Reserves a scan for this visitor. Returns { ok, trial, reason, release }:
// call release() if the scan then fails, so an error does not cost a scan.
async function reserveTrialScan(req, now = new Date()) {
  const visitor = visitorId(req);
  const day = dayKey(now);
  if (!(await take(day, DAILY_TRIAL_CAP))) {
    return { ok: false, reason: 'busy', trial: summary(await usedBy(visitor)) };
  }
  const used = await take(visitor, TRIAL_SCANS);
  if (!used) {
    await giveBack(day);
    return { ok: false, reason: 'used', trial: summary(TRIAL_SCANS) };
  }
  return {
    ok: true,
    trial: summary(used),
    release: async () => { await giveBack(visitor); await giveBack(day); },
  };
}

function resetTrialMemory() {
  memory.clear();
}

module.exports = {
  DAILY_TRIAL_CAP,
  TRIAL_SCANS,
  clientIp,
  reserveTrialScan,
  resetTrialMemory,
  trialStatus,
  visitorId,
};
