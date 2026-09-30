'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function loadAirtableModule(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-test-'));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  process.env.AIRTABLE_API_KEY = '';
  process.env.AIRTABLE_BASE_ID = '';
  process.env.AIRTABLE_TABLE_NAME = 'Contest Opportunities';
  process.env.DAN_AGENT_DATA_DIR = tmpDir;

  const configPath = path.resolve(__dirname, '..', 'src', 'config.js');
  const airtablePath = path.resolve(__dirname, '..', 'src', 'airtable.js');
  delete require.cache[configPath];
  delete require.cache[airtablePath];

  return require(airtablePath);
}

test('saveDigest preserves all local records across concurrent writes', async t => {
  const airtable = await loadAirtableModule(t);

  const digests = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-05-1${index}`,
    quick_plan: `plan-${index}`,
    contest_digest: [{
      opportunity: `Opportunity ${index}`,
      repo: 'owner/repo',
      why_it_qualifies: 'qualifies',
      suggested_action: 'do the work',
      clarity_tip: 'npm test',
      issue_url: `https://github.com/owner/repo/issues/${index}`,
      code_skeleton: `// ${index}`,
      why_it_matters: 'impact',
      effort: 'low',
    }],
  }));

  await Promise.all(digests.map(digest => airtable.saveDigest(digest)));

  const result = await airtable.listOpportunities();
  assert.equal(result.storage, 'local');
  assert.equal(result.opportunities.length, digests.length);
  assert.deepEqual(
    result.opportunities.map(item => item.opportunity).sort(),
    digests.map(digest => digest.contest_digest[0].opportunity).sort()
  );
});

test('updateOpportunity can clear due date and PR URL fields', async t => {
  const airtable = await loadAirtableModule(t);

  await airtable.saveDigest({
    date: '2026-05-16',
    quick_plan: 'plan',
    contest_digest: [{
      opportunity: 'Opportunity',
      repo: 'owner/repo',
      why_it_qualifies: 'qualifies',
      suggested_action: 'do the work',
      clarity_tip: 'npm test',
      issue_url: 'https://github.com/owner/repo/issues/1',
      code_skeleton: '// code',
      why_it_matters: 'impact',
      effort: 'low',
    }],
  });

  const initial = await airtable.listOpportunities();
  const id = initial.opportunities[0].id;

  await airtable.updateOpportunity(id, {
    dueDate: '2026-05-20',
    prUrl: 'https://github.com/owner/repo/pull/1',
  });
  const updated = await airtable.updateOpportunity(id, {
    dueDate: '',
    prUrl: '',
  });

  assert.equal(updated.dueDate, '');
  assert.equal(updated.prUrl, '');
});

test('saveDigest deduplicates recurring issue entries into one queue item', async t => {
  const airtable = await loadAirtableModule(t);

  await airtable.saveDigest({
    date: '2026-05-15',
    quick_plan: 'plan-1',
    contest_digest: [{
      opportunity: 'Same issue',
      repo: 'owner/repo',
      why_it_qualifies: 'qualifies',
      suggested_action: 'do the work',
      clarity_tip: 'npm test',
      issue_url: 'https://github.com/owner/repo/issues/9',
      code_skeleton: '// code',
      why_it_matters: 'impact',
      effort: 'low',
    }],
  });

  await airtable.saveDigest({
    date: '2026-05-16',
    quick_plan: 'plan-2',
    contest_digest: [{
      opportunity: 'Same issue',
      repo: 'owner/repo',
      why_it_qualifies: 'qualifies again',
      suggested_action: 'do the work again',
      clarity_tip: 'npm test',
      issue_url: 'https://github.com/owner/repo/issues/9',
      code_skeleton: '// newer code',
      why_it_matters: 'impact',
      effort: 'medium',
    }],
  });

  const result = await airtable.listOpportunities();
  assert.equal(result.opportunities.length, 1);
});

test('saveDigest returns record ids and recordIssueEvents appends to the activity log', async t => {
  const airtable = await loadAirtableModule(t);

  const created = await airtable.saveDigest({
    date: '2026-09-05',
    quick_plan: 'plan',
    contest_digest: [{
      opportunity: 'Tracked',
      repo: 'owner/repo',
      why_it_qualifies: 'q',
      suggested_action: 'a',
      clarity_tip: '',
      issue_url: 'https://github.com/owner/repo/issues/5',
      code_skeleton: '',
      why_it_matters: 'm',
      effort: 'low',
    }],
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].issueUrl, 'https://github.com/owner/repo/issues/5');
  assert.match(created[0].id, /^local-/);

  const applied = await airtable.recordIssueEvents([
    { recordId: created[0].id, activityLog: '', line: '[bot 2026-09-05] new activity', issueUpdatedAt: '2026-09-05T00:00:00Z' },
    { recordId: created[0].id, activityLog: '[bot 2026-09-05] new activity', line: '[bot 2026-09-06] closed upstream', status: 'Done' },
    { recordId: 'missing', line: 'x' },
    { recordId: created[0].id },
  ]);
  assert.equal(applied, 2);

  const { opportunities } = await airtable.listOpportunities();
  assert.equal(opportunities[0].status, 'Done');
  assert.equal(opportunities[0].issueUpdatedAt, '2026-09-05T00:00:00Z');
  assert.equal(opportunities[0].activityLog, '[bot 2026-09-05] new activity\n[bot 2026-09-06] closed upstream');

  const removed = await airtable.deleteOpportunities([created[0].id]);
  assert.equal(removed, 1);
  assert.equal((await airtable.listOpportunities()).opportunities.length, 0);
});

test('derivePriority blends impact with effort', async t => {
  const airtable = await loadAirtableModule(t);
  assert.equal(airtable.derivePriority({ effort: 'low' }), 'High');
  assert.equal(airtable.derivePriority({ effort: 'high' }), 'Low');
  assert.equal(airtable.derivePriority({ effort: 'low', impact: 'low' }), 'Medium');
  assert.equal(airtable.derivePriority({ effort: 'medium', impact: 'high' }), 'High');
  assert.equal(airtable.derivePriority({ effort: 'high', impact: 'low' }), 'Low');
});
