# I built a bot so I would stop staring at GitHub

*By Daniel Mwihoti · November 2026*

For most of this year I wanted to contribute to Bitcoin open source and kept not doing it.

Not for lack of time, exactly. The problem was smaller and more embarrassing than that. Every evening I would open GitHub, click into Bitcoin Core or LND or rust-payjoin, scroll a few hundred open issues, read three threads to the bottom, discover that two of them already had someone working on them and the third needed a design decision I was not qualified to make, and close the tab. Forty minutes gone. Nothing written. I did this more times than I want to admit.

The gap was never "can I write the code". The gap was *finding the right issue to write code for*. So I built a tool that does the finding, and this post is about what came out of that.

## What it is

It is called **Bitcoin Contributor Intelligence**, which is a grander name than it deserves. In practice it is three things:

- a Telegram bot, [@btc_opensource_projects_bot](https://t.me/btc_opensource_projects_bot), that sends a short daily digest of open issues worth a look;
- a small dashboard at [btc-opensource-projects.vercel.app](https://btc-opensource-projects.vercel.app) that holds the running queue;
- a scan that runs every morning at 8am Nairobi time, reads the issues the way I used to, and does the forty minutes for me.

Every morning the bot gives me a handful of issues across the Bitcoin ecosystem. For each one it tells me what the maintainer actually wants (read from the thread, not the title), whether anyone has claimed it, which files are involved, what a first step would be, and what might go wrong. Then it gets out of the way.

## The first version was useless

The first digest I ever received said, roughly, "Bitcoin Core has an open issue about improving documentation. This would be a good contribution." I knew that. Anyone knows that. It had read the title and nothing else.

That was the real lesson of this project, and it took me a while to accept: an AI summary of an issue title is worth exactly as much as the title. The value is in the reading. Humans find good issues by opening the thread, scrolling to the last comment, noticing that the maintainer said "happy to review a PR for this" three weeks ago and nobody followed up. So the scan had to do that too. Now it pulls the whole thread, the linked pull requests, the project's contributing guide, and the actual source files the issue touches, and only then asks a model to say what the work is. The output went from generic to specific overnight. Same models. Different input.

The other early embarrassment: the bot sent me the same digest every single day for a week. It had no memory of what it had already shown me. Now it keeps a record of every issue it has surfaced, what happened to it, and whether it has changed since. If nothing is new, it says so in two lines instead of pretending.

## Things that broke, in order

I kept this project running on free tiers the whole way, which means I met every limit there is.

Gemini started returning 403s one morning and the whole scan died silently. Groq's free tier gives you eight thousand tokens a minute, which sounds like a lot until you try to send it a two-hundred-comment thread. Two of the models I had hard-coded were retired while I was not looking and returned 404s. Airtable, where I stored everything at first, filled up at a thousand rows and then told me I had exceeded my API calls for the month too.

Each of those is now a feature. The scan tries providers in order (Gemini, then Groq, then xAI) and skips to the next one when one refuses; if all of them refuse it falls back to a plain ranked list with no model at all, so a digest always goes out. It learns each provider's token budget from the response headers rather than guessing. Storage moved to a free Postgres database on Neon. There is a `check-models` command that tells me which models are still alive before I rely on them. None of this is clever. It is just the scar tissue of a tool that has to run unattended every day.

## Letting other people in

For the first month this was only mine. Then a few people in a group chat asked if they could get the digest too, and that forced two decisions I am glad I made.

First, the bot now works for anyone. You send `/start` and you get the public digest. If you tell it your GitHub username with `/github`, it reads your public profile (languages, repos you have touched) and the daily digest becomes "picked for you" rather than "picked for Dan". `/skills rust, lightning` and `/level newcomer` let you correct it. `/match` shows you what it would pick right now.

Second, the dashboard stopped being behind a shared PIN I had to hand out. You ask the bot for `/dashboard` and it gives you your own key. That one change made the whole thing feel like a product instead of a script I was sharing.

I want to be honest about what it is *not*. It is not a per-person workspace; everyone with a key edits the same queue. In Telegram, the claim and dismiss buttons and the PR follow-through are still owner-only, because I have not worked out how multiple people claiming the same issue should behave. Those are on the list.

## Did it work?

The honest answer: partly, and more than I expected in a direction I did not expect.

I have one merged PR that came directly out of a digest: a small housekeeping change to [rust-payjoin](https://github.com/payjoin/rust-payjoin/pull/1589). It is a one-line `.gitignore` fix. It is not going to change Bitcoin. But it got me through the door of a project I had been circling for months, and I have an open PR in [Saving Satoshi](https://github.com/saving-satoshi/saving-satoshi-script/pull/20) that is a real piece of work, migrating their drag-and-drop implementation to a maintained library. Both started as a line in a Telegram message at 8am.

The thing I did not expect is that building the tool taught me more about the ecosystem than using it did. To make the scan cover the right repos I had to catalogue 42 Bitcoin projects into eleven areas (consensus, Lightning, wallets, privacy, mining, ecash, and so on) and write a one-line description of each. I now know what Fedimint is for and why Floresta exists, which I did not two months ago. The map was the point.

## What I would tell someone starting

Build the smallest thing that removes the specific friction stopping you. Mine was "open GitHub, lose forty minutes". The tool that fixed that is not impressive technically, and it did not need to be.

Make it read before it speaks. Any summariser that only sees a title is a title.

Expect every free tier to fail you, and design so that the thing still runs when it does.

And let other people in earlier than feels comfortable. The two best decisions in this project were both forced by someone else asking to use it.

If you want to try it: send `/start` to [@btc_opensource_projects_bot](https://t.me/btc_opensource_projects_bot), then `/github yourname`, and see what shows up tomorrow morning. The code is at [github.com/mwihoti/gitpersonalagent](https://github.com/mwihoti/gitpersonalagent), and there is a technical write-up alongside this one if you want to know how it works.

If you try it and something is wrong, or you run one of the programmes I mentioned and want to talk, message me on Telegram: [@Mwihoti](https://t.me/Mwihoti).
