'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { effectiveProfile } = require('../src/profile');
const { liveMatches, matchIssue, matchableProjects, rankForProfile, suggestRepositories } = require('../src/matching');

const eff = (profile) => effectiveProfile(profile);
const rustDev = eff({ github: { login: 'ada', languages: { rust: 0.6, go: 0.2 }, areas: ['privacy'], contributions: { 'payjoin/rust-payjoin': 3 }, mergedPRs: 3, level: 'intermediate' } });

const issue = (overrides = {}) => ({ number: 1, title: 'Some work', repo: 'payjoin/rust-payjoin', repositoryLanguage: 'Rust', labels: ['bug'], issueFitScore: 60, issueComplexity: 'Medium', bitcoinArea: 'privacy', ...overrides });

test('language, area, and familiarity raise the score and explain why', () => {
  const result = matchIssue(issue(), rustDev);
  // +18 rust (60% share), +8 area from merged work, +11 familiarity = +37.
  // Blended with the generic score of 60: 60 * 0.55 + (50 + 37) * 0.45 = 72.
  assert.equal(result.delta, 37);
  assert.equal(result.score, 72);
  assert.equal(result.reasons.length, 3);
  assert.match(result.reasons[0], /Rust is 60% of your public code/);
  assert.ok(result.reasons.some(text => /3 merged pull requests in payjoin\/rust-payjoin/.test(text)));
  assert.ok(result.reasons.some(text => /Privacy is where you have contributed/.test(text)));
});

test('a language the person does not use lowers the score, except for documentation work', () => {
  const python = matchIssue(issue({ repo: 'a/b', repositoryLanguage: 'Python', bitcoinArea: '', labels: ['bug'] }), rustDev);
  assert.equal(python.delta, -12);
  assert.deepEqual(python.reasons, []);
  const docs = matchIssue(issue({ repo: 'a/b', repositoryLanguage: 'Python', bitcoinArea: '', labels: ['documentation'] }), rustDev);
  assert.equal(docs.delta, 0, 'docs do not need the language');
  assert.equal(matchIssue(issue({ repositoryLanguage: '' , repo: 'a/b', bitcoinArea: '' }), rustDev).delta, 0, 'unknown language is neutral');
});

test('difficulty depends on level: starters for newcomers, meatier work for experienced people', () => {
  const profile = level => eff({ github: { languages: { rust: 0.6 } }, manual: { level } });
  const starter = issue({ repo: 'x/y', bitcoinArea: '', labels: ['good first issue'], issueComplexity: 'Quick win' });
  const hard = issue({ repo: 'x/y', bitcoinArea: '', labels: [], issueComplexity: 'Complex' });

  assert.ok(matchIssue(starter, profile('newcomer')).score > matchIssue(starter, profile('experienced')).score);
  assert.ok(matchIssue(hard, profile('experienced')).score > matchIssue(hard, profile('newcomer')).score);
  assert.match(matchIssue(starter, profile('newcomer')).reasons.join(' '), /good first issue, which suits where you are/);
  const deep = issue({ repo: 'bitcoin/bitcoin', bitcoinArea: 'core', repositoryLanguage: 'C++', labels: [] });
  assert.ok(matchIssue(deep, eff({ manual: { level: 'newcomer' } })).delta < 0, 'consensus code is a stretch for a newcomer');
});

test('declared areas and keywords steer the result, and the score stays in range', () => {
  const profile = eff({ manual: { areas: ['lightning'], keywords: ['mempool', 'taproot', 'psbt'] } });
  const hit = matchIssue(issue({ repo: 'lightningnetwork/lnd', repositoryLanguage: 'Go', bitcoinArea: 'lightning', title: 'Taproot channel mempool bug' }), profile);
  assert.match(hit.reasons.join(' '), /Lightning is an area you chose/);
  assert.match(hit.reasons.join(' '), /mentions "mempool" and "taproot"/);
  assert.ok(matchIssue(issue({ bitcoinArea: 'privacy', repo: 'payjoin/rust-payjoin', repositoryLanguage: '' }), profile).delta < 0, 'outside a chosen area');
  // Scores blend instead of adding, so strong matches stay apart rather than all hitting 100.
  const strong = matchIssue(issue({ issueFitScore: 100 }), rustDev).score;
  const decent = matchIssue(issue({ issueFitScore: 70 }), rustDev).score;
  const weak = matchIssue(issue({ issueFitScore: 2, repo: 'a/b', repositoryLanguage: 'Python', bitcoinArea: '' }), rustDev).score;
  assert.ok(strong < 100 && strong > decent && decent > weak, `${strong} > ${decent} > ${weak}`);
  assert.ok(weak >= 1 && weak < 25);
});

