'use strict';

const DEFAULT_ISSUES_URL = 'https://bitcoindevs.xyz/good-first-issues?sort=newest-first&page=1&labels=good+first+issue';
const DEFAULT_MAX_REPOS = 12;

function getIssuesUrl() {
  return process.env.BITCOINDEVS_ISSUES_URL || DEFAULT_ISSUES_URL;
}

function getMaxRepos() {
  const parsed = Number.parseInt(process.env.BITCOINDEVS_MAX_REPOS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REPOS;
}

function unescapeHydrationPayload(html) {
  return String(html || '')
    .replace(/\\"/g, '"')
    .replace(/\\u002F/g, '/')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>');
}

function extractString(record, field) {
  const match = record.match(new RegExp(`"${field}":"([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function extractLabels(record) {
  const match = record.match(/"labels":\[(.*?)\]/i);
  if (!match) return [];
  return Array.from(match[1].matchAll(/"([^"]+)"/g), item => item[1]);
}

function issueKey(issue) {
  return `${issue.repo}#${issue.number}`;
}

function parseBitcoinDevsIssues(html, options = {}) {
  const {
    requiredLabel = 'good first issue',
  } = options;
  const normalized = unescapeHydrationPayload(html);
  const records = normalized.match(/\{(?=[^{}]*"url":"https:\/\/github\.com\/)[^{}]+\}/g) || [];
  const issues = new Map();

  for (const record of records) {
    const url = extractString(record, 'url');
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    if (!match) continue;

    const labels = extractLabels(record);
    if (requiredLabel) {
      const hasRequiredLabel = labels.some(label => label.toLowerCase() === requiredLabel.toLowerCase());
      if (!hasRequiredLabel) continue;
    }

    const issue = {
      repo: `${match[1]}/${match[2]}`,
      number: Number(match[3]),
      title: extractString(record, 'title'),
      url,
      publishedAt: extractString(record, 'publishedAt'),
      labels,
    };
    issues.set(issueKey(issue), issue);
  }

  return Array.from(issues.values()).sort((a, b) => {
    const dateDiff = String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
    if (dateDiff !== 0) return dateDiff;
    return b.number - a.number;
  });
}

function repositoriesFromIssues(issues, limit = getMaxRepos()) {
  const repos = [];
  const seen = new Set();

  for (const issue of issues) {
    const key = issue.repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(issue.repo);
    if (repos.length >= limit) break;
  }

  return repos;
}

async function fetchBitcoinDevsRepositories(options = {}) {
  const url = options.url || getIssuesUrl();
  const maxRepos = options.maxRepos || getMaxRepos();
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'danagent-bitcoindevs-scan/1.0',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`BitcoinDevs issue discovery failed: ${res.status}`);
  }

  const html = await res.text();
  const issues = parseBitcoinDevsIssues(html);
  return repositoriesFromIssues(issues, maxRepos);
}

module.exports = {
  DEFAULT_ISSUES_URL,
  fetchBitcoinDevsRepositories,
  parseBitcoinDevsIssues,
  repositoriesFromIssues,
};
