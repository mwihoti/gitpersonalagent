'use strict';

// Closed-loop learning from what actually happened to past recommendations.
//
// Every tracked record carries an outcome we can read off its fields and
// activity log: claimed, dismissed (with a reason), PR opened, merged, ignored.
// Those outcomes become weights per repo, label, language, effort and source,
// which then (a) nudge the heuristic fit score and (b) give the model a short
// "contributor profile" so its picks match what this person actually ships.

const OUTCOME_WEIGHTS = {
  merged: 3,
  pr_opened: 2,
  claimed: 1.5,
  dismissed: -2,
  // Never looking at an item is not a judgement about its repo or labels.
  // A backlog nobody triaged used to read as "skips these repos".
  ignored: 0,
};

const DISMISS_REASONS = {
  big: 'too big',
  stack: 'not my stack',
  taken: 'already taken',
  meh: 'not interesting',
};

const IGNORED_AFTER_DAYS = 21;
const MAX_ADJUSTMENT = 12;

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function parseLabels(value) {
  if (Array.isArray(value)) return value.map(normalizeKey).filter(Boolean);
  return String(value || '').split(',').map(normalizeKey).filter(Boolean);
}

// Reads the outcome of one record. Order matters: a merged PR beats "done",
// an explicit dismissal beats a plain "done".
function deriveOutcome(record, now = Date.now()) {
  const log = String(record.activityLog || '');
  const status = String(record.status || '');
  const dismissMatch = log.match(/dismissed(?: by [^\n(]+)?(?:\s*\((?<reason>[^)]+)\))?/i);
  const reasonMatch = log.match(/\[dismiss reason:\s*(?<reason>[^\]]+)\]/i);

  if (/\[outcome merged\]/i.test(log) || /\bmerged\b/i.test(status)) {
    return { outcome: 'merged', reason: '' };
  }
  // Closed upstream or auto-archived by the bot: says nothing about taste.
  if (/\[outcome (?:archived|closed-upstream)\]/i.test(log)) {
    return { outcome: 'archived', reason: '' };
  }
  if (reasonMatch || (dismissMatch && /done|closed|dropped|skip/i.test(status))) {
    const reason = normalizeKey((reasonMatch && reasonMatch.groups.reason) || (dismissMatch && dismissMatch.groups && dismissMatch.groups.reason) || '');
    return { outcome: 'dismissed', reason };
  }
  if (record.prUrl) {
    return { outcome: /done|complete|shipped/i.test(status) ? 'merged' : 'pr_opened', reason: '' };
  }
  if (/progress|active|doing|working/i.test(status) || record.owner) {
    return { outcome: 'claimed', reason: '' };
  }
  if (/done|closed|complete|dropped|skip/i.test(status)) {
    return { outcome: 'dismissed', reason: '' };
  }
  const stamp = new Date(record.lastUpdated || record.date || '').getTime();
  if (!Number.isNaN(stamp) && now - stamp > IGNORED_AFTER_DAYS * 86400000) {
    return { outcome: 'ignored', reason: '' };
  }
  return { outcome: 'pending', reason: '' };
}

function bump(map, key, delta) {
  const k = normalizeKey(key);
  if (!k) return;
  map.set(k, (map.get(k) || 0) + delta);
}

// records: normalized rows from airtable.listOpportunities()
function buildPreferenceModel(records = [], options = {}) {
  const now = options.now || Date.now();
  const repos = new Map();
  const labels = new Map();
  const efforts = new Map();
  const sources = new Map();
  const languages = new Map();
  const counts = { merged: 0, pr_opened: 0, claimed: 0, dismissed: 0, ignored: 0, archived: 0, pending: 0 };
  const dismissReasons = new Map();

  for (const record of records) {
    const { outcome, reason } = deriveOutcome(record, now);
    counts[outcome] = (counts[outcome] || 0) + 1;
    const weight = OUTCOME_WEIGHTS[outcome] || 0;
    if (!weight) continue;

    bump(repos, record.repo, weight);
    bump(efforts, record.effort, weight);
    bump(sources, record.source, weight);
    bump(languages, record.language, weight);
    for (const label of parseLabels(record.labels)) bump(labels, label, weight);

    if (outcome === 'dismissed' && reason) {
      bump(dismissReasons, reason, 1);
      // Reasons carry targeted signal beyond the generic penalty.
      if (/big/.test(reason)) bump(efforts, record.effort, -2);
      if (/stack/.test(reason)) {
        bump(languages, record.language, -3);
        bump(repos, record.repo, -1);
      }
    }
  }

  const positive = counts.merged + counts.pr_opened + counts.claimed;
  const negative = counts.dismissed;
  return {
    repos,
    labels,
    efforts,
    sources,
    languages,
    counts,
    dismissReasons,
    // Confidence grows with evidence; a handful of outcomes should not swing rankings hard.
    confidence: Math.min(1, (positive + negative) / 12),
    sampleSize: positive + negative,
  };
}

