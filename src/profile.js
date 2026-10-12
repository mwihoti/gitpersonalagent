'use strict';

// Who a subscriber is, as far as matching needs to know.
//
// Two sources, kept apart so neither overwrites the other:
//   github   read from the person's PUBLIC GitHub activity: languages in the
//            repositories they own, and the repositories they have merged pull
//            requests into. Refreshed whenever they run /github again.
//   manual   what they told the bot: /skills (languages, areas, keywords) and
//            /level.
//
// Nothing here needs the person to sign in or hand over a token. Only public
// data is read, and the stored profile holds derived facts (language shares,
// repository names with PR counts), not raw activity.

const github = require('./github');
const { AREAS, classifyRepo, normalizeArea } = require('./bitcoin-ecosystem');

const LANGUAGE_ALIASES = {
  rust: 'rust', rs: 'rust',
  go: 'go', golang: 'go',
  python: 'python', py: 'python',
  javascript: 'javascript', js: 'javascript', node: 'javascript', nodejs: 'javascript',
  typescript: 'typescript', ts: 'typescript',
  java: 'java', kotlin: 'kotlin', swift: 'swift',
  c: 'c', 'c++': 'c++', cpp: 'c++', 'c#': 'c#', csharp: 'c#',
  ruby: 'ruby', php: 'php', scala: 'scala', elixir: 'elixir', haskell: 'haskell',
  shell: 'shell', bash: 'shell', nix: 'nix', zig: 'zig', dart: 'dart', solidity: 'solidity',
  html: 'html', css: 'css', clarity: 'clarity', lua: 'lua',
};

const AREA_ALIASES = {
  ln: 'lightning', lightning: 'lightning', lnd: 'lightning', bolt: 'lightning',
  privacy: 'privacy', coinjoin: 'privacy', payjoin: 'privacy',
  docs: 'education', documentation: 'education', education: 'education', writing: 'education',
  ui: 'design', ux: 'design', design: 'design', frontend: 'design',
  l2: 'ecash', ecash: 'ecash', cashu: 'ecash', fedimint: 'ecash',
  mining: 'mining', stratum: 'mining',
  node: 'core', consensus: 'core', core: 'core',
  wallet: 'wallet', wallets: 'wallet', keys: 'wallet', signing: 'wallet',
  crypto: 'library', cryptography: 'library', library: 'library', libraries: 'library',
  payments: 'payments', merchant: 'payments', btcpay: 'payments',
  infra: 'infra', infrastructure: 'infra', explorer: 'infra', indexer: 'infra',
};

const STOPWORDS = new Set(['and', 'or', 'the', 'a', 'an', 'i', 'am', 'know', 'with', 'in', 'at', 'of', 'to', 'my', 'skills', 'skill', 'like', 'love', 'want', 'work', 'on']);
const LEVELS = ['newcomer', 'intermediate', 'experienced'];
const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeLanguage(name) {
  const key = String(name || '').trim().toLowerCase();
  return LANGUAGE_ALIASES[key] || key;
}

