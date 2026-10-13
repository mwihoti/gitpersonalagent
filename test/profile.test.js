'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProfileError, buildGitHubProfile, describeProfile, effectiveProfile, hasProfile, normalizeLevel, parseGitHubLogin, parseSkills,
} = require('../src/profile');

const NOW = Date.parse('2026-10-12T00:00:00Z');

test('parseSkills sorts languages, Bitcoin areas, and keywords, with aliases', () => {
  const parsed = parseSkills('Rust, golang and TS; lightning, payjoin, docs #taproot  psbt c++');
  assert.deepEqual(parsed.languages, ['rust', 'go', 'typescript', 'c++']);
  assert.deepEqual(parsed.areas, ['lightning', 'privacy', 'education']);
  assert.deepEqual(parsed.keywords, ['taproot', 'psbt']);
  assert.deepEqual(parseSkills(''), { languages: [], areas: [], keywords: [] });
  assert.equal(parseSkills('x'.repeat(80)).keywords.length, 0, 'long junk is not a keyword');
  assert.equal(parseSkills(Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')).keywords.length, 12, 'keywords are capped');
});

test('GitHub usernames are read from names, @handles, and links, and bad input is rejected', () => {
  assert.equal(parseGitHubLogin('/github mwihoti'.replace('/github ', '')), 'mwihoti');
  assert.equal(parseGitHubLogin('@Some-User'), 'Some-User');
  assert.equal(parseGitHubLogin('https://github.com/payjoin/rust-payjoin'), 'payjoin');
  assert.equal(parseGitHubLogin('github.com/ab-c?tab=repos'), 'ab-c');
  assert.equal(parseGitHubLogin(''), '');
  assert.equal(parseGitHubLogin('-leading'), '');
  assert.equal(parseGitHubLogin('a'.repeat(40)), '');
  assert.equal(parseGitHubLogin('bad name!'), 'bad');
});

test('levels accept the words people actually use', () => {
  assert.equal(normalizeLevel('Beginner'), 'newcomer');
  assert.equal(normalizeLevel('new'), 'newcomer');
  assert.equal(normalizeLevel('mid'), 'intermediate');
  assert.equal(normalizeLevel('Senior'), 'experienced');
  assert.equal(normalizeLevel('wizard'), '');
});

function fakeClient(overrides = {}) {
  const repo = (language, extra = {}) => ({ language, fork: false, archived: false, stargazers_count: 0, pushed_at: '2026-08-01T00:00:00Z', ...extra });
  return {
    fetchGitHubUser: async login => ({ login, name: 'Ada', public_repos: 9 }),
    fetchUserRepos: async () => [
      repo('Rust', { stargazers_count: 40 }), repo('Rust'),
      repo('TypeScript', { pushed_at: '2021-01-01T00:00:00Z' }),
      repo('Python', { fork: true }), repo('Go', { archived: true }), repo(null),
    ],
    searchMergedPullRequests: async () => ({
      total: 12,
      items: [
        ...Array.from({ length: 3 }, () => ({ repository_url: 'https://api.github.com/repos/payjoin/rust-payjoin' })),
        { repository_url: 'https://api.github.com/repos/lightningnetwork/lnd' },
      ],
    }),
    fetchRepoDetails: async repo => ({ language: repo.startsWith('lightningnetwork') ? 'Go' : 'Rust' }),
    ...overrides,
  };
}

test('a GitHub profile weighs owned code, merged work, areas, and level', async () => {
  const profile = await buildGitHubProfile('ada', { client: fakeClient(), now: NOW });

  assert.equal(profile.login, 'ada');
  assert.equal(profile.mergedPRs, 12);
  assert.equal(profile.level, 'experienced');
  assert.deepEqual(Object.keys(profile.languages)[0], 'rust');
  assert.ok(profile.languages.go > 0, 'merged work in a Go repo counts');
  assert.ok(!profile.languages.python, 'forks are ignored');
  const sum = Object.values(profile.languages).reduce((a, b) => a + b, 0);
  assert.ok(sum > 0.95 && sum <= 1.02, `shares sum to about 1 (${sum})`);
  assert.deepEqual(Object.entries(profile.contributions)[0], ['payjoin/rust-payjoin', 3]);
  assert.ok(profile.areas.includes('privacy') && profile.areas.includes('lightning'));
  assert.equal(profile.fetchedAt, '2026-10-12T00:00:00.000Z');
});

test('level needs merged work elsewhere and in Bitcoin projects before it says experienced', async () => {
  const bitcoin = n => Array.from({ length: n }, () => ({ repository_url: 'https://api.github.com/repos/lightningnetwork/lnd' }));
  const levelOf = async (total, items) => (await buildGitHubProfile('x', {
    now: NOW,
    client: fakeClient({ searchMergedPullRequests: async () => ({ total, items }) }),
  })).level;

  assert.equal(await levelOf(0, []), 'newcomer');
  assert.equal(await levelOf(3, []), 'intermediate');
  assert.equal(await levelOf(40, []), 'intermediate', 'lots of merged work elsewhere, none in Bitcoin projects');
  assert.equal(await levelOf(40, bitcoin(2)), 'intermediate');
  assert.equal(await levelOf(40, bitcoin(3)), 'experienced');
  assert.equal(await levelOf(5, bitcoin(5)), 'intermediate', 'few merged pull requests overall');
});

test('areas and Bitcoin experience come only from catalogued projects, never from a name guess', async () => {
  const profile = await buildGitHubProfile('x', {
    now: NOW,
    client: fakeClient({
      searchMergedPullRequests: async () => ({
        total: 6,
        items: [
          { repository_url: 'https://api.github.com/repos/demilade111/nodeninja' },
          { repository_url: 'https://api.github.com/repos/demilade111/nodeninja' },
          { repository_url: 'https://api.github.com/repos/payjoin/rust-payjoin' },
        ],
      }),
    }),
  });
  assert.deepEqual(profile.areas, ['privacy']);
  assert.equal(profile.bitcoinPRs, 1);
});

test('profile building fails clearly for unknown users, bad names, and rate limits', async () => {
  await assert.rejects(() => buildGitHubProfile('ghost', { client: fakeClient({ fetchGitHubUser: async () => null }) }), error => error instanceof ProfileError && error.code === 'not_found');
  await assert.rejects(() => buildGitHubProfile('bad name'), error => error.code === 'invalid');
  const limited = Object.assign(new Error('limit'), { rateLimited: true });
  await assert.rejects(() => buildGitHubProfile('ada', { client: fakeClient({ searchMergedPullRequests: async () => { throw limited; } }) }), error => error.code === 'rate_limited');
});

test('declared skills strengthen GitHub facts without replacing them', async () => {
  const github = await buildGitHubProfile('ada', { client: fakeClient(), now: NOW });
  const profile = { github, manual: { languages: ['zig'], areas: ['mining'], keywords: ['taproot'], level: 'newcomer' } };
  const eff = effectiveProfile(profile);

  assert.equal(eff.languages.get('zig'), 0.6, 'a named language counts fully even with no public code');
  assert.ok(Math.abs(eff.languages.get('rust') - github.languages.rust / 2) < 1e-9, 'GitHub languages the person did not name count for half');
  assert.ok(eff.areas.has('mining') && eff.areas.has('privacy'));
  assert.ok(eff.declaredAreas.has('mining') && !eff.declaredAreas.has('privacy'));
  assert.equal(eff.level, 'newcomer', 'a declared level wins over the derived one');
  assert.equal(eff.contributions.get('payjoin/rust-payjoin'), 3);
  assert.equal(hasProfile(profile), true);
  assert.equal(hasProfile({}), false);
  assert.equal(hasProfile(null), false);

  const lines = describeProfile(profile);
  assert.match(lines[0], /GitHub: ada, 12 merged pull requests/);
  assert.ok(lines.some(line => /^Languages: .*rust \d+%/.test(line)));
  assert.ok(lines.some(line => /^Level: newcomer \(set by you\)/.test(line)));
  assert.ok(lines.some(line => /payjoin\/rust-payjoin \(3\)/.test(line)));
});
