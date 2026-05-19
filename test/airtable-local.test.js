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
