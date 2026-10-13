'use strict';

// Fit between a person and an issue.
//
// An issue already carries a generic fit score (clear, active, welcoming, not
// taken). Matching adds what is specific to the reader: do they know the
// language, work in this area, already have merged work in this project, and
// is the difficulty right for where they are. The adjustments are bounded, so
// a bad profile cannot bury a genuinely good issue and a good one cannot
// promote a dead issue. Claimed issues are never offered.

const { AREAS, BITCOIN_PROJECTS, classifyRepo, findProject } = require('./bitcoin-ecosystem');
const { normalizeLanguage, effectiveProfile } = require('./profile');

const DOCS_LABELS = new Set(['documentation', 'docs', 'doc', 'typo']);

function labelList(issue) {
  return (issue.labels || [])
    .map(label => String(typeof label === 'string' ? label : (label && label.name) || '').toLowerCase().trim())
    .filter(Boolean);
}

function titleCase(value) {
  return String(value || '').replace(/(^|[\s-])([a-z])/g, (_, lead, letter) => `${lead}${letter.toUpperCase()}`);
}

const LANGUAGE_LABELS = { rust: 'Rust', go: 'Go', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', 'c++': 'C++', 'c#': 'C#', c: 'C', java: 'Java', kotlin: 'Kotlin', swift: 'Swift', nix: 'Nix', shell: 'Shell' };
const languageLabel = name => LANGUAGE_LABELS[name] || titleCase(name);

// Score one issue for one person. `eff` comes from effectiveProfile().
function matchIssue(issue, eff, context = {}) {
  const repo = String(issue.repo || context.repo || '').toLowerCase();
  const labels = labelList(issue);
  const parts = [];
  const add = (points, text) => { if (points) parts.push({ points, text }); };

  // Language: the clearest signal of whether they could do the work today.
  const language = normalizeLanguage(issue.repositoryLanguage || (findProject(repo) || {}).language);
  const docsWork = labels.some(label => DOCS_LABELS.has(label));
  if (eff.languages.size && language) {
    const share = eff.languages.get(language) || 0;
    if (share >= 0.08) {
      const declared = eff.declaredLanguages.has(language);
      add(Math.round(18 * Math.min(1, share / 0.4)),
        declared ? `${languageLabel(language)} is one of your skills` : `${languageLabel(language)} is ${Math.round(share * 100)}% of your public code`);
    } else if (!docsWork) {
      add(-12, '');
    }
  }

  // Area the person works in. Declared areas count for more than inferred ones.
  const area = issue.bitcoinArea || classifyRepo(repo).area;
  if (area && eff.areas.has(area)) {
    add(eff.declaredAreas.has(area) ? 14 : 8, `${AREAS[area].label} is ${eff.declaredAreas.has(area) ? 'an area you chose' : 'where you have contributed'}`);
  } else if (area && eff.declaredAreas.size) {
    add(-5, '');
  }

  // Familiarity: maintainers there have already merged their work.
  const merged = eff.contributions.get(repo) || 0;
  if (merged) add(Math.min(14, 8 + merged), `you have ${merged} merged pull request${merged === 1 ? '' : 's'} in ${issue.repo || context.repo}`);

  // Difficulty. Newcomers need approachable work; experienced people are
  // better served by meatier issues than another typo.
  const goodFirst = labels.includes('good first issue');
  const project = findProject(repo);
  const complexity = String(issue.issueComplexity || '').toLowerCase();
  if (eff.level === 'newcomer') {
    if (goodFirst) add(8, 'labelled good first issue, which suits where you are');
    if (project && project.level === 'deep') add(-10, '');
    if (complexity === 'complex') add(-10, '');
  } else if (eff.level === 'intermediate') {
    if (goodFirst) add(2, '');
    if (project && project.level === 'deep') add(-3, '');
    if (complexity === 'complex') add(-3, '');
  } else if (eff.level === 'experienced') {
    if (goodFirst) add(-4, '');
    if (complexity === 'complex') add(4, 'a bigger piece of work than a starter issue');
  }

  // Words the person asked for.
  const haystack = `${issue.title || ''} ${labels.join(' ')} ${repo}`.toLowerCase();
  const hits = (eff.keywords || []).filter(word => haystack.includes(word)).slice(0, 2);
  if (hits.length) add(6 * hits.length, `mentions ${hits.map(word => `"${word}"`).join(' and ')}`);

  const delta = parts.reduce((sum, part) => sum + part.points, 0);
  const base = Number(issue.issueFitScore) || 50;
  // Blend the generic score with the personal one instead of adding them. A
  // sum saturates at 100 and ranks everything the same; the blend keeps good
  // issues apart (about 20 to 97).
  return {
    score: Math.max(1, Math.min(100, Math.round(base * 0.55 + (50 + delta) * 0.45))),
    delta,
    reasons: parts.filter(part => part.points > 0 && part.text).sort((a, b) => b.points - a.points).slice(0, 3).map(part => part.text),
  };
}

// pool: [{ repo, issues: [...] }] as the scan produces it.
function rankForProfile(pool, profile, options = {}) {
  // minDelta 0 keeps out anything that is a negative fit (a language they do
  // not use, work too deep for a newcomer): better to say "nothing today" than
  // to offer an issue they cannot do.
  const { limit = Number(process.env.PROFILE_MATCH_LIMIT) || 5, perRepo = 2, minDelta = 0 } = options;
  const eff = profile && profile.languages instanceof Map ? profile : effectiveProfile(profile);

  const scored = [];
  for (const entry of pool || []) {
    for (const issue of entry.issues || []) {
      if (issue.claim && issue.claim.claimed) continue;
      const fit = matchIssue({ ...issue, repo: entry.repo }, eff, { repo: entry.repo });
      if (fit.delta < minDelta) continue;
      scored.push({
        repo: entry.repo,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: labelList(issue),
        effort: String(issue.issueComplexity || '').toLowerCase(),
        updatedAt: issue.updatedAt || '',
        score: fit.score,
        reasons: fit.reasons,
        verified: issue.detailChecked !== false,
        // A claim nobody followed up on is not a block, but the person should know.
        caution: issue.claim && issue.claim.stale ? issue.claim.reason : '',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const counts = new Map();
  const out = [];
  for (const item of scored) {
    const key = item.repo.toLowerCase();
    if ((counts.get(key) || 0) >= perRepo) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// Which repositories are worth looking in for this person, best first.
function suggestRepositories(repos, profile, limit = 5) {
  const eff = profile && profile.languages instanceof Map ? profile : effectiveProfile(profile);
  const scored = [...new Set(repos)].map((repo, index) => {
    const key = repo.toLowerCase();
    const project = findProject(key);
    const language = normalizeLanguage(project ? project.language : '');
    const area = classifyRepo(key).area;
    let points = 0;
    if (language && eff.languages.size) points += 40 * Math.min(1, (eff.languages.get(language) || 0) / 0.4);
    if (area && eff.areas.has(area)) points += eff.declaredAreas.has(area) ? 25 : 15;
    if (eff.contributions.get(key)) points += 25;
    if (project && eff.level === 'newcomer') points += project.level === 'newcomer' ? 10 : project.level === 'deep' ? -10 : 0;
    return { repo, points, index };
  });
  // Ties keep the incoming order, which lists the most active projects first.
  scored.sort((a, b) => b.points - a.points || a.index - b.index);
  return scored.slice(0, limit).map(entry => entry.repo);
}

let projectCache = { at: 0, repos: null };

// The catalogue plus whatever the BitcoinDevs page currently lists.
async function matchableProjects(options = {}) {
  const { discover = require('./bitcoindevs').fetchBitcoinDevsIssues, now = Date.now() } = options;
  if (projectCache.repos && now - projectCache.at < 3_600_000) return projectCache.repos;
  let discovered = [];
  try {
    discovered = (await discover()).repos || [];
  } catch {
    discovered = [];
  }
  const repos = [...new Set([...discovered, ...BITCOIN_PROJECTS.map(project => project.repo)])];
  projectCache = { at: now, repos };
  return repos;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

// On-demand matches without a scan: list the most promising repositories,
// read their best issues closely, then rank those for this person.
async function liveMatches(profile, deps = {}) {
  const {
    scan = require('./github').scanRepo,
    projects = await matchableProjects(),
    limit = Number(process.env.PROFILE_MATCH_LIMIT) || 5,
    repoCount = 5,
    detail = 12,
  } = deps;
  const eff = effectiveProfile(profile);
  const repos = suggestRepositories(projects, eff, repoCount);
  const results = await mapLimit(repos, 3, repo => scan(repo, { mode: 'all-open', detail }).catch(() => null));
  const pool = results.filter(Boolean).map(result => ({
    repo: result.repo,
    // Only issues that were read closely, so a claim in the thread is not missed.
    issues: (result.issues || []).filter(issue => issue.detailChecked),
  }));
  return {
    repos,
    scanned: pool.length,
    issueCount: pool.reduce((sum, entry) => sum + entry.issues.length, 0),
    matches: rankForProfile(pool, eff, { limit, perRepo: 2 }),
  };
}

module.exports = {
  labelList,
  liveMatches,
  matchIssue,
  matchableProjects,
  rankForProfile,
  suggestRepositories,
};
