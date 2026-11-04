# Bitcoin Contributor Intelligence — technical overview

*How the scan, the bot, and the dashboard fit together. Current as of November 2026; the code is at [github.com/mwihoti/gitpersonalagent](https://github.com/mwihoti/gitpersonalagent).*

## 1. What the system does

Once a day the system reads the open issues of a set of Bitcoin open-source repositories, works out which ones a contributor could realistically pick up, reads those closely, and delivers the result as a Telegram digest and a web queue. It also remembers what it has shown before, what happened to each item, and (for the owner) watches pull requests that came out of it.

Three surfaces, one codebase:

| Surface | Where it runs | What it does |
|---|---|---|
| Daily scan | GitHub Actions (`scan.yml`, 05:00 UTC daily) | Fetch, rank, analyse, store, deliver |
| Telegram bot | Vercel function (`api/telegram.js`) via webhook | Commands, repo browser, personal matching, dashboard keys |
| Dashboard + API | Vercel (`public/`, `api/`, `src/api/`) | Queue view, repo view, scan history, locked behind per-person keys |

Node.js, CommonJS, no framework. About 9,100 lines across 30 modules in `src/`, with 206 tests under `node --test`.

## 2. Architecture

```
                ┌──────────────────────────────┐
                │ GitHub Actions               │
  05:00 UTC ───►│ scan.yml / telegram-scan.yml │──► src/run-scan.js
                └──────────────────────────────┘          │
                         ▲ repository_dispatch            │ reads
                         │                                ▼
┌──────────────┐   ┌─────────────┐          ┌──────────────────────┐
│ Telegram     │──►│ Vercel      │          │ GitHub REST API      │
│ users        │◄──│ api/*.js    │          │ bitcoindevs.xyz      │
└──────────────┘   └─────────────┘          │ model providers      │
                         │                  └──────────────────────┘
                         ▼                                │ writes
                ┌──────────────────────────────┐          │
                │ Neon Postgres                │◄─────────┘
                │ opportunities · subscribers  │
                └──────────────────────────────┘
                         ▲
                ┌──────────────┐
                │ Dashboard    │  public/app.js → /api/opportunities …
                └──────────────┘
```

The important constraint shaping this: Vercel functions have seconds, a full scan needs minutes to hours. So the webhook never scans. When a user sends `/scan`, `api/telegram.js` fires a `repository_dispatch` event and GitHub Actions does the work with a six-hour budget, then posts the digest back to the chat that asked. The daily cron is the same job on a schedule. Both share one concurrency group (`repo-scan`) so two scans never run at once.

## 3. The scan pipeline (`src/run-scan.js`)

Each stage is a function that takes the previous stage's output; the orchestrator just threads them together and times each one.

### 3.1 Targets

`src/repositories.js` merges two lists: the projects currently listed on [bitcoindevs.xyz/good-first-issues](https://bitcoindevs.xyz/good-first-issues) (scraped by `src/bitcoindevs.js`, typically 16–18 repos) and a watchlist held in the database. `BITCOINDEVS_MODE=merge` is the default. Separately, `src/bitcoin-ecosystem.js` is a hand-written catalogue of 42 projects in 11 areas (Consensus & Node, Lightning, Wallets & Keys, Libraries & Primitives, Privacy, Payments & Merchant, Ecash & L2, Mining, Infrastructure & Explorers, Design & UX, Education & Docs). The catalogue drives `/projects` and `/areas` and the matching; the scan targets are the smaller live list.

### 3.2 Fetch and rank (`src/github.js`, `src/repo-insights.js`)

For each repo, `listAllOpenIssues` pages through every open issue (not just the newest page — an early version capped at 20 and missed most of the good ones). Pull requests are filtered out. Each issue gets a heuristic `issueFitScore` from `buildIssueFitScore`: labels (`good first issue`, `help wanted`, `bug` up; `needs design`, `blocked` down), age, comment activity, assignee presence, and whether the body has enough to work from. The top 40 per repo form a pool; the best `SCAN_DETAIL_PER_REPO=10` get a second read with comments.

Claim detection (`detectClaim`) looks at assignees and the last comments for "I'll take this", "working on it", linked PRs. A claim older than `CLAIM_TTL_DAYS=45` with no PR is treated as stale and the issue comes back into play.

The GitHub client handles the rate-limit headers itself: it reads `x-ratelimit-remaining`/`reset` and sleeps rather than failing, and it degrades to anonymous (60 req/h) if the token is bad, which `api/health.js` reports as `githubAuth`.

### 3.3 Dedupe and triage

Before any model is called, `src/issue-tracking.js` compares candidates against every record already in the database. Issues already surfaced and unchanged are dropped; changed ones (new comments, label changes, claim appeared) are marked as updates. This is the fix for the "same digest every day" problem: the dedupe used to read a local file that was empty in CI.

A cheap triage pass (`triageIssues` in `src/gemma.js`) then asks a model to score the whole remaining pool in one call. Its scores are blended with the heuristic score rather than replacing it, so a bad model day cannot wreck the ordering.

### 3.4 Digest selection

The model is given the ranked, deduped candidates and asked for a structured JSON digest: for each pick, `opportunity`, `repo`, `issueUrl`, `effort`, `priority`, `score`, and a one-paragraph reason. Default mode asks for 15 picks (`/scan N` overrides; `all`, `goodfirst`, `medium` modes have their own limits). `fitDigestInput` trims the prompt to the provider's token budget. Output is validated field by field (`assertString`, enum checks) so a malformed answer fails loudly instead of leaking into the database.

### 3.5 Deep analysis (`src/issue-analysis.js`, `src/issue-context.js`)

This is where the output stops being generic. For each pick, `buildIssueContext` assembles:

- the issue body and the **full comment thread in order** (fetched from the last page backwards so the most recent discussion is never cut);
- linked pull requests and their state;
- the repository's `CONTRIBUTING.md` (or equivalent);
- excerpts of the source files the thread mentions.

A second model call returns a grounded plan: `currentState` (one of `available`, `claimed`, `has_open_pr`, `likely_done`, `stale`, `blocked`, `needs_design`, `needs_clarification`), what the maintainers want, files involved, a first step, pitfalls, acceptance criteria, `effort` and `impact`. Results are cached by issue URL + `updated_at` so repeated views cost nothing. Deep analysis is skipped inside a Vercel function (no time) unless `DIGEST_DEEP_ANALYSIS=true`; Actions is where it runs.

### 3.6 Changes, housekeeping, learning, follow-through

- **Changelog digest**: for items already in the queue, re-check status and report closed/merged/claimed changes in a compact block.
- **Queue housekeeping** (`src/queue-refresh.js`): re-verify open items, mark done ones, drop stale ones. Also runnable with `npm run refresh-queue`.
- **Learning loop** (`src/feedback.js`): every outcome on a tracked record (claimed +1.5, PR opened +2, merged +3, dismissed −2, never looked at 0) becomes a weight per repo, label, language, effort and source. Those weights nudge the heuristic score (capped at ±12) and are summarised into a short "contributor profile" for the model prompt. The loop is shared across the workspace, not per user.
- **PR follow-through** (`src/pr-tracking.js`): for every In Progress record with a PR URL, fetch the PR and reduce it to one actionable state (`merged`, `closed`, `draft`, `needs_rebase`, `ci_failing`, `changes_requested`, `approved`, `ci_pending`, `in_review`, `awaiting_review`), flag anything quiet for more than `PR_STALL_DAYS=5` days, and include a nudge in the digest. Owner-only.

### 3.7 Save and deliver

`saveDigest` in `src/airtable.js` (the name is historical) upserts to Postgres and appends to the activity log. `deliverDigest` in `src/whatsapp.js` then sends:

- a **public digest** to every subscriber without a profile;
- a **"Picked for you"** digest to each subscriber with a GitHub profile, filtered through `src/matching.js`.

Messages are HTML: one index message listing the picks, then one detail message per new or updated item (files to change, first step, pitfalls), with the "still open" and "closed" lists capped and ending in "…and N more in the dashboard" rather than being cut mid-item.

## 4. Model providers (`src/providers.js`)

```
MODEL_PROVIDERS = gemini → groq → xai → fallback
```

Each provider lists its models in order. `requestJson` walks the chain:

- **401/403** from a provider: skip the whole provider (bad key, suspended account).
- **404** on a model: skip that model (retired; this happened to `llama-3.3-70b-versatile`).
- **429**: try the next model, then wait for the window and retry.
- Everything fails: the **deterministic fallback** builds a digest from heuristic scores alone, so a digest always goes out.

Token budgets are learned, not configured: the client reads `x-ratelimit-limit-tokens` from responses and `promptBudget()` sizes subsequent prompts to fit. On Groq's free tier (8k TPM) that means deep analysis runs with concurrency 1 and tight context; on Gemini it runs wider. Groq's `openai/gpt-oss-120b`/`20b` are called with `reasoning_effort: low` because at default effort they spent the entire budget thinking and returned empty content.

`npm run check-models` hits every configured model with a one-token request and prints which are alive.

## 5. Storage (`src/db.js`, `src/airtable.js`, `src/subscribers.js`)

Neon Postgres over `@neondatabase/serverless` (HTTP, so it works inside short-lived functions). `src/db.js` is a 60-line seam: `query(text, params)` returns rows, `isConfigured()` reads `DATABASE_URL` at call time, and `isNetworkError()` distinguishes a dead network from a SQL mistake. Only the former triggers the local-JSON fallback in `data/`; a bad query throws.

Two tables, created by `npm run setup` (`scripts/setup-db.js`):

- **`opportunities`** (31 columns): identity (`issue_url`, `repo`, `number`), the digest fields, deep-analysis fields, `status` (New / In Progress / Done / Dismissed), `pr_url`, `activity` log, `first_seen`/`last_seen`, `digest_id`.
- **`subscribers`** (11 columns): keyed on `(chat_id, bot_id)` so the same person on two bots is two subscriptions; `profile` JSON (GitHub-derived skills plus `/skills` and `/level` overrides) written only by `setSubscriberProfile` so re-subscribing never wipes it; `dashboard_key` as a SHA-256 hash.

The project started on Airtable, hit the 1,000-row ceiling and the monthly API cap, and moved. The module names and the local file format did not change, which is why `airtable.js` still holds the Postgres opportunities store.

## 6. Telegram bot (`src/whatsapp.js`, `src/browse.js`, `src/profile.js`, `src/matching.js`)

`api/telegram.js` receives webhook updates (secret-checked), parses the command, and answers inline. On deploy, `api/setup-webhook.js` re-registers the webhook URL and secret so a redeploy can never leave the bot pointed at a stale URL.

| Command | Who | What |
|---|---|---|
| `/start`, `/stop`, `/status`, `/help` | anyone | subscribe, unsubscribe, bot health |
| `/scan [N\|all\|goodfirst\|medium]` | subscribers | dispatch a scan to Actions; digest returns to this chat |
| `/analyze <issue url>` | anyone | deep analysis of one issue (section 3.5), cached |
| `/repos` | anyone | interactive browser: one button per scanned repo → its 10 best open issues, re-sortable Best fit / Good first / High priority, or the cross-repo queue |
| `/projects [area]`, `/areas`, `/issues` | anyone | the 42-project catalogue by area; what is open now |
| `/github <user>`, `/skills …`, `/level …`, `/me`, `/forget`, `/match` | anyone | build a profile from public GitHub data (no OAuth), override it, see matches now |
| `/dashboard` | subscribers | issue a personal dashboard key (`wk_` + 32 hex); reissuing revokes the old one |
| `/pr <issue url> <pr url>` | owner | link a PR to a record for follow-through |
| Claim / Dismiss buttons | owner | change record status; dismiss asks for a reason (too big / not my stack / taken / not interesting) that feeds the learning loop |

The repo browser is deliberately cheap: a button tap scans with `detail: 0, maxItems: 300` (list-data scores only, newest 300 for huge repos) so it answers in a few seconds inside a function. Callback data is packed into Telegram's 64-byte limit (`b:r:<sort>:<owner/repo>`). Scan targets are cached ten minutes so taps do not re-scrape bitcoindevs.xyz.

Profiles come from the public GitHub API only: languages across the user's repos, repos they have contributed to, account age. `src/matching.js` scores each queue item against that profile plus the `/skills` and `/level` overrides and explains the match ("Matched to Rust, privacy").

## 7. Dashboard and auth (`public/`, `src/auth.js`)

The dashboard is static HTML/JS with three views (queue, repos, scans) reading `/api/opportunities`, `/api/repositories`, `/api/health`. `src/auth.js` decides access:

- If `DAN_AGENT_API_KEY` is set, it is the owner key.
- Any `wk_…` key is hashed and looked up in `subscribers.dashboard_key`.
- Open access only when there is **no** owner key **and** no database (local development).

A `/dashboard` link from the bot carries `#key=` in the fragment; `public/app.js` consumes it, stores it locally, and strips it from the URL. Visitors without a key see a locked welcome explaining how to get one rather than an auto-opening modal (the modal was the worst thing about the mobile experience). A 401 says exactly what to do: "Send /dashboard to the Telegram bot…".

`api/health.js` is public and reports storage mode, GitHub auth state, the model chain, bot username, the current run, the last 30 runs with timings, and the schedule.

## 8. Operations

- **Deploy**: `npx vercel --prod` after merging to `main`. Git integration is not wired to auto-deploy. Production domain `www.btcopensource.space` (the apex redirects to it); `btc-opensource-projects.vercel.app` and `danpersonalagent.vercel.app` remain as aliases so old links keep working.
- **Schedules**: `scan.yml` daily 05:00 UTC; `weekly-digest.yml` Mondays 06:00 UTC; `telegram-scan.yml` on dispatch. All in the `danpersonaagent` Actions environment.
- **Secrets**: `GITHUB_TOKEN` (fine-grained, public repos, Issues: read-only), `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, provider keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`), optional `DAN_AGENT_API_KEY`.
- **Tests**: `npm test` (`node --test`, 206 tests). Tests stub modules via `require.cache` and pin `DATABASE_URL=''` so a developer's real `.env` cannot leak in; `db.js` reads the env at call time for the same reason.
- **Tuning knobs**: `DIGEST_OPPORTUNITY_LIMIT`, `DIGEST_ANALYZE_LIMIT`, `DIGEST_DEEP_ANALYSIS`, `DIGEST_TRIAGE`, `SCAN_DETAIL_PER_REPO`, `CLAIM_TTL_DAYS`, `PR_STALL_DAYS`, `BITCOINDEVS_MODE`, `BITCOINDEVS_MAX_REPOS`.

## 9. Known limits

- One shared workspace. Everyone with a key sees and edits the same queue and watchlist on the dashboard; in Telegram, the claim/dismiss buttons and `/pr` are owner-only. Per-person workspaces are the obvious next step.
- The learning loop is workspace-wide, so it learns the owner's taste.
- Profiles are only as good as public GitHub activity; a private-repo contributor looks like a newcomer.
- Deep analysis is bounded by provider budgets; on a tight free tier a 15-pick digest can take most of an hour.
- No CI yet; tests run locally before each PR.

## 10. Lessons that shaped the design

1. **Read before you summarise.** A model given a title produces a title. Given the thread, linked PRs, contributing guide and source, it produces a plan. The input is the product.
2. **Remember what you said.** Dedupe against durable storage, not a file that is empty in CI.
3. **Free tiers are the environment, not an exception.** Provider chain, learned budgets, model liveness check, deterministic fallback. The digest goes out regardless.
4. **Never scan in a function.** Dispatch to a runner with hours and report back.
5. **Hash anything that opens a door.** Dashboard keys are stored as SHA-256; reissue revokes.
