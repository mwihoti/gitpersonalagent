'use strict';
const { preferredAreas } = require('./bitcoin-ecosystem');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripMarkdown(value) {
  return normalizeWhitespace(
    String(value || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/^>+/gm, ' ')
      .replace(/^#+\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
  );
}

function splitSentences(value) {
  return stripMarkdown(value)
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function truncate(value, max = 220) {
  const text = normalizeWhitespace(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function uniqueLines(lines, max = 3) {
  const seen = new Set();
  const result = [];

  for (const line of lines) {
    const normalized = normalizeWhitespace(line).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(truncate(line));
    if (result.length >= max) break;
  }

  return result;
}

function collectSignalLines(issue, comments) {
  const sources = [
    ...splitSentences(issue.body),
    ...comments.flatMap(comment => splitSentences(comment.body)),
  ];

  const priority = sources.filter(line => (
    /should|need|needs|expected|goal|followup|follow-up|todo|implement|support|document|fix|test|reproduce|alert|dashboard/i.test(line)
  ));

  return uniqueLines(priority.length ? priority : sources, 4);
}

function inferExpectation(issue, comments) {
  const labels = new Set((issue.labels || []).map(label => String(label).toLowerCase()));
  const text = `${issue.title}\n${issue.body}\n${comments.map(comment => comment.body).join('\n')}`;
  const cleaned = stripMarkdown(text);

  if (labels.has('bug')) {
    return 'Reproduce the bug and identify the cause. Add a regression test where possible, then fix the affected code.';
  }

  if (labels.has('documentation') || labels.has('docs') || /\bdocs?\b|dashboard/i.test(cleaned)) {
    return 'Update the docs to explain the behavior. Add an example or screenshot if it helps.';
  }

  if (/alert|anomaly|monitor|metric|grafana|prometheus/i.test(cleaned)) {
    return 'Define the metric or alert the issue asks for. Add it to the existing monitoring code and check the output.';
  }

  if (/sequence diagram|visuali[sz]e|dashboard|description/i.test(cleaned)) {
    return 'Confirm what the view should show, implement it, and explain how to read it.';
  }

  if (labels.has('enhancement') || labels.has('help wanted') || labels.has('good first issue')) {
    return 'Confirm the requested behavior, make the change, and include steps to test it.';
  }

  return 'Check the issue and discussion for requirements. Ask about anything unclear before starting.';
}

function inferQuickPlan(issue, comments) {
  const signalLines = collectSignalLines(issue, comments);
  const firstSignal = signalLines[0] || truncate(issue.title);
  const labels = new Set((issue.labels || []).map(label => String(label).toLowerCase()));

  const steps = [
    `Check the issue and related files for this requirement: ${firstSignal}`,
  ];

  if (labels.has('bug')) {
    steps.push('Reproduce the failure locally or with a focused test so you can verify the fix.');
  } else {
    steps.push('Find the code or docs that describe this behavior.');
  }

  steps.push('Make the change and check it against the requirements in the discussion.');
  steps.push('Run the project checks. Include any needed tests or docs, and explain the change in your pull request.');

  return steps.slice(0, 4);
}

function summarizeConversation(issue, comments) {
  const signalLines = collectSignalLines(issue, comments);
  if (!signalLines.length) {
    return 'The issue body gives the main request, but there is not enough discussion yet to infer extra maintainer context.';
  }

  if (!comments.length) {
    return `The issue is mostly defined by the original report: ${signalLines.slice(0, 2).join(' ')}`;
  }

  return signalLines.slice(0, 3).join(' ');
}

function describeProject(repo) {
  const topics = (repo.topics || []).slice(0, 4);
  const parts = [];

  if (repo.description) {
    parts.push(repo.description);
  } else {
    parts.push(`${repo.full_name || repo.name} is a GitHub project without a repo description yet.`);
  }

  if (repo.language) {
    parts.push(`Primary language: ${repo.language}.`);
  }

  if (topics.length) {
    parts.push(`Focus areas: ${topics.join(', ')}.`);
  }

  return parts.join(' ');
}

function shapeConversation(comment) {
  return {
    author: comment.user?.login || 'unknown',
    createdAt: comment.created_at || '',
    body: truncate(stripMarkdown(comment.body), 240),
  };
}

function buildRepoOverview(repo) {
  return {
    name: repo.full_name || repo.name || '',
    url: repo.html_url || '',
    description: repo.description || '',
    projectSummary: describeProject(repo),
    language: repo.language || '',
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    openIssues: repo.open_issues_count || 0,
    topics: repo.topics || [],
  };
}

function daysSince(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 365;
  const diff = Date.now() - date.getTime();
  return Math.max(0, Math.round(diff / 86400000));
}

function scoreFromRange(value, ranges) {
  for (const range of ranges) {
    if (value <= range.max) return range.score;
  }
  return ranges[ranges.length - 1].score;
}

const CLAIM_PATTERN = /\b(i(?:'|’)?ll (?:take(?!\s+a\s+(?:quick\s+|closer\s+|second\s+)?(?:look|peek|glance))|pick|work|do|handle|open|start|give)|i(?:'|’)?d like to (?:take|pick|work|try|handle)|i (?:can|could|would like to|want to|plan to) (?:take|pick|work|try|handle|do)|(?:would (?:like|love)|want|happy) to \w+ on (?:this|it)\b|(?:i am|i(?:'|’)?m) (?:working|going to work|on it)|working on (?:this|it|a fix|a pr|a patch)|pick(?:ing)? this up|take this (?:one|issue|on)|(?:please )?assign (?:this |it )?(?:to )?me|opened? (?:a )?(?:pr|pull request)|(?:have|got) (?:a|an) (?:open )?(?:branch|pr|patch|draft)|(?:branch|pr|patch) (?:should|will|would) (?:close|fix|resolve) this|should close this issue)\b|https?:\/\/github\.com\/[^\s)]+\/tree\//i;

function isBotLogin(login) {
  return /\[bot\]$|-bot$|^dependabot|^renovate/i.test(String(login || ''));
}

// Detects whether somebody already owns this issue: an assignee, an open
// linked PR, or a comment that reads like "I'll take this".
//
// A comment-only claim goes stale: someone who said "I'll take this" months
// ago and never opened a PR has usually moved on. Those come back as
// { claimed: false, stale: true } so the issue stays available, with a note
// to ask before starting.
function claimTtlDays() {
  const value = Number(process.env.CLAIM_TTL_DAYS);
  return Number.isFinite(value) && value > 0 ? value : 45;
}

function ageLabel(days) {
  if (days < 60) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function detectClaim(issue, comments = [], linkedPRs = [], options = {}) {
  const now = options.now || Date.now();
  const assignees = (issue.assignees || [])
    .map(user => (typeof user === 'string' ? user : user?.login))
    .filter(Boolean);
  if (assignees.length) {
    return { claimed: true, reason: `assigned to ${assignees.join(', ')}`, by: assignees[0], prUrl: '' };
  }

  const openPR = linkedPRs.find(pr => pr.state === 'open' && pr.sameRepo !== false);
  if (openPR) {
    return {
      claimed: true,
      reason: `open PR #${openPR.number}${openPR.author ? ` by ${openPR.author}` : ''}`,
      by: openPR.author || '',
      prUrl: openPR.url || '',
    };
  }

  const author = issue.user?.login || '';
  for (const comment of [...comments].reverse()) {
    const login = comment.user?.login || '';
    if (!login || login === author || isBotLogin(login)) continue;
    const text = stripMarkdown(comment.body);
    if (CLAIM_PATTERN.test(text)) {
      const stamp = new Date(comment.created_at || comment.createdAt || '').getTime();
      const days = Number.isNaN(stamp) ? 0 : Math.floor((now - stamp) / 86400000);
      if (days > claimTtlDays()) {
        return {
          claimed: false,
          stale: true,
          reason: `${login} offered to take it ${ageLabel(days)} but no PR followed; likely abandoned, ask before starting`,
          by: login,
          prUrl: '',
        };
      }
      return { claimed: true, reason: `${login} said they are working on it`, by: login, prUrl: '' };
    }
  }

  return { claimed: false, reason: '', by: '', prUrl: '' };
}

// Rank by where the repo sits in the Bitcoin ecosystem.
//
// With BITCOIN_FOCUS_AREAS set (e.g. `lightning,privacy`) a contributor stops
// being shown consensus C++ when what they wanted was Lightning. With it
// unset, being a known Bitcoin project is still a mild positive — that is the
// whole point of this tool.
//
// An area we only *guessed* from the repo name gets half the weight of one we
// know from the catalogue, so a repo called "lightning-dashboard" that has
// nothing to do with Bitcoin cannot dominate the queue.
function scoreBitcoinArea(issue, reasons) {
  const area = issue.bitcoinArea || '';
  if (!area) return 0;

  const certain = issue.bitcoinAreaSource === 'catalog';
  const label = issue.bitcoinAreaLabel || area;
  const focus = preferredAreas();

  if (!focus.length) {
    const points = certain ? 6 : 3;
    if (certain) reasons.push(`${label} is a known Bitcoin ecosystem project`);
    return points;
  }

  // Only three reasons are shown, so when the contributor has stated a focus
  // the area is one of the first things they need to see — unshift, don't
  // push. Claim and merged-PR reasons unshift later and still land ahead of
  // this, which is the right order.
  if (focus.includes(area)) {
    const points = certain ? 14 : 7;
    reasons.unshift(`${label} matches your focus areas`);
    return points;
  }

  // Outside the stated focus. Penalise, but never hard enough to bury a
  // genuinely great issue — the contributor may still want to see it.
  reasons.unshift(`${label} sits outside your focus areas`);
  return certain ? -6 : -3;
}

function buildIssueFitScore(issue, comments = []) {
  const labels = new Set((issue.labels || []).map(label => String(label).toLowerCase()));
  const text = stripMarkdown(`${issue.title}\n${issue.body}\n${comments.map(comment => comment.body).join('\n')}`);
  const reasons = [];
  let score = 50;

  if (labels.has('good first issue')) {
    score += 18;
    reasons.push('good first issue label suggests an easier onboarding path');
  }
  if (labels.has('help wanted')) {
    score += 12;
    reasons.push('help wanted label signals maintainer openness to external contributions');
  }
  if (labels.has('bug')) {
    score += 10;
    reasons.push('bug fixes tend to have clear user value');
  }
  if (labels.has('documentation') || labels.has('docs')) {
    score += 8;
    reasons.push('documentation issues are often faster to scope and ship');
  }
  if (labels.has('enhancement')) {
    score += 4;
    reasons.push('enhancement work can be valuable when the scope is narrow');
  }

  const commentsCount = Number(issue.comments || 0);
  const commentScore = scoreFromRange(commentsCount, [
    { max: 0, score: 2 },
    { max: 2, score: 6 },
    { max: 5, score: 9 },
    { max: 20, score: 5 },
  ]);
  score += commentScore;
  if (commentScore >= 6) {
    reasons.push('discussion exists, so the expected outcome is easier to infer');
  }

  const ageDays = daysSince(issue.updated_at || issue.updatedAt);
  const recencyScore = scoreFromRange(ageDays, [
    { max: 7, score: 10 },
    { max: 21, score: 7 },
    { max: 60, score: 4 },
    { max: 3650, score: 1 },
  ]);
  score += recencyScore;
  if (recencyScore >= 7) {
    reasons.push('recent activity suggests the issue is still active');
  }

  const bodyLength = stripMarkdown(issue.body).length;
  const bodyScore = scoreFromRange(bodyLength, [
    { max: 80, score: 2 },
    { max: 500, score: 8 },
    { max: 1200, score: 5 },
    { max: 100000, score: 1 },
  ]);
  score += bodyScore;
  if (bodyScore >= 8) {
    reasons.push('the issue description has enough detail to estimate the work');
  }

  if (/\btest|docs?|example|typo|logging|metric|dashboard|alert|refactor\b/i.test(text)) {
    score += 8;
    reasons.push('the requested change looks scoped enough for a fast contribution');
  }

  if (/\banomaly detection|call-stack|contract testing|architecture|sequence diagram|design a system\b/i.test(text)) {
    score -= 8;
    reasons.push('the request likely needs deeper design work before coding starts');
  }

  if (issue.source === 'bitcoindevs') {
    score += 12;
    reasons.push('BitcoinDevs curated this as an open-source contribution candidate');
  }

  score += scoreBitcoinArea(issue, reasons);

  if (issue.languagePreferred === false) {
    score -= 10;
    reasons.push(`repo language ${issue.repositoryLanguage || 'unknown'} is outside the preferred language filter`);
  }

  if (bodyLength < 40 && commentsCount === 0) {
    score -= 8;
    reasons.push('the issue is light on detail and may need clarification before coding');
  }

  if (/note: please don't just throw your llm/i.test(text)) {
    score -= 6;
    reasons.push('the issue explicitly warns that deeper human investigation is required');
  }

  if (issue.claim && issue.claim.claimed) {
    score -= 30;
    reasons.unshift(`someone already owns this: ${issue.claim.reason}`);
  } else if (issue.claim && issue.claim.stale) {
    reasons.unshift(issue.claim.reason);
  }

  const mergedPRs = (issue.linkedPRs || []).filter(pr => pr.state === 'merged' && pr.sameRepo !== false);
  if (mergedPRs.length && !(issue.claim && issue.claim.claimed)) {
    score -= 10;
    reasons.unshift(`PR #${mergedPRs[0].number} for this was already merged; check what is left to do`);
  }

  const normalizedScore = Math.max(1, Math.min(100, score));
  let band = 'Low fit';
  if (normalizedScore >= 75) band = 'High fit';
  else if (normalizedScore >= 55) band = 'Medium fit';

  let complexity = 'Complex';
  if (normalizedScore >= 68) complexity = 'Quick win';
  else if (normalizedScore >= 50) complexity = 'Medium';

  let recommendation = 'Avoid for first pass';
  if (issue.claim && issue.claim.claimed) recommendation = 'Avoid for first pass';
  else if (normalizedScore >= 60) recommendation = 'Recommended first PR';
  else if (normalizedScore >= 50) recommendation = 'Worth considering';

  return {
    issueFitScore: normalizedScore,
    issueFitLabel: band,
    issueFitReason: truncate(reasons.slice(0, 3).join('. '), 260),
    issueComplexity: complexity,
    issueRecommendation: recommendation,
  };
}

function buildIssueInsight(issue, comments = []) {
  const recentConversation = comments.slice(-3).map(shapeConversation);

  return {
    ...buildIssueFitScore(issue, comments),
    conversationSummary: summarizeConversation(issue, comments),
    expectationSummary: inferExpectation(issue, comments),
    quickPlan: inferQuickPlan(issue, comments),
    recentConversation,
    claim: issue.claim || detectClaim(issue, comments, issue.linkedPRs || []),
  };
}

module.exports = {
  detectClaim,
  buildIssueInsight,
  buildRepoOverview,
  buildIssueFitScore,
  stripMarkdown,
};
