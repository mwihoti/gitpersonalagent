'use strict';
const config = require('./config');
const { buildIssueInsight, buildRepoOverview, detectClaim, stripMarkdown } = require('./repo-insights');
const { classifyRepo } = require('./bitcoin-ecosystem');

const DAYS_BACK = 30; // general recent activity window
let authDisabledForRun = false;

function since(days = DAYS_BACK) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makeHeaders() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (config.github.token && !authDisabledForRun) headers.Authorization = `Bearer ${config.github.token}`;
  return headers;
}

function getPreferredLanguages() {
  return String(process.env.PREFERRED_LANGUAGES || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function shouldRetryWithoutAuth(res, usedAuth) {
  return usedAuth && (res.status === 401 || res.status === 403);
}

let rateLimitedUntil = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rateLimitResponse(url) {
  const resetIn = Math.max(0, Math.round((rateLimitedUntil - Date.now()) / 1000));
  return {
    ok: false,
    status: 403,
    rateLimited: true,
    json: async () => ({ message: `GitHub rate limit exhausted for ${url}; resets in ${resetIn}s` }),
    text: async () => `rate limit exhausted; resets in ${resetIn}s`,
  };
}

// Primary limit exhausted (remaining 0): remember the reset time and fail fast
// until then instead of burning the budget further. Secondary limit
// (retry-after): wait once, briefly.
async function handleRateLimit(res, url) {
  const remaining = res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : null;
  const reset = res.headers && res.headers.get ? Number(res.headers.get('x-ratelimit-reset')) : 0;
  const retryAfter = res.headers && res.headers.get ? Number(res.headers.get('retry-after')) : 0;
  if ((res.status === 403 || res.status === 429) && remaining === '0' && reset) {
    rateLimitedUntil = reset * 1000;
    console.warn(`  GitHub rate limit exhausted; skipping GitHub calls for ${Math.max(0, Math.round((rateLimitedUntil - Date.now()) / 1000))}s (${url})`);
    return 'exhausted';
  }
  if ((res.status === 403 || res.status === 429) && retryAfter > 0) {
    const wait = Math.min(retryAfter, 10) * 1000;
    console.warn(`  GitHub secondary rate limit; waiting ${wait / 1000}s before retrying ${url}`);
    await sleep(wait);
    return 'retry';
  }
  return '';
}

async function githubRequest(url, options = {}) {
  if (rateLimitedUntil && Date.now() < rateLimitedUntil) {
    return rateLimitResponse(url);
  }
  const headers = makeHeaders();
  if (options.accept) headers.Accept = options.accept;
  const usedAuth = Boolean(headers.Authorization);
  let first = await fetch(url, { headers });

  const limit = await handleRateLimit(first, url);
  if (limit === 'exhausted') return rateLimitResponse(url);
  if (limit === 'retry') first = await fetch(url, { headers });

  // Endpoints such as code search return 403 on their own rate limits; that
  // must not disable the token for the rest of the run.
  if (options.keepAuth || !shouldRetryWithoutAuth(first, usedAuth)) {
    return first;
  }

  authDisabledForRun = true;
  console.warn(`  GitHub auth rejected (${first.status}) for ${url} — disabling token for this process and retrying without token`);
  return fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
}

async function getGitHubErrorMessage(res) {
  try {
    const body = await res.json();
    return body.message ? `${res.status} ${body.message}` : String(res.status);
  } catch {
    return String(res.status);
  }
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

  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues?${params}`);
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

  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues?${params}`);
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

  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues?${params}`);
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

  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.filter(i => !i.pull_request);
}

async function fetchIssueByNumber(repo, number) {
  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues/${number}`);
  if (!res.ok) return null;
  const issue = await res.json();
  return issue.pull_request ? null : issue;
}

