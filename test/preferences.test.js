'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

test('ranking reset requires access and preserves saved work and activity timestamps', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dan-preferences-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  process.env.DAN_AGENT_DATA_DIR = dir;
  process.env.AIRTABLE_API_KEY = '';
  process.env.AIRTABLE_BASE_ID = '';
  process.env.DAN_AGENT_API_KEY = 'test-key';
  for (const file of ['../src/config', '../src/airtable', '../src/auth', '../src/api/preferences']) delete require.cache[require.resolve(file)];
  const airtable = require('../src/airtable');
  const handler = require('../src/api/preferences');
  const { buildPreferenceModel } = require('../src/feedback');
  const [created] = await airtable.saveDigest({ date: '2026-10-01', contest_digest: [{ repo: 'a/b', opportunity: 'Test issue', issue_url: 'https://github.com/a/b/issues/1', effort: 'low' }] });
  const before = await airtable.updateOpportunity(created.id, { status: 'Done', activityLog: 'Dismissed [dismiss reason: too big]', quickPlan: '- [x] Reproduce\n- [ ] Fix' });
  async function call(headers, body) {
    let payload;
    const res = { setHeader() {}, end(value) { payload = JSON.parse(value); } };
    await handler({ method: 'POST', headers, body }, res);
    return { status: res.statusCode, payload };
  }
  assert.equal((await call({}, { action: 'reset' })).status, 401);
  assert.equal((await call({ 'x-api-key': 'test-key' }, { action: 'invalid' })).status, 400);
  assert.deepEqual(await call({ 'x-api-key': 'test-key' }, { action: 'reset' }), { status: 200, payload: { ok: true, reset: 1 } });
  const after = (await airtable.listOpportunities()).opportunities[0];
  assert.equal(after.status, before.status);
  assert.equal(after.quickPlan, before.quickPlan);
  assert.equal(after.lastUpdated, before.lastUpdated);
  assert.ok(after.activityLog.startsWith(before.activityLog));
  assert.equal(buildPreferenceModel([after]).sampleSize, 0);
  const next = await airtable.updateOpportunity(after.id, { status: 'In Progress' });
  assert.equal(buildPreferenceModel([next]).counts.claimed, 1);
});
