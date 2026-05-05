'use strict';
const config = require('./config');

const DAYS_BACK = 30; // general recent activity window

function since(days = DAYS_BACK) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makeHeaders() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;
  return headers;
}

// Recent issues updated in the last N days
async function fetchRecentIssues(repo) {
  const params = new URLSearchParams({
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: '30',
    since: since(),
  });

  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?${params}`,
    { headers: makeHeaders() }
  );
  if (!res.ok) {
    console.warn(`  GitHub ${repo} (recent): ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.filter(i => !i.pull_request);
}

// Good first issues — any age, always worth surfacing
async function fetchGoodFirstIssues(repo) {
  const params = new URLSearchParams({
    state: 'open',
    labels: 'good first issue',
    sort: 'created',
    direction: 'desc',
    per_page: '10',
  });

  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?${params}`,
    { headers: makeHeaders() }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.filter(i => !i.pull_request);
}

// Bug-labeled issues — high-signal for contest
async function fetchBugIssues(repo) {
  const params = new URLSearchParams({
    state: 'open',
    labels: 'bug',
    sort: 'updated',
    direction: 'desc',
    per_page: '10',
  });

  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?${params}`,
    { headers: makeHeaders() }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.filter(i => !i.pull_request);
}

async function fetchRecentPRActivity(repo) {
  const params = new URLSearchParams({
    state: 'open',
    sort: 'created',
    direction: 'desc',
    per_page: '10',
  });

  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls?${params}`,
    { headers: makeHeaders() }
  );
  if (!res.ok) return [];
  const prs = await res.json();
  return prs.map(p => ({
    number: p.number,
    title: p.title,
    author: p.user?.login,
    url: p.html_url,
  }));
}

function dedup(issues) {
  const seen = new Set();
  return issues.filter(i => {
    if (seen.has(i.number)) return false;
    seen.add(i.number);
    return true;
  });
}

function shape(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: (issue.body || '').slice(0, 400),
    labels: issue.labels.map(l => l.name),
    url: issue.html_url,
    comments: issue.comments,
    updatedAt: issue.updated_at,
  };
}

async function scanRepos() {
  const results = [];

  for (const repo of config.github.repos) {
    console.log(`  Scanning ${repo}...`);
    const result = await scanRepo(repo);
    console.log(`    → ${result.issues.length} issues (${result.labelSummary})`);
    results.push(result);
  }

  return results;
}

async function scanRepo(repo) {
  const [recent, goodFirst, bugs, recentPRs] = await Promise.all([
    fetchRecentIssues(repo),
    fetchGoodFirstIssues(repo),
    fetchBugIssues(repo),
    fetchRecentPRActivity(repo),
  ]);

  const merged = dedup([...goodFirst, ...bugs, ...recent]);
  const issues = merged.map(shape);
  const labelSummary = [
    goodFirst.length ? `${goodFirst.length} good-first` : '',
    bugs.length ? `${bugs.length} bugs` : '',
  ].filter(Boolean).join(', ');

  return {
    repo,
    repoUrl: `https://github.com/${repo}`,
    totalOpenIssues: recent.length,
    issues,
    recentPRs,
    labelSummary: labelSummary || 'recent activity',
  };
}

module.exports = { scanRepos, scanRepo };
