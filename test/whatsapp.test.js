"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  buildDigestMessage,
  buildDigestMessages,
  listTelegramSubscribers,
  messageText,
  normalizeCommand,
  parseScanMode,
  sendTelegramToChat,
  subscribeTelegramChat,
  unsubscribeTelegramChat,
} = require("../src/whatsapp");

test("buildDigestMessage formats a readable mobile digest", () => {
  const message = buildDigestMessage({
    date: "2026-05-28",
    contest_digest: [
      {
        opportunity: "Add regression coverage for descriptor parsing",
        repo: "bitcoindevkit/bdk-ffi",
        issue_url: "https://github.com/bitcoindevkit/bdk-ffi/issues/1002",
        why_it_qualifies:
          "Clear test-only task with a scoped expected behavior.",
        suggested_action:
          "Add a failing descriptor fixture, assert the unsupported descriptor error, then run the package tests.",
        clarity_tip: "cargo test",
        effort: "low",
      },
    ],
    quick_plan:
      "Start with the low-risk test issue, then pick one Rust documentation issue.",
    tech_news_summary: [
      "Bitcoin tooling continues to improve contributor onboarding.",
    ],
  });

  assert.match(message, /^<b>Repository Intelligence Digest<\/b> · 2026-05-28/);
  assert.match(message, /<b>Top opportunities<\/b>/);
  assert.match(message, /bitcoindevkit\/bdk-ffi/);
  assert.match(
    message,
    /<a href="https:\/\/github.com\/bitcoindevkit\/bdk-ffi\/issues\/1002">Add regression coverage/,
  );
  assert.match(message, /<b>Execution plan<\/b>/);
  assert.ok(message.length < 3900);
});

test("buildDigestMessages splits summary and opportunity details", () => {
  const digest = {
    date: "2026-05-28",
    contest_digest: [
      {
        opportunity: "Remove stale issue template",
        repo: "bitcoin/bitcoin",
        issue_url: "https://github.com/bitcoin/bitcoin/issues/35399",
        why_it_qualifies: "BitcoinDevs source and high local fit score.",
        suggested_action: "Patch the template and update contributor docs.",
        clarity_tip: "Run docs checks.",
        effort: "low",
        source: "bitcoindevs",
        score: 91,
      },
    ],
    quick_plan: "Start with the narrow template cleanup.",
    tech_news_summary: [],
  };

  const messages = buildDigestMessages(digest);

  assert.equal(messages.length, 2);
  assert.match(messages[0], /Repository Intelligence Digest/);
  assert.match(messages[1], /Opportunity 1 of 1/);
  assert.match(messages[1], /Source: bitcoindevs · Score: 91/);
  assert.match(messages[1], /Issue: https:\/\/github.com\/bitcoin\/bitcoin\/issues\/35399/);
});

test("buildDigestMessages sends up to 8 opportunity details by default", () => {
  const digest = {
    date: "2026-05-28",
    contest_digest: Array.from({ length: 10 }, (_, index) => ({
      opportunity: `Opportunity ${index + 1}`,
      repo: "bitcoin/bitcoin",
      issue_url: `https://github.com/bitcoin/bitcoin/issues/${index + 1}`,
      why_it_qualifies: "Clear scoped work.",
      suggested_action: "Make the smallest useful change.",
      clarity_tip: "Run tests.",
      effort: "low",
    })),
    quick_plan: "Start with the first item.",
    tech_news_summary: [],
  };

  const messages = buildDigestMessages(digest);

  assert.equal(messages.length, 9);
  assert.match(messages[8], /Opportunity 8 of 8/);
});

