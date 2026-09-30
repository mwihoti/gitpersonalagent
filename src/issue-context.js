'use strict';

// Gathers everything a contributor would read before touching an issue: the
// full thread, linked pull requests, the contributing guide, and the source
// files the issue talks about. Output is plain data so it can be rendered,
// cached, or handed to the model.

const github = require('./github');
const { detectClaim, stripMarkdown } = require('./repo-insights');

const PATH_PATTERN = /(?:^|[\s(`'"<])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,6})(?=[\s)`'">.,;:]|$)/gi;
const BARE_FILE_PATTERN = /`([\w.-]+\.(?:rs|py|js|ts|tsx|go|c|h|cpp|hpp|kt|swift|java|md|toml|yml|yaml|json|sh|proto))`/gi;
const SYMBOL_PATTERN = /`([A-Za-z_][\w:.]*(?:\(\))?)`/g;
const IGNORED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'com', 'org', 'io', 'xyz', 'net']);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractPaths(text) {
  const found = [];
  for (const match of String(text || '').matchAll(PATH_PATTERN)) {
    const candidate = match[1];
    const ext = candidate.split('.').pop().toLowerCase();
    if (IGNORED_EXTENSIONS.has(ext)) continue;
    if (/^https?:|github\.com|\.\.\//i.test(candidate)) continue;
    found.push(candidate);
  }
  for (const match of String(text || '').matchAll(BARE_FILE_PATTERN)) {
    found.push(match[1]);
  }
  return unique(found).slice(0, 6);
}

function extractSymbols(text, paths = []) {
  const pathSet = new Set(paths);
  const found = [];
  for (const match of String(text || '').matchAll(SYMBOL_PATTERN)) {
    const raw = match[1].replace(/\(\)$/, '');
    if (raw.length < 4 || pathSet.has(raw) || /\.[a-z]{1,6}$/i.test(raw)) continue;
    // Identifiers look like snake_case, CamelCase, or Rust paths.
    if (!/_|::|[a-z][A-Z]|\./.test(raw)) continue;
    found.push(raw.split('::').pop().split('.').pop());
  }
  return unique(found).slice(0, 5);
}

function excerptAround(content, needle, options = {}) {
  const { before = 40, after = 80, maxChars = 3500 } = options;
  const lines = String(content || '').split('\n');
  let index = needle ? lines.findIndex(line => line.includes(needle)) : -1;
  if (index === -1) index = 0;
  const start = Math.max(0, index - before);
  const end = Math.min(lines.length, index + after);
  const slice = lines.slice(start, end).join('\n');
  return {
    startLine: start + 1,
    endLine: end,
    text: slice.length > maxChars ? `${slice.slice(0, maxChars)}\n…` : slice,
    matchedSymbol: index > 0 || (needle && lines[0] && lines[0].includes(needle)) ? needle : '',
  };
}

function shapeComment(comment) {
  return {
    id: comment.id,
    author: comment.user?.login || 'unknown',
    authorAssociation: comment.author_association || '',
    createdAt: comment.created_at || '',
    body: String(comment.body || '').slice(0, 1200),
    reactions: Number(comment.reactions?.total_count || 0),
  };
}

// Collect source files referenced in the issue or thread. Direct paths are
// fetched as-is; unresolved paths and symbols fall back to code search when a
// token is available.
async function collectFiles(repo, text, options = {}) {
  const { maxFiles = 4, defaultBranch = '', hintPaths = [], client = github } = options;
  const paths = extractPaths(text);
  const symbols = extractSymbols(text, paths);
  const files = [];
  const tried = new Set();

  const addFile = async (filePath, symbol = '', reason = '') => {
    if (files.length >= maxFiles || tried.has(filePath)) return false;
    tried.add(filePath);
    const file = await client.fetchRepoFile(repo, filePath, { ref: defaultBranch }).catch(() => null);
    if (!file) return false;
    // When a hint file is offered, only keep it if it actually mentions a symbol.
    const matched = symbol || symbols.find(candidate => file.content.includes(candidate)) || '';
    if (reason && !matched) return false;
    const excerpt = excerptAround(file.content, matched);
    files.push({
      path: file.path,
      url: file.url,
      reason: reason || (matched ? `mentions \`${matched}\`` : 'mentioned in the issue'),
      totalLines: file.content.split('\n').length,
      ...excerpt,
    });
    return true;
  };

  for (const filePath of paths) {
    await addFile(filePath);
  }

  // Files touched by a linked PR are the best hint for where the change lives.
  for (const hint of hintPaths) {
    if (files.length >= maxFiles) break;
    await addFile(hint.path, '', hint.reason);
  }

  const unresolved = paths.filter(filePath => !files.some(file => file.path === filePath));
  for (const filePath of unresolved.slice(0, 2)) {
    if (files.length >= maxFiles) break;
    const basename = filePath.split('/').pop();
    const hits = await client.searchCode(repo, `filename:${basename}`, { limit: 3 }).catch(() => []);
    if (hits[0]) await addFile(hits[0].path);
  }

  for (const symbol of symbols.slice(0, 3)) {
    if (files.length >= maxFiles) break;
    if (files.some(file => file.text.includes(symbol))) continue;
    const hits = await client.searchCode(repo, `"${symbol}"`, { limit: 3 }).catch(() => []);
    const hit = hits.find(item => !tried.has(item.path));
    if (hit) await addFile(hit.path, symbol);
  }

  return { files, paths, symbols };
}

async function buildIssueContext(repo, number, options = {}) {
  const {
    maxComments = 25,
    maxFiles = 4,
    includeFiles = true,
    includePullFiles = true,
    client = github,
  } = options;

  const [repoDetails, issue] = await Promise.all([
    client.fetchRepoDetails(repo),
    client.fetchIssueFull(repo, number),
  ]);

  const [rawComments, linkedPRs, contributing] = await Promise.all([
    client.fetchAllIssueComments(issue, { max: maxComments }),
    client.fetchLinkedPullRequests(repo, number).catch(() => []),
    client.fetchContributingGuide(repo).catch(() => null),
  ]);

  const comments = rawComments.map(shapeComment);
  const claim = detectClaim(issue, rawComments, linkedPRs);

  const pullRequests = [];
  for (const pr of linkedPRs.slice(0, 4)) {
    let files = [];
    if (includePullFiles && pr.sameRepo !== false && pr.state !== 'closed') {
      files = await client.fetchPullRequestFiles(repo, pr.number, { limit: 15 }).catch(() => []);
    }
    pullRequests.push({ ...pr, files });
  }

  const threadText = [issue.title, issue.body, ...rawComments.map(comment => comment.body)].join('\n');
  const hintPaths = [];
  for (const pr of pullRequests) {
    if (pr.sameRepo === false) continue;
    for (const file of pr.files || []) {
      if (hintPaths.length >= 6 || /\.(md|rst|txt|lock|json|yml|yaml)$/i.test(file.path)) continue;
      hintPaths.push({ path: file.path, reason: `touched by PR #${pr.number} (${pr.state})` });
    }
  }
  const sources = includeFiles
    ? await collectFiles(repo, threadText, { maxFiles, defaultBranch: repoDetails.default_branch || '', hintPaths, client })
    : { files: [], paths: [], symbols: [] };

  return {
    repo: {
      name: repoDetails.full_name || repo,
      url: repoDetails.html_url || `https://github.com/${repo}`,
      description: repoDetails.description || '',
      language: repoDetails.language || '',
      defaultBranch: repoDetails.default_branch || '',
      stars: repoDetails.stargazers_count || 0,
      topics: repoDetails.topics || [],
    },
    issue: {
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      body: String(issue.body || '').slice(0, 8000),
      bodyPlain: stripMarkdown(issue.body).slice(0, 600),
      labels: (issue.labels || []).map(label => label.name),
      author: issue.user?.login || '',
      authorAssociation: issue.author_association || '',
      assignees: (issue.assignees || []).map(user => user.login),
      state: issue.state,
      createdAt: issue.created_at || '',
      updatedAt: issue.updated_at || '',
      commentsCount: Number(issue.comments || 0),
      reactions: Number(issue.reactions?.total_count || 0),
      milestone: issue.milestone?.title || '',
    },
    comments,
    claim,
    pullRequests,
    contributing: contributing
      ? { path: contributing.path, url: contributing.url, text: contributing.content.slice(0, 4000) }
      : null,
    files: sources.files,
    mentionedPaths: sources.paths,
    mentionedSymbols: sources.symbols,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildIssueContext,
  collectFiles,
  excerptAround,
  extractPaths,
  extractSymbols,
};
