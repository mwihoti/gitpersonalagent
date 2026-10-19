'use strict';
// Thin seam over the Neon Postgres driver.
//
// Everything that persists goes through query() so tests can stub this one
// module, and so the rest of the code never learns which driver is in use.
// DATABASE_URL unset means "no cloud storage": callers fall back to the local
// JSON files, exactly as they did when Airtable was unconfigured.

// Loaded for its side effect (dotenv). The URL itself is read from
// process.env at call time, so test harnesses that swap the environment and
// reload other modules never leave this one holding a stale value.
require('./config');

let client = null;
let clientUrl = '';

function databaseUrl() {
  return process.env.DATABASE_URL || '';
}

function isConfigured() {
  return Boolean(databaseUrl());
}

function sql() {
  const url = databaseUrl();
  if (!url) {
    throw new Error('Database not configured — set DATABASE_URL in .env');
  }
  if (!client || clientUrl !== url) {
    const { neon } = require('@neondatabase/serverless');
    client = neon(url);
    clientUrl = url;
  }
  return client;
}

// Returns an array of row objects. Timestamps arrive as ISO strings and
// double precision as numbers; everything else in our schema is text.
async function query(text, params = []) {
  return sql().query(text, params);
}

// A failure of the network or of the Neon endpoint, as opposed to a SQL error
// we wrote ourselves. Only the former justifies the local-file fallback.
function isNetworkError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = error.code || (error.cause && error.cause.code) || '';
  if (['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return /fetch failed|Error connecting to database/i.test(String(error.message || ''));
}

module.exports = {
  isConfigured,
  isNetworkError,
  query,
};
