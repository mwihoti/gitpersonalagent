'use strict';

// Per-issue deep analysis: feed the model the real thread, linked PRs,
// contributing guide, and source excerpts, and get back a grounded plan.
// Results are cached by issue URL + updated_at so repeated views are free.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { buildIssueContext } = require('./issue-context');
const { requestJson } = require('./gemma');
const { promptBudget } = require('./providers');
const { parseIssueUrl, fetchIssueStatus } = require('./github');
const { buildIssueInsight } = require('./repo-insights');

const CACHE_DIR = path.join(
  process.env.DAN_AGENT_DATA_DIR || (process.env.VERCEL ? path.join('/tmp', 'danagent-data') : path.join(__dirname, '..', 'data')),
  'issue-analysis',
);

const STATES = new Set([
  'available', 'claimed', 'has_open_pr', 'likely_done', 'stale', 'blocked', 'needs_design', 'needs_clarification',
]);
const LEVELS = new Set(['low', 'medium', 'high']);

const SYSTEM_PROMPT = `You are a senior open-source contributor preparing to work on a GitHub issue.
You receive the full issue, the discussion thread in order, linked pull requests, the project's contributing guide, and excerpts of the source files involved.

Your job: say precisely what the maintainers want, whether the issue is actually available to a new contributor, and the smallest complete change that would be accepted.

Rules:
- Ground every claim in the material. Quote the thread for maintainer intent (author + short quote). Name real file paths from the excerpts. Never invent APIs, functions, or files.
- If the thread shows the work is already taken (assignee, open PR, "I'm working on it") say so in current_state.
- If the material does not settle something, do not guess: put it in open_questions.
- Prefer the narrowest change that fully resolves the request. Mention tests the project would expect.
- code_skeleton must be consistent with the excerpts (same language, real identifiers). If no source was provided, keep it minimal and say what to look for.

Return ONLY a JSON object with exactly these keys:
{
  "summary": "2-3 sentences: what the issue is really about",
  "maintainer_wants": "what maintainers expect the change to do and not do, grounded in the thread",
  "evidence": [{ "who": "login", "when": "YYYY-MM-DD", "quote": "short verbatim quote" }],
  "current_state": "available | claimed | has_open_pr | likely_done | stale | blocked | needs_design | needs_clarification",
  "state_reason": "one sentence on why",
  "open_questions": ["question to ask on the issue before starting"],
  "files_to_change": [{ "path": "real/path.ext", "why": "what changes there" }],
  "plan": ["concrete step referencing files or functions", "..."],
  "validation": "command or check the project would run",
  "effort": "low | medium | high",
  "impact": "low | medium | high",
  "confidence": 0-100,
  "code_skeleton": "grounded starter code with a file path comment on the first line",
  "first_comment_draft": "optional short, polite comment to post on the issue (claim or clarify); empty string if not needed"
}`;

function section(title, body) {
  return `=== ${title} ===\n${body}\n`;
}

// Builds the analysis prompt. With a finite budget (chars) each section gets
// a share, so a rate-limited provider still sees the issue, the most recent
// discussion, and the code, instead of a prompt cut off in the middle.
function buildPrompt(context, budgetChars = Infinity) {
  const { repo, issue, comments, pullRequests, contributing, files, claim } = context;
  const limited = Number.isFinite(budgetChars);
  const share = fraction => (limited ? Math.max(300, Math.floor(budgetChars * fraction)) : Infinity);
  const clip = (text, max) => (String(text || '').length > max ? `${String(text).slice(0, max)}…` : String(text || ''));
  const parts = [];

  parts.push(section('REPOSITORY', [
    `${repo.name} — ${clip(repo.description || 'no description', 200)}`,
    `Language: ${repo.language || 'unknown'} · Stars: ${repo.stars} · Default branch: ${repo.defaultBranch || 'unknown'}`,
  ].join('\n')));

  parts.push(section('ISSUE', [
    `#${issue.number}: ${issue.title}`,
    `URL: ${issue.url}`,
    `Author: ${issue.author}${issue.authorAssociation ? ` (${issue.authorAssociation})` : ''} · Opened: ${issue.createdAt.slice(0, 10)} · Updated: ${issue.updatedAt.slice(0, 10)}`,
    `Labels: ${issue.labels.join(', ') || 'none'} · Assignees: ${issue.assignees.join(', ') || 'none'} · Comments: ${issue.commentsCount} · Reactions: ${issue.reactions}`,
    issue.milestone ? `Milestone: ${issue.milestone}` : '',
    '',
    clip(issue.body || '(no description)', Math.min(8000, share(0.22))),
  ].filter(line => line !== null).join('\n')));

  if (claim && (claim.claimed || claim.stale)) {
    parts.push(section('OWNERSHIP SIGNAL', claim.reason));
  }

  if (comments.length) {
    // Newest comments matter most; keep the first one too when there is room.
    const perComment = limited ? 500 : 1200;
    const render = comment =>
      `[${comment.createdAt.slice(0, 10)}] ${comment.author}${comment.authorAssociation && comment.authorAssociation !== 'NONE' ? ` (${comment.authorAssociation.toLowerCase()})` : ''}:\n${clip(comment.body, perComment)}`;
    let room = share(0.3);
    const picked = [];
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const text = render(comments[i]);
      if (picked.length && text.length > room) break;
      picked.unshift(text);
      room -= text.length + 2;
    }
    parts.push(section(`DISCUSSION (${picked.length} of ${issue.commentsCount} comments, most recent, in order)`, picked.join('\n\n')));
  } else {
    parts.push(section('DISCUSSION', 'No comments yet.'));
  }

  if (pullRequests.length) {
    parts.push(section('LINKED PULL REQUESTS', pullRequests.map(pr => {
      const prFiles = pr.files && pr.files.length ? `\n  files: ${pr.files.slice(0, limited ? 6 : 15).map(file => file.path).join(', ')}` : '';
      const where = pr.sameRepo === false && pr.repo ? ` (in ${pr.repo})` : '';
      return `#${pr.number} [${pr.state}]${where} by ${pr.author || 'unknown'}: ${pr.title}${prFiles}`;
    }).join('\n')));
  }

  if (contributing) {
    parts.push(section(`CONTRIBUTING GUIDE (${contributing.path}, excerpt)`, clip(contributing.text, Math.min(4000, share(0.06)))));
  }

  if (files.length) {
    const perFile = limited ? Math.floor(share(0.3) / files.length) : Infinity;
    for (const file of files) {
      parts.push(section(`SOURCE ${file.path} (lines ${file.startLine}-${file.endLine} of ${file.totalLines}; ${file.reason})`, clip(file.text, perFile)));
    }
  } else {
    parts.push(section('SOURCE', 'No source files could be resolved from the issue text.'));
  }

  parts.push(limited
    ? 'Analyze the material above and return the JSON object. Be concise: plan of at most 6 steps, code_skeleton of at most 25 lines.'
    : 'Analyze the material above and return the JSON object.');
  return parts.join('\n');
}

