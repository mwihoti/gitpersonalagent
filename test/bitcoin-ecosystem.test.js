'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  AREAS,
  BITCOIN_PROJECTS,
  areaSummary,
  classifyRepo,
  findProject,
  listProjects,
  normalizeArea,
  seedRepositories,
} = require('../src/bitcoin-ecosystem');

function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('every catalogue entry is well formed and uniquely listed', () => {
  const seen = new Set();
  for (const project of BITCOIN_PROJECTS) {
    assert.match(project.repo, /^[\w.-]+\/[\w.-]+$/, `bad repo: ${project.repo}`);
    assert.ok(AREAS[project.area], `unknown area on ${project.repo}: ${project.area}`);
    assert.ok(['newcomer', 'intermediate', 'deep'].includes(project.level), `bad level on ${project.repo}`);
    assert.ok(project.language, `missing language on ${project.repo}`);
    assert.ok(project.blurb.length > 20, `blurb too thin on ${project.repo}`);

    const key = project.repo.toLowerCase();
    assert.ok(!seen.has(key), `duplicate entry: ${project.repo}`);
    seen.add(key);
  }
});

test('every declared area has at least one project', () => {
  for (const entry of areaSummary()) {
    assert.ok(entry.projectCount > 0, `area "${entry.area}" has no projects`);
  }
});

test('normalizeArea accepts the key and the human label, and rejects junk', () => {
  assert.strictEqual(normalizeArea('lightning'), 'lightning');
  assert.strictEqual(normalizeArea('  Lightning  '), 'lightning');
  assert.strictEqual(normalizeArea('Wallets & keys'), 'wallet');
  assert.strictEqual(normalizeArea('nonsense'), '');
  assert.strictEqual(normalizeArea(''), '');
});

test('classifyRepo knows catalogue repos exactly and infers the rest', () => {
  const known = classifyRepo('bitcoin/bitcoin');
  assert.strictEqual(known.area, 'core');
  assert.strictEqual(known.source, 'catalog');

  // Case should not matter — GitHub repo names are case-insensitive in practice.
  assert.strictEqual(classifyRepo('BITCOIN/BITCOIN').source, 'catalog');

  const guessed = classifyRepo('someone/lnurl-tipjar');
  assert.strictEqual(guessed.area, 'lightning');
  assert.strictEqual(guessed.source, 'inferred');

  const unknown = classifyRepo('acme/crm-dashboard');
  assert.strictEqual(unknown.area, '');
  assert.strictEqual(unknown.source, 'unknown');
});

test('findProject is case-insensitive and returns null for strangers', () => {
  assert.strictEqual(findProject('LightningNetwork/LND').repo, 'lightningnetwork/lnd');
  assert.strictEqual(findProject('acme/nope'), null);
});

test('listProjects filters by area, language, and level', () => {
  const privacy = listProjects({ area: 'privacy' });
  assert.ok(privacy.length >= 1);
  assert.ok(privacy.every(project => project.area === 'privacy'));

  const rust = listProjects({ language: 'Rust' });
  assert.ok(rust.every(project => project.language === 'Rust'));

  const newcomer = listProjects({ level: 'newcomer' });
  assert.ok(newcomer.every(project => project.level === 'newcomer'));

  assert.strictEqual(listProjects({ limit: 3 }).length, 3);
});

test('seedRepositories spreads across areas instead of draining one', () => {
  const repos = withEnv({ BITCOIN_FOCUS_AREAS: undefined, PREFERRED_LANGUAGES: undefined },
    () => seedRepositories(8));

  assert.strictEqual(repos.length, 8);
  assert.strictEqual(new Set(repos).size, 8, 'seed list repeated a repo');

  const areas = new Set(repos.map(repo => classifyRepo(repo).area));
  assert.ok(areas.size >= 6, `expected a spread of areas, got ${[...areas].join(',')}`);
});

test('seedRepositories honours a focus area', () => {
  const repos = withEnv({ BITCOIN_FOCUS_AREAS: 'lightning', PREFERRED_LANGUAGES: undefined },
    () => seedRepositories(5));

  assert.ok(repos.length > 0);
  assert.ok(repos.every(repo => findProject(repo).area === 'lightning'));
});

test('seedRepositories honours a language filter', () => {
  const repos = withEnv({ BITCOIN_FOCUS_AREAS: undefined, PREFERRED_LANGUAGES: 'Rust' },
    () => seedRepositories(6));

  assert.ok(repos.length > 0);
  assert.ok(repos.every(repo => findProject(repo).language === 'Rust'));
});

test('an over-narrow filter still returns repos rather than an empty scan', () => {
  // Nothing in the catalogue is Lightning AND Haskell. An empty result here
  // would mean a scan with no targets, which is the bug this module exists to
  // prevent — so it must widen instead.
  const repos = withEnv({ BITCOIN_FOCUS_AREAS: 'lightning', PREFERRED_LANGUAGES: 'Haskell' },
    () => seedRepositories(4));

  assert.ok(repos.length > 0, 'seed list collapsed to nothing');
  assert.ok(repos.every(repo => findProject(repo).area === 'lightning'),
    'widening should drop the language filter before the focus area');
});

test('seedRepositories never returns more than the catalogue holds', () => {
  const repos = withEnv({ BITCOIN_FOCUS_AREAS: undefined, PREFERRED_LANGUAGES: undefined },
    () => seedRepositories(500));
  assert.strictEqual(repos.length, BITCOIN_PROJECTS.length);
});
