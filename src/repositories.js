'use strict';
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { fetchBitcoinDevsIssues, saveBitcoinDevsDiscovery } = require('./bitcoindevs');
const { seedRepositories } = require('./bitcoin-ecosystem');
const { assertRepositoryAccessible } = require('./github');

const LOCAL_DATA_DIR = process.env.DAN_AGENT_DATA_DIR || (process.env.VERCEL
  ? path.join('/tmp', 'danagent-data')
  : path.join(__dirname, '..', 'data'));
const LOCAL_REPOS_FILE = path.join(LOCAL_DATA_DIR, 'repositories.json');
let writeQueue = Promise.resolve();

function mutateRepositories(task) {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return next;
}

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
    enabled: repo.enabled !== false,
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

  return mutateRepositories(async () => {
    const rows = await readRepoStore();
    const exists = rows.find(row => String(row.repo).toLowerCase() === repo.toLowerCase());
    if (exists) {
      return shapeRepository(exists);
    }

    await assertRepositoryAccessible(repo);

    const record = {
      id: `repo-${randomUUID()}`,
      repo,
      addedAt: new Date().toISOString(),
    };
    rows.push(record);
    await writeRepoStore(rows);
    return shapeRepository(record);
  });
}

async function removeRepository(id) {
  return mutateRepositories(async () => {
    const rows = await readRepoStore();
    const next = rows.filter(row => row.id !== id);
    if (next.length === rows.length) {
      throw new Error(`Repository not found: ${id}`);
    }
    await writeRepoStore(next);
  });
}

async function updateRepository(id, updates = {}) {
  if (typeof updates.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return mutateRepositories(async () => {
    const rows = await readRepoStore();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw new Error(`Repository not found: ${id}`);
    rows[index].enabled = updates.enabled;
    await writeRepoStore(rows);
    return shapeRepository(rows[index], index);
  });
}

function isBitcoinDevsDiscoveryEnabled() {
  return String(process.env.BITCOINDEVS_DISCOVERY || 'true').toLowerCase() !== 'false';
}

async function getScanRepositories() {
  const targets = await getScanTargets();
  return targets.repos;
}

async function getScanTargets() {
  const repos = await listRepositories();
  const savedRepos = repos.filter(entry => entry.enabled).map(entry => entry.repo);
  if (repos.length || !isBitcoinDevsDiscoveryEnabled()) {
    return {
      source: savedRepos.length ? 'watchlist' : 'none',
      sourceUrl: '',
      repos: savedRepos,
      issues: [],
    };
  }

  try {
    const discovery = await fetchBitcoinDevsIssues();
    const savedDiscovery = await saveBitcoinDevsDiscovery(discovery);
    if (savedDiscovery.repos.length) {
      console.log(`  Using ${savedDiscovery.repos.length} BitcoinDevs good-first-issue repos as scan targets`);
      return savedDiscovery;
    }
    // The board answered but had nothing today. Fall through to the catalogue
    // rather than returning an empty scan.
    console.warn('  BitcoinDevs returned no issues; using the curated Bitcoin ecosystem list');
  } catch (error) {
    console.warn(`  BitcoinDevs discovery skipped: ${error.message}`);
  }

  return bitcoinEcosystemTargets();
}

// Last resort, and the thing that makes a fresh install useful: a curated list
// of Bitcoin projects that actually take outside contributions. Before this,
// an empty watchlist plus an unreachable BitcoinDevs board meant a scan with
// nothing to scan.
function bitcoinEcosystemTargets() {
  const repos = seedRepositories(getEcosystemSeedLimit());
  if (repos.length) {
    console.log(`  Using ${repos.length} curated Bitcoin ecosystem repos as scan targets`);
  }
  return {
    source: repos.length ? 'bitcoin-ecosystem' : 'none',
    sourceUrl: '',
    repos,
    issues: [],
  };
}

function getEcosystemSeedLimit() {
  const parsed = Number.parseInt(process.env.BITCOIN_SEED_REPOS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}

module.exports = {
  addRepository,
  bitcoinEcosystemTargets,
  getScanRepositories,
  getScanTargets,
  listRepositories,
  normalizeRepo,
  removeRepository,
  updateRepository,
};
