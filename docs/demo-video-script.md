# Demo video script — "Your first Bitcoin contribution, triaged"

**Audience:** Bitcoin open-source contributors. Assume they can code and have a
GitHub account. Do **not** assume they know this tool, Airtable, or what a
"digest" is.

**Target length:** 4:30. Anything past 5:00 gets closed.

**One thing they should remember:** *it tells you whether the issue is actually
free before you spend a weekend on it.*

---

## Before you hit record

The demo stalls if you improvise this. Twenty minutes of prep:

| # | Do this | Why |
|---|---|---|
| 1 | Run a full scan and let it finish. `npm run scan` | A cold queue is an empty screen. You need ~15 opportunities on screen in the queue shot. |
| 2 | Run "Analyze issue" on the one issue you will feature, so it is cached | Analysis is cached by issue URL under `data/issue-analysis/`. Cached = instant on camera. On the free Groq tier a cold analysis takes minutes. |
| 3 | Pick the featured issue **by hand** the day before | It must be real, unclaimed, and have a thread worth reading. Verify it is still open on recording day. |
| 4 | Subscribe your Telegram chat with `/start` and confirm a digest has landed | You need a real digest to scroll in segment 6. |
| 5 | Empty the watchlist | Segment 2 shows adding the first project. Add it back after recording. |
| 6 | Set `DAN_AGENT_API_KEY` and enter it once, so the prompt does not appear mid-take | |
| 7 | Telegram Desktop, light theme, font size up one notch | Phone screen recordings are unreadable at 720p. |
| 8 | Browser at 1440×900, zoom 110%, bookmarks bar hidden | |

**Capture:** OBS, 1920×1080, 30fps. One track for screen, one for mic — you will
want to fix audio separately. Record the web and Telegram segments as separate
takes and cut them together; do not alt-tab on camera.

**Voice:** flat and factual. The subject matter is interesting enough. No music
under narration; if you want a bed, keep it under −28 dB.

---

## Segment 1 — The problem (0:00–0:20)

**Screen:** `bitcoindevs.xyz/good-first-issues`, already scrolled halfway down a
long list. Scroll slowly and keep scrolling while you talk.

> There is no shortage of open Bitcoin issues. This is a few hundred of them.
>
> The problem is that you cannot tell, from this page, which of these somebody
> already claimed three weeks ago, which one has an open PR, and which one is
> waiting on a design decision nobody has made yet.
>
> You find that out after you have read the code.

**Cut on:** the word "code". Hard cut, no fade.

> *Production note: do not name a specific issue as a bad example here. Those are
> real maintainers and real contributors.*

---

## Segment 2 — Pick an area (0:20–0:55)

**Screen:** the dashboard, freshly loaded, scrolled to the **Start here** panel.

**Action:** click through three area chips — `Lightning`, then `Privacy`, then
`Ecash & L2`. Let each grid render. Then click `Privacy`, and on
`payjoin/rust-payjoin` click **Add to watchlist**. Let the button flip to
"Watching".

> So: start from what you actually want to work on.
>
> Forty-two Bitcoin projects that take outside contributions, grouped by area.
> Consensus, Lightning, wallets, privacy, ecash, mining, and so on.
>
> The tag on each card is not difficulty. It is how much Bitcoin-specific context
> you need before the code makes sense. `bitcoinjs-lib` is approachable on day
> one. `secp256k1` is not.
>
> I want privacy work, so — payjoin. Added. It is now part of every scan.

**Timing note:** do not rush the chip clicks. The grid re-render is the visual
that sells this panel.

---

## Segment 3 — The queue (0:55–1:35)

**Screen:** scroll down to **Opportunity queue**.

**Action:** let the list sit for two seconds. Set the priority filter to `High`.
Scroll the list slowly. Do not click anything yet.

> This is what came back this morning.
>
> Each line is an issue that survived filtering. Things that are already assigned,
> things with an open PR, things where somebody commented "I'll pick this up" —
> those are gone before they reach this list.
>
> And it is a changelog, not a snapshot. Tomorrow this will show me what is new,
> what moved, and what got claimed overnight. The same eight items do not come
> back every morning.

**If a repo name is visible that you do not want on camera,** use the search box
to filter to the one you do. Do not edit the queue mid-take.

---

## Segment 4 — The one that matters (1:35–2:25)

This is the segment people will share. Give it room.

**Screen:** click your pre-selected featured issue. The detail pane opens.

**Action:** click **Analyze issue**. Because you cached it in prep, the analysis
card appears fast. Scroll it slowly, top to bottom, pausing on each block you
name.

> Here is the part that saves the weekend.
>
> It read the whole issue thread, the linked pull requests, the project's
> contributing guide, and the source files the issue actually names.
>
> **What the maintainer wants** — with the quote it came from, so I can check it
> rather than trust it.
>
> **State** — available, claimed, has an open PR, likely already done, stale,
> blocked, needs a design decision. That one field is most of the value.
>
> **Files to change** — the checkmark means that path was verified against the
> repo. No checkmark means the model inferred it and I should look myself.
>
> **Questions to ask before starting.** If those are unanswered, the right first
> move is a comment on the issue, not a branch.

**Pause on the "state" line for a full beat.** That is the thesis of the whole
tool.

---

## Segment 5 — Telegram, for anyone (2:25–3:05)

**Screen:** Telegram Desktop, a fresh chat with the bot. Full screen.

**Action:** type each command live. Let each reply render fully before the next.

| Type | Wait for |
|---|---|
| `/projects` | the area map with counts |
| `/projects lightning` | the nine Lightning repos with links |
| `/issues privacy` | what is open right now in privacy |

