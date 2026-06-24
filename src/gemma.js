'use strict';
const config = require('./config');
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
  } = options;

  const limitInstruction = opportunityLimit
    ? `Return at most ${opportunityLimit} total opportunities across all repositories. Pick the highest-signal items only.`
    : 'Return a repository opportunity digest with UP TO 3 implementation opportunities per repo.';
  const codeInstruction = codeSkeletonLimit
    ? `Keep each code_skeleton under ${codeSkeletonLimit} characters.`
    : 'For each opportunity include a real code_skeleton the developer can immediately use.';

  return `Today is ${new Date().toISOString().slice(0, 10)}.

=== GITHUB SCAN (${scanLabel}) ===
${JSON.stringify(repoData, null, 2)}

=== LATEST TECH NEWS (titles only) ===
${summarizeNews(news, newsLimit)}

Analyze the above data. ${limitInstruction}
${codeInstruction}
Focus on good-first-issue, bug, help-wanted, and high-signal issues first.`;
}

// Trim repo data before sending to cloud APIs — keeps top 6 issues per repo
// (already sorted: good-first + bugs first), truncates bodies, drops recentPRs.
function trimForCloud(repoData, options = {}) {
  const {
    issuesPerRepo = 6,
    bodyChars = 200,
    includeRepoUrl = true,
  } = options;

  return repoData.map(r => ({
    repo: r.repo,
    ...(includeRepoUrl ? { repoUrl: r.repoUrl } : {}),
    issues: r.issues.slice(0, issuesPerRepo).map(i => ({
      number: i.number,
      title: i.title,
      body: (i.body || '').slice(0, bodyChars),
      labels: i.labels,
      url: i.url,
    })),
  }));
}

// Fallback chain (cloud): gemini-2.5-flash-lite → gemini-2.5-flash → Groq.
// Falls back to local Ollama when no cloud keys are set.
async function analyzeDigestWithModel(repoData, news) {
  const digestMode = process.env.DIGEST_MODE === 'weekly' ? 'weekly' : 'daily';
  const trimmedRepoData = trimForCloud(repoData, {
    issuesPerRepo: digestMode === 'weekly' ? 6 : 4,
    bodyChars: 120,
  });
  const userMessage = buildUserMessage(trimmedRepoData, news, {
    newsLimit: digestMode === 'weekly' ? 20 : 12,
    scanLabel: digestMode === 'weekly' ? 'weekly top prioritized issues per repo' : 'top prioritized issues per repo',
    opportunityLimit: digestMode === 'weekly' ? 12 : 8,
    codeSkeletonLimit: 700,
  });

  try {
    if (process.env.GEMINI_API_KEY) {
      return analyzeWithGemini(userMessage);
    }
    if (process.env.GROQ_API_KEY) {
      return analyzeWithGroq(userMessage);
    }
  } catch (error) {
    console.warn(`  Model analysis failed, using deterministic fallback: ${error.message}`);
  }

  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    try {
      return await analyzeWithOllama(buildUserMessage(repoData, news));
    } catch (error) {
      console.warn(`  Ollama analysis failed, using deterministic fallback: ${error.message}`);
    }
  }

  return buildDeterministicDigest(repoData, news);
}

// Try each Gemini model in order; on 503 move to the next.
// If all are unavailable, fall back to Groq (if key is set).
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

async function analyzeWithGemini(userMessage) {
  for (const model of GEMINI_MODELS) {
    console.log(`  Sending to Gemini (${model})...`);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: 12000,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || '';
      try {
        return parseJSON(raw);
      } catch (error) {
        console.warn(`  Gemini ${model} returned invalid JSON — trying fallback model/provider...`);
        continue;
      }
    }

    const errText = await res.text();

    if (res.status === 503) {
      console.warn(`  Gemini ${model} unavailable (503) — trying next...`);
      continue;
    }

    throw new Error(`Gemini error: ${res.status} ${errText}`);
  }

  // All Gemini models returned 503 — try Groq
  if (process.env.GROQ_API_KEY) {
    console.warn('  Gemini did not produce a usable digest — falling back to Groq...');
    return analyzeWithGroq(userMessage);
  }

  throw new Error('Gemini did not produce a usable digest and GROQ_API_KEY is not set');
}

async function analyzeWithGroq(userMessage) {
  const model = 'llama-3.3-70b-versatile';
  const attempts = [
    { label: 'full', message: userMessage },
    {
      label: 'compact',
      message: userMessage
        .replace(/\n\s{2,}/g, '\n')
        .slice(0, 9000),
    },
  ];

  for (const attempt of attempts) {
    console.log(`  Sending to Groq (${model}, ${attempt.label})...`);

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: attempt.message },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (res.ok) {
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || '';
      return parseJSON(raw);
    }

    const err = await res.text();
    if (res.status === 413 && attempt.label !== 'compact') {
      console.warn('  Groq request too large — retrying with compact payload...');
      continue;
    }

    throw new Error(`Groq error: ${res.status} ${err}`);
  }
}

async function analyzeWithOllama(userMessage) {
  const body = {
    model: config.ollama.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 8192,
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
  return parseJSON(raw);
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

function buildDeterministicDigest(repoData, news) {
  const issues = repoData.flatMap(repo => (repo.issues || []).map(issue => ({
    ...issue,
    repo: repo.repo,
  }))).sort((a, b) => {
    const scoreDiff = Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  }).slice(0, 8);

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

module.exports = {
  analyzeWithGemma: analyzeDigestWithModel,
  analyzeDigestWithModel,
  buildDeterministicDigest,
  validateDigest,
};