test("buildDigestMessages renders a changelog and only details new or updated items", () => {
  const item = (number, extra = {}) => ({
    opportunity: `Opportunity <${number}> & friends`,
    repo: "owner/repo",
    issue_url: `https://github.com/owner/repo/issues/${number}`,
    why_it_qualifies: "Clear scoped work.",
    suggested_action: "Run `cargo test` after the change.",
    clarity_tip: "N/A",
    effort: "low",
    issue_created_at: "2024-01-01T00:00:00Z",
    assignees: [],
    ...extra,
  });
  const digest = {
    date: "2026-09-04",
    contest_digest: [
      item(1),
      item(2, {
        latest_comment: { author: "maintainer", createdAt: "2026-09-03T00:00:00Z", body: "Please rebase" },
        linked_prs: [{ number: 40, url: "https://github.com/owner/repo/pull/40", state: "open" }],
      }),
    ],
    changes: {
      new: ["https://github.com/owner/repo/issues/1"],
      updated: [{
        issue_url: "https://github.com/owner/repo/issues/2",
        latest_comment: { author: "maintainer", createdAt: "2026-09-03T00:00:00Z", body: "Please rebase" },
      }],
      closed: [{ issue_url: "https://github.com/owner/repo/issues/7", repo: "owner/repo", title: "Old one", reason: "closed", tracked_since: "2026-08-21" }],
      claimed: [{ issue_url: "https://github.com/owner/repo/issues/8", repo: "owner/repo", title: "Taken", reason: "assigned to bob", tracked_since: "2026-08-22" }],
      still_open: [{ issue_url: "https://github.com/owner/repo/issues/9", repo: "owner/repo", title: "Still here", tracked_since: "2026-08-21" }],
    },
    quick_plan: "Start with item 1.",
    tech_news_summary: [],
  };

  const messages = buildDigestMessages(digest);
  const summary = messages[0];

  assert.equal(messages.length, 3);
  assert.match(summary, /New 1 · Updated 1 · Closed 1 · Claimed 1 · Still open 1/);
  assert.match(summary, /<b>New today<\/b>/);
  assert.match(summary, /<b>Updated since last digest<\/b>/);
  assert.match(summary, /maintainer: “Please rebase”/);
  assert.match(summary, /<b>Closed or claimed since last digest<\/b>/);
  assert.match(summary, /assigned to bob · tracked since 2026-08-22/);
  assert.match(summary, /<b>Still open<\/b>/);
  assert.match(summary, /Opportunity &lt;1&gt; &amp; friends/);
  assert.doesNotMatch(summary, /<1>/);
  assert.match(summary, /opened \d+y ago · unassigned/);
  assert.match(summary, /open PR #40/);

  assert.match(messages[1], /Opportunity 1 of 2<\/b> · NEW/);
  assert.match(messages[1], /<code>cargo test<\/code>/);
  assert.doesNotMatch(messages[1], /<b>Check<\/b>/);
  assert.match(messages[2], /Opportunity 2 of 2<\/b> · UPDATED/);
  assert.match(messages[2], /Linked PRs: <a href="https:\/\/github.com\/owner\/repo\/pull\/40">#40<\/a> \(open\)/);
});

test("detail messages carry claim/dismiss buttons when the record id is known", () => {
  const messages = buildDigestMessages({
    date: "2026-09-05",
    contest_digest: [{
      opportunity: "Fix it",
      repo: "o/r",
      issue_url: "https://github.com/o/r/issues/1",
      why_it_qualifies: "w",
      suggested_action: "s",
      clarity_tip: "",
      effort: "low",
      record_id: "recABC123",
    }],
    quick_plan: "p",
    tech_news_summary: [],
  });

  assert.equal(typeof messages[0], "string");
  assert.equal(typeof messages[1], "object");
  assert.match(messageText(messages[1]), /Opportunity 1 of 1/);
  assert.deepEqual(messages[1].replyMarkup.inline_keyboard[0].map((b) => b.callback_data), ["claim:recABC123", "dismiss:recABC123"]);
});

test("weekly review renders a This week section", () => {
  const message = buildDigestMessage({
    date: "2026-09-07",
    contest_digest: [],
    quick_plan: "",
    tech_news_summary: [],
    weekly_review: {
      days: 7,
      open_count: 12,
      added: [{ issue_url: "https://github.com/o/r/issues/1", repo: "o/r", title: "New one" }],
      done: [{ issue_url: "https://github.com/o/r/issues/2", repo: "o/r", title: "Shipped", owner: "dan" }],
      in_progress: [],
      stale: [{ issue_url: "https://github.com/o/r/issues/3", repo: "o/r", title: "Quiet" }],
    },
  });

  assert.match(message, /<b>This week<\/b> · 12 open in the queue/);
  assert.match(message, /Added \(1\)/);
  assert.match(message, /Finished \(1\)[\s\S]*Shipped<\/a> · o\/r · owner dan/);
  assert.match(message, /Gone quiet \(1\)/);
});

test("sendTelegramToChat retries as plain text when Telegram rejects the HTML", async () => {
  const calls = [];
  const prevFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.parse_mode) {
      return { ok: false, status: 400, json: async () => ({ description: "can't parse entities" }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const sent = await sendTelegramToChat("123", { text: "<b>Hi</b> &amp; bye", replyMarkup: { inline_keyboard: [] } }, "token", { parseMode: "HTML" });
    assert.equal(sent, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].parse_mode, "HTML");
    assert.equal(calls[1].parse_mode, undefined);
    assert.equal(calls[1].text, "Hi & bye");
    assert.ok(calls[1].reply_markup);
  } finally {
    global.fetch = prevFetch;
  }
});

test("engineering section leads with PRs that need you", () => {
  const message = buildDigestMessage({
    date: "2026-09-30",
    contest_digest: [],
    quick_plan: "",
    tech_news_summary: [],
    engineering: {
      counts: { active: 3, yourMove: 1, merged: 1 },
      prs: [
        { title: "Fix parsing", prUrl: "https://github.com/o/r/pull/11", state: "changes_requested", detail: "changes requested by maint", yourMove: true },
        { title: "Docs", prUrl: "https://github.com/o/r/pull/10", state: "merged", detail: "merged 2d ago", yourMove: false },
      ],
      nudges: [{ title: "Quiet one", issueUrl: "https://github.com/o/r/issues/3", detail: "in progress for 10 days with no PR linked" }],
    },
  });

  assert.match(message, /<b>Your work<\/b> · 3 in progress · 1 need you/);
  assert.match(message, /→ <a href="https:\/\/github.com\/o\/r\/pull\/11">Fix parsing<\/a> · Changes requested: changes requested by maint/);
  assert.match(message, /✔ .*Docs.*Merged/);
  assert.match(message, /⏳ .*Quiet one.*no PR linked/);
  assert.match(message, /Link a PR with <code>\/pr/);
});

test("the digest caps the closed/claimed list, labels repeats, and warns when nothing was saved", () => {
  const entry = (n) => ({ issue_url: `https://github.com/o/r/issues/${n}`, repo: "o/r", title: `Taken ${n}`, reason: "assigned to bob", tracked_since: "2026-08-31" });
  const item = (n) => ({ opportunity: `Item ${n}`, repo: "o/r", issue_url: `https://github.com/o/r/issues/${n}`, why_it_qualifies: "w", suggested_action: "s", clarity_tip: "", effort: "low", claim: n === 2 ? { stale: true, by: "ghost" } : null, issue_updated_at: "2026-09-29T00:00:00Z" });
  const messages = buildDigestMessages({
    date: "2026-09-30",
    contest_digest: [item(1), item(2)],
    persistence_error: "Airtable base is at its record limit",
    changes: {
      new: ["https://github.com/o/r/issues/1"],
      updated: [],
      repeated: [{ issue_url: "https://github.com/o/r/issues/2" }],
      closed: [],
      claimed: Array.from({ length: 32 }, (_, i) => entry(100 + i)),
      still_open: [],
    },
    quick_plan: "plan",
    tech_news_summary: [],
  });
  const summary = messages[0];

  assert.match(summary, /New 1 · Updated 0 · Seen before 1 · Closed 0 · Claimed 32/);
  assert.match(summary, /⚠ New items were not saved: Airtable base is at its record limit/);
  assert.match(summary, /<b>Seen before, still worth a look<\/b>/);
  assert.match(summary, /stale claim by ghost/);
  assert.equal((summary.match(/Taken \d+/g) || []).length, 6);
  assert.match(summary, /…and 26 more in the dashboard/);
  assert.match(summary, /<b>Execution plan<\/b>/, "the rest of the digest is no longer cut off");
  assert.doesNotMatch(summary, /Message shortened/);
  assert.match(messageText(messages[2]), /Opportunity 2 of 2<\/b> · SEEN BEFORE/);
});

test("a chat subscribed to two bots gets the digest once, through the requested bot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "danagent-twobots-"));
  const saved = { dir: process.env.DAN_AGENT_DATA_DIR, t1: process.env.TELEGRAM_BOT_TOKEN, t2: process.env.TELEGRAM_BOT_TOKEN_2, chat: process.env.TELEGRAM_CHAT_ID, reply: process.env.SCAN_REPLY_BOT };
  Object.assign(process.env, { DAN_AGENT_DATA_DIR: dir, TELEGRAM_BOT_TOKEN: "111:AAA", TELEGRAM_BOT_TOKEN_2: "222:BBB", TELEGRAM_CHAT_ID: "", AIRTABLE_API_KEY: "", AIRTABLE_BASE_ID: "" });
  for (const mod of ["../src/whatsapp", "../src/config", "../src/subscribers", "../src/bots", "../src/airtable"]) delete require.cache[require.resolve(mod)];
  const fresh = require("../src/whatsapp");
  const sent = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push([String(url).match(/bot(\d+):/)[1], String(body.chat_id)]);
    return { ok: true, json: async () => ({ ok: true }) };
  };

  try {
    await fresh.subscribeTelegramChat({ id: 500, type: "private" }, "111");
    await fresh.subscribeTelegramChat({ id: 500, type: "private" }, "222");
    await fresh.subscribeTelegramChat({ id: 600, type: "private" }, "222");

    sent.length = 0;
    await fresh.sendNotification("hello");
    assert.deepEqual(sent.sort(), [["111", "500"], ["222", "600"]]);

    sent.length = 0;
    process.env.SCAN_REPLY_BOT = "222";
    await fresh.sendNotification("hello");
    assert.deepEqual(sent.sort(), [["222", "500"], ["222", "600"]]);
  } finally {
    global.fetch = prevFetch;
    const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restore("DAN_AGENT_DATA_DIR", saved.dir); restore("TELEGRAM_BOT_TOKEN", saved.t1); restore("TELEGRAM_BOT_TOKEN_2", saved.t2); restore("TELEGRAM_CHAT_ID", saved.chat); restore("SCAN_REPLY_BOT", saved.reply);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildDigestMessages explains a quiet day without a model digest", () => {
  const messages = buildDigestMessages({
    date: "2026-09-04",
    contest_digest: [],
    changes: { new: [], updated: [], closed: [], claimed: [], still_open: [{ issue_url: "https://github.com/o/r/issues/1", repo: "o/r", title: "Still here" }] },
    quick_plan: "No new or updated issues since the last digest.",
    tech_news_summary: ["Headline"],
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /No new or updated opportunities today. 1 tracked issue is unchanged./);
  assert.doesNotMatch(messages[0], /Execution plan/);
  assert.match(messages[0], /- Headline/);
});

test("Telegram subscribers can opt in and out", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "danagent-subscribers-"));
  const previousDataDir = process.env.DAN_AGENT_DATA_DIR;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.DAN_AGENT_DATA_DIR = dir;
  process.env.TELEGRAM_CHAT_ID = "";

  try {
    const whatsappPath = require.resolve("../src/whatsapp");
    const configPath = require.resolve("../src/config");
    const subscribersPath = require.resolve("../src/subscribers");
    delete require.cache[whatsappPath];
    delete require.cache[configPath];
    delete require.cache[subscribersPath];
    const fresh = require("../src/whatsapp");

    await fresh.subscribeTelegramChat({
      id: 12345,
      type: "private",
      username: "ada",
      first_name: "Ada",
    });

    assert.deepEqual(await fresh.listTelegramSubscribers(), ["12345"]);
    assert.equal(await fresh.unsubscribeTelegramChat(12345), true);
    assert.deepEqual(await fresh.listTelegramSubscribers(), []);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.DAN_AGENT_DATA_DIR;
    } else {
      process.env.DAN_AGENT_DATA_DIR = previousDataDir;
    }
    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId;
    }
  }
});

