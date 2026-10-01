'use strict';
const config = require('./config');
const { runChain, hasCloudProvider, promptBudget, isTightBudget } = require('./providers');
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EFFORT_VALUES = new Set(['low', 'medium', 'high']);

const SYSTEM_PROMPT = `You are "Repository Intelligence Assistant" — a precise engineering copilot that helps teams monitor GitHub repositories and turn issue activity into practical delivery plans.

Your main goal: Help the user identify the best implementation opportunities across monitored repositories. Suggest UP TO 3 high-signal opportunities per repo scanned.

When given GitHub issues and tech news:
- Suggest UP TO 3 implementation opportunities PER REPO, prioritizing good-first-issue, bug, help wanted, and high-signal enhancement work.
- For each opportunity, generate a REAL code_skeleton — actual starter code or file-level snippet the developer can start with immediately.
- Prioritize low and medium effort items. Only suggest high effort if the expected impact is clear.
- Mention the most relevant validation command when it can be inferred, such as cargo test, npm test, pnpm test, go test, pytest, or project-specific checks.
- Focus on actionable engineering work: bug fixes, tests, documentation, automation, DX improvements, observability, security, or scoped product enhancements.
- Write like a contributor leaving a useful note for another developer. Use short sentences, name the actual behavior or file, and explain the next action. Avoid promotional language, generic praise, buzzwords such as "leverage" or "high-signal", and repeated introductions. Describe the concrete benefit instead of claiming broad ecosystem impact. Preserve the issue's title where it already describes the work clearly.

STRICT OUTPUT FORMAT (return ONLY valid JSON, no markdown fences, no extra text):
{
  "date": "YYYY-MM-DD",
  "contest_digest": [
    {
      "opportunity": "Short title of the implementation opportunity",
      "repo": "owner/repo",
      "issue_url": "github issue/PR url or empty string",
      "why_it_qualifies": "Why this is a strong implementation target right now",
      "suggested_action": "Step-by-step what to implement (1-4 hours work when possible)",
      "code_skeleton": "Actual starter code or snippet. Include file path as comment on first line. Make it runnable or checkable.",
      "clarity_tip": "Most relevant validation command or review tip (empty string if not applicable)",
      "why_it_matters": "How this helps the team, product, maintainers, or ecosystem",
      "effort": "low | medium | high"
    }
  ],
  "quick_plan": "Concrete short execution strategy: which 3-5 items to tackle first and why",
  "tech_news_summary": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"]
}

Be concise, realistic, and technically specific. Never suggest trivial or invalid changes. Return ONLY the JSON object.`;

function summarizeNews(news, limit = 25) {
  const items = [
    ...news.githubReleases.map(n => `[${n.source}] ${n.title}`),
    ...news.hackerNews.map(n => `[HN] ${n.title}`),
    ...news.rssFeeds.map(n => `[${n.source}] ${n.title}`),
  ];
  return items.slice(0, limit).join('\n');
}

function buildUserMessage(repoData, news, options = {}) {
  const {
    newsLimit = 25,
    scanLabel = 'last 30 days + all good-first-issues',
    opportunityLimit = null,
    codeSkeletonLimit = null,
    scanFocus = '',
    maxPerRepo = 0,
    contributorProfile = '',
  } = options;

  const limitInstruction = opportunityLimit
    ? `Return at most ${opportunityLimit} total opportunities across all repositories. Pick the highest-signal items only.`
    : 'Return a repository opportunity digest with UP TO 3 implementation opportunities per repo.';
  const codeInstruction = codeSkeletonLimit
    ? `Keep each code_skeleton under ${codeSkeletonLimit} characters.`
    : 'For each opportunity include a real code_skeleton the developer can immediately use.';

  const spreadInstruction = maxPerRepo
    ? `Spread the picks across repositories: at most ${maxPerRepo} opportunities from any single repo.`
    : '';

  return `Today is ${new Date().toISOString().slice(0, 10)}.

=== GITHUB SCAN (${scanLabel}) ===
${JSON.stringify(repoData)}

=== LATEST TECH NEWS (titles only) ===
${summarizeNews(news, newsLimit)}

${contributorProfile ? `=== CONTRIBUTOR PROFILE (learned from past outcomes) ===\n${contributorProfile}\nPrefer work that matches this profile; avoid repeating what they dismiss.\n\n` : ''}Analyze the above data. ${limitInstruction}
${codeInstruction}
${spreadInstruction ? `${spreadInstruction}\n` : ''}${scanFocus ? `${scanFocus}\n` : ''}
Focus on good-first-issue, bug, help-wanted, and high-signal issues first.`;
}

