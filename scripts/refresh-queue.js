'use strict';
// Tidies the tracked queue and, optionally, deep-analyzes what is left.
//
//   npm run refresh-queue                       dry run: show what would change
//   npm run refresh-queue -- --apply            close / note / archive records
//   npm run refresh-queue -- --apply --analyze 10
//                                               ...then deep-analyze the 10
//                                               best open items that have no
//                                               analysis yet (rate-limit aware)
require('dotenv').config();
const { listOpportunities, recordIssueEvents, updateOpportunity } = require('../src/airtable');
const { planQueueRefresh } = require('../src/queue-refresh');
const { analyzeIssue } = require('../src/issue-analysis');
const { isDoneStatus } = require('../src/issue-tracking');

function flag(name) {
  return process.argv.includes(name);
}

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index !== -1 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

async function main() {
  const apply = flag('--apply');
  const analyzeCount = flag('--analyze') ? flagValue('--analyze', 5) : 0;
  const { opportunities } = await listOpportunities();

  const plan = await planQueueRefresh(opportunities);
  console.log(`${opportunities.length} records, ${plan.candidates} open and untaken, ${plan.checked} checked on GitHub.\n`);
  for (const action of plan.actions) {
    console.log(`${action.action.padEnd(8)} ${String(action.ageDays).padStart(4)}d  ${action.repo.padEnd(34)} ${action.title.slice(0, 60)}\n         ${action.reason}`);
  }
  console.log(`\narchive ${plan.counts.archive} · close ${plan.counts.close} · note ${plan.counts.note}`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write these changes.');
  } else if (plan.actions.length) {
    const applied = await recordIssueEvents(plan.actions.map(action => action.event));
    console.log(`Applied ${applied} updates.`);
  }

  if (!analyzeCount) return;

  const archived = new Set(plan.actions.filter(a => a.action !== 'note').map(a => a.recordId));
  const targets = opportunities
    .filter(record => record.issueUrl && !isDoneStatus(record.status) && !archived.has(record.id))
    .filter(record => !record.analysis || record.analysis.model === 'heuristic')
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, analyzeCount);

  console.log(`\nDeep-analyzing ${targets.length} open items without an analysis...`);
  for (const record of targets) {
    try {
      const result = await analyzeIssue({ url: record.issueUrl }, { knownUpdatedAt: record.issueUpdatedAt });
      const a = result.analysis;
      console.log(`  ${result.model === 'heuristic' ? 'skip ' : 'done '} ${record.repo} ${record.opportunity.slice(0, 50)} → ${a.currentState}${a.effort ? `, ${a.effort} effort` : ''}`);
      if (apply && result.model !== 'heuristic') {
        await updateOpportunity(record.id, { analysis: result, issueUpdatedAt: result.issueUpdatedAt }, { touch: false });
      }
    } catch (error) {
      console.log(`  fail  ${record.issueUrl}: ${error.message.slice(0, 120)}`);
    }
  }
  if (!apply) console.log('Dry run: analyses were not stored. Add --apply to save them to the records.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
