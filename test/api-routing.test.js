'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

test('shared queue function preserves authentication, item updates, and preference routing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dan-api-routing-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  Object.assign(process.env, { DAN_AGENT_DATA_DIR: dir, AIRTABLE_API_KEY: '', AIRTABLE_BASE_ID: '', DAN_AGENT_API_KEY: 'routing-key' });
  const airtable = require('../src/airtable');
  const handler = require('../api/opportunities');
  const [created] = await airtable.saveDigest({ date: '2026-10-01', contest_digest: [{ repo: 'a/b', opportunity: 'Test issue', issue_url: 'https://github.com/a/b/issues/1', effort: 'low' }] });
  async function call(method, query = {}, body = {}, authorized = true) {
    let payload;
    const res = { setHeader() {}, end(value) { if (value) payload = JSON.parse(value); } };
    await handler({ method, headers: authorized ? { 'x-api-key': 'routing-key' } : {}, query, body }, res);
    return { status: res.statusCode, payload };
  }
  for (const query of [{}, { id: created.id }, { __action: 'preferences' }]) {
    assert.equal((await call('POST', query, { action: 'reset' }, false)).status, 401);
  }
  const list = await call('GET');
  assert.equal(list.status, 200);
  assert.equal(list.payload.opportunities.length, 1);
  const updated = await call('PUT', { id: created.id }, { status: 'In Progress', quickPlan: '- [x] Reproduce' });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.opportunity.status, 'In Progress');
  const reset = await call('POST', { __action: 'preferences' }, { action: 'reset' });
  assert.equal(reset.status, 200);
  assert.equal((await call('GET')).payload.learning.sampleSize, 0);
  assert.equal((await call('OPTIONS', { id: created.id }, {}, false)).status, 204);
});

test('Vercel queue rewrites preserve public routes within the function budget', async () => {
  const config = require('../vercel.json');
  assert.ok(config.rewrites.some(rule => rule.source === '/api/preferences' && rule.destination === '/api/opportunities?__action=preferences'));
  assert.ok(config.rewrites.some(rule => rule.source === '/api/opportunities/:id' && rule.destination === '/api/opportunities?id=:id'));
  async function functionsIn(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? functionsIn(path.join(dir, entry.name)) : Number(entry.name.endsWith('.js'))))).reduce((a, b) => a + b, 0);
  }
  assert.ok(await functionsIn(path.join(__dirname, '..', 'api')) <= 12);
});