async function fetchRecentPRActivity(repo) {
  const params = new URLSearchParams({
    state: 'open',
    sort: 'created',
    direction: 'desc',
    per_page: '10',
  });

  const res = await githubRequest(`https://api.github.com/repos/${repo}/pulls?${params}`);
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
  const res = await githubRequest(`https://api.github.com/repos/${repo}`);

  if (!res.ok) {
    throw new Error(`GitHub repo lookup failed for ${repo}: ${await getGitHubErrorMessage(res)}`);
  }

  return res.json();
}

async function assertRepositoryAccessible(repo) {
  try {
    await fetchRepoDetails(repo);
  } catch (error) {
    if (/404/.test(String(error.message))) {
      throw new Error(`GitHub repository not found: ${repo}`);
    }
    throw new Error(`GitHub repository check failed for ${repo}: ${error.message}`);
  }
}

// Returns the latest N comments in chronological order (oldest first).
// The per-issue comments endpoint ignores sort/direction, so we ask for the
// last page and keep its tail.
async function fetchIssueComments(issue, limit = 5) {
  const total = Number(issue.comments || 0);
  if (!total || !issue.comments_url) return [];

  const pageSize = 100;
  const params = new URLSearchParams({
    per_page: String(pageSize),
    page: String(Math.max(1, Math.ceil(total / pageSize))),
  });

  const res = await githubRequest(`${issue.comments_url}?${params}`);

  if (!res.ok) return [];
  const comments = await res.json();
  return Array.isArray(comments) ? comments.slice(-limit) : [];
}

// Pull requests that reference this issue, via the timeline API.
async function fetchLinkedPullRequests(repo, number) {
  if (process.env.GITHUB_FETCH_TIMELINE === 'false') return [];
  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues/${number}/timeline?per_page=100`);
  if (!res.ok) return [];
  const events = await res.json();
  if (!Array.isArray(events)) return [];

  const seen = new Set();
  const prs = [];
  for (const event of events) {
    const source = event && event.event === 'cross-referenced' ? event.source?.issue : null;
    if (!source || !source.pull_request || seen.has(source.number)) continue;
    seen.add(source.number);
    const merged = Boolean(source.pull_request.merged_at);
    const ref = parseIssueUrl(source.html_url);
    const prRepo = ref ? ref.repo : (source.repository?.full_name || '');
    prs.push({
      number: source.number,
      title: source.title || '',
      url: source.html_url || '',
      author: source.user?.login || '',
      state: merged ? 'merged' : (source.state || 'open'),
      updatedAt: source.updated_at || '',
      repo: prRepo,
      // A PR in another repository that merely mentions this issue is not a fix for it.
      sameRepo: !prRepo || prRepo.toLowerCase() === String(repo).toLowerCase(),
    });
  }
  return prs;
}

// Lightweight state check used to detect issues that closed or got claimed
// after we recommended them.
async function fetchIssueStatus(repo, number) {
  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues/${number}`);
  if (!res.ok) return null;
  const issue = await res.json();
  return {
    repo,
    number,
    url: issue.html_url || `https://github.com/${repo}/issues/${number}`,
    title: issue.title || '',
    state: issue.state || 'open',
    stateReason: issue.state_reason || '',
    closedAt: issue.closed_at || '',
    updatedAt: issue.updated_at || '',
    assignees: (issue.assignees || []).map(user => user.login).filter(Boolean),
    isPullRequest: Boolean(issue.pull_request),
  };
}

// ─── Deep-context helpers (used by issue-context.js) ─────────────────────────

async function fetchIssueFull(repo, number) {
  const res = await githubRequest(`https://api.github.com/repos/${repo}/issues/${number}`);
  if (!res.ok) {
    throw new Error(`GitHub issue lookup failed for ${repo}#${number}: ${await getGitHubErrorMessage(res)}`);
  }
  const issue = await res.json();
  if (issue.pull_request) {
    throw new Error(`${repo}#${number} is a pull request, not an issue`);
  }
  return issue;
}

