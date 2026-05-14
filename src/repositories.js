'use strict';
const fs = require('fs/promises');
const path = require('path');

const LOCAL_DATA_DIR = process.env.DAN_AGENT_DATA_DIR || (process.env.VERCEL
  ? path.join('/tmp', 'danagent-data')
  : path.join(__dirname, '..', 'data'));
const LOCAL_REPOS_FILE = path.join(LOCAL_DATA_DIR, 'repositories.json');

function normalizeRepo(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';

  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/#?]+)/i);
  if (urlMatch) return urlMatch[1].replace(/\.git$/i, '');

  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : '';
}

async function ensureRepoStore() {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
  try {
    await fs.access(LOCAL_REPOS_FILE);
  } catch {
    await fs.writeFile(LOCAL_REPOS_FILE, '[]\n', 'utf8');
  }
}

async function readRepoStore() {
  await ensureRepoStore();
  const raw = await fs.readFile(LOCAL_REPOS_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeRepoStore(repos) {
  await ensureRepoStore();
  await fs.writeFile(LOCAL_REPOS_FILE, `${JSON.stringify(repos, null, 2)}\n`, 'utf8');
}

function shapeRepository(repo, index) {
  return {
    id: repo.id || `repo-${index}-${Buffer.from(repo.repo).toString('base64url').slice(0, 12)}`,
    repo: repo.repo,
    addedAt: repo.addedAt || '',
  };
}

async function listRepositories() {
  const rows = await readRepoStore();
  return rows
    .map(shapeRepository)
    .sort((a, b) => String(a.repo).localeCompare(String(b.repo)));
}

async function addRepository(input) {
  const repo = normalizeRepo(input);
  if (!repo) {
    throw new Error('Enter a valid GitHub repo URL or owner/repo value.');
  }

  const rows = await readRepoStore();
  const exists = rows.find(row => String(row.repo).toLowerCase() === repo.toLowerCase());
  if (exists) {
    return shapeRepository(exists);
  }

  const record = {
    id: `repo-${Date.now()}`,
    repo,
    addedAt: new Date().toISOString(),
  };
  rows.push(record);
  await writeRepoStore(rows);
  return shapeRepository(record);
}

async function removeRepository(id) {
  const rows = await readRepoStore();
  const next = rows.filter(row => row.id !== id);
  if (next.length === rows.length) {
    throw new Error(`Repository not found: ${id}`);
  }
  await writeRepoStore(next);
}

async function getScanRepositories() {
  const repos = await listRepositories();
  return repos.map(entry => entry.repo);
}

module.exports = {
  addRepository,
  getScanRepositories,
  listRepositories,
  normalizeRepo,
  removeRepository,
};
