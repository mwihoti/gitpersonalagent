# Stacks Dev Assistant — Dan Agent

An AI-powered agent that scans the Stacks ecosystem for contest-qualifying PR opportunities, generates starter code, and delivers a daily digest to your phone. Built for the **Code, Commit, Earn** contest (10,000+ STX monthly prize pool).

---

## What It Does

Every morning at 8am Nairobi time the agent:

1. **Scans GitHub** — pulls open issues from 5 Stacks repos, prioritising `good first issue` and `bug` labels
2. **Fetches tech news** — TechCrunch, Wired, Ars Technica, TLDR Tech, Stacks Blog, GitHub Releases, Hacker News
3. **Analyses with Gemma 4** — Google's latest model (via Ollama Cloud) identifies the best contest opportunities and generates real code skeletons
4. **Saves to Airtable** — structured database of opportunities with effort level, suggested action, and starter code
5. **Notifies via Telegram** — sends a digest to @dan_sentinel_bot with top opportunities and weekly plan

---

## Architecture

```
agent.js                    ← Orchestrator + cron scheduler
src/
├── github.js               ← GitHub API scanner (issues + releases)
├── gemma.js                ← Ollama / Gemma 4 31B Cloud interface
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
            ├─→ Gemma 4 31B Cloud ─→ JSON digest ─→ Airtable
News/RSS  ──┘                                    └─→ Telegram
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

### 4. Log in to Ollama

```bash
ollama login
```

### 5. Run a test scan

```bash
npm run scan
```

You should see the digest printed in terminal, a Telegram message from @dan_sentinel_bot, and new rows in Airtable.

### 6. Start the daily schedule

```bash
npm start
```

Runs at 8am Nairobi time (Africa/Nairobi) every day.

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

# Protect dashboard APIs and manual scans
DAN_AGENT_API_KEY=replace_with_a_long_random_string

# Repos to scan (comma-separated)
GITHUB_REPOS=stacks-network/stacks-core,stacks-network/rendezvous,stx-labs/connect,stx-labs/clarinet,stx-labs/token-metadata-api
```

If `DAN_AGENT_API_KEY` is set, the dashboard prompts for it once and sends it on all API requests. Manual scans and all dashboard data endpoints reject unauthenticated requests.

---

## npm Scripts

| Command | Description |
|---|---|
| `npm run scan` | Run a single scan immediately |
| `npm start` | Start the cron scheduler (runs daily at 8am) |
| `npm run setup` | Create all Airtable fields (run once) |

---

## Repos Monitored

| Repo | Focus |
|---|---|
| `stacks-network/stacks-core` | Core blockchain node (Rust) |
| `stacks-network/rendezvous` | Clarity contract fuzzer |
| `stx-labs/connect` | Stacks wallet connection library (JS) |
| `stx-labs/clarinet` | Clarity development toolchain (Rust) |
| `stx-labs/token-metadata-api` | Token metadata service (TypeScript) |

Add more repos by editing `GITHUB_REPOS` in `.env`.

---

## News Sources

| Source | Type | Focus |
|---|---|---|
| TechCrunch | RSS | Startups, funding, Silicon Valley |
| Wired | RSS | In-depth investigative tech |
| Ars Technica | RSS | Science, policy, deep tech |
| TLDR Tech | RSS | Daily 5-minute developer digest |
| Stacks Blog | RSS | Stacks ecosystem updates |
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
name: Daily Stacks Scan
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

## Contest Strategy

The contest allows up to **20 qualifying PRs per month** — each is one entry in a random draw.

**Recommended monthly workflow:**
1. Run `npm run scan` every Monday morning
2. Check Airtable for the week's opportunities
3. Start with `low` effort items (1–2 hours each)
4. Submit 1–2 PRs per week = 4–8 entries per month
5. Always run `clarinet check` before opening a Clarity PR

**What qualifies:**
- New UI element or page
- Bug fix
- New Clarity contract or function
- Contract optimization
- Security enhancement
- Adding a test suite
- Meaningful refactor

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