// Up to `max` comments in order. Long threads keep the opening comments and
// the most recent ones, which is where the decisions usually are.
async function fetchAllIssueComments(issue, options = {}) {
  const { max = 25, head = 5 } = options;
  const total = Number(issue.comments || 0);
  if (!total || !issue.comments_url) return [];

  const pageSize = 100;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const pages = lastPage === 1 ? [1] : [1, lastPage];
  const collected = [];
  for (const page of pages) {
    const res = await githubRequest(`${issue.comments_url}?per_page=${pageSize}&page=${page}`);
    if (!res.ok) break;
    const batch = await res.json();
    if (Array.isArray(batch)) collected.push(...batch);
  }

  const unique = [];
  const seen = new Set();
  for (const comment of collected) {
    if (seen.has(comment.id)) continue;
    seen.add(comment.id);
    unique.push(comment);
  }
  if (unique.length <= max) return unique;
  return [...unique.slice(0, head), ...unique.slice(-(max - head))];
}

async function fetchRepoFile(repo, filePath, options = {}) {
  const ref = options.ref ? `?ref=${encodeURIComponent(options.ref)}` : '';
  const cleanPath = String(filePath || '').replace(/^\/+/, '');
  if (!cleanPath) return null;
  const res = await githubRequest(
    `https://api.github.com/repos/${repo}/contents/${cleanPath.split('/').map(encodeURIComponent).join('/')}${ref}`,
    { accept: 'application/vnd.github.raw+json', keepAuth: true },
  );
  if (!res.ok) return null;
  const content = await res.text();
  if (!content || content.startsWith('[')) return null; // directory listing
  return {
    path: cleanPath,
    url: `https://github.com/${repo}/blob/${options.ref || 'HEAD'}/${cleanPath}`,
    content,
  };
}

const CONTRIBUTING_PATHS = [
  'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'doc/CONTRIBUTING.md',
  'docs/contributing.md', 'doc/contributing.md', 'CONTRIBUTING.rst', 'CONTRIBUTING',
];
const contributingCache = new Map();

async function fetchContributingGuide(repo) {
  const key = String(repo).toLowerCase();
  if (contributingCache.has(key)) return contributingCache.get(key);
  let found = null;
  for (const candidate of CONTRIBUTING_PATHS) {
    const file = await fetchRepoFile(repo, candidate).catch(() => null);
    if (file) {
      found = file;
      break;
    }
  }
  contributingCache.set(key, found);
  return found;
}