function str(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function list(value, max = 8, mapper = item => str(item, 400)) {
  if (!Array.isArray(value)) return [];
  return value.map(mapper).filter(item => (typeof item === 'string' ? item : Object.values(item).some(Boolean))).slice(0, max);
}

function normalizeAnalysis(raw, context) {
  const state = str(raw.current_state, 40).toLowerCase().replace(/[\s-]+/g, '_');
  const knownPaths = new Set(context.files.map(file => file.path));
  const effort = str(raw.effort, 10).toLowerCase();
  const impact = str(raw.impact, 10).toLowerCase();

  return {
    summary: str(raw.summary, 1200),
    maintainerWants: str(raw.maintainer_wants, 1500),
    evidence: list(raw.evidence, 5, item => ({
      who: str(item && item.who, 60),
      when: str(item && item.when, 12),
      quote: str(item && item.quote, 300),
    })),
    currentState: STATES.has(state) ? state : 'available',
    stateReason: str(raw.state_reason, 400),
    openQuestions: list(raw.open_questions, 6),
    filesToChange: list(raw.files_to_change, 8, item => ({
      path: str(item && item.path, 200),
      why: str(item && item.why, 300),
      verified: knownPaths.has(str(item && item.path, 200)),
    })),
    // Models often number the steps themselves; the renderers add numbers.
    plan: list(raw.plan, 8, item => str(item, 400).replace(/^\s*(?:step\s*)?\d+\s*[.):-]\s*/i, '')),
    validation: str(raw.validation, 300),
    effort: LEVELS.has(effort) ? effort : 'medium',
    impact: LEVELS.has(impact) ? impact : 'medium',
    confidence: Math.max(0, Math.min(100, Number(raw.confidence) || 0)),
    codeSkeleton: str(raw.code_skeleton, 12000),
    firstCommentDraft: str(raw.first_comment_draft, 1200),
  };
}

// When no model is reachable, fall back to the heuristic insight so callers
// always get the same shape.
function heuristicAnalysis(context) {
  const insight = buildIssueInsight(
    {
      title: context.issue.title,
      body: context.issue.body,
      labels: context.issue.labels.map(name => ({ name })),
      comments: context.issue.commentsCount,
      updated_at: context.issue.updatedAt,
      claim: context.claim,
      linkedPRs: context.pullRequests,
    },
    context.comments.map(comment => ({ body: comment.body, user: { login: comment.author }, created_at: comment.createdAt })),
  );
  const claim = context.claim || {};
  return {
    summary: insight.conversationSummary,
    maintainerWants: insight.expectationSummary,
    evidence: [],
    currentState: claim.claimed ? (claim.prUrl ? 'has_open_pr' : 'claimed') : 'available',
    stateReason: claim.reason || 'No ownership signal found in the thread.',
    openQuestions: [],
    filesToChange: context.files.map(file => ({ path: file.path, why: file.reason, verified: true })),
    plan: insight.quickPlan,
    validation: '',
    effort: 'medium',
    impact: 'medium',
    confidence: 20,
    codeSkeleton: '',
    firstCommentDraft: '',
  };
}

