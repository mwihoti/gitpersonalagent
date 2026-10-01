"use strict";
// The three read-only Telegram commands aimed at the wider Bitcoin community:
// /projects, /areas and /issues. Unlike /scan and /analyze they must work for
// someone who has never subscribed, and must never trigger a scan.
const test = require("node:test");
const assert = require("node:assert/strict");

const { handleTelegramUpdate } = require("../src/whatsapp");
const { buildIssueFitScore } = require("../src/repo-insights");

const BOT = { botId: "test-bot", token: "test-token", isPrimary: true };

// Collects everything the bot tries to send, and answers every Telegram API
// call with a success so no command path touches the network.
function captureReplies(run) {
  const sent = [];
  const realFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (String(url).includes("sendMessage")) sent.push(body.text || "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
      text: async () => "{}",
    };
  };

  return Promise.resolve(run(sent)).finally(() => {
    global.fetch = realFetch;
  });
}

function message(text) {
  return {
    message: {
      chat: { id: 4242, type: "private" },
      from: { username: "satoshi", first_name: "Sat" },
      text,
    },
  };
}

// A scan trigger that fails loudly: these commands must never reach it.
const forbiddenScan = async () => {
  throw new Error("a read-only command triggered a scan");
};

test("/projects answers an unsubscribed chat with the area map", async () => {
  await captureReplies(async (sent) => {
    await handleTelegramUpdate(message("/projects"), forbiddenScan, BOT);

    assert.equal(sent.length, 1);
    assert.match(sent[0], /Bitcoin projects I watch/);
    assert.match(sent[0], /\/projects lightning/);
    // The bare command shows the map, not 42 repo lines.
    assert.doesNotMatch(sent[0], /lightningnetwork\/lnd/);
  });
});

test("/projects <area> lists that area's repos with links", async () => {
  await captureReplies(async (sent) => {
    await handleTelegramUpdate(message("/projects lightning"), forbiddenScan, BOT);

    assert.match(sent[0], /<b>Lightning<\/b>/);
    assert.match(sent[0], /github\.com\/lightningnetwork\/lnd/);
    // Repos from other areas must not leak in.
    assert.doesNotMatch(sent[0], /btcpayserver/);
  });
});

test("/projects rejects an unknown area instead of answering with everything", async () => {
  await captureReplies(async (sent) => {
    await handleTelegramUpdate(message("/projects banana"), forbiddenScan, BOT);

    assert.match(sent[0], /don't know the area/i);
    assert.match(sent[0], /\/areas/);
  });
});

test("/areas lists every area with its key and count", async () => {
  await captureReplies(async (sent) => {
    await handleTelegramUpdate(message("/areas"), forbiddenScan, BOT);

    assert.match(sent[0], /Areas of the Bitcoin ecosystem/);
    assert.match(sent[0], /<code>lightning<\/code>/);
    assert.match(sent[0], /<code>privacy<\/code>/);
  });
});

test("/repos is accepted as an alias for /projects", async () => {
  await captureReplies(async (sent) => {
    await handleTelegramUpdate(message("/repos"), forbiddenScan, BOT);
    assert.match(sent[0], /Bitcoin projects I watch/);
  });
});

test("bot-addressed and uppercase forms still route", async () => {
  await captureReplies(async (sent) => {
    await handleTelegramUpdate(message("/Projects@danagent_bot"), forbiddenScan, BOT);
    assert.match(sent[0], /Bitcoin projects I watch/);
  });
});

test("/help advertises the browse commands to a stranger", async () => {
  await captureReplies(async (sent) => {
    await handleTelegramUpdate(message("/help"), forbiddenScan, BOT);

    assert.match(sent[0], /no subscription needed/i);
    assert.match(sent[0], /\/projects/);
    assert.match(sent[0], /\/issues/);
  });
});

// ── Ranking ──────────────────────────────────────────────────────────────

function issueFixture(extra = {}) {
  return {
    title: "Fix fee estimation rounding",
    body: "x".repeat(300),
    labels: ["good first issue"],
    comments: 2,
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

function withFocus(value, fn) {
  const previous = process.env.BITCOIN_FOCUS_AREAS;
  if (value === undefined) delete process.env.BITCOIN_FOCUS_AREAS;
  else process.env.BITCOIN_FOCUS_AREAS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BITCOIN_FOCUS_AREAS;
    else process.env.BITCOIN_FOCUS_AREAS = previous;
  }
}

test("a known Bitcoin project outranks an unclassified repo", () => {
  withFocus(undefined, () => {
    const plain = buildIssueFitScore(issueFixture());
    const bitcoin = buildIssueFitScore(issueFixture({
      bitcoinArea: "lightning",
      bitcoinAreaLabel: "Lightning",
      bitcoinAreaSource: "catalog",
    }));

    assert.ok(bitcoin.issueFitScore > plain.issueFitScore);
  });
});

test("a guessed area counts for less than a catalogued one", () => {
  withFocus(undefined, () => {
    // Use a middling issue so neither result is clipped at the 100 ceiling.
    const base = { labels: [], comments: 0, body: "short", updated_at: new Date().toISOString() };
    const certain = buildIssueFitScore({
      ...base, title: "t", bitcoinArea: "lightning", bitcoinAreaLabel: "Lightning", bitcoinAreaSource: "catalog",
    });
    const guessed = buildIssueFitScore({
      ...base, title: "t", bitcoinArea: "lightning", bitcoinAreaLabel: "Lightning", bitcoinAreaSource: "inferred",
    });

    assert.ok(certain.issueFitScore > guessed.issueFitScore);
  });
});

test("BITCOIN_FOCUS_AREAS lifts matching areas above non-matching ones", () => {
  withFocus("lightning,privacy", () => {
    const inFocus = buildIssueFitScore(issueFixture({
      bitcoinArea: "privacy",
      bitcoinAreaLabel: "Privacy",
      bitcoinAreaSource: "catalog",
    }));
    const offFocus = buildIssueFitScore(issueFixture({
      bitcoinArea: "mining",
      bitcoinAreaLabel: "Mining",
      bitcoinAreaSource: "catalog",
    }));

    assert.ok(inFocus.issueFitScore > offFocus.issueFitScore);
    assert.match(offFocus.issueFitReason + inFocus.issueFitReason, /focus areas/);
  });
});

test("an off-focus issue is demoted but never buried", () => {
  withFocus("lightning", () => {
    const offFocus = buildIssueFitScore(issueFixture({
      bitcoinArea: "mining",
      bitcoinAreaLabel: "Mining",
      bitcoinAreaSource: "catalog",
    }));

    // A strong good-first-issue outside the focus area should still be
    // visible — focus is a preference, not a filter.
    assert.ok(offFocus.issueFitScore >= 55, `off-focus score collapsed to ${offFocus.issueFitScore}`);
  });
});

test("a claimed issue still outranks nothing, focus area notwithstanding", () => {
  withFocus("lightning", () => {
    const claimed = buildIssueFitScore(issueFixture({
      bitcoinArea: "lightning",
      bitcoinAreaLabel: "Lightning",
      bitcoinAreaSource: "catalog",
      claim: { claimed: true, reason: "alice said she is working on it", by: "alice" },
    }));
    const free = buildIssueFitScore(issueFixture({
      bitcoinArea: "lightning",
      bitcoinAreaLabel: "Lightning",
      bitcoinAreaSource: "catalog",
    }));

    // Being taken must outweigh the focus-area bonus, or the digest would
    // recommend work somebody else is already doing.
    assert.ok(free.issueFitScore > claimed.issueFitScore + 15);
    assert.equal(claimed.issueRecommendation, "Avoid for first pass");
  });
});
