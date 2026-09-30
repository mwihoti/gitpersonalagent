'use strict';

// Model provider chain.
//
// Every cloud provider here speaks the OpenAI chat-completions protocol, so
// one client serves all of them. Each provider has an ordered model list; the
// chain walks provider → model until one returns a usable answer.
//
//   MODEL_PROVIDERS   order to try, default "gemini,groq,xai,fallback"
//   GEMINI_API_KEY    GEMINI_MODELS   (comma-separated, first is preferred)
//   GROQ_API_KEY      GROQ_MODELS
//   XAI_API_KEY       XAI_MODELS      (GROK_API_KEY / GROK_MODELS also accepted)
//   FALLBACK_API_KEY  FALLBACK_API_URL  FALLBACK_MODELS
//                     any other OpenAI-compatible endpoint: OpenRouter,
//                     Cerebras, Together, DeepSeek, Mistral, a self-hosted vLLM…
//
// Failure handling per response:
//   401 / 403            key or project problem → skip the whole provider
//   413                  payload too large → retry once with a compacted prompt
//   anything else        (404 retired model, 429, 5xx, timeout, bad JSON)
//                        → next model, then next provider

function list(value, fallback) {
  const items = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function env(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return '';
}

function tpm(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Providers whose key was rejected (401/403) in this process. A blocked key
// stays blocked, so there is no point calling it again for every request.
const deadProviders = new Set();

function resetProviderState() {
  deadProviders.clear();
}

function providerRegistry() {
  return {
    gemini: {
      label: 'Gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: env('GEMINI_API_KEY'),
      models: list(env('GEMINI_MODELS'), ['gemini-2.5-flash-lite', 'gemini-2.5-flash']),
      jsonMode: true,
      maxTokensCap: 16000,
      tpm: tpm('GEMINI_TPM', 0),
    },
    groq: {
      label: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: env('GROQ_API_KEY'),
      // Verified with `npm run check-models` on 2026-09-30. Retired names
      // (llama-3.3-70b-versatile, llama-3.1-8b-instant) are gone; run
      // `npm run check-models -- --list` to see what your key can use.
      models: list(env('GROQ_MODELS'), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']),
      jsonMode: false,
      maxTokensCap: 8192,
      // Groq's free "on_demand" tier allows 8,000 tokens per minute per model,
      // counting prompt plus requested output. Raise GROQ_TPM on a paid tier
      // (or set 0 for no limit) to send fuller prompts.
      tpm: tpm('GROQ_TPM', 8000),
    },
    xai: {
      label: 'xAI Grok',
      url: 'https://api.x.ai/v1/chat/completions',
      apiKey: env('XAI_API_KEY', 'GROK_API_KEY'),
      models: list(env('XAI_MODELS', 'GROK_MODELS'), ['grok-4.3', 'grok-4.5']),
      jsonMode: true,
      maxTokensCap: 16000,
      tpm: tpm('XAI_TPM', 0),
    },
    fallback: {
      label: env('FALLBACK_LABEL') || 'Fallback',
      url: env('FALLBACK_API_URL'),
      apiKey: env('FALLBACK_API_KEY'),
      models: list(env('FALLBACK_MODELS', 'FALLBACK_MODEL'), []),
      jsonMode: false,
      maxTokensCap: 8192,
      tpm: tpm('FALLBACK_TPM', 0),
    },
  };
}

// Providers that are usable right now, in the configured order.
function activeProviders(options = {}) {
  const registry = providerRegistry();
  const order = list(env('MODEL_PROVIDERS'), ['gemini', 'groq', 'xai', 'fallback']).map(name => name.toLowerCase());
  const providers = [];
  for (const name of order) {
    const provider = registry[name === 'grok' ? 'xai' : name];
    if (!provider || !provider.apiKey) continue;
    if (options.live && deadProviders.has(name === 'grok' ? 'xai' : name)) continue;
    if (!provider.url || !provider.models.length) {
      console.warn(`  ${provider.label}: key is set but ${provider.url ? 'FALLBACK_MODELS' : 'FALLBACK_API_URL'} is missing — skipping`);
      continue;
    }
    if (!providers.some(existing => existing.url === provider.url)) {
      providers.push({ name: name === 'grok' ? 'xai' : name, ...provider });
    }
  }
  return providers;
}

function hasCloudProvider() {
  return activeProviders().length > 0;
}

function compact(message) {
  return fitPrompt(String(message).replace(/\n\s{2,}/g, '\n'), 9000);
}

// Shorten a prompt to maxChars while keeping its ending, which is where the
// task instruction lives.
function fitPrompt(text, maxChars) {
  const value = String(text);
  if (!Number.isFinite(maxChars) || value.length <= maxChars) return value;
  const marker = '\n…[trimmed to fit the model rate limit]…\n';
  const tail = Math.min(600, Math.floor(maxChars / 4));
  const head = Math.max(0, maxChars - tail - marker.length);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function firstLine(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// What one request may spend on a provider with a tokens-per-minute limit:
// roughly a third for the answer, the rest for the prompt. ~3 chars per token
// is deliberately conservative for JSON and code.
function budgetFor(provider, requestedMaxTokens, systemLength = 0) {
  const cap = Math.min(requestedMaxTokens, provider.maxTokensCap || requestedMaxTokens);
  if (!provider.tpm) return { maxTokens: cap, promptChars: Infinity };
  const maxTokens = Math.min(cap, Math.floor(provider.tpm * 0.35));
  const promptTokens = provider.tpm - maxTokens - 200;
  return { maxTokens, promptChars: Math.max(1500, promptTokens * 3 - systemLength) };
}

// Prompt size (chars) the provider that will most likely answer can take.
// Callers use it to build a prompt that fits instead of having it truncated.
function promptBudget({ system = '', maxTokens = 8000 } = {}) {
  const [first] = activeProviders({ live: true });
  if (!first) return Infinity;
  return budgetFor(first, maxTokens, String(system).length).promptChars;
}

// True when the likely provider is tightly rate limited: callers should send
// requests one at a time and keep outputs short.
function isTightBudget() {
  const [first] = activeProviders({ live: true });
  return Boolean(first && first.tpm && first.tpm <= 20000);
}

function retryDelayMs(headers, text) {
  const header = headers && headers.get ? Number(headers.get('retry-after')) : NaN;
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const match = String(text || '').match(/try again in (?:(\d+)m)?\s*([\d.]+)(ms|s)/i);
  if (!match) return 0;
  const minutes = Number(match[1] || 0);
  const value = Number(match[2] || 0);
  return Math.ceil(minutes * 60000 + (match[3] === 'ms' ? value : value * 1000));
}

// gpt-oss and similar reasoning models spend output tokens on hidden
// reasoning first. Low effort leaves the budget for the actual answer.
function reasoningEffort(provider, model) {
  const configured = env(`${provider.name.toUpperCase()}_REASONING_EFFORT`, 'MODEL_REASONING_EFFORT').toLowerCase();
  if (configured === 'off' || configured === 'none') return '';
  if (provider.name === 'groq' && /gpt-oss/i.test(model)) return configured || 'low';
  return '';
}

async function callModel(provider, model, { system, user, maxTokens, temperature, timeoutMs, jsonMode, plain = false }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: Math.min(maxTokens, provider.maxTokensCap || maxTokens),
  };
  if (jsonMode && !plain) body.response_format = { type: 'json_object' };
  const effort = plain ? '' : reasoningEffort(provider, model);
  if (effort) body.reasoning_effort = effort;

  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.ok) {
    const data = await res.json();
    return { ok: true, content: data.choices?.[0]?.message?.content || '' };
  }
  const text = await res.text().catch(() => '');
  return { ok: false, status: res.status, error: firstLine(text), retryAfterMs: res.status === 429 ? retryDelayMs(res.headers, text) : 0 };
}

// Walk the chain until a model returns something `parse` accepts.
// Returns { value, provider, model }. Throws with a summary when all fail.
//
// Rate limits (429) are handled in two steps: first move on to the next model,
// which has its own quota; if every model is rate limited, wait for the
// soonest reset and go around again, up to MODEL_RATE_LIMIT_WAIT_SECONDS.
async function runChain({ system, user, parse, maxTokens = 8000, temperature = 0.3, timeoutMs = 120_000, logger = console }) {
  if (!activeProviders().length) {
    throw new Error('No cloud model provider is configured');
  }

  // Serverless requests cannot sit out a rate limit; background scans can.
  const waitBudgetMs = tpm('MODEL_RATE_LIMIT_WAIT_SECONDS', process.env.VERCEL ? 15 : 150) * 1000;
  const deadline = Date.now() + waitBudgetMs;
  const attempts = [];
  const failedModels = new Set();

  for (let pass = 0; pass < 5; pass += 1) {
    const providers = activeProviders({ live: true });
    let soonestReset = Infinity;

    for (const provider of providers) {
      let skipProvider = false;
      for (const model of provider.models) {
        if (skipProvider) break;
        const key = `${provider.name}/${model}`;
        if (failedModels.has(key)) continue;

        const budget = budgetFor(provider, maxTokens, String(system).length);
        let message = fitPrompt(user, budget.promptChars);
        const jsonMode = provider.jsonMode;
        let plain = false;

        for (let round = 0; round < 2; round += 1) {
          logger.log(`  Sending to ${provider.label} (${model}${round ? ', retry' : ''})...`);
          let result;
          try {
            result = await callModel(provider, model, { system, user: message, maxTokens: budget.maxTokens, temperature, timeoutMs, jsonMode, plain });
          } catch (error) {
            attempts.push(`${provider.label}/${model}: ${firstLine(error.message, 120)}`);
            logger.warn(`  ${provider.label} ${model} request failed (${firstLine(error.message, 120)}) — trying next...`);
            failedModels.add(key);
            break;
          }

          if (result.ok) {
            try {
              if (!String(result.content || '').trim()) throw new Error('empty answer (output budget spent on reasoning?)');
              return { value: parse(result.content), provider: provider.name, model };
            } catch (error) {
              attempts.push(`${provider.label}/${model}: unusable answer (${firstLine(error.message, 80)})`);
              logger.warn(`  ${provider.label} ${model} returned an unusable answer — trying next...`);
              failedModels.add(key);
              break;
            }
          }

          if (result.status === 401 || result.status === 403) {
            attempts.push(`${provider.label}: ${result.status} ${result.error}`);
            logger.warn(`  ${provider.label} rejected the key (${result.status} ${result.error}) — skipping this provider for the rest of the run`);
            deadProviders.add(provider.name);
            skipProvider = true;
            break;
          }
          if (result.status === 429) {
            const delay = result.retryAfterMs || 20_000;
            soonestReset = Math.min(soonestReset, delay);
            attempts.push(`${provider.label}/${model}: 429 rate limited`);
            logger.warn(`  ${provider.label} ${model} is rate limited (resets in ~${Math.ceil(delay / 1000)}s) — trying next...`);
            break;
          }
          if (result.status === 413 && round === 0) {
            logger.warn(`  ${provider.label} ${model}: request too large — retrying with a compact payload...`);
            message = compact(user);
            continue;
          }
          // A 400 can mean an optional parameter (JSON mode, reasoning effort)
          // is not supported by this model: retry once with a bare request.
          if (result.status === 400 && !plain && round === 0 && !/model_not_found|does not exist/i.test(result.error)) {
            logger.warn(`  ${provider.label} ${model}: request rejected (${result.error.slice(0, 100)}) — retrying without optional parameters...`);
            plain = true;
            continue;
          }

          attempts.push(`${provider.label}/${model}: ${result.status} ${result.error}`);
          const hint = result.status === 404 || /not found|decommission|deprecat|does not exist/i.test(result.error)
            ? ` — model looks retired; set ${provider.name.toUpperCase()}_MODELS`
            : '';
          logger.warn(`  ${provider.label} ${model} failed (${result.status} ${result.error})${hint} — trying next...`);
          failedModels.add(key);
          break;
        }
      }
    }

    // Nothing was rate limited, so waiting would not help.
    if (soonestReset === Infinity) break;
    const wait = Math.min(soonestReset + 1000, 65_000);
    if (Date.now() + wait > deadline) break;
    logger.warn(`  Every model is rate limited — waiting ${Math.ceil(wait / 1000)}s for the quota to reset...`);
    await sleep(wait);
  }

  throw new Error(`All model providers failed: ${[...new Set(attempts)].join(' | ')}`);
}

// Ping every configured provider/model with a tiny prompt. Used by
// `npm run check-models` to find dead keys and retired models before a scan does.
async function probeModels({ timeoutMs = 30_000 } = {}) {
  const results = [];
  for (const provider of activeProviders()) {
    for (const model of provider.models) {
      const started = Date.now();
      try {
        const result = await callModel(provider, model, {
          system: 'You are a health check.',
          user: 'Reply with exactly: {"ok":true}',
          maxTokens: 400,
          temperature: 0,
          timeoutMs,
          jsonMode: false,
        });
        const answer = result.ok ? firstLine(result.content, 60) : '';
        results.push({
          provider: provider.name,
          model,
          // Reachable but silent is not usable for a scan.
          ok: result.ok && Boolean(answer),
          status: result.ok ? 200 : result.status,
          detail: result.ok ? (answer || 'reachable, but returned an empty answer') : result.error,
          ms: Date.now() - started,
        });
      } catch (error) {
        results.push({ provider: provider.name, model, ok: false, status: 0, detail: firstLine(error.message, 120), ms: Date.now() - started });
      }
    }
  }
  return results;
}

// Model ids each configured key can actually use (GET <base>/models).
async function listAvailableModels({ timeoutMs = 20_000 } = {}) {
  const out = [];
  for (const provider of activeProviders()) {
    const url = provider.url.replace(/\/chat\/completions\/?$/, '/models');
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        out.push({ provider: provider.name, label: provider.label, models: [], error: `${res.status} ${firstLine(await res.text().catch(() => ''), 120)}` });
        continue;
      }
      const data = await res.json();
      const models = (data.data || data.models || [])
        .map(item => String(item.id || item.name || '').replace(/^models\//, ''))
        .filter(Boolean)
        .sort();
      out.push({ provider: provider.name, label: provider.label, models, error: '' });
    } catch (error) {
      out.push({ provider: provider.name, label: provider.label, models: [], error: firstLine(error.message, 120) });
    }
  }
  return out;
}

// Safe-to-expose summary for /api/health and logs: names only, never keys.
function describeProviders() {
  return activeProviders().map(provider => ({ name: provider.name, label: provider.label, models: provider.models }));
}

module.exports = {
  activeProviders,
  describeProviders,
  fitPrompt,
  hasCloudProvider,
  isTightBudget,
  listAvailableModels,
  promptBudget,
  resetProviderState,
  probeModels,
  runChain,
};