> The same thing works from your phone, and these three need no account and no
> subscription.
>
> `/projects` — the areas. `/projects lightning` — the repos in one, each with
> what it is and what language it is in.
>
> `/issues privacy` — what is open right now. That reads the last scan. It does
> not kick off a new one, so it answers instantly.
>
> Nothing here asks you to sign up for anything.

**Emphasise the last line.** It is the difference between a tool and a funnel.

---

## Segment 6 — The morning digest (3:05–3:45)

**Screen:** scroll up in the same Telegram chat to a real digest you received.

**Action:** scroll slowly through New today → Updated → Closed or claimed. Then
send `/analyze <issue url>` with your featured issue and let the reply arrive.

> Subscribe and this arrives every morning.
>
> New today. Updated since the last digest, with the newest comment. Closed or
> claimed since yesterday — which is how you find out to stop, before you have
> started.
>
> And `/analyze` on any GitHub issue URL gives you the same deep read I showed on
> the dashboard, in the chat.

**If the `/analyze` call is slow on the day,** cut to the reply. Do not sit on a
loading state.

---

## Segment 7 — Claiming it (3:45–4:15)

**Screen:** stay in Telegram. Scroll to a digest detail message with the two
inline buttons.

**Action:** press **I'll take it**. Show the confirmation. Then type
`/pr <issue url> <pr url>` using a PR you actually opened.

> When you pick one up, press "I'll take it" and it is marked in progress with
> your name on it.
>
> Once you open the PR, link it, and from then on it watches that PR — review
> requested, CI failing, conflicts, merged. If the ball is in your court, that
> leads the next morning's digest.
>
> And "Not for me" asks why. Too big, not my stack, already taken. Those answers
> change what you get shown next week.

---

## Segment 8 — Close (4:15–4:40)

**Screen:** back to the dashboard, top of page, hero visible.

> Self-hosted. Your GitHub token, your Telegram bot, your data.
>
> It runs on a free tier: GitHub Actions for the scans, a webhook for the bot.
>
> If you want it pointed at a different corner of the ecosystem, the project list
> is one file — send a PR.

**End card, 3 seconds, static:**

```
github.com/<your-org>/<your-repo>

Contributions welcome — including to the project list.
```

---

## Captions to burn in

Narration moves fast for non-native English speakers, and a lot of this audience
is. Burn in these six, nothing more:

| At | Caption |
|---|---|
| 0:14 | "Which of these is actually free?" |
| 0:38 | "Level = Bitcoin context needed, not difficulty" |
| 1:12 | "Claimed and already-fixed issues are filtered out" |
| 2:02 | "State: available · claimed · has PR · likely done · stale" |
| 2:44 | "No account needed" |
| 4:02 | "Tracks your PR until it merges" |

---

## What to cut if you run long

In this order, and no further:

1. Segment 7 down to just the "I'll take it" press — drop the `/pr` demo (−20s).
2. Segment 3 down to one sentence, since Segment 4 re-establishes the queue (−20s).
3. Segment 6's digest scroll down to one screen (−15s).

**Do not cut** Segment 4. Without it this looks like an RSS reader.

---

## Honest-framing rules

Same rules apply to the video as to the README. This audience checks.

- Do not imply a maintainer endorsed the tool. None have.
- Do not show a real contributor's claim comment as an example of noise.
- Say "it reads the thread and tells you what it found", not "it understands the
  issue". The analysis is a model output and is sometimes wrong — the verified
  checkmarks on file paths exist precisely because the rest is not verified.
- If you show a fit score on camera, say it is a local heuristic, not a ranking
  anyone else agrees with.

---

## The generated MP4

There is also a **rendered 1080p MP4** that needs no camera, no microphone and
no screen recorder: `demo/bitcoin-contributor-demo.mp4` (about 60 seconds,
silent, with burned-in captions).

```bash
npm install --no-save puppeteer-core   # once
npm run dev                            # dashboard on :3000, in another shell
npm run demo:seed                      # real open issues into the local store
npm run demo:record                    # drives the app, writes demo/frames/
npm run demo:encode                    # frames → demo/bitcoin-contributor-demo.mp4
```

How it works, and why it is built this way:

- **It records the real app.** `scripts/record-demo.js` drives the actual
  dashboard and the actual walkthrough page in Chromium. Nothing on screen is a
  mockup of the product.
- **The issues are real.** `scripts/seed-demo-data.js` pulls currently-open
  `good first issue` / `help wanted` issues from catalogue repos, scores them
  with the project's own `buildIssueInsight`, and writes them through the normal
  `saveDigest` path. Assigned issues are dropped, because filtering those out is
  the thing the tool claims to do. What is missing compared with production is
  the LLM narrative — exactly what a real install with no model keys produces.
- **Frames are deterministic.** Every frame sets an exact state (scroll offset,
  cursor position, caption) and then screenshots. Scrolling is perfectly smooth
  and the whole run is reproducible, which a real-time capture is not.
- **Clicks invoke the element's own handler**, not a coordinate click. A
  coordinate click can drift onto a project link and navigate the page to
  GitHub, which silently breaks every later scene.

**Re-run it after any dashboard redesign.** The captions are written against
specific panels, so a UI change can leave a caption describing something that is
no longer on screen. The script throws if a target element is missing rather
than quietly producing a broken video, so a failed run is the signal to update
the scene list.

**It is silent on purpose.** This audience watches muted, and a silent captioned
cut can ship immediately. To add voice, record the narration from the segments
above over the top — the MP4 covers segments 1-5 and 8.
