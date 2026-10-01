# Repository Intelligence Dashboard

An AI-powered operations dashboard that scans GitHub repositories for high-signal implementation opportunities, generates starter code, and delivers a daily digest to your team.

---

## What It Does

Every morning at 8am Nairobi time the agent:

1. **Scans GitHub** — pulls open issues from the repositories in your dashboard watchlist, prioritising `good first issue`, `help wanted`, and `bug` labels
2. **Fetches tech news** — TechCrunch, Wired, Ars Technica, TLDR Tech, GitHub Blog, GitHub Releases, Hacker News
3. **Analyses with a configured model provider** — walks a chain of Gemini, Groq, xAI Grok, and any OpenAI-compatible fallback, each with its own fallback models; uses Ollama locally when no cloud key is set
4. **Saves to Airtable** — structured database of opportunities with effort level, suggested action, and starter code
5. **Notifies via Telegram** — sends a digest with top opportunities and a short plan, with WhatsApp as fallback

---

## Architecture

```
agent.js                    ← Orchestrator + cron scheduler
src/
├── github.js               ← GitHub API scanner (issues + releases)
├── gemma.js                ← Model-provider interface + digest validation
├── news.js                 ← Multi-source news aggregator (RSS + APIs)
├── airtable.js             ← Airtable record writer
├── whatsapp.js             ← Telegram (primary) + WhatsApp/CallMeBot (fallback)
└── config.js               ← Environment variable loader
scripts/
└── setup-airtable.js       ← One-time Airtable field creator
```

**Data flow:**
```
GitHub API ─┐
            ├─→ LLM provider (Gemini/Groq/Ollama) ─→ JSON digest ─→ Airtable
News/RSS  ──┘                                                └─→ Telegram
```

---

## Prerequisites