// Trim repo data before sending to cloud APIs — keeps top 6 issues per repo
// (already sorted: good-first + bugs first), truncates bodies, drops recentPRs.
function trimForCloud(repoData, options = {}) {
  const envBodyChars = Number(process.env.DIGEST_BODY_CHARS);
  const {
    issuesPerRepo = 6,
    bodyChars = Number.isFinite(envBodyChars) && envBodyChars > 0 ? envBodyChars : 1500,
    includeRepoUrl = true,
    commentChars = 300,
    maxComments = 3,
    maxPrs = 4,
    lean = false,
  } = options;

  return repoData.map(r => ({
    repo: r.repo,
    ...(includeRepoUrl ? { repoUrl: r.repoUrl } : {}),
    ...(r.overview && r.overview.language ? { language: r.overview.language } : {}),
    issues: r.issues.slice(0, issuesPerRepo).map(i => ({
      number: i.number,
      title: i.title,
      body: (i.body || '').slice(0, bodyChars),
      labels: i.labels,
      url: i.url,
      ...(i.createdAt ? { created_at: String(i.createdAt).slice(0, 10) } : {}),
      ...(i.comments && !lean ? { comments_count: i.comments } : {}),
      ...(i.assignees && i.assignees.length ? { assignees: i.assignees } : {}),
      ...(i.issueFitScore ? { fit_score: i.issueFitScore, ...(lean ? {} : { fit_reason: i.issueFitReason }) } : {}),
      ...(i.triageScore ? { triage_score: i.triageScore, triage_reason: i.triageReason } : {}),
      ...(maxComments && commentChars && Array.isArray(i.recentConversation) && i.recentConversation.length ? {
        recent_comments: i.recentConversation.slice(-maxComments).map(c => `${c.author || 'someone'} (${String(c.createdAt || '').slice(0, 10)}): ${String(c.body || '').slice(0, commentChars)}`),
      } : {}),
      ...(maxPrs && Array.isArray(i.linkedPRs) && i.linkedPRs.length ? {
        linked_prs: i.linkedPRs.slice(0, maxPrs).map(pr => `#${pr.number} ${pr.state}${pr.author ? ` by ${pr.author}` : ''}${lean ? '' : `: ${pr.title}`}`),
      } : {}),
      ...(i.claim && i.claim.stale ? { ownership: i.claim.reason } : {}),
      ...(i.hasNewActivity ? { note: 'recommended before; has new activity since' } : {}),
    })),
  }));
}

// Shrink the per-issue detail step by step until the whole scan fits the
// provider's prompt budget. Every repo stays represented: losing detail on
// each issue is better than the model never seeing half the watchlist.
const FIT_LEVELS = [
  { bodyChars: 1500, commentChars: 300, maxComments: 3, maxPrs: 4 },
  { bodyChars: 700, commentChars: 200, maxComments: 2, maxPrs: 3 },
  { bodyChars: 350, commentChars: 140, maxComments: 1, maxPrs: 2 },
  { bodyChars: 180, commentChars: 100, maxComments: 1, maxPrs: 2, lean: true, includeRepoUrl: false },
  { bodyChars: 100, commentChars: 0, maxComments: 0, maxPrs: 1, lean: true, includeRepoUrl: false, perRepo: 3 },
  { bodyChars: 50, commentChars: 0, maxComments: 0, maxPrs: 0, lean: true, includeRepoUrl: false, perRepo: 2 },
];

function fitDigestInput(repoData, { issuesPerRepo, budgetChars }) {
  let data = null;
  for (const level of FIT_LEVELS) {
    const { perRepo, ...trim } = level;
    data = trimForCloud(repoData, { ...trim, issuesPerRepo: Math.min(issuesPerRepo, perRepo || issuesPerRepo) });
    if (JSON.stringify(data).length <= budgetChars) break;
  }
  return data;
}

