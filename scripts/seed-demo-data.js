'use strict';
// Seeds the local opportunity store with REAL, currently-open GitHub issues so
// the demo recording shows genuine output rather than invented rows.
//
// It deliberately uses the project's own ranking code (buildIssueInsight) and
// its own save path (saveDigest). The only thing missing compared with a
// production run is the LLM narrative — which is exactly what a real install
// without model keys produces.
//
// One request per repo, to stay inside the unauthenticated GitHub limit.
//
//   npm run demo:seed
const path = require('path');
const PROJECT = path.join(__dirname, '..');
process.chdir(PROJECT);

const REPOS = [
  'lnbits/lnbits',
  'mempool/mempool',
  'btcpayserver/btcpayserver',
  'spesmilo/electrum',
  'rust-bitcoin/rust-bitcoin',
  'BitcoinDesign/Guide',
  'fedimint/fedimint',
  'bitcoindevkit/bdk',
];

const LABELS = ['good first issue', 'help wanted'];

async function fetchIssues(repo, label) {
  const url = `https://api.github.com/repos/${repo}/issues`
    + `?state=open&per_page=6&sort=updated&labels=${encodeURIComponent(label)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'danagent-demo-seed/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.warn(`  ${repo} [${label}] → ${res.status}`);
    return [];
  }
  const rows = await res.json();
  // The issues endpoint returns pull requests too; they are not opportunities.
  return (Array.isArray(rows) ? rows : []).filter(row => !row.pull_request);
}

(async () => {
  const { buildIssueInsight } = require('../src/repo-insights');
  const { classifyRepo, findProject } = require('../src/bitcoin-ecosystem');
  const { saveDigest } = require('../src/airtable');

  const items = [];

  for (const repo of REPOS) {
    let found = [];
    for (const label of LABELS) {
      if (found.length) break;
      found = await fetchIssues(repo, label);
    }
    console.log(`  ${repo} → ${found.length} open issues`);

    const area = classifyRepo(repo);
    const project = findProject(repo);

    for (const raw of found.slice(0, 3)) {
      const issue = {
        number: raw.number,
        title: raw.title,
        body: raw.body || '',
        labels: (raw.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
        url: raw.html_url,
        comments: raw.comments || 0,
        updated_at: raw.updated_at,
        created_at: raw.created_at,
        assignees: (raw.assignees || []).map(u => u.login),
        linkedPRs: [],
        repositoryLanguage: project ? project.language : '',
        languagePreferred: true,
        bitcoinArea: area.area,
        bitcoinAreaLabel: area.label,
        bitcoinAreaSource: area.source,
      };

      const insight = buildIssueInsight(issue, []);

      // Assigned issues are exactly what the tool filters out, so leaving them
      // in the demo queue would misrepresent what it does.
      if (issue.assignees.length) continue;

      items.push({
        opportunity: issue.title,
        repo,
        issue_url: issue.url,
        why_it_qualifies: insight.issueFitReason,
        suggested_action: insight.quickPlan,
        why_it_matters: insight.expectationSummary,
        clarity_tip: project ? project.blurb : '',
        quick_plan: insight.quickPlan,
        score: insight.issueFitScore,
        effort: insight.issueComplexity === 'Quick win' ? 'low'
          : insight.issueComplexity === 'Medium' ? 'medium' : 'high',
        impact: insight.issueRecommendation,
        labels: issue.labels,
        language: issue.repositoryLanguage,
        issue_updated_at: issue.updated_at,
        source: 'bitcoin-ecosystem',
        source_url: `https://github.com/${repo}`,
      });
    }
  }

  items.sort((a, b) => b.score - a.score);

  const digest = {
    date: new Date().toISOString().slice(0, 10),
    contest_digest: items,
    quick_plan: 'Start with the highest-fit unclaimed issue and ask the maintainer before writing code.',
    tech_news_summary: [],
  };

  await saveDigest(digest);
  console.log(`\nSeeded ${items.length} real open issues.`);
  console.log(items.slice(0, 8).map(i => `  ${i.score}  ${i.repo}  ${i.opportunity.slice(0, 64)}`).join('\n'));
})().catch(e => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
