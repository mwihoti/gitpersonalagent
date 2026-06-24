'use strict';
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_ISSUES_URL = 'https://bitcoindevs.xyz/good-first-issues?sort=newest-first&page=1&labels=good+first+issue';
const DEFAULT_MAX_REPOS = 12;
const LOCAL_DATA_DIR = process.env.DAN_AGENT_DATA_DIR || (process.env.VERCEL
  ? path.join('/tmp', 'danagent-data')
  : path.join(__dirname, '..', 'data'));
const DISCOVERY_FILE = path.join(LOCAL_DATA_DIR, 'bitcoindevs-discoveries.json');
const DISCOVERY_LIMIT = 30;

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

async function ensureDiscoveryStore() {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
  try {
    await fs.access(DISCOVERY_FILE);
  } catch {
    await fs.writeFile(DISCOVERY_FILE, '[]\n', 'utf8');
  }
}

async function readBitcoinDevsDiscoveries() {
  await ensureDiscoveryStore();
  const raw = await fs.readFile(DISCOVERY_FILE, 'utf8');
  return JSON.parse(raw);
}

async function saveBitcoinDevsDiscovery(discovery) {
  await ensureDiscoveryStore();
  const existing = await readBitcoinDevsDiscoveries();
  const next = [{
    discoveredAt: discovery.discoveredAt || new Date().toISOString(),
    source: 'bitcoindevs',
    sourceUrl: discovery.sourceUrl || getIssuesUrl(),
    issues: discovery.issues || [],
    repos: discovery.repos || repositoriesFromIssues(discovery.issues || []),
  }, ...existing].slice(0, DISCOVERY_LIMIT);
  await fs.writeFile(DISCOVERY_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next[0];
}

async function fetchBitcoinDevsIssues(options = {}) {
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
  const repos = repositoriesFromIssues(issues, maxRepos);
  const repoSet = new Set(repos.map(repo => repo.toLowerCase()));
  return {
    discoveredAt: new Date().toISOString(),
    source: 'bitcoindevs',
    sourceUrl: url,
    repos,
    issues: issues.filter(issue => repoSet.has(issue.repo.toLowerCase())),
  };
}

async function fetchBitcoinDevsRepositories(options = {}) {
  const discovery = await fetchBitcoinDevsIssues(options);
  return discovery.repos;
}

module.exports = {
  DEFAULT_ISSUES_URL,
  fetchBitcoinDevsIssues,
  fetchBitcoinDevsRepositories,
  parseBitcoinDevsIssues,
  readBitcoinDevsDiscoveries,
  repositoriesFromIssues,
  saveBitcoinDevsDiscovery,
};