// Code search needs a token; without one GitHub answers 401 and we return [].
async function searchCode(repo, query, options = {}) {
  const { limit = 5 } = options;
  if (!config.github.token || authDisabledForRun) return [];
  const q = encodeURIComponent(`${query} repo:${repo}`);
  const res = await githubRequest(`https://api.github.com/search/code?q=${q}&per_page=${limit}`, {
    accept: 'application/vnd.github.text-match+json',
    keepAuth: true,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map(item => ({
    path: item.path,
    url: item.html_url,
    matches: (item.text_matches || []).map(match => match.fragment).slice(0, 2),
  }));
}

async function fetchPullRequestFiles(repo, number, options = {}) {
  const { limit = 20 } = options;
  const res = await githubRequest(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=${limit}`);
  if (!res.ok) return [];
  const files = await res.json();
  return Array.isArray(files)
    ? files.map(file => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions }))
    : [];
}

// One-call view of a PR: merge state, latest review verdict, CI result.
async function fetchPullRequestSnapshot(repo, number) {
  const res = await githubRequest(`https://api.github.com/repos/${repo}/pulls/${number}`);
  if (!res.ok) throw new Error(`PR lookup failed for ${repo}#${number}: ${await getGitHubErrorMessage(res)}`);
  const pr = await res.json();

  const [reviewsRes, checksRes, statusRes] = await Promise.all([
    githubRequest(`https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    pr.head && pr.head.sha ? githubRequest(`https://api.github.com/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`) : null,
    pr.head && pr.head.sha ? githubRequest(`https://api.github.com/repos/${repo}/commits/${pr.head.sha}/status`) : null,
  ]);

  // Latest non-comment review per reviewer decides the verdict.
  let reviewState = '';
  let reviewer = '';
  let reviewComments = 0;
  if (reviewsRes && reviewsRes.ok) {
    const reviews = await reviewsRes.json();
    const latest = new Map();
    for (const review of Array.isArray(reviews) ? reviews : []) {
      const login = review.user?.login || '';
      if (!login || login === pr.user?.login) continue;
      if (review.state === 'COMMENTED') { reviewComments += 1; continue; }
      latest.set(login, review);
    }
    const verdicts = [...latest.values()];
    const changes = verdicts.find(r => r.state === 'CHANGES_REQUESTED');
    const approved = verdicts.find(r => r.state === 'APPROVED');
    if (changes) { reviewState = 'changes_requested'; reviewer = changes.user.login; }
    else if (approved) { reviewState = 'approved'; reviewer = approved.user.login; }
  }

  let ci = '';
  let ciDetail = '';
  if (checksRes && checksRes.ok) {
    const data = await checksRes.json();
    const runs = data.check_runs || [];
    const failed = runs.find(run => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(run.conclusion));
    if (failed) { ci = 'failure'; ciDetail = failed.name; }
    else if (runs.some(run => run.status !== 'completed')) ci = 'pending';
    else if (runs.length) ci = 'success';
  }
  if (!ci && statusRes && statusRes.ok) {
    const data = await statusRes.json();
    if (data.state === 'failure' || data.state === 'error') ci = 'failure';
    else if (data.state === 'pending' && (data.statuses || []).length) ci = 'pending';
    else if (data.state === 'success') ci = 'success';
  }

  return {
    repo,
    number,
    url: pr.html_url,
    title: pr.title || '',
    author: pr.user?.login || '',
    state: pr.state,
    merged: Boolean(pr.merged_at),
    mergedAt: pr.merged_at || '',
    draft: Boolean(pr.draft),
    mergeableState: pr.mergeable_state || '',
    updatedAt: pr.updated_at || '',
    headSha: pr.head?.sha || '',
    reviewState,
    reviewer,
    reviewComments,
    ci,
    ciDetail,
  };
}

function parseIssueUrl(url) {
  const match = String(url || '').match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/i);
  if (!match) return null;
  return { repo: match[1], number: Number(match[2]) };
}

function dedup(issues) {
  const seen = new Set();
  return issues.filter(i => {
    if (seen.has(i.number)) return false;
    seen.add(i.number);
    return true;
  });
}

function shapeComment(comment) {
  if (!comment) return null;
  return {
    author: comment.user?.login || '',
    createdAt: comment.created_at || '',
    body: stripMarkdown(comment.body).slice(0, 240),
  };
}

function shape(issue, comments = [], linkedPRs = [], claim = null) {
  return {
    number: issue.number,
    title: issue.title,
    body: (issue.body || '').slice(0, 400),
    labels: issue.labels.map(l => l.name),
    url: issue.html_url,
    comments: issue.comments,
    updatedAt: issue.updated_at,
    createdAt: issue.created_at || '',
    author: issue.user?.login || '',
    assignees: (issue.assignees || []).map(user => user.login).filter(Boolean),
    latestComment: shapeComment(comments[comments.length - 1]),
    linkedPRs,
    claim: claim || detectClaim(issue, comments, linkedPRs),
    source: issue.source || '',
    sourceUrl: issue.sourceUrl || '',
    sourcePublishedAt: issue.sourcePublishedAt || '',
    repositoryLanguage: issue.repositoryLanguage || '',
    bitcoinArea: issue.bitcoinArea || '',
    bitcoinAreaLabel: issue.bitcoinAreaLabel || '',
    bitcoinAreaSource: issue.bitcoinAreaSource || '',
  };
}

async function scanRepos(repos = [], options = {}) {
  const results = [];
  const seedIssuesByRepo = options.seedIssuesByRepo || {};
  const mode = options.mode || 'prioritized';

  for (const repo of repos) {
    console.log(`  Scanning ${repo}...`);
    try {
      const result = await scanRepo(repo, {
        mode,
        seedIssues: seedIssuesByRepo[repo] || [],
      });
      console.log(`    → ${result.issues.length} issues (${result.labelSummary})`);
      results.push(result);
    } catch (error) {
      console.warn(`    → skipped ${repo}: ${error.message}`);
      results.push({
        repo,
        repoUrl: `https://github.com/${repo}`,
        overview: `Skipped: ${error.message}`,
        totalOpenIssues: 0,
        issues: [],
        recentPRs: [],
        labelSummary: 'skipped',
        error: error.message,
      });
    }
  }

  return results;
}

async function scanRepo(repo, options = {}) {
  const {
    mode = 'prioritized',
    seedIssues = [],
  } = options;

  const [repoDetails, recent, goodFirst, bugs, recentPRs, openIssues, seeded] = await Promise.all([
    fetchRepoDetails(repo),
    fetchRecentIssues(repo),
    fetchGoodFirstIssues(repo),
    fetchBugIssues(repo),
    fetchRecentPRActivity(repo),
    mode === 'all-open' ? fetchOpenIssues(repo, 50) : Promise.resolve([]),
    Promise.all(seedIssues.map(async seed => {
      const issue = await fetchIssueByNumber(repo, seed.number);
      if (!issue) return null;
      return {
        ...issue,
        source: seed.source || 'bitcoindevs',
        sourceUrl: seed.url || seed.sourceUrl || '',
        sourcePublishedAt: seed.publishedAt || '',
      };
    })),
  ]);

  const repositoryLanguage = repoDetails.language || '';
  const preferredLanguages = getPreferredLanguages();
  const languagePreferred = !preferredLanguages.length
    || preferredLanguages.includes(String(repositoryLanguage).toLowerCase());
  // Which part of the Bitcoin ecosystem this repo sits in. Ranking uses it to
  // favour the areas the contributor said they care about.
  const bitcoinArea = classifyRepo(repo);
  const decorateIssue = issue => ({
    ...issue,
    repositoryLanguage,
    languagePreferred,
    bitcoinArea: bitcoinArea.area,
    bitcoinAreaLabel: bitcoinArea.label,
    bitcoinAreaSource: bitcoinArea.source,
  });

  const sourceIssues = mode === 'all-open'
    ? openIssues
    : dedup([
      ...seeded.filter(Boolean),
      ...goodFirst.map(issue => ({ ...issue, source: issue.source || 'github-label' })),
      ...bugs.map(issue => ({ ...issue, source: issue.source || 'github-bug' })),
      ...recent.map(issue => ({ ...issue, source: issue.source || 'github-recent' })),
    ]).slice(0, 20);

  const merged = dedup(sourceIssues).slice(0, 20).map(decorateIssue);
  const issues = await Promise.all(merged.map(async issue => {
    const [comments, linkedPRs] = await Promise.all([
      fetchIssueComments(issue),
      fetchLinkedPullRequests(repo, issue.number).catch(() => []),
    ]);
    const claim = detectClaim(issue, comments, linkedPRs);
    return {
      ...shape(issue, comments, linkedPRs, claim),
      ...buildIssueInsight({ ...issue, claim, linkedPRs }, comments),
    };
  })).then(items => items.sort((a, b) => {
    const scoreDiff = Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  }));
  const labelSummary = [
    seedIssues.length ? `${seedIssues.length} BitcoinDevs` : '',
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

module.exports = {
  scanRepos,
  scanRepo,
  assertRepositoryAccessible,
  fetchIssueStatus,
  fetchLinkedPullRequests,
  fetchIssueFull,
  fetchAllIssueComments,
  fetchRepoDetails,
  fetchRepoFile,
  fetchContributingGuide,
  fetchPullRequestFiles,
  fetchPullRequestSnapshot,
  searchCode,
  parseIssueUrl,
};
