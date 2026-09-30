'use strict';
// One-off cleanup for bases that accumulated one row per scan day for the
// same issue. Keeps the row with the most human input (status, owner,
// activity log, PR URL), otherwise the newest, and deletes the rest.
//
//   node scripts/dedupe-airtable.js          # dry run: shows what would go
//   node scripts/dedupe-airtable.js --apply  # actually delete
require('dotenv').config();
const { listRawOpportunities, deleteOpportunities } = require('../src/airtable');
const { normalizeUrl, isDoneStatus } = require('../src/issue-tracking');

function humanScore(record) {
  let score = 0;
  if (record.status && record.status !== 'New') score += 4;
  if (isDoneStatus(record.status)) score += 2;
  if (record.owner) score += 2;
  if (record.prUrl) score += 3;
  if (record.activityLog) score += 2;
  if (record.nextStep) score += 1;
  if (record.analysis) score += 1;
  return score;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const rows = await listRawOpportunities();
  const groups = new Map();
  for (const row of rows) {
    const key = normalizeUrl(row.issueUrl);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const toDelete = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const diff = humanScore(b) - humanScore(a);
      if (diff !== 0) return diff;
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
    const [keep, ...rest] = group;
    console.log(`${key}\n  keep   ${keep.id} (${keep.date}, ${keep.status}${keep.owner ? `, ${keep.owner}` : ''})`);
    for (const row of rest) {
      console.log(`  delete ${row.id} (${row.date}, ${row.status})`);
      toDelete.push(row.id);
    }
  }

  console.log(`\n${rows.length} rows, ${groups.size} distinct issues, ${toDelete.length} duplicates`);
  if (!toDelete.length) return;
  if (!apply) {
    console.log('Dry run. Re-run with --apply to delete.');
    return;
  }
  const removed = await deleteOpportunities(toDelete);
  console.log(`Deleted ${removed} rows.`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