test("normalizeCommand accepts slash, plain, and bot-addressed commands", () => {
  assert.equal(normalizeCommand("/start"), "start");
  assert.equal(normalizeCommand("start"), "start");
  assert.equal(
    normalizeCommand("/status@btc_opensource_projects_bot"),
    "status",
  );
  assert.equal(normalizeCommand("/scan now"), "scan");
});

test("parseScanMode recognizes admin scan modes", () => {
  assert.equal(parseScanMode("/scan"), "default");
  assert.equal(parseScanMode("/scan all"), "all");
  assert.equal(parseScanMode("/scan good-first"), "goodfirst");
  assert.equal(parseScanMode("/scan medium"), "medium");
});

test("claim button updates the record and answers the callback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "danagent-callback-"));
  const previousDataDir = process.env.DAN_AGENT_DATA_DIR;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.DAN_AGENT_DATA_DIR = dir;
  process.env.TELEGRAM_CHAT_ID = "777";
  process.env.AIRTABLE_API_KEY = "";
  process.env.AIRTABLE_BASE_ID = "";
  for (const mod of ["../src/whatsapp", "../src/config", "../src/subscribers", "../src/airtable"]) {
    delete require.cache[require.resolve(mod)];
  }
  const airtable = require("../src/airtable");
  const fresh = require("../src/whatsapp");
  const calls = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };

  try {
    await airtable.saveDigest({
      date: "2026-09-05",
      quick_plan: "p",
      contest_digest: [{
        opportunity: "Take me",
        repo: "o/r",
        issue_url: "https://github.com/o/r/issues/1",
        why_it_qualifies: "w",
        suggested_action: "s",
        clarity_tip: "",
        code_skeleton: "",
        why_it_matters: "m",
        effort: "low",
      }],
    });
    const { opportunities } = await airtable.listOpportunities();
    const recordId = opportunities[0].id;

    await fresh.handleTelegramUpdate({
      callback_query: {
        id: "cb1",
        data: `claim:${recordId}`,
        from: { username: "dan" },
        message: { message_id: 5, chat: { id: 777 } },
      },
    }, async () => {}, { token: "tok", botId: "b", isPrimary: true });

    const after = await airtable.listOpportunities();
    assert.equal(after.opportunities[0].status, "In Progress");
    assert.equal(after.opportunities[0].owner, "dan");
    assert.match(after.opportunities[0].activityLog, /claimed by dan/);
    assert.ok(calls.some((c) => c.url.includes("answerCallbackQuery") && /Assigned to dan/.test(c.body.text)));
    assert.ok(calls.some((c) => c.url.includes("editMessageReplyMarkup")));

    // Dismiss asks why, then the reason lands in the log for the learning loop.
    const bot = { token: "tok", botId: "b", isPrimary: true };
    await fresh.handleTelegramUpdate({ callback_query: { id: "cb2", data: `dismiss:${recordId}`, from: { username: "dan" }, message: { message_id: 6, chat: { id: 777 } } } }, async () => {}, bot);
    const why = calls.filter((c) => c.url.includes("editMessageReplyMarkup")).pop();
    assert.ok(why.body.reply_markup.inline_keyboard[0].some((b) => b.callback_data === `why:${recordId}:big`));
    await fresh.handleTelegramUpdate({ callback_query: { id: "cb3", data: `why:${recordId}:stack`, from: { username: "dan" }, message: { message_id: 6, chat: { id: 777 } } } }, async () => {}, bot);
    const dismissed = (await airtable.listOpportunities()).opportunities[0];
    assert.equal(dismissed.status, "Done");
    assert.match(dismissed.activityLog, /claimed by dan[\s\S]*dismissed by dan[\s\S]*\[dismiss reason: not my stack\]/);

    // /pr links a pull request to the queue item.
    await fresh.handleTelegramUpdate({ message: { chat: { id: 777 }, from: { username: "dan" }, text: "/pr https://github.com/o/r/issues/1 https://github.com/o/r/pull/42" } }, async () => {}, bot);
    const linked = (await airtable.listOpportunities()).opportunities[0];
    assert.equal(linked.prUrl, "https://github.com/o/r/pull/42");
    assert.equal(linked.status, "In Progress");
    assert.ok(calls.some((c) => c.url.includes("sendMessage") && /I will track/.test(c.body.text)));
  } finally {
    global.fetch = prevFetch;
    if (previousDataDir === undefined) delete process.env.DAN_AGENT_DATA_DIR; else process.env.DAN_AGENT_DATA_DIR = previousDataDir;
    if (previousChatId === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = previousChatId;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
