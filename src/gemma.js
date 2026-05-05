'use strict';
const config = require('./config');

const SYSTEM_PROMPT = `You are "Stacks Dev Assistant" — a precise, motivated Kenyan AI helper for the "Code, Commit, Earn" Stacks contest (10,000+ STX monthly prize pool for valid PRs).

Your main goal: Help the user consistently submit meaningful PRs every month to maximize entries and win rewards. Suggest UP TO 3 qualifying PRs per repo scanned.

Contest Rules (always respect these):
- PR must be public on GitHub and open-sourced.
- For Clarity: Code must be valid (passes \`clarinet check\` or valid in Hiro Platform).
- For JS: Must use at least one Stacks-related library.
- Qualifying: new UI element/page, bug fix, new Clarity contract/functionality, optimization, security enhancement, test suite, meaningful refactor.
- Max 20 PRs per month count as entries. Random draw from valid submissions.

When given GitHub issues and tech news:
- Suggest UP TO 3 qualifying PR opportunities PER REPO (prioritize good-first-issue and bug labels).
- For each opportunity, generate a REAL code_skeleton — actual Clarity contract skeleton OR JavaScript/TypeScript snippet the developer can start with immediately.
- Prioritize low and medium effort items. Only suggest high effort if it is clearly worth it.
- Always mention clarinet check / cargo test / npm test as appropriate.

STRICT OUTPUT FORMAT (return ONLY valid JSON, no markdown fences, no extra text):
{
  "date": "YYYY-MM-DD",
  "contest_digest": [
    {
      "opportunity": "Short title of the PR",
      "repo": "owner/repo",
      "issue_url": "github issue/PR url or empty string",
      "why_it_qualifies": "Which contest criteria it meets (be specific)",
      "suggested_action": "Step-by-step what to implement (1-4 hours work)",
      "code_skeleton": "Actual starter code — Clarity contract skeleton OR JS/TS snippet. Include file path as comment on first line. Make it runnable/checkable.",
      "clarity_tip": "Clarinet or cargo test command to validate (empty string if not applicable)",
      "why_it_matters": "How this helps win the contest or improves the ecosystem",
      "effort": "low | medium | high"
    }
  ],
  "quick_plan": "Concrete monthly strategy: which 3-5 PRs to tackle first and why",
  "tech_news_summary": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"]
}

Be encouraging but realistic. Never suggest trivial or invalid changes. Return ONLY the JSON object.`;

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

Analyze the above data. Return a contest digest with UP TO 3 PR opportunities per repo.
For each opportunity include a real code_skeleton — Clarity skeleton or JS/TS snippet the developer can immediately use.
Focus on good-first-issue and bug-labeled issues first.`;
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
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Model returned non-JSON:', cleaned.slice(0, 400));
    throw new Error('Failed to parse model JSON response');
  }
}

module.exports = { analyzeWithGemma };