// "github.com/user", "https://github.com/user/repo", "@user" or "user".
function parseGitHubLogin(input) {
  let text = String(input || '').trim();
  const url = text.match(/github\.com\/([A-Za-z0-9-]+)/i);
  if (url) text = url[1];
  text = text.replace(/^@/, '').split(/[\s/?#]/)[0];
  return USERNAME_PATTERN.test(text) ? text : '';
}

function normalizeLevel(input) {
  const text = String(input || '').trim().toLowerCase();
  if (/^(new|newcomer|beginner|starter|first|junior|learning)/.test(text)) return 'newcomer';
  if (/^(inter|mid|some)/.test(text)) return 'intermediate';
  if (/^(exp|expert|senior|advanced|pro|lead)/.test(text)) return 'experienced';
  return '';
}

// Free text from /skills into languages, Bitcoin areas, and other keywords.
function parseSkills(text) {
  const languages = [];
  const areas = [];
  const keywords = [];
  const add = (list, value, max) => { if (value && !list.includes(value) && list.length < max) list.push(value); };

  for (const raw of String(text || '').toLowerCase().split(/[\s,;/|]+/)) {
    const token = raw.replace(/^#/, '').replace(/[.:!?]+$/, '');
    if (!token || STOPWORDS.has(token)) continue;
    if (LANGUAGE_ALIASES[token]) add(languages, LANGUAGE_ALIASES[token], 8);
    else if (AREA_ALIASES[token] || normalizeArea(token)) add(areas, AREA_ALIASES[token] || normalizeArea(token), 6);
    else if (/^[a-z0-9][a-z0-9+#._-]{1,29}$/.test(token)) add(keywords, token, 12);
  }
  return { languages, areas, keywords };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// Reads public GitHub data and derives language shares, the repositories the
// person has contributed to, an experience level, and Bitcoin areas.
async function buildGitHubProfile(login, options = {}) {
  const { client = github, now = Date.now() } = options;
  if (!USERNAME_PATTERN.test(String(login || ''))) {
    throw new ProfileError('invalid', 'That does not look like a GitHub username.');
  }

  let user;
  let repos;
  let merged;
  try {
    user = await client.fetchGitHubUser(login);
    if (!user) throw new ProfileError('not_found', `I could not find a GitHub user called ${login}.`);
    [repos, merged] = await Promise.all([client.fetchUserRepos(login), client.searchMergedPullRequests(login)]);
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    if (error.rateLimited) throw new ProfileError('rate_limited', 'GitHub is limiting requests right now. Try again in a few minutes.');
    throw error;
  }

  const weights = new Map();
  const add = (language, weight) => {
    const key = normalizeLanguage(language);
    if (key && weight > 0) weights.set(key, (weights.get(key) || 0) + weight);
  };

  // Languages of code they own. Recent and starred work counts more.
  for (const repo of repos) {
    if (repo.fork || repo.archived || !repo.language) continue;
    const years = (now - Date.parse(repo.pushed_at || repo.updated_at || 0)) / (365 * 86_400_000);
    const recency = years <= 1 ? 1 : years <= 3 ? 0.6 : 0.3;
    add(repo.language, recency * (1 + Math.log10(1 + (repo.stargazers_count || 0))));
  }

  // Repositories they have merged work into. A merged PR is stronger evidence
  // of skill than a repo they own, so these count three times as much.
  const contributions = new Map();
  for (const item of merged.items) {
    const repo = String(item.repository_url || '').replace('https://api.github.com/repos/', '').toLowerCase();
    if (repo) contributions.set(repo, (contributions.get(repo) || 0) + 1);
  }
  const ranked = [...contributions.entries()].sort((a, b) => b[1] - a[1]);
  const details = await mapLimit(ranked.slice(0, 12), 4, ([repo]) => client.fetchRepoDetails(repo).catch(() => null));
  ranked.slice(0, 12).forEach(([, count], index) => {
    if (details[index] && details[index].language) add(details[index].language, 3 * Math.min(count, 5));
  });

  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  const languages = {};
  [...weights.entries()]
    .map(([name, value]) => [name, total ? value / total : 0])
    .filter(([, share]) => share >= 0.04)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([name, share]) => { languages[name] = Math.round(share * 100) / 100; });

  // Areas and Bitcoin experience come only from projects the catalogue knows.
  // Guessing an area from a repository name is wrong too often ("nodeninja"
  // is not node infrastructure) and would put false claims in front of people.
  const areaCounts = new Map();
  let bitcoinPRs = 0;
  for (const [repo, count] of ranked) {
    const { area, source } = classifyRepo(repo);
    if (source !== 'catalog') continue;
    bitcoinPRs += count;
    if (area) areaCounts.set(area, (areaCounts.get(area) || 0) + count);
  }
  const areas = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([area]) => area);

  const mergedPRs = merged.total;
  return {
    login: user.login,
    name: user.name || '',
    publicRepos: user.public_repos || 0,
    languages,
    contributions: Object.fromEntries(ranked.slice(0, 25)),
    mergedPRs,
    bitcoinPRs,
    // Plenty of merged work elsewhere is not the same as knowing Bitcoin
    // projects, so "experienced" needs both.
    level: mergedPRs >= 10 && bitcoinPRs >= 3 ? 'experienced' : mergedPRs >= 1 ? 'intermediate' : 'newcomer',
    areas,
    fetchedAt: new Date(now).toISOString(),
  };
}

// The view matching works from: GitHub facts plus what the person declared.
function effectiveProfile(profile) {
  const auto = (profile && profile.github) || {};
  const manual = (profile && profile.manual) || {};
  const languages = new Map(Object.entries(auto.languages || {}).map(([name, share]) => [normalizeLanguage(name), share]));
  const declaredLanguages = new Set((manual.languages || []).map(normalizeLanguage));
  // Naming languages is a stronger statement than owning repos in them: the
  // named ones count fully, and what GitHub shows but the person did not name
  // counts for half.
  if (declaredLanguages.size) {
    for (const [name, share] of languages) if (!declaredLanguages.has(name)) languages.set(name, share / 2);
    for (const name of declaredLanguages) languages.set(name, Math.max(languages.get(name) || 0, 0.6));
  }

  const declaredAreas = new Set(manual.areas || []);
  const areas = new Set([...(auto.areas || []), ...declaredAreas]);
  const level = manual.level || auto.level || '';

  return {
    languages,
    declaredLanguages,
    areas,
    declaredAreas,
    keywords: manual.keywords || [],
    level,
    contributions: new Map(Object.entries(auto.contributions || {})),
    github: auto.login || '',
    mergedPRs: auto.mergedPRs || 0,
    bitcoinPRs: auto.bitcoinPRs || 0,
    hasSignal: Boolean(languages.size || areas.size || (manual.keywords || []).length || level),
  };
}

function hasProfile(profile) {
  return effectiveProfile(profile).hasSignal;
}

// Plain-text lines describing the profile (the bot adds its own markup).
function describeProfile(profile) {
  const eff = effectiveProfile(profile);
  const lines = [];
  if (eff.github) {
    const bitcoin = eff.bitcoinPRs ? ` (${eff.bitcoinPRs} in Bitcoin projects)` : '';
    lines.push(`GitHub: ${eff.github}${eff.mergedPRs ? `, ${eff.mergedPRs} merged pull request${eff.mergedPRs === 1 ? '' : 's'} in other projects${bitcoin}` : ''}`);
  }
  const langs = [...eff.languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (langs.length) {
    lines.push(`Languages: ${langs.map(([name, share]) => (eff.declaredLanguages.has(name) && !(profile.github && profile.github.languages && profile.github.languages[name]) ? name : `${name} ${Math.round(share * 100)}%`)).join(', ')}`);
  }
  if (eff.areas.size) lines.push(`Areas: ${[...eff.areas].map(area => (AREAS[area] ? AREAS[area].label : area)).join(', ')}`);
  if (eff.keywords.length) lines.push(`Also interested in: ${eff.keywords.join(', ')}`);
  if (eff.level) lines.push(`Level: ${eff.level}${profile && profile.manual && profile.manual.level ? ' (set by you)' : ''}`);
  const familiar = [...eff.contributions.entries()].slice(0, 4);
  if (familiar.length) lines.push(`You have merged work in: ${familiar.map(([repo, count]) => `${repo} (${count})`).join(', ')}`);
  return lines;
}

module.exports = {
  LEVELS,
  ProfileError,
  buildGitHubProfile,
  describeProfile,
  effectiveProfile,
  hasProfile,
  normalizeLanguage,
  normalizeLevel,
  parseGitHubLogin,
  parseSkills,
};
