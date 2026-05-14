'use strict';
const config = require('./config');
const { buildIssueInsight, buildRepoOverview } = require('./repo-insights');

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

async function fetchOpenIssues(repo, perPage = 30) {
  const params = new URLSearchParams({
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: String(perPage),
  });

  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?${params}`,
    { headers: makeHeaders() }
  );
  if (!res.ok) {
    console.warn(`  GitHub ${repo} (open): ${res.status}`);
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

async function fetchRepoDetails(repo) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}`,
    { headers: makeHeaders() }
  );

  if (!res.ok) {
    throw new Error(`GitHub repo lookup failed for ${repo}: ${res.status}`);
  }

  return res.json();
}

async function fetchIssueComments(issue) {
  if (!issue.comments) return [];

  const params = new URLSearchParams({
    per_page: '5',
    sort: 'updated',
    direction: 'desc',
  });

  const res = await fetch(
    `${issue.comments_url}?${params}`,
    { headers: makeHeaders() }
  );

  if (!res.ok) return [];
  return res.json();
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

async function scanRepos(repos = []) {
  const results = [];

  for (const repo of repos) {
    console.log(`  Scanning ${repo}...`);
    const result = await scanRepo(repo);
    console.log(`    → ${result.issues.length} issues (${result.labelSummary})`);
    results.push(result);
  }

  return results;
}

async function scanRepo(repo, options = {}) {
  const {
    mode = 'prioritized',
  } = options;

  const [repoDetails, recent, goodFirst, bugs, recentPRs, openIssues] = await Promise.all([
    fetchRepoDetails(repo),
    fetchRecentIssues(repo),
    fetchGoodFirstIssues(repo),
    fetchBugIssues(repo),
    fetchRecentPRActivity(repo),
    mode === 'all-open' ? fetchOpenIssues(repo, 50) : Promise.resolve([]),
  ]);

  const sourceIssues = mode === 'all-open'
    ? openIssues
    : dedup([...goodFirst, ...bugs, ...recent]).slice(0, 20);

  const merged = dedup(sourceIssues).slice(0, 20);
  const issues = await Promise.all(merged.map(async issue => {
    const comments = await fetchIssueComments(issue);
    return {
      ...shape(issue),
      ...buildIssueInsight(issue, comments),
    };
  })).then(items => items.sort((a, b) => {
    const scoreDiff = Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  }));
  const labelSummary = [
    goodFirst.length ? `${goodFirst.length} good-first` : '',
    bugs.length ? `${bugs.length} bugs` : '',
  ].filter(Boolean).join(', ');

  return {
    repo,
    repoUrl: `https://github.com/${repo}`,
    overview: buildRepoOverview(repoDetails),
    totalOpenIssues: mode === 'all-open' ? openIssues.length : recent.length,
    issues,
    recentPRs,
    labelSummary: labelSummary || 'recent activity',
  };
}

module.exports = { scanRepos, scanRepo };