// Cloud providers and their fallback models are walked in order (providers.js).
// Local Ollama is used when no cloud key is set; if everything fails the
// deterministic digest keeps the scan alive.
async function analyzeDigestWithModel(repoData, news, options = {}) {
  const digestMode = process.env.DIGEST_MODE === 'weekly' ? 'weekly' : 'daily';
  const scanMode = options.scanMode || 'default';
  const focusByMode = {
    all: 'User requested all issues: cover a broader set of open issues, not only the easiest ones. Keep ranking by actionability.',
    goodfirst: 'User requested good first issues: only recommend issues labeled good first issue or sourced from BitcoinDevs.',
    medium: 'User requested medium effort: prioritize medium-effort implementation work, avoid tiny copy-only fixes and avoid large ambiguous rewrites.',
    default: '',
  };
  // Leave room for the news block and instructions around the scan data.
  const tight = isTightBudget();
  const budgetChars = promptBudget({ system: SYSTEM_PROMPT, maxTokens: 12000 }) - (tight ? 1400 : 2500);
  const trimmedRepoData = fitDigestInput(repoData, {
    issuesPerRepo: options.issuesPerRepo || (digestMode === 'weekly' ? 6 : 4),
    budgetChars,
  });
  const userMessage = buildUserMessage(trimmedRepoData, news, {
    newsLimit: tight ? 6 : (digestMode === 'weekly' ? 20 : 12),
    scanLabel: options.scanLabel || (digestMode === 'weekly' ? 'weekly top prioritized issues per repo' : 'top prioritized issues per repo'),
    opportunityLimit: options.opportunityLimit || (digestMode === 'weekly' ? 12 : 8),
    // On a tight budget the answer must stay short; deep analysis supplies the real skeleton later.
    codeSkeletonLimit: tight ? 200 : 700,
    scanFocus: focusByMode[scanMode] || '',
    maxPerRepo: options.maxPerRepo || 0,
    contributorProfile: options.contributorProfile || '',
  });

  if (hasCloudProvider()) {
    try {
      const { value } = await runChain({ system: SYSTEM_PROMPT, user: userMessage, parse: parseJSON, maxTokens: 12000 });
      return value;
    } catch (error) {
      console.warn(`  Model analysis failed, using deterministic fallback: ${error.message.split('\n')[0].slice(0, 400)}`);
    }
  } else {
    try {
      return await analyzeWithOllama(buildUserMessage(repoData, news, {
        scanLabel: options.scanLabel,
        opportunityLimit: options.opportunityLimit,
        scanFocus: focusByMode[scanMode] || '',
        maxPerRepo: options.maxPerRepo || 0,
        contributorProfile: options.contributorProfile || '',
      }));
    } catch (error) {
      console.warn(`  Ollama analysis failed, using deterministic fallback: ${error.message}`);
    }
  }

  return buildDeterministicDigest(repoData, news, {
    opportunityLimit: options.opportunityLimit,
  });
}

async function analyzeWithOllama(userMessage, options = {}) {
  const system = options.system || SYSTEM_PROMPT;
  const parse = options.parse || parseJSON;
  const body = {
    model: config.ollama.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    options: {
      temperature: options.temperature ?? 0.3,
      num_predict: options.maxTokens || 8192,
    },
  };

  console.log(`  Sending to Ollama (${config.ollama.model})...`);
  const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const raw = data.message?.content || '';
  return parse(raw);
}

// Extract and parse a JSON object from raw model output without digest validation.
function parseLooseJson(raw) {
  const stripped = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1));
    }
    throw new Error('Model returned non-JSON output');
  }
}

// Generic structured call used by per-issue analysis. Same provider chain as
// the digest (see providers.js), or local Ollama when no cloud key is set.
async function requestJson({ system, user, maxTokens = 6000, timeoutMs = 120_000, temperature = 0.2 }) {
  if (hasCloudProvider()) {
    const { value } = await runChain({ system, user, parse: parseLooseJson, maxTokens, timeoutMs, temperature });
    return value;
  }
  return analyzeWithOllama(user, { system, maxTokens, timeoutMs, temperature, parse: parseLooseJson });
}

