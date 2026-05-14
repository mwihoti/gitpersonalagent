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
