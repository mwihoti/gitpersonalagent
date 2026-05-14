'use strict';
const config = require('./config');
const { sendJson } = require('./http');

function getApiKey() {
  return String(config.dashboard.apiKey || '').trim();
}

function getRequestApiKey(req) {
  const headerValue = req.headers['x-api-key'];
  if (headerValue) return String(headerValue).trim();

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isAuthorizedRequest(req) {
  const apiKey = getApiKey();
  if (!apiKey) return true;
  return getRequestApiKey(req) === apiKey;
}

function requireApiAuth(req, res) {
  if (isAuthorizedRequest(req)) {
    return true;
  }

  res.setHeader('WWW-Authenticate', 'Bearer realm="Dan Agent API"');
  sendJson(res, 401, {
    error: 'Unauthorized. Set DAN_AGENT_API_KEY and send it as X-API-Key or Bearer token.',
  });
  return false;
}

module.exports = {
  getApiKey,
  getRequestApiKey,
  isAuthorizedRequest,
  requireApiAuth,
};