function parseJSON(raw) {
  // Strip markdown code fences only at the very start/end of the response.
  // Do NOT use the multiline flag — with /m, ^ and $ match every line, which
  // would incorrectly strip triple-backtick fences that appear inside JSON
  // string values (e.g. code_skeleton fields containing ```clarity blocks).
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return validateDigest(JSON.parse(stripped));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  // Fallback: extract the outermost {...} block in case the model prepended
  // or appended prose around the JSON object.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const extracted = raw.slice(start, end + 1);
    try {
      return validateDigest(JSON.parse(extracted));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  console.error('Model returned non-JSON:', stripped.slice(0, 400));
  throw new Error('Failed to parse model JSON response');
}

function assertString(value, field, options = {}) {
  const {
    allowEmpty = false,
    maxLength = 4000,
  } = options;
  if (typeof value !== 'string') {
    throw new Error(`Invalid model response: "${field}" must be a string`);
  }

  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw new Error(`Invalid model response: "${field}" cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`Invalid model response: "${field}" exceeds ${maxLength} chars`);
  }
  return normalized;
}

function validateOpportunity(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Invalid model response: contest_digest[${index}] must be an object`);
  }

  const repo = assertString(item.repo, `contest_digest[${index}].repo`, { maxLength: 200 });
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid model response: contest_digest[${index}].repo must be owner/repo`);
  }

  const effort = assertString(item.effort, `contest_digest[${index}].effort`, { maxLength: 20 }).toLowerCase();
  if (!EFFORT_VALUES.has(effort)) {
    throw new Error(`Invalid model response: contest_digest[${index}].effort must be low, medium, or high`);
  }

  const issueUrl = assertString(item.issue_url ?? '', `contest_digest[${index}].issue_url`, {
    allowEmpty: true,
    maxLength: 500,
  });
  if (issueUrl && !/^https?:\/\//i.test(issueUrl)) {
    throw new Error(`Invalid model response: contest_digest[${index}].issue_url must be an http(s) URL`);
  }

  return {
    opportunity: assertString(item.opportunity, `contest_digest[${index}].opportunity`, { maxLength: 200 }),
    repo,
    issue_url: issueUrl,
    why_it_qualifies: assertString(item.why_it_qualifies, `contest_digest[${index}].why_it_qualifies`, { maxLength: 2000 }),
    suggested_action: assertString(item.suggested_action, `contest_digest[${index}].suggested_action`, { maxLength: 2500 }),
    code_skeleton: assertString(item.code_skeleton, `contest_digest[${index}].code_skeleton`, { maxLength: 12000 }),
    clarity_tip: assertString(item.clarity_tip ?? '', `contest_digest[${index}].clarity_tip`, { allowEmpty: true, maxLength: 500 }),
    why_it_matters: assertString(item.why_it_matters, `contest_digest[${index}].why_it_matters`, { maxLength: 2000 }),
    effort,
    source: assertString(item.source ?? '', `contest_digest[${index}].source`, { allowEmpty: true, maxLength: 100 }),
    source_url: assertString(item.source_url ?? '', `contest_digest[${index}].source_url`, { allowEmpty: true, maxLength: 500 }),
    issue_updated_at: assertString(item.issue_updated_at ?? '', `contest_digest[${index}].issue_updated_at`, { allowEmpty: true, maxLength: 50 }),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
  };
}

function validateDigest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid model response: root payload must be an object');
  }

  const date = assertString(payload.date, 'date', { maxLength: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Invalid model response: "date" must be YYYY-MM-DD');
  }

  if (!Array.isArray(payload.contest_digest)) {
    throw new Error('Invalid model response: "contest_digest" must be an array');
  }
  if (payload.contest_digest.length > 50) {
    throw new Error('Invalid model response: "contest_digest" exceeds 50 items');
  }

  const news = payload.tech_news_summary;
  if (!Array.isArray(news)) {
    throw new Error('Invalid model response: "tech_news_summary" must be an array');
  }
  if (news.length > 20) {
    throw new Error('Invalid model response: "tech_news_summary" exceeds 20 items');
  }

  return {
    date,
    contest_digest: payload.contest_digest.map(validateOpportunity),
    quick_plan: assertString(payload.quick_plan, 'quick_plan', { maxLength: 2000 }),
    tech_news_summary: news.map((item, index) =>
      assertString(item, `tech_news_summary[${index}]`, { maxLength: 300 })),
  };
}

function summarizeFallbackNews(news) {
  return [
    ...(news.githubReleases || []).map(item => item.title),
    ...(news.hackerNews || []).map(item => item.title),
    ...(news.rssFeeds || []).map(item => item.title),
  ].filter(Boolean).slice(0, 5);
}

function inferEffort(issue) {
  const score = Number(issue.issueFitScore || 0);
  if (score >= 72) return 'low';
  if (score >= 52) return 'medium';
  return 'high';
}

function buildDeterministicDigest(repoData, news, options = {}) {
  const limit = Number(options.opportunityLimit || 8);
  const issues = repoData.flatMap(repo => (repo.issues || []).map(issue => ({
    ...issue,
    repo: repo.repo,
  }))).sort((a, b) => {
    const scoreDiff = Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  }).slice(0, Number.isFinite(limit) && limit > 0 ? limit : 8);

  return {
    date: new Date().toISOString().slice(0, 10),
    contest_digest: issues.map(issue => ({
      opportunity: issue.title,
      repo: issue.repo,
      issue_url: issue.url || '',
      why_it_qualifies: issue.issueFitReason || 'Ranked by local issue labels, recency, discussion, and actionability signals.',
      suggested_action: issue.expectationSummary || 'Read the issue, identify the smallest useful change, add validation, and open a narrow PR.',
      code_skeleton: `// ${issue.repo}#${issue.number}\n// Start by locating the files related to: ${issue.title}\n// Add a focused test or documentation update before opening the PR.`,
      clarity_tip: (issue.quickPlan || []).slice(-1)[0] || 'Run the repository test or lint command before opening a PR.',
      why_it_matters: issue.conversationSummary || 'This keeps the contribution focused on a maintainer-visible issue.',
      effort: inferEffort(issue),
      source: issue.source || 'github',
      source_url: issue.sourceUrl || '',
      issue_updated_at: issue.updatedAt || '',
      score: Number(issue.issueFitScore || 0),
    })),
    quick_plan: issues.length
      ? 'Start with the highest-scoring low-effort issue, keep the first PR narrow, and use the issue thread to confirm expected behavior.'
      : 'No actionable issues were found. Refresh discovery sources or add repositories to the watchlist.',
    tech_news_summary: summarizeFallbackNews(news),
    model_fallback: true,
  };
}

