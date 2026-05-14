'use strict';

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
    return 'Reproduce the bug, isolate the root cause, add or update a failing test if possible, then ship the smallest safe fix.';
  }

  if (labels.has('documentation') || labels.has('docs') || /\bdocs?\b|dashboard/i.test(cleaned)) {
    return 'Clarify the current behavior in docs, add concrete examples or screenshots where useful, and make the explanation easy for a first-time user to follow.';
  }

  if (/alert|anomaly|monitor|metric|grafana|prometheus/i.test(cleaned)) {
    return 'Add the missing metric or alert logic, define what signal should be emitted, and make it observable through existing dashboards or tests.';
  }

  if (/sequence diagram|visuali[sz]e|dashboard|description/i.test(cleaned)) {
    return 'Turn the raw data into something understandable: define the expected output, produce a first usable view, and document how a user should interpret it.';
  }

  if (labels.has('enhancement') || labels.has('help wanted') || labels.has('good first issue')) {
    return 'Implement a scoped improvement that matches the issue description, keep the change narrow, and include validation steps so maintainers can review it quickly.';
  }

  return 'Read the issue carefully, confirm the intended outcome from the discussion, then implement the smallest complete change that resolves the request.';
}

function inferQuickPlan(issue, comments) {
  const signalLines = collectSignalLines(issue, comments);
  const firstSignal = signalLines[0] || truncate(issue.title);
  const labels = new Set((issue.labels || []).map(label => String(label).toLowerCase()));

  const steps = [
    `Read the issue and related files, then restate the target outcome: ${firstSignal}`,
  ];

  if (labels.has('bug')) {
    steps.push('Reproduce the failure locally or with a focused test so you can verify the fix.');
  } else {
    steps.push('Locate the existing code path or docs section that owns this behavior and map the smallest change surface.');
  }

  steps.push('Implement the first narrow version, then compare it against the issue description and comment thread.');
  steps.push('Run the relevant project checks, update docs/tests if needed, and open a PR that explains the before/after behavior.');

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

  if (/note: please don't just throw your llm/i.test(text)) {
    score -= 6;
    reasons.push('the issue explicitly warns that deeper human investigation is required');
  }

  const normalizedScore = Math.max(1, Math.min(100, score));
  let band = 'Low fit';
  if (normalizedScore >= 75) band = 'High fit';
  else if (normalizedScore >= 55) band = 'Medium fit';

  let complexity = 'Complex';
  if (normalizedScore >= 68) complexity = 'Quick win';
  else if (normalizedScore >= 50) complexity = 'Medium';

  let recommendation = 'Avoid for first pass';
  if (normalizedScore >= 60) recommendation = 'Recommended first PR';
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
  const recentConversation = comments.slice(0, 3).map(shapeConversation);

  return {
    ...buildIssueFitScore(issue, comments),
    conversationSummary: summarizeConversation(issue, comments),
    expectationSummary: inferExpectation(issue, comments),
    quickPlan: inferQuickPlan(issue, comments),
    recentConversation,
  };
}

module.exports = {
  buildIssueInsight,
  buildRepoOverview,
  buildIssueFitScore,
  stripMarkdown,
};
