'use strict';
const config = require('./config');

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
  } = options;

  return `Today is ${new Date().toISOString().slice(0, 10)}.

=== GITHUB SCAN (${scanLabel}) ===
${JSON.stringify(repoData, null, 2)}

=== LATEST TECH NEWS (titles only) ===
${summarizeNews(news, newsLimit)}

Analyze the above data. Return a repository opportunity digest with UP TO 3 implementation opportunities per repo.
For each opportunity include a real code_skeleton the developer can immediately use.
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
async function analyzeWithGemma(repoData, news) {
  const trimmedRepoData = trimForCloud(repoData, {
    issuesPerRepo: 4,
    bodyChars: 120,
  });
  const userMessage = buildUserMessage(trimmedRepoData, news, {
    newsLimit: 12,
    scanLabel: 'top prioritized issues per repo',
  });
  if (process.env.GEMINI_API_KEY) {
    return analyzeWithGemini(userMessage);
  }
  if (process.env.GROQ_API_KEY) {
    return analyzeWithGroq(userMessage);
  }
  return analyzeWithOllama(buildUserMessage(repoData, news));
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
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || '';
      return parseJSON(raw);
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
    console.warn('  All Gemini models unavailable — falling back to Groq...');
    return analyzeWithGroq(userMessage);
  }

  throw new Error('All Gemini models unavailable and GROQ_API_KEY is not set');
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
    return JSON.parse(stripped);
  } catch (_) {
    // Fallback: extract the outermost {...} block in case the model prepended
    // or appended prose around the JSON object.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (_2) { /* fall through to error */ }
    }
    console.error('Model returned non-JSON:', stripped.slice(0, 400));
    throw new Error('Failed to parse model JSON response');
  }
}

module.exports = { analyzeWithGemma };