- Node.js v18+
- An [Ollama account](https://ollama.com) (for `gemma4:31b-cloud`)
- A GitHub account (for the fine-grained token)
- An Airtable account
- A Telegram bot (via @BotFather)

---

## Local Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd danagent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your keys (see [Configuration](#configuration) below).

### 3. Set up Airtable table

Create a base in Airtable, then run:

```bash
npm run setup
```

If your network can't reach the Airtable API, create these fields manually in the Airtable UI:

| Field name | Type |
|---|---|
| Opportunity | Single line text |
| Date | Date |
| Repo | Single line text |
| Effort | Single select (`low`, `medium`, `high`) |
| Why It Qualifies | Long text |
| Suggested Action | Long text |
| Clarity Tip | Long text |
| Why It Matters | Long text |
| Quick Plan | Long text |
| Issue URL | URL |
| Code Skeleton | Long text |

<a name="subscribers-table"></a>
#### Subscribers table

For durable Telegram subscriptions (required in webhook/serverless mode), create a second table named `Subscribers` (override with `AIRTABLE_SUBSCRIBERS_TABLE`):

| Field name | Type |
|---|---|
| ChatId | Single line text |
| BotId | Single line text |
| Type | Single line text |
| Title | Single line text |
| Username | Single line text |
| First Name | Single line text |
| Last Name | Single line text |
| Subscribed At | Single line text |
| Last Seen At | Single line text |

### 4. Log in to Ollama

```bash
ollama login
```

### 5. Run a test scan

```bash
npm run scan
```

You should see the digest printed in terminal, a notification message, and new rows in Airtable.

### 6. Start the daily schedule

```bash
npm start
```

Runs at 8am Nairobi time (Africa/Nairobi) every day.

Scheduled scans use the dashboard watchlist first. If the watchlist is empty, the agent falls back to the BitcoinDevs good-first-issues page and scans the GitHub repositories linked there.

### 7. Run the public Telegram bot

```bash
node agent.js --bot
```

Bot mode runs the daily scheduler and listens for Telegram commands:

| Command | Who can use it | What it does |
|---|---|---|
| `/start` or `/subscribe` | Anyone | Subscribes that Telegram chat to daily digest notifications |
| `/stop` or `/unsubscribe` | Anyone | Unsubscribes that Telegram chat |
| `/status` | Anyone | Confirms the bot is running |
| `/help` | Anyone | Shows available commands |
| `/scan` | Admin chat only | Runs the normal top-priority scan immediately |
| `/scan all` | Admin chat only | Scans a broader set of open issues |
| `/scan goodfirst` | Admin chat only | Focuses on good-first/BitcoinDevs issues |
| `/scan medium` | Admin chat only | Focuses on medium-effort implementation issues |

Set `TELEGRAM_BOT_TOKEN` to make the bot public. Set `TELEGRAM_CHAT_ID` to your admin chat id if you want `/scan` to be available only to you.

Subscribed chats are stored in **Airtable** when `AIRTABLE_API_KEY` + `AIRTABLE_BASE_ID` are set (durable, works on serverless), and fall back to a local JSON file (`data/telegram-subscribers.json`, or `/tmp/danagent-data` on Vercel) for local development. See [Subscribers table](#subscribers-table) for the schema.

### 8. Run the bot on Vercel with webhooks (free, always responds)

Long-polling (`--bot`) needs a process running 24/7. On free serverless hosts that scale to zero (Vercel, and fly.io's auto-stop machines), that process dies and the bot goes silent. **Webhook mode** avoids this: Telegram pushes each message to `/api/telegram`, so the bot wakes on demand and responds instantly — no always-on worker, no cost.

The daily digest still runs via the Vercel cron already defined in `vercel.json` (`/api/scan`).

1. Deploy to Vercel and set the env vars (`TELEGRAM_BOT_TOKEN`, `AIRTABLE_*`, `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_DISPATCH_REPO`, `GITHUB_DISPATCH_TOKEN`, plus `CRON_SECRET` if you keep the Vercel cron).
2. Create the [Subscribers table](#subscribers-table) in Airtable so subscriptions survive cold starts.
3. Register the webhook once:

   ```bash
   PUBLIC_BASE_URL=https://your-app.vercel.app \
   TELEGRAM_WEBHOOK_SECRET=your_secret \
   npm run set-webhook
   ```

   Or pass the URL directly: `node scripts/set-webhook.js https://your-app.vercel.app`

   Useful flags: `node scripts/set-webhook.js --info` (status), `--delete` (revert to polling).

   **If your host marks the tokens and secret as sensitive** (Vercel does, so
   `vercel env pull` returns `[SENSITIVE]`), let the deployment register itself.
   It already holds the right values, so nothing has to be copied:

   ```bash
   curl https://your-app.vercel.app/api/setup-webhook            # show status
   curl -X POST https://your-app.vercel.app/api/setup-webhook    # register all bots
   ```

   Add `-H "X-API-Key: $DAN_AGENT_API_KEY"` when the dashboard key is set. The
   script refuses to register from a shell whose `.env` has fewer bots or no
   secret compared with the deployment, because that would silence the bot.

#### How `/scan` avoids the serverless timeout

A full scan (GitHub + news + LLM) routinely runs longer than a serverless
function is allowed to live. So the webhook **never runs the scan itself** —
it hands the job to GitHub Actions and returns in milliseconds:

```
Telegram → /api/telegram (ms)  ──repository_dispatch──→  GitHub Actions
                                                          (6-hour budget)
                                                                │
                                       digest → all subscribers ┘
```

Every command path is now fast, so nothing can time out:

| Command | Runs where | Response |
|---|---|---|
| `/start` `/stop` `/status` `/help` | webhook | instant |
| `/scan …` | queued to GitHub Actions | instant ack, digest when the run finishes |

To enable it, set `GITHUB_DISPATCH_REPO` (`owner/repo`) and
`GITHUB_DISPATCH_TOKEN` (a PAT with `contents: write`, **separate** from the
read-only scan token). The receiving workflow is
`.github/workflows/telegram-scan.yml`; you can also run it by hand from the
Actions tab. If the run fails, the requester gets a message with a link to it.

If dispatch is not configured, the webhook falls back to running the scan in the
background — fine for quick scans, but it can be cut short by `maxDuration`,
which is exactly why dispatch is recommended.

#### Running two bots from one deployment

Set a second token and both bots answer, each with its own audience:

```env
TELEGRAM_BOT_TOKEN=111111:AAA…      # primary
TELEGRAM_BOT_TOKEN_2=222222:BBB…    # second bot
```

`npm run set-webhook` then registers **one URL per bot**:

```
https://your-app.vercel.app/api/telegram?bot=111111
https://your-app.vercel.app/api/telegram?bot=222222
```

The `bot` parameter tells the webhook which token to reply through. Subscriptions
are stored per bot (the `BotId` column), because **a bot may only message chats
that started that same bot** — sharing one list across bots produces
`bot can't initiate conversation with a user` errors. The daily digest is sent to
each bot's own subscribers, through that bot's token.

`TELEGRAM_CHAT_ID` (the admin chat) is only auto-included for the **primary**
bot, for the same reason. Long-polling mode (`npm run bot`) polls every
configured bot in parallel.

Rows written before multi-bot support have an empty `BotId` and are treated as
belonging to the primary bot, so existing subscribers keep working.

**Considering Cloudflare Workers instead?** See
[`deploy/cloudflare.md`](deploy/cloudflare.md) for an honest comparison and a
step-by-step migration plan. Summary: with scans on GitHub Actions, the host
only serves a thin webhook, so Vercel is already sufficient.

---

## Model providers and fallbacks

Set any subset of keys. Providers are tried in `MODEL_PROVIDERS` order, and
each provider walks its model list left to right before handing over.

| Provider | Key | Models variable | Default models |
|---|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | `GEMINI_MODELS` | `gemini-2.5-flash-lite`, `gemini-2.5-flash` |
| Groq | `GROQ_API_KEY` | `GROQ_MODELS` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` |
| xAI Grok | `XAI_API_KEY` (or `GROK_API_KEY`) | `XAI_MODELS` | `grok-4.3`, `grok-4.5` |
| Anything OpenAI-compatible | `FALLBACK_API_KEY` + `FALLBACK_API_URL` | `FALLBACK_MODELS` | none, you choose |

`MODEL_PROVIDERS` defaults to `gemini,groq,xai,fallback`. Put your most
reliable provider first, for example `MODEL_PROVIDERS=groq,xai,gemini`.

How failures are handled:

- **401 or 403** (bad key, blocked project): the whole provider is skipped.
- **404, 429, 5xx, timeout, or unparseable answer**: the next model is tried,
  then the next provider. A 404 logs a hint to update that provider's models
  variable, since it usually means the model was retired.
- **413**: one retry with a compacted prompt.
- **Everything failed**: the scan still completes with the heuristic digest.

The fallback slot takes any endpoint that speaks the OpenAI chat-completions
protocol. OpenRouter example:

```env
FALLBACK_API_URL=https://openrouter.ai/api/v1/chat/completions
FALLBACK_API_KEY=sk-or-...
FALLBACK_MODELS=meta-llama/llama-3.3-70b-instruct,mistralai/mistral-small
```

### Rate limits and small free tiers

Groq's free tier allows **8,000 tokens per minute per model**, counting the
prompt and the requested answer. A full scan is far bigger than that, so the
pipeline budgets for it. The limit is **read from the API's own
`x-ratelimit-limit-tokens` header** on the first response, so upgrading your
Groq tier takes effect on the next scan with no configuration. `GROQ_TPM`
overrides it when set (`0` means no limit); the built-in default before the
first response is `8000`.

- Prompts are **built to fit**: the digest input drops detail per issue before
  it drops repositories, triage sends one compact line per candidate, and the
  analysis prompt keeps the issue, the newest comments, and the source.
- On a 429 the next model is tried first, since each model has its own quota.
  When every model is limited, the scan waits for the reset and continues, up
  to `MODEL_RATE_LIMIT_WAIT_SECONDS` per request (default 150, 15 on Vercel).
- Deep analyses run one at a time on a tight budget.
- A key rejected with 401/403 is skipped for the rest of the run.

Expect a scan on the free Groq tier to take about five minutes and to work
from short excerpts. A provider with a real quota (a working Gemini key, xAI,
or a paid Groq tier with `GROQ_TPM` raised, `0` for no limit) gives the model
full issue bodies and threads and is the single biggest quality upgrade.

Check the whole chain before relying on it:

```bash
npm run check-models
```

It sends a one-line prompt to every configured model and prints which ones
answer. Add `-- --list` to also print every model id your keys can use, which
is the reliable way to choose fallbacks since providers retire models often.
Groq's gpt-oss models are reasoning models; requests to them use
`reasoning_effort: low` so reasoning cannot use up the output budget
(`GROQ_REASONING_EFFORT=medium|high|off` overrides). `/api/health` also reports the active chain (names only, never keys).

On GitHub Actions, keys are environment **secrets** (`XAI_API_KEY`,
`FALLBACK_API_KEY`) and the rest are repository **variables**
(`MODEL_PROVIDERS`, `GEMINI_MODELS`, `GROQ_MODELS`, `XAI_MODELS`,
`FALLBACK_API_URL`, `FALLBACK_MODELS`).

---

## Deep issue analysis

The heuristic fit score gets an issue onto the list. The deep analysis is what
tells you whether to actually start. For each issue it reads:

- the full issue and the whole thread in order (long threads keep the opening
  and the latest comments);
- linked pull requests, with the files a same-repo PR touched;
- the project's `CONTRIBUTING.md`;
- the source files the issue mentions, resolved by path and, with a
  `GITHUB_TOKEN`, by code search for backticked identifiers such as
  `json_to_s64`. Excerpts are centred on the symbol.

The model returns a structured answer: what the maintainer wants with quoted
evidence, the current state (`available`, `claimed`, `has_open_pr`,
`likely_done`, `stale`, `blocked`, `needs_design`, `needs_clarification`),
questions to ask before starting, the files to change (marked ✓ when the path
was verified against the repo), a step plan, the validation command, effort,
impact, a confidence score, a grounded code skeleton, and an optional draft
comment for the issue. Without a model provider it degrades to the heuristic
insight so the shape is always the same.

Where it runs:

- **Daily digest:** the top `DIGEST_ANALYZE_LIMIT` picks (default 8) are
  analysed before sending. Items that turn out to be claimed or already have
  an open PR are dropped; the rest carry the maintainer summary, plan, files,
  and questions into Telegram and Airtable. Set `DIGEST_DEEP_ANALYSIS=false`
  to skip this step.
- **Workbench:** "Analyze issue" on any opportunity runs it on demand, stores
  the result on the record, and pre-fills Quick plan and Next step (unsaved
  until you press Save).
- **Repo scout:** "Analyze" on any issue card.
- **API:** `POST /api/issue-analysis` with `{ "url": "https://github.com/o/r/issues/1" }`
  (or `repo` + `number`), optional `force` and `recordId`.

Before the model picks, a cheap **triage pass** ranks every candidate (clear
ask, maintainer interest, narrow scope, not taken) and blends that with the
heuristic score. Set `DIGEST_TRIAGE=false` to skip it, or `true` to force it
with a local Ollama model.

From Telegram, `/analyze <issue url>` runs the same analysis and replies with
the maintainer summary, plan, files, and questions. Each opportunity detail
message carries two buttons: **I'll take it** sets the record to In Progress
with you as owner, **Not for me** marks it Done. Both write to Airtable.

Results are cached by issue URL and `updated_at` under `data/issue-analysis/`,
so re-opening an unchanged issue is free. Priority is now derived from impact
and effort together rather than effort alone. Optional Airtable columns
`Impact`, `Maintainer Wants`, `Files To Change`, `Open Questions`, and
`Analysis` (long text) persist the result; `npm run setup` creates them, and
they are silently skipped if absent.

---

## Learning loop and engineering follow-through

**Learning loop.** Every outcome on a tracked record feeds back into ranking:
merged PRs and claims count for a repo, its labels, language, and effort
level; dismissals count against them. The Telegram "Not for me" button asks
why (too big, not my stack, already taken, not interesting) and those reasons
sharpen the signal: "too big" penalises that effort level, "not my stack"
penalises that language. The learned weights nudge the fit score (capped at
±12 per factor, scaled by how much evidence exists) and the digest model gets a
one-paragraph contributor profile ("ships in rust-payjoin, dismisses docs
issues"). The dashboard's Learning loop card shows what the ranker has learned.
Optional Airtable columns `Labels` and `Language` make label and language
learning possible; without them repo and effort learning still work.

**Engineering follow-through.** For every In Progress record with a PR URL the
scan checks the pull request: merged, closed, draft, conflicts, CI failing,
changes requested, approved, or awaiting review. The digest gets a "Your work"
section that leads with items where the ball is in your court. A merged PR
marks the record Done and logs `[outcome merged]`, which is the strongest
positive signal for the learning loop. Items in progress with no PR for
`PR_STALL_DAYS` (default 5), or PRs that need you and have sat for that long,
get a nudge. Link a PR with `/pr <issue url> <pr url>` from Telegram or the PR
URL field in the workbench. Set `GITHUB_LOGINS` (comma-separated GitHub
usernames) and open PRs you authored on a tracked issue are linked
automatically.

---

## What the daily digest contains

The digest is a changelog, not a snapshot. Before the model runs, the scan
loads every issue already saved in Airtable (or the local store) and:

- drops issues that are unchanged since they were last recommended, so the
  same eight items do not come back every morning;
- drops issues somebody already owns: an assignee, an open PR in the same repo
  that references the issue, or a comment such as "I'll pick this up";
- keeps issues with new activity, and passes the latest comment to the model.

The Telegram summary then shows **New today**, **Updated since last digest**
(with the newest comment), **Closed or claimed since last digest**, and a short
**Still open** list. Detail messages are sent only for new and updated items.
Each line carries the issue age, last comment, assignee state, and any open PR.

More behaviours worth knowing:

- **Claims expire.** "I'll take this" with no PR after `CLAIM_TTL_DAYS`
  (default 45) no longer hides an issue. It is offered again with a
  "stale claim by X" note so you can ask before starting.
- **A claim is reported once.** After the note is written to the record's
  Activity Log it does not reappear, and the closed/claimed section is capped
  at `DIGEST_CLOSED_LIMIT` lines (default 6).
- **Scans never overlap.** All three workflows share one concurrency group.
- **`/scan`** reports what changed and says so when nothing did.
  `/scan all`, `/scan goodfirst`, and `/scan medium` show everything again,
  labelled "Seen before" where nothing moved.
- **Two bots.** Add `TELEGRAM_BOT_TOKEN_2` to the Actions environment so both
  audiences get digests. A chat subscribed to both bots receives one copy, and
  an on-demand scan answers through the bot it was requested on.
- **The queue cleans itself.** Each daily scan retires records whose issue
  closed upstream, notes a new assignee once, and archives items that nobody
  touched for `QUEUE_ARCHIVE_DAYS` (default 90). Archived and closed-upstream
  items carry no weight in the learning loop. Run it by hand, and give the
  survivors a deep analysis, with
  `npm run refresh-queue -- --apply --analyze 10` (dry run without `--apply`).
- **Storage problems are shown.** If Airtable refuses new rows (the free plan
  caps records per base), the digest says so. Run
  `npm run dedupe-airtable -- --apply` to clear duplicate rows.

Airtable follows along: new items are added once, tracked items get a `[bot]`
line in their Activity Log when the issue moves, and issues that close upstream
are set to `Done` (or whichever option your Status field maps to).

| Variable | Default | Effect |
|---|---|---|
| `DIGEST_MAX_PER_REPO` | `2` | Cap on opportunities per repository in one digest (`0` disables) |
| `DIGEST_DETAIL_LIMIT` | `8` | Maximum per-item detail messages |
| `DIGEST_INDEX_LIMIT` | `12` | Maximum lines in the summary index |
| `DIGEST_STILL_OPEN_LIMIT` | `8` | Lines in the Still open section |
| `DIGEST_TRACK_DAYS` | `21` | How far back tracked issues are re-checked for closure or claims |
| `DIGEST_STATUS_CHECKS` | `30` | Maximum GitHub status checks per run |
| `DIGEST_INCLUDE_CLAIMED` | `false` | Set `true` to keep claimed issues in the model input |
| `GITHUB_FETCH_TIMELINE` | `true` | Set `false` to skip linked-PR lookups (saves one request per issue) |
| `SCAN_MODE` | `default` | Mode for `node agent.js --scan`; the daily workflow reads the `DAILY_SCAN_MODE` repository variable |
| `DIGEST_BODY_CHARS` | `1500` | Issue body characters sent to the digest model (was 120) |
| `DIGEST_ANALYZE_LIMIT` | `8` | Opportunities that get the deep analysis per scan |
| `DIGEST_DEEP_ANALYSIS` | `true` | Set `false` to skip deep analysis in scans |

Messages use Telegram HTML (linked titles, `code` spans). If Telegram rejects a
message, it is re-sent as plain text.

The Monday **weekly digest** runs without dedupe and adds a "This week"
section: items added, finished, in progress, and gone quiet (no update in
`DIGEST_STALE_DAYS`, default 14). The workbench shows the same stale flag, and
each selected item loads its live GitHub state: open or closed, assignees, open
PRs, the latest comment, and whether it changed since you saved.

Deep analysis is skipped automatically inside Vercel functions (the in-request
scan fallback); run scans on GitHub Actions to get it. Set
`DIGEST_INCLUDE_NEWS=false` to drop the news section entirely.

Bases that accumulated one row per scan day for the same issue can be cleaned
with `npm run dedupe-airtable` (dry run) and `npm run dedupe-airtable -- --apply`.
It keeps the row with the most human input and deletes the rest.

---

## Configuration

All configuration lives in `.env`. Copy `.env.example` to get started.

```env
# GitHub fine-grained token (read-only, public repos)
# Get at: github.com/settings/tokens → Fine-grained → Public repos → Issues: Read-only
GITHUB_TOKEN=github_pat_...

# Ollama (gemma4:31b-cloud needs an Ollama account)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:31b-cloud

# Airtable
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_TABLE_NAME=tblgjC6xgOTdJtw72

# Telegram (primary notification)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# WhatsApp via CallMeBot (fallback — leave blank if not using)
WHATSAPP_PHONE=254712345678
WHATSAPP_APIKEY=...

# Cron schedule (default: 8am Nairobi daily)
SCAN_SCHEDULE=0 8 * * *

# BitcoinDevs fallback discovery
BITCOINDEVS_ISSUES_URL=https://bitcoindevs.xyz/good-first-issues?sort=newest-first&page=1&labels=good+first+issue
BITCOINDEVS_MAX_REPOS=12
BITCOINDEVS_DISCOVERY=true
PREFERRED_LANGUAGES=Rust,Python,TypeScript

# Weekly workflow sets this automatically
DIGEST_MODE=daily

# Protect dashboard APIs and manual scans
DAN_AGENT_API_KEY=replace_with_a_long_random_string

```

If `DAN_AGENT_API_KEY` is set, the dashboard prompts for it once and sends it on all API requests. Manual scans and all dashboard data endpoints reject unauthenticated requests.

---

## npm Scripts

| Command | Description |
|---|---|
| `npm run scan` | Run a single scan immediately |
| `npm start` | Start the cron scheduler (runs daily at 8am) |
| `npm run bot` | Run the long-polling bot + scheduler (persistent worker) |
| `npm run set-webhook` | Register the Telegram webhook (serverless mode) |
| `npm run setup` | Create all Airtable fields (run once) |

---

## Repositories Monitored

Manage repositories from the dashboard:

1. Open the app
2. Add `owner/repo` or a GitHub repo URL in the watchlist form
3. Use `Run scan now` or let the daily schedule use the saved watchlist

If no repositories are saved, scheduled scans discover repositories from BitcoinDevs good-first-issues instead.
Those discoveries are persisted locally, exact BitcoinDevs issue URLs are scanned first, and each dashboard opportunity shows its source and local fit score.

---

## News Sources

| Source | Type | Focus |
|---|---|---|
| TechCrunch | RSS | Startups, funding, Silicon Valley |
| Wired | RSS | In-depth investigative tech |
| Ars Technica | RSS | Science, policy, deep tech |
| TLDR Tech | RSS | Daily 5-minute developer digest |
| GitHub Blog | RSS | Platform and open-source ecosystem updates |
| GitHub Releases | API | Latest releases from monitored repos |
| Hacker News | API | Community-voted tech stories |

---

## Deployment

Running on your laptop is fine for testing, but to keep the agent running 24/7 use one of these options:

### Option A — PM2 (run on your laptop/server as a background daemon)

```bash
npm install -g pm2
pm2 start agent.js --name danagent -- --schedule
pm2 save
pm2 startup   # auto-start on reboot
```

Useful commands:
```bash
pm2 logs danagent       # view live logs
pm2 status              # check if running
pm2 restart danagent    # restart after code changes
```

### Option B — Railway (easiest cloud deploy, free tier)

1. Push the project to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Go to **Variables** → add all your `.env` keys
5. Railway auto-detects Node.js and starts `npm start`

Free tier gives you 500 hours/month — enough for this agent.

### Option C — Render (free background worker)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Background Worker
3. Build command: `npm install`
4. Start command: `node agent.js --schedule`
5. Add environment variables in the dashboard

### Option D — Hetzner VPS (cheapest 24/7, ~$4/month)

Best value for money. Get a CAX11 ARM instance (€3.29/month):

```bash
# On the server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs git

# Install Ollama (for local model fallback if needed)
curl -fsSL https://ollama.com/install.sh | sh

git clone <your-repo>
cd danagent
npm install
cp .env.example .env
nano .env   # add your keys

# Run with PM2
npm install -g pm2
pm2 start agent.js --name danagent -- --schedule
pm2 save && pm2 startup
```

### Option E — GitHub Actions (free, scheduled)

Create `.github/workflows/scan.yml`:

```yaml
name: Daily Repository Scan
on:
  schedule:
    - cron: '0 5 * * *'   # 8am Nairobi = 5am UTC
  workflow_dispatch:        # manual trigger button

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: node agent.js --scan
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OLLAMA_BASE_URL: ${{ secrets.OLLAMA_BASE_URL }}
          OLLAMA_MODEL: ${{ secrets.OLLAMA_MODEL }}
          AIRTABLE_API_KEY: ${{ secrets.AIRTABLE_API_KEY }}
          AIRTABLE_BASE_ID: ${{ secrets.AIRTABLE_BASE_ID }}
          AIRTABLE_TABLE_NAME: ${{ secrets.AIRTABLE_TABLE_NAME }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
```

Add all secrets in your GitHub repo → Settings → Secrets and variables → Actions.

**Note:** For GitHub Actions with Ollama cloud, set `OLLAMA_BASE_URL` to point to a remote Ollama instance or replace the Ollama call with a direct Gemini/Groq API call.

---

## Operating Model

**Recommended weekly workflow:**
1. Keep the watchlist current in the dashboard
2. Run `npm run scan` on a schedule or before planning sessions
3. Review the highest-fit issues first
4. Assign owners and next steps in the workbench
5. Use repo-specific validation commands before opening PRs

---

## Project Structure

```
danagent/
├── agent.js                 ← Main entry point
├── package.json
├── .env                     ← Your secrets (never commit this)
├── .env.example             ← Template (safe to commit)
├── src/
│   ├── github.js
│   ├── gemma.js
│   ├── news.js
│   ├── airtable.js
│   ├── whatsapp.js
│   └── config.js
└── scripts/
    └── setup-airtable.js
```

---

## Licence

MIT