function looksComplete(raw) {
  return raw && typeof raw === 'object' && (str(raw.summary) || str(raw.maintainer_wants)) && Array.isArray(raw.plan);
}

// One retry with a nudge covers the common failure: prose around the JSON or
// a missing key. Provider failover already happens inside request().
async function requestAnalysis(context, request, logger) {
  const user = buildPrompt(context, promptBudget({ system: SYSTEM_PROMPT, maxTokens: 6000 }));
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const nudge = attempt === 1 ? '' : '\n\nYour previous answer was not a valid JSON object with the required keys. Return ONLY the JSON object, no prose, no code fences.';
      const raw = await request({ system: SYSTEM_PROMPT, user: `${user}${nudge}`, maxTokens: 6000 });
      if (!looksComplete(raw)) {
        throw new Error('model answer is missing summary/plan');
      }
      return normalizeAnalysis(raw, context);
    } catch (error) {
      lastError = error;
      // Only a malformed answer is worth a second try; provider errors are not.
      const malformed = /JSON|missing summary/i.test(error.message);
      if (attempt === 1 && malformed) {
        logger.warn(`  Deep analysis attempt 1 failed (${error.message}); retrying once`);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

function cacheKey(url) {
  return crypto.createHash('sha1').update(String(url).toLowerCase()).digest('hex');
}

async function readCache(url) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${cacheKey(url)}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(url, payload) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${cacheKey(url)}.json`), JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.warn(`  Analysis cache write skipped: ${error.message}`);
  }
}

function summarizeContext(context) {
  return {
    repo: context.repo,
    issue: {
      number: context.issue.number,
      title: context.issue.title,
      url: context.issue.url,
      labels: context.issue.labels,
      author: context.issue.author,
      assignees: context.issue.assignees,
      createdAt: context.issue.createdAt,
      updatedAt: context.issue.updatedAt,
      commentsCount: context.issue.commentsCount,
      bodyPlain: context.issue.bodyPlain,
    },
    claim: context.claim,
    comments: context.comments.slice(-6).map(comment => ({
      author: comment.author,
      createdAt: comment.createdAt,
      body: comment.body.slice(0, 400),
    })),
    pullRequests: context.pullRequests.map(pr => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      author: pr.author,
      repo: pr.repo,
      sameRepo: pr.sameRepo,
      files: (pr.files || []).map(file => file.path).slice(0, 10),
    })),
    contributing: context.contributing ? { path: context.contributing.path, url: context.contributing.url } : null,
    files: context.files.map(file => ({
      path: file.path,
      url: file.url,
      reason: file.reason,
      startLine: file.startLine,
      endLine: file.endLine,
    })),
  };
}

function resolveRef(input = {}) {
  if (input.repo && input.number) {
    return { repo: input.repo, number: Number(input.number), url: input.url || `https://github.com/${input.repo}/issues/${input.number}` };
  }
  const parsed = parseIssueUrl(input.url);
  if (!parsed) throw new Error('Provide an issue URL or repo + number');
  return { ...parsed, url: input.url };
}

// analyzeIssue({ url } | { repo, number }, { force, fetchContext, request, logger })
async function analyzeIssue(input, options = {}) {
  const ref = resolveRef(input);
  const {
    force = false,
    fetchContext = buildIssueContext,
    fetchStatus = fetchIssueStatus,
    request = requestJson,
    logger = console,
    knownUpdatedAt = '',
  } = options;

  if (!force) {
    const cached = await readCache(ref.url);
    if (cached && cached.issueUpdatedAt && cached.model !== 'heuristic') {
      // Cheap freshness check: one request for the issue's updated_at.
      const current = knownUpdatedAt || (await fetchStatus(ref.repo, ref.number).catch(() => null) || {}).updatedAt || '';
      if (current && current === cached.issueUpdatedAt) {
        return { ...cached, cached: true };
      }
    }
  }

  const context = await fetchContext(ref.repo, ref.number, options.contextOptions || {});
  let analysis;
  let model = 'model';
  try {
    analysis = await requestAnalysis(context, request, logger);
  } catch (error) {
    logger.warn(`  Deep analysis fell back to heuristics for ${ref.url}: ${error.message}`);
    analysis = heuristicAnalysis(context);
    model = 'heuristic';
  }

  const payload = {
    issueUrl: context.issue.url,
    issueUpdatedAt: context.issue.updatedAt,
    analyzedAt: new Date().toISOString(),
    model,
    analysis,
    context: summarizeContext(context),
    cached: false,
  };
  // A heuristic result only means the model was unavailable this time; caching
  // it would keep serving templates after the model is back.
  if (model !== 'heuristic') await writeCache(ref.url, payload);
  return payload;
}

module.exports = {
  analyzeIssue,
  buildPrompt,
  normalizeAnalysis,
  heuristicAnalysis,
  SYSTEM_PROMPT,
};
