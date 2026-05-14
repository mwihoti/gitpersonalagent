'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function loadAuthModule(apiKey = '') {
  const configPath = path.resolve(__dirname, '..', 'src', 'config.js');
  const authPath = path.resolve(__dirname, '..', 'src', 'auth.js');
  delete require.cache[configPath];
  delete require.cache[authPath];

  if (apiKey) {
    process.env.DAN_AGENT_API_KEY = apiKey;
  } else {
    delete process.env.DAN_AGENT_API_KEY;
  }

  return require(authPath);
}

test('isAuthorizedRequest allows requests when no API key is configured', () => {
  const auth = loadAuthModule('');
  assert.equal(auth.isAuthorizedRequest({ headers: {} }), true);
});

test('isAuthorizedRequest accepts X-API-Key and Bearer token', () => {
  const auth = loadAuthModule('secret-key');

  assert.equal(auth.isAuthorizedRequest({
    headers: { 'x-api-key': 'secret-key' },
  }), true);

  assert.equal(auth.isAuthorizedRequest({
    headers: { authorization: 'Bearer secret-key' },
  }), true);

  assert.equal(auth.isAuthorizedRequest({
    headers: { authorization: 'Bearer wrong-key' },
  }), false);
});