function toAdjustment(weight, confidence) {
  if (!weight) return 0;
  return Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, Math.round(weight * 2.5 * confidence)));
}

// Score delta and human-readable reasons for one issue.
function scoreAdjustment(model, issue) {
  if (!model || !model.sampleSize) return { delta: 0, reasons: [] };
  const reasons = [];
  let delta = 0;

  const repoW = model.repos.get(normalizeKey(issue.repo)) || 0;
  const repoAdj = toAdjustment(repoW, model.confidence);
  if (repoAdj) {
    delta += repoAdj;
    reasons.push(repoAdj > 0 ? `you have shipped or claimed work in ${issue.repo}` : `you tend to skip ${issue.repo}`);
  }

  let labelW = 0;
  for (const label of parseLabels(issue.labels)) labelW += model.labels.get(label) || 0;
  const labelAdj = toAdjustment(labelW / 2, model.confidence);
  if (labelAdj) {
    delta += labelAdj;
    reasons.push(labelAdj > 0 ? 'labels match what you usually take' : 'labels match what you usually dismiss');
  }

  const effortAdj = toAdjustment((model.efforts.get(normalizeKey(issue.effort || issue.issueComplexity)) || 0) / 2, model.confidence);
  if (effortAdj) delta += effortAdj;

  const langAdj = toAdjustment((model.languages.get(normalizeKey(issue.repositoryLanguage)) || 0) / 2, model.confidence);
  if (langAdj) {
    delta += langAdj;
    if (langAdj < 0) reasons.push(`${issue.repositoryLanguage} is outside what you pick up`);
  }

  return { delta: Math.max(-2 * MAX_ADJUSTMENT, Math.min(2 * MAX_ADJUSTMENT, delta)), reasons: reasons.slice(0, 2) };
}

function applyPreferences(repoData = [], model) {
  if (!model || !model.sampleSize) return repoData;
  return repoData.map(repo => ({
    ...repo,
    issues: (repo.issues || []).map(issue => {
      const { delta, reasons } = scoreAdjustment(model, { ...issue, repo: repo.repo });
      if (!delta) return issue;
      const score = Math.max(1, Math.min(100, Number(issue.issueFitScore || 0) + delta));
      return {
        ...issue,
        issueFitScore: score,
        preferenceDelta: delta,
        issueFitReason: [issue.issueFitReason, ...reasons].filter(Boolean).join('. ').slice(0, 320),
      };
    }).sort((a, b) => Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0)),
  }));
}

function topEntries(map, sign, limit = 3) {
  return [...map.entries()]
    .filter(([, weight]) => (sign > 0 ? weight > 0 : weight < 0))
    .sort((a, b) => (sign > 0 ? b[1] - a[1] : a[1] - b[1]))
    .slice(0, limit)
    .map(([key]) => key);
}

// Short natural-language profile for the digest prompt.
function summarizePreferences(model) {
  if (!model || !model.sampleSize) return '';
  const c = model.counts;
  const lines = [
    `Track record: ${c.merged} merged, ${c.pr_opened} PRs open, ${c.claimed} claimed, ${c.dismissed} dismissed, ${c.ignored} ignored.`,
  ];
  const likedRepos = topEntries(model.repos, 1);
  const avoidRepos = topEntries(model.repos, -1);
  const likedLabels = topEntries(model.labels, 1);
  const avoidLabels = topEntries(model.labels, -1);
  const avoidLangs = topEntries(model.languages, -1, 2);
  if (likedRepos.length) lines.push(`Ships in: ${likedRepos.join(', ')}.`);
  if (avoidRepos.length) lines.push(`Skips: ${avoidRepos.join(', ')}.`);
  if (likedLabels.length) lines.push(`Takes: ${likedLabels.join(', ')} issues.`);
  if (avoidLabels.length) lines.push(`Dismisses: ${avoidLabels.join(', ')} issues.`);
  if (avoidLangs.length) lines.push(`Avoids languages: ${avoidLangs.join(', ')}.`);
  const reasons = [...model.dismissReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (reasons.length) lines.push(`Common dismissal reasons: ${reasons.map(([r, n]) => `${r} (${n})`).join(', ')}.`);
  return lines.join(' ');
}

// Compact stats for the dashboard.
function describePreferences(model) {
  if (!model) return null;
  return {
    counts: model.counts,
    sampleSize: model.sampleSize,
    confidence: Math.round(model.confidence * 100),
    boostedRepos: topEntries(model.repos, 1, 5),
    penalizedRepos: topEntries(model.repos, -1, 5),
    likedLabels: topEntries(model.labels, 1, 5),
    dislikedLabels: topEntries(model.labels, -1, 5),
    dismissReasons: Object.fromEntries(model.dismissReasons),
    summary: summarizePreferences(model),
  };
}

module.exports = {
  DISMISS_REASONS,
  applyPreferences,
  buildPreferenceModel,
  deriveOutcome,
  describePreferences,
  scoreAdjustment,
  summarizePreferences,
};