const TRIAGE_PROMPT = `You rank GitHub issues for an external contributor looking for their next pull request.
For each candidate, judge how good a first contribution it is: clear ask, maintainer interest, narrow scope, not already taken, still relevant.
Return ONLY JSON: { "ranked": [ { "id": 0, "score": 0-100, "reason": "at most 8 words" } ] }. Use the id from the first column. Include every candidate exactly once.`;

// Cheap model ranking over all candidates so the digest is not limited to the
// label-driven fit score. Returns a Map url → { score, reason }.
async function triageIssues(repoData, options = {}) {
  const { request = requestJson, maxCandidates = 120, budgetChars = promptBudget({ system: TRIAGE_PROMPT, maxTokens: 4000 }) } = options;
  const all = [];
  for (const repo of repoData) {
    for (const issue of repo.issues || []) {
      if (issue.url) all.push({ ...issue, repo: repo.repo });
    }
  }
  if (all.length < 2) return new Map();

  // One compact line per candidate, referenced by a short id, so the whole
  // field fits even a small prompt budget. Best heuristic fits go first in
  // case the list still has to be cut.
  all.sort((a, b) => Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0));
  const header = 'id|repo#number|title|labels|updated|comments|fit|excerpt';
  const base = issue => [
    issue.repo ? `${issue.repo}#${issue.number}` : issue.url,
    String(issue.title || '').replace(/\|/g, '/').slice(0, 80),
    (issue.labels || []).slice(0, 3).join(','),
    String(issue.updatedAt || '').slice(0, 10),
    issue.comments || 0,
    issue.issueFitScore || 0,
  ].join('|');

  const pool = all.slice(0, maxCandidates);
  const baseSize = pool.reduce((n, issue, index) => n + base(issue).length + String(index).length + 3, 0);
  const spare = Number.isFinite(budgetChars) ? budgetChars - header.length - 40 - baseSize : Infinity;
  const excerptChars = Number.isFinite(spare) ? Math.max(0, Math.min(200, Math.floor(spare / pool.length))) : 200;

  const lines = [];
  let used = header.length + 40;
  const included = [];
  for (const issue of pool) {
    const excerpt = excerptChars
      ? String(issue.body || '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, excerptChars)
      : '';
    const line = `${included.length}|${base(issue)}|${excerpt}`;
    if (Number.isFinite(budgetChars) && used + line.length + 1 > budgetChars) break;
    used += line.length + 1;
    lines.push(line);
    included.push(issue);
  }
  if (included.length < 2) return new Map();

  const raw = await request({
    system: TRIAGE_PROMPT,
    user: `Candidates (${included.length}), one per line:\n${header}\n${lines.join('\n')}`,
    maxTokens: 4000,
    temperature: 0.1,
  });
  const ranked = Array.isArray(raw && raw.ranked) ? raw.ranked : [];
  const result = new Map();
  for (const entry of ranked) {
    const byId = entry && entry.id !== undefined && included[Number(entry.id)];
    const url = String((byId && byId.url) || (entry && entry.url) || '').trim().toLowerCase();
    const score = Number(entry && entry.score);
    if (!url || !Number.isFinite(score)) continue;
    result.set(url, { score: Math.max(0, Math.min(100, score)), reason: String(entry.reason || '').slice(0, 200) });
  }
  return result;
}

module.exports = {
  fitDigestInput,
  requestJson,
  triageIssues,
  hasCloudProvider,
  parseLooseJson,
  trimForCloud,
  analyzeWithGemma: analyzeDigestWithModel,
  analyzeDigestWithModel,
  buildDeterministicDigest,
  validateDigest,
};