test('ranking skips claimed issues, caps each repo, drops negative fits, and orders by personal score', () => {
  const pool = [
    { repo: 'payjoin/rust-payjoin', issues: [issue({ number: 1 }), issue({ number: 2, issueFitScore: 55 }), issue({ number: 3, issueFitScore: 50 }), issue({ number: 4, claim: { claimed: true }, issueFitScore: 99 })] },
    { repo: 'lightningnetwork/lnd', issues: [issue({ number: 10, repo: 'lightningnetwork/lnd', repositoryLanguage: 'Go', bitcoinArea: 'lightning', issueFitScore: 70 })] },
    { repo: 'a/rs', issues: [issue({ number: 20, repo: 'a/rs', repositoryLanguage: 'Rust', bitcoinArea: '', issueFitScore: 80, detailChecked: false })] },
    { repo: 'a/py', issues: [issue({ number: 30, repo: 'a/py', repositoryLanguage: 'Python', bitcoinArea: '', issueFitScore: 99 })] },
  ];

  const ranked = rankForProfile(pool, rustDev, { limit: 10 });

  assert.deepEqual(ranked.map(item => item.number), [20, 1, 2, 10]);
  assert.ok(!ranked.some(item => item.number === 4), 'claimed issues are never offered');
  assert.ok(!ranked.some(item => item.number === 30), 'a language they do not use is not offered, however good the issue');
  assert.equal(ranked.filter(item => item.repo === 'payjoin/rust-payjoin').length, 2, 'two per repository');
  assert.equal(ranked.find(item => item.number === 20).verified, false);
  assert.equal(rankForProfile(pool, rustDev, { limit: 2 }).length, 2);
  assert.deepEqual(rankForProfile(null, rustDev), []);
  assert.equal(rankForProfile(pool, rustDev, { limit: 10, minDelta: -100 }).some(item => item.number === 30), true, 'the filter can be turned off');
});

test('a stale claim is offered with a warning, a live one is not offered at all', () => {
  const stale = { claimed: false, stale: true, reason: 'bob offered to take it 3mo ago but no PR followed; likely abandoned, ask before starting' };
  const ranked = rankForProfile([{ repo: 'payjoin/rust-payjoin', issues: [
    issue({ number: 1, claim: stale }),
    issue({ number: 2, claim: { claimed: true, reason: 'open PR #9 by bob' } }),
    issue({ number: 3 }),
  ] }], rustDev, { limit: 5 });

  assert.deepEqual(ranked.map(item => item.number).sort(), [1, 3]);
  assert.match(ranked.find(item => item.number === 1).caution, /no PR followed/);
  assert.equal(ranked.find(item => item.number === 3).caution, '');
});

test('repository suggestions favour known languages, areas, and projects you have worked in', () => {
  const repos = ['lightningnetwork/lnd', 'rust-bitcoin/rust-bitcoin', 'payjoin/rust-payjoin', 'jamaljsr/polar'];
  assert.deepEqual(suggestRepositories(repos, rustDev, 2), ['payjoin/rust-payjoin', 'rust-bitcoin/rust-bitcoin']);
  assert.deepEqual(suggestRepositories(repos, eff({}), 3), repos.slice(0, 3), 'no profile keeps the incoming order');
  assert.equal(suggestRepositories(['a/b', 'a/b', 'c/d'], rustDev, 5).length, 2, 'duplicates collapse');
});

test('live matching reads the best repos closely and only offers verified issues', async () => {
  const scanned = [];
  const result = await liveMatches({ github: { languages: { rust: 0.7 }, areas: [], contributions: {}, level: 'newcomer' } }, {
    projects: ['payjoin/rust-payjoin', 'rust-bitcoin/rust-bitcoin', 'lightningnetwork/lnd', 'broken/repo'],
    repoCount: 3,
    limit: 3,
    scan: async (repo, options) => {
      scanned.push([repo, options.mode, options.detail]);
      if (repo === 'lightningnetwork/lnd') throw new Error('boom');
      return { repo, issues: [issue({ number: 5, repo, detailChecked: true }), issue({ number: 6, repo, detailChecked: false, issueFitScore: 99 })] };
    },
  });

  assert.deepEqual(scanned.map(row => row[0]).sort(), ['lightningnetwork/lnd', 'payjoin/rust-payjoin', 'rust-bitcoin/rust-bitcoin']);
  assert.ok(scanned.every(row => row[1] === 'all-open' && row[2] === 12));
  assert.equal(result.scanned, 2, 'a failed repo is skipped, not fatal');
  assert.ok(result.matches.length >= 2 && result.matches.every(match => match.verified && match.number === 5));
});

test('matchable projects combine the page and the catalogue, and are cached', async () => {
  let calls = 0;
  const discover = async () => { calls += 1; return { repos: ['new/project', 'lightningnetwork/lnd'] }; };
  const first = await matchableProjects({ discover, now: 9e15 });
  const second = await matchableProjects({ discover, now: 9e15 + 1000 });

  assert.equal(first[0], 'new/project');
  assert.equal(first.filter(repo => repo === 'lightningnetwork/lnd').length, 1, 'no duplicates');
  assert.ok(first.length > 10, 'the catalogue is included');
  assert.equal(second, first);
  assert.equal(calls, 1);

  const afterExpiry = await matchableProjects({ discover: async () => { throw new Error('down'); }, now: 9e15 + 4_000_000 });
  assert.ok(afterExpiry.length > 10 && !afterExpiry.includes('new/project'), 'when the page is down the catalogue still works');
});
