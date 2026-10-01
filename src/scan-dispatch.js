'use strict';
// Hands a scan off to GitHub Actions.
//
// A full scan (GitHub + news + LLM) routinely outlives a serverless invocation,
// so on Vercel/Cloudflare we don't run it in the request. We trigger the
// `telegram-scan` workflow instead: it gets a 6-hour budget, runs the exact same
// `node agent.js --scan` path as the daily cron, and notifies subscribers when
// it finishes. The webhook returns in milliseconds either way.
//
// GitHub offers two ways to trigger a workflow, and they need DIFFERENT token
// permissions. Rather than force one on you, we try both:
//
//   workflow_dispatch    needs Actions: write     (cannot touch repo contents)
//   repository_dispatch  needs Contents: write    (can rewrite any file)
//
// workflow_dispatch is attempted first because it is the tighter permission —
// a leaked token could start scans but not push code. If the token doesn't
// carry Actions: write we fall back to repository_dispatch, so whichever
// permission you granted, /scan works.
//
// Env:
//   GITHUB_DISPATCH_REPO      owner/repo holding the workflow (defaults to
//                             GITHUB_REPOSITORY when running inside Actions)
//   GITHUB_DISPATCH_TOKEN     PAT with Actions: write OR Contents: write
//   GITHUB_DISPATCH_REF       branch holding the workflow file (default: main)
//   GITHUB_DISPATCH_WORKFLOW  workflow filename (default: telegram-scan.yml)
const EVENT_TYPE = 'telegram-scan';

function dispatchConfig() {
  return {
    repo: process.env.GITHUB_DISPATCH_REPO || process.env.GITHUB_REPOSITORY || '',
    token: process.env.GITHUB_DISPATCH_TOKEN || '',
    ref: process.env.GITHUB_DISPATCH_REF || 'main',
    workflow: process.env.GITHUB_DISPATCH_WORKFLOW || 'telegram-scan.yml',
  };
}

function isDispatchConfigured() {
  const { repo, token } = dispatchConfig();
  return Boolean(repo && token);
}

async function githubPost(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'danagent-bot',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  // GitHub answers 204 No Content on success for both dispatch endpoints.
  if (res.ok) return { ok: true };
  return {
    ok: false,
    status: res.status,
    detail: (await res.text().catch(() => '')).slice(0, 200),
  };
}

async function dispatchScan({ scanMode = 'default', chatId = '', botId = '', limit = 0 } = {}) {
  const { repo, token, ref, workflow } = dispatchConfig();
  if (!repo || !token) {
    throw new Error('GitHub Actions dispatch is not configured');
  }

  const chat = String(chatId || '');
  const bot = String(botId || '');
  const count = limit ? String(limit) : '';

  // 1. workflow_dispatch — Actions: write
  const viaWorkflow = await githubPost(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    token,
    { ref, inputs: { scan_mode: scanMode, chat_id: chat, bot_id: bot, limit: count } },
  );
  if (viaWorkflow.ok) return 'workflow_dispatch';

  // 2. repository_dispatch — Contents: write
  const viaRepository = await githubPost(
    `https://api.github.com/repos/${repo}/dispatches`,
    token,
    { event_type: EVENT_TYPE, client_payload: { scan_mode: scanMode, chat_id: chat, bot_id: bot, limit: count } },
  );
  if (viaRepository.ok) return 'repository_dispatch';

  throw new Error(describeFailure(viaWorkflow, viaRepository, { repo, ref, workflow }));
}

function describeFailure(viaWorkflow, viaRepository, { repo, ref, workflow }) {
  const codes = `workflow_dispatch=${viaWorkflow.status}, repository_dispatch=${viaRepository.status}`;

  if (viaWorkflow.status === 401 || viaRepository.status === 401) {
    return `GitHub rejected the token (401). GITHUB_DISPATCH_TOKEN is invalid, expired, or was pasted with stray whitespace. [${codes}]`;
  }

  if (viaWorkflow.status === 403 && viaRepository.status === 403) {
    return `Token lacks permission (403). Give GITHUB_DISPATCH_TOKEN either "Actions: Read and write" or "Contents: Read and write" on ${repo}. [${codes}]`;
  }

  // 404 on both usually means the token can't even see the repo.
  if (viaWorkflow.status === 404 && viaRepository.status === 404) {
    return `Not found (404) for ${repo}. Either the token has no access to that repo, or GITHUB_DISPATCH_REPO is wrong. [${codes}]`;
  }

  // workflow_dispatch 404 with a different repository_dispatch code points at
  // the workflow file itself rather than the token.
  if (viaWorkflow.status === 404) {
    return `Workflow ${workflow} not found on branch "${ref}" of ${repo}, and repository_dispatch also failed. Check GITHUB_DISPATCH_REF. [${codes}]`;
  }

  const detail = viaRepository.detail || viaWorkflow.detail || '';
  return `GitHub dispatch failed [${codes}] ${detail}`;
}

module.exports = {
  EVENT_TYPE,
  isDispatchConfigured,
  dispatchScan,
};
