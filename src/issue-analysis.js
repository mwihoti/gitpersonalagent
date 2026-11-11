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
- Write like a contributor explaining the issue to a teammate: short sentences, specific behavior, named files, and direct next steps. Avoid promotional language, generic praise, and repeated summaries. Keep the first_comment_draft brief and natural; ask a specific question or state the work you intend to take on.

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

// ─── Evidence: tie each quote back to the comment it came from ─────────────────
// The model quotes the thread; we find the quote in the real thread so the
// digest can link the exact comment and show its real date and author. A
// quote we cannot find stays in the analysis but is marked unverified, and
// the digest leaves it out rather than show a line nobody actually wrote.

const MAINTAINER_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Marks that never count as words: REMOVED stands where struck or unclosed
// text was dropped (a paragraph containing it is never shown), HEADING
// starts a heading line.
const REMOVED = '⁠⁠';
const HEADING = '⁣';

// Fenced code blocks, found line by line (a regex over the whole body
// backtracks badly on long runs of backticks). Each block becomes one
// placeholder, with blank lines around it so it is its own paragraph.
function maskFences(text, keep) {
  const out = [];
  let fence = '';
  let body = [];
  for (const line of text.split('\n')) {
    if (fence) {
      const trimmed = line.trim();
      if (trimmed.length >= fence.length && /^(?:`+|~+)$/.test(trimmed) && trimmed[0] === fence[0]) {
        out.push(keep(body.join('\n')), '');
        fence = '';
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }
    const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (open) { fence = open[1]; out.push(''); continue; }
    out.push(line);
  }
  if (fence) out.push(keep(body.join('\n')));
  return out.join('\n');
}

// What a reader sees once the Markdown renders, so a quote of the visible text
// matches. For thread sources (quotes: 'drop'), anything quoted from someone
// else or struck out is removed. Code (fenced blocks and inline spans) is set
// aside first and restored untouched, so `~~x`, `~/.config` or a "> " shell
// prompt inside code never trigger any of that.
function visibleText(markdown, options = {}) {
  const dropQuotes = options.quotes === 'drop';
  const code = [];
  const keep = (match) => `⁢${code.push(match) - 1}⁢`;
  let text = maskFences(String(markdown || ''), keep)
    .replace(/`[^`\n]+`/g, keep)
    // Hidden when rendered; an unclosed one hides everything after it.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (match) => (match.endsWith('-->') ? ' ' : REMOVED));

  if (dropQuotes) {
    // An opener with no closer (written that way, or cut by the length cap)
    // drops everything after it.
    text = text
      // A reply without the words it answers ("> Any reason not to?" / "No.")
      // can mean the opposite: mark it, so the comment is never shown.
      .replace(/<blockquote\b[^>]*>[\s\S]*?(?:<\/blockquote>|$)/gi, REMOVED)
      .replace(/<(del|s|strike)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, REMOVED)
      // Superscript and subscript carry meaning (10<sup>-6</sup>) that plain
      // text cannot show: such a comment is never quoted.
      .replace(/<(sup|sub)\b[^>]*>/gi, REMOVED)
      .replace(/~~(?:(?!\n[ \t]*\n)[\s\S])*?(?:~~|(?=\n[ \t]*\n)|$)/g, REMOVED)
      .replace(/(?<![~\p{L}\p{N}])~(?=[^\s~])(?:(?!\n[ \t]*\n)[^~])*?[^\s~]~(?![~\p{L}\p{N}])/gu, REMOVED);
  }

  const lines = [];
  let inQuote = false;
  let prev = '';
  let prevWasItem = false;
  for (const line of text.split('\n')) {
    if (dropQuotes) {
      if (/^\s*(?:(?:[-*+]|\d+[.)])[ \t]+)?>/.test(line)) { inQuote = true; lines.push(REMOVED); prev = ''; prevWasItem = false; continue; }
      if (inQuote && line.trim()) { lines.push(REMOVED); continue; }
      inQuote = false;
      // An unchecked template box ("- [ ] I am willing to submit a PR") is
      // something the author did NOT say.
      if (/^[ \t]*(?:\d+[.)]|[-*+])[ \t]+\[ \][ \t]/.test(line)) { lines.push(''); prev = ''; prevWasItem = false; continue; }
    }
    const heading = line.match(/^[ \t]*#{1,6}[ \t]+(.*?)[ \t#]*$/);
    if (heading) {
      lines.push(`${HEADING}${/[.:!?]$/.test(heading[1]) ? heading[1] : `${heading[1]}:`}`);
      prev = line; prevWasItem = false;
      continue;
    }
    // Bullets become "•" (not a word, so matching ignores it). A numbered
    // line is a list item only where CommonMark says so: after a blank line
    // or another item, or when it is "1." — otherwise "10. Anything more" in
    // a wrapped paragraph keeps its number.
    const bullet = /^[ \t]*[-*+][ \t]+/.test(line);
    const number = line.match(/^[ \t]*(\d+)[.)][ \t]+/);
    const numbered = number && (!prev.trim() || prevWasItem || number[1] === '1');
    const isItem = Boolean(bullet || numbered);
    lines.push(isItem ? line.replace(/^[ \t]*(?:\d+[.)]|[-*+])[ \t]+(?:\[[ xX]\][ \t]+)?/, '• ') : line);
    prev = line;
    prevWasItem = isItem;
  }

  return lines.join('\n')
    // Link text cannot contain "[" and a URL has no spaces or "(": each
    // attempt stops at the next bracket, so "[[[[…" stays linear.
    .replace(/!?\[([^[\]\n]*)\]\([^()\s]*\)/g, '$1')
    // Real HTML only: Vec<u8> or Option<T> in prose must survive.
    .replace(/<\/?(?:a|b|i|em|strong|code|pre|kbd|sub|sup|br|hr|p|div|span|img|details|summary|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|del|s|ins|h[1-6])\b[^<>]*>/gi, ' ')
    // One pass, so "&amp;lt;" becomes the literal text "&lt;", as GitHub shows it.
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (all, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[name])
    .replace(/⁢(\d+)⁢/g, (all, index) => code[Number(index)]);
}

// Word tokens with their position in the visible text, so a match can be
// shown in the commenter's own words.
function tokenize(text) {
  return Array.from(String(text || '').matchAll(/[\p{L}\p{N}\p{M}]+/gu), match => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

// Models trim with ellipses ("a ... b", "a [...] b", "a (…) b"). Each piece
// must appear, in order, in one comment.
function quoteParts(quote) {
  return visibleText(quote)
    .split(/\s*(?:[[(]\s*(?:\.\.\.|…)\s*[\])]|\.\.\.|…)\s*/)
    .map(part => tokenize(part).map(token => token.word))
    .filter(part => part.length);
}

function cleanQuote(quote) {
  return String(quote || '').trim().replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
}

function cleanLogin(value) {
  return String(value || '').trim().replace(/^@/, '').replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
}

function threadSources(context) {
  const issue = (context && context.issue) || {};
  const sources = [];
  if (issue.body) {
    sources.push({ author: issue.author || '', createdAt: issue.createdAt || '', url: issue.url || '', body: issue.body, association: issue.authorAssociation || '', truncated: Boolean(issue.bodyTruncated) });
  }
  for (const comment of (context && context.comments) || []) {
    sources.push({ author: comment.author || '', createdAt: comment.createdAt || '', url: comment.url || '', body: comment.body || '', association: comment.authorAssociation || '', truncated: Boolean(comment.truncated) });
  }
  return sources;
}

// Finds the parts in order in a source's tokens. The last word of each part
// may be a prefix, because quotes get clipped mid-word. Returns the token
// ranges matched, or null.
function findParts(tokens, parts) {
  const ranges = [];
  let from = 0;
  for (const part of parts) {
    let found = -1;
    for (let i = from; i + part.length <= tokens.length && found < 0; i += 1) {
      let ok = true;
      for (let j = 0; j < part.length && ok; j += 1) {
        const word = tokens[i + j].word;
        ok = j === part.length - 1 && part[j].length >= 3 ? word.startsWith(part[j]) : word === part[j];
      }
      if (ok) found = i;
    }
    if (found < 0) return null;
    ranges.push([found, found + part.length - 1]);
    from = found + part.length;
  }
  return ranges;
}

// A short quote ("LGTM", "go ahead") counts only as the whole comment: as a
// fragment it would match half the thread.
const SHORT_QUOTE = 12;
const SPAN_LIMIT = 300;

// Paired emphasis only, and never inside `code`: "2**20" and `__init__`
// must reach the reader exactly as written.
function stripEmphasis(text) {
  // Multi-backtick code spans are not parsed here: leave everything as is.
  if (text.includes('``')) return text;
  return text.split(/(`[^`\n]*`)/).map((piece, index) => (index % 2
    ? piece
    // Not glued to a letter or digit outside, so 2**20 and a**b stay as written.
    : piece.replace(/(?<![\p{L}\p{N}*_])(\*\*|__)(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}*_])/gu, '$2'))).join('');
}

// An edit or retraction anywhere in a comment may withdraw any part of it.
// Broad on purpose: a false alarm only hides a quote. Keywords count when
// followed by ":", ")", "]" or a dash ("Quick update:", "EDIT2:", "(edit:"),
// phrases count anywhere.
const EDIT_MARKER = /\b(?:edit(?:ed)?|update[ds]?|upd|eta|p\.?s|addendum|correction)\s*\d*\s*(?:\([^)\n]{0,20}\)\s*)?(?:[:\])—-]|\*{1,3}\s*:)|\b(?:edited to add|never ?mind|nvm|disregard (?:that|this|the above|my)|on second thought|scratch that|changed my mind|retract(?:ed|ing)?)\b/i;

// The whole comment, exactly as written, or '' when it cannot be shown
// safely. Showing the entire comment means nothing around the quote can be
// lost: a lead-in, a "not", an "Edit: never mind" are all on screen. So it
// must be one paragraph and short, not cut by the length cap, and nothing
// struck through may have been removed from it.
function sourceSpan(source) {
  if (source.truncated || EDIT_MARKER.test(source.body)) return '';
  const visible = source.visible.trim();
  if (!visible || visible.includes(REMOVED) || /\n[ \t]*\n/.test(visible)) return '';
  const shown = stripEmphasis(visible.split(HEADING).join('')).replace(/\s+/g, ' ').trim();
  return shown.length <= SPAN_LIMIT ? shown : '';
}

// True when any matched piece sits inside quotation marks on its line: the
// commenter is repeating someone ('Re "we should drop it": no'), not saying
// it. Straight single quotes count only at word edges, so "don't" is not one.
function openQuote(before) {
  const straight = (before.match(/"/g) || []).length % 2 === 1;
  const curly = (before.match(/\u201c/g) || []).length > (before.match(/\u201d/g) || []).length;
  const curlySingle = (before.match(/\u2018/g) || []).length > (before.match(/\u2019(?![\p{L}])/gu) || []).length;
  const singleOpen = (before.match(/(?:^|[\s(\[])'(?=\S)/g) || []).length;
  const singleClose = (before.match(/(?<=\S)'(?=$|[\s,.;:!?)\]])/g) || []).length;
  return straight || curly || curlySingle || singleOpen > singleClose;
}

function insideQuotes(source, ranges) {
  return ranges.some(([first]) => {
    const start = source.tokens[first].start;
    const lineStart = source.visible.lastIndexOf('\n', start - 1) + 1;
    // One character past the start, so an opening ' can see the word it opens.
    return openQuote(source.visible.slice(lineStart, start + 1));
  });
}

function isMaintainer(source) {
  return MAINTAINER_ROLES.has(String(source.association).toUpperCase());
}

function resolveEvidence(items, context) {
  // A thread we did not read in full may hold the comment that withdraws a
  // quote, so none is trusted.
  if (context && context.commentsComplete === false) {
    return items.map(raw => ({ ...raw, quote: cleanQuote(raw.quote), verified: false, url: '', role: '' }));
  }
  const issueAuthor = cleanLogin(((context && context.issue) || {}).author);
  const sources = threadSources(context)
    .map((source, order) => {
      const visible = visibleText(source.body, { quotes: 'drop' });
      return { ...source, order, visible, tokens: tokenize(visible) };
    });

  return items.map(raw => {
    const item = { ...raw, quote: cleanQuote(raw.quote) };
    const parts = quoteParts(item.quote);
    const total = parts.flat().join(' ');
    const found = [];
    if (total) {
      for (const source of sources) {
        if (total.length < SHORT_QUOTE) {
          const ranges = [[0, source.tokens.length - 1]];
          if (source.tokens.map(token => token.word).join(' ') === total && sourceSpan(source)) found.push({ source, ranges });
          continue;
        }
        const ranges = findParts(source.tokens, parts);
        if (ranges && !insideQuotes(source, ranges) && sourceSpan(source)) found.push({ source, ranges });
      }
    }

    // Credit the named author when they said it; otherwise the named date;
    // otherwise whoever said it first, which is the original rather than
    // someone repeating it.
    const who = cleanLogin(item.who);
    const byAuthor = found.filter(match => cleanLogin(match.source.author) === who);
    let pool = byAuthor.length ? byAuthor : found;
    const onDate = pool.filter(match => item.when && match.source.createdAt.startsWith(item.when));
    if (onDate.length) pool = onDate;
    const match = pool.sort((a, b) => String(a.source.createdAt).localeCompare(String(b.source.createdAt)) || a.source.order - b.source.order)[0];
    if (!match) return { ...item, verified: false, url: '', role: '' };

    const { source } = match;
    // Only someone's latest word in the thread is shown: any later comment by
    // the same person may change their position, and reading it reliably is
    // not possible.
    const revisited = sources.some(other => other.order > source.order
      && cleanLogin(other.author) === cleanLogin(source.author));
    // The reporter can edit the issue text at any time, so it may be newer
    // than any comment of theirs: their comments are never quoted.
    const reporterComment = source.order > 0 && issueAuthor && cleanLogin(source.author) === issueAuthor && Boolean(((context && context.issue) || {}).body);
    if (revisited || reporterComment) return { ...item, verified: false, url: '', role: '' };
    return {
      ...item,
      // Shown in the commenter's own words, never the model's paraphrase.
      quote: sourceSpan(source),
      who: source.author || item.who,
      when: source.createdAt ? source.createdAt.slice(0, 10) : item.when,
      url: source.url,
      role: isMaintainer(source) ? 'maintainer' : (source.author && cleanLogin(source.author) === issueAuthor ? 'issue author' : ''),
      verified: true,
    };
  });
}

function normalizeAnalysis(raw, context) {
  const state = str(raw.current_state, 40).toLowerCase().replace(/[\s-]+/g, '_');
  const knownPaths = new Set(context.files.map(file => file.path));
  const effort = str(raw.effort, 10).toLowerCase();
  const impact = str(raw.impact, 10).toLowerCase();

  return {
    summary: str(raw.summary, 1200),
    maintainerWants: str(raw.maintainer_wants, 1500),
    evidence: resolveEvidence(list(raw.evidence, 5, item => ({
      who: str(item && item.who, 60),
      when: str(item && item.when, 12),
      quote: str(item && item.quote, 600),
    })), context),
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
  resolveEvidence,
  SPAN_LIMIT,
  heuristicAnalysis,
  SYSTEM_PROMPT,
};
