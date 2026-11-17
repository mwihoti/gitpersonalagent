"use strict";
// Quotes from the issue thread: matched back to the real comment, then shown
// in the digest with a link to that comment and its real date.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AIRTABLE_API_KEY = "";
process.env.DATABASE_URL = "";

const { resolveEvidence, normalizeAnalysis } = require("../src/issue-analysis");
const { buildDigestMessages, evidenceLines } = require("../src/whatsapp");

function context() {
  return {
    issue: {
      url: "https://github.com/owner/repo/issues/7",
      author: "reporter",
      authorAssociation: "NONE",
      createdAt: "2026-01-05T10:00:00Z",
      body: "The `parse_amount` helper accepts **negative** values.",
    },
    comments: [
      {
        url: "https://github.com/owner/repo/issues/7#issuecomment-1",
        author: "maint",
        authorAssociation: "MEMBER",
        createdAt: "2026-03-02T09:00:00Z",
        body: "Good catch. Happy to review a PR for this,\nas long as it adds a test.",
      },
      {
        url: "https://github.com/owner/repo/issues/7#issuecomment-2",
        author: "passerby",
        authorAssociation: "CONTRIBUTOR",
        createdAt: "2026-04-10T09:00:00Z",
        body: "+1, happy to review a PR for this too",
      },
    ],
    files: [],
  };
}

test("a quote is matched to its comment: real author, date, link, and role", () => {
  const [item] = resolveEvidence([
    { who: "@maint", when: "2026-03-01", quote: "“Happy to review a PR for this, as long as it adds a test”" },
  ], context());
  assert.equal(item.verified, true);
  assert.equal(item.who, "maint");
  assert.equal(item.when, "2026-03-02", "the real comment date wins over the model's guess");
  assert.equal(item.url, "https://github.com/owner/repo/issues/7#issuecomment-1");
  assert.equal(item.role, "maintainer");
});

test("when two comments contain the quote, the named author decides", () => {
  const [item] = resolveEvidence([{ who: "passerby", when: "", quote: "happy to review a PR for this" }], context());
  assert.equal(item.url, "https://github.com/owner/repo/issues/7#issuecomment-2");
  assert.equal(item.role, "");
});

test("quotes from the issue body link the issue and tag its author; ellipses and markdown are tolerated", () => {
  const [item] = resolveEvidence([{ who: "reporter", when: "", quote: "The parse_amount helper ... negative values" }], context());
  assert.equal(item.verified, true);
  assert.equal(item.url, "https://github.com/owner/repo/issues/7");
  assert.equal(item.role, "issue author");
  assert.equal(item.when, "2026-01-05");
});

test("a quote nobody wrote stays in the analysis but is marked unverified, with no link", () => {
  const [item] = resolveEvidence([{ who: "maint", when: "2026-03-02", quote: "we will merge this immediately" }], context());
  assert.equal(item.verified, false);
  assert.equal(item.url, "");
});

test("normalizeAnalysis resolves evidence against the thread", () => {
  const analysis = normalizeAnalysis({
    summary: "s",
    plan: ["a"],
    evidence: [{ who: "maint", when: "2026-03-02", quote: "Happy to review a PR for this" }],
  }, context());
  assert.equal(analysis.evidence[0].url, "https://github.com/owner/repo/issues/7#issuecomment-1");
});

test("evidenceLines: verified only, maintainers first, linked, dated, escaped", () => {
  const lines = evidenceLines([
    { who: "passerby", when: "2026-04-10", quote: "newer but not a maintainer", url: "https://x/2", role: "", verified: true },
    { who: "ghost", when: "2026-05-01", quote: "made up", url: "", role: "", verified: false },
    { who: "maint", when: "2026-03-02", quote: "Happy to review <a PR>", url: "https://x/1", role: "maintainer", verified: true },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Happy to review &lt;a PR&gt;/);
  assert.match(lines[0], /<a href="https:\/\/x\/1">@maint \(maintainer\) · 2 Mar 2026/);
  assert.match(lines[1], /@passerby · 10 Apr 2026/);
  assert.ok(!lines.join("\n").includes("made up"), "unverified quotes are never shown");
});

test("the digest detail message carries a From the thread block", () => {
  const digest = {
    date: "2026-11-11",
    contest_digest: [{
      opportunity: "Reject negative amounts in parse_amount",
      repo: "owner/repo",
      issue_url: "https://github.com/owner/repo/issues/7",
      why_it_qualifies: "Small, scoped, maintainer asked for it.",
      suggested_action: "Add the check and a test.",
      effort: "quick win",
      score: 80,
      maintainer_wants: "A bounds check plus a test.",
      evidence: [{ who: "maint", when: "2026-03-02", quote: "Happy to review a PR for this", url: "https://github.com/owner/repo/issues/7#issuecomment-1", role: "maintainer", verified: true }],
    }],
  };
  const messages = buildDigestMessages(digest);
  const detail = messages.map((m) => (typeof m === "string" ? m : m.text)).join("\n");
  assert.match(detail, /<b>From the thread<\/b>/);
  assert.match(detail, /issuecomment-1">@maint \(maintainer\) · 2 Mar 2026/);
});

test("old analyses without evidence links render exactly as before", () => {
  assert.deepEqual(evidenceLines([{ who: "x", when: "2025-01-02", quote: "q" }]), []);
  assert.deepEqual(evidenceLines(undefined), []);
});

// ─── Regressions found in review ──────────────────────────────────────────────

function thread(comments, issue = {}) {
  return {
    issue: { url: "https://github.com/o/r/issues/1", author: "op", authorAssociation: "NONE", createdAt: "2026-01-01T00:00:00Z", body: "", ...issue },
    comments: comments.map((c, i) => ({ url: `C${i + 1}`, authorAssociation: "NONE", createdAt: `2026-03-0${i + 1}T00:00:00Z`, ...c })),
    files: [],
  };
}

test("a reply that quotes someone is never credited with their words", () => {
  const ctx = thread([
    { author: "alice", body: "I'm working on this, PR coming soon" },
    { author: "maint", authorAssociation: "OWNER", body: "> I'm working on this, PR coming soon\n\nAny update? Otherwise this is up for grabs." },
  ]);
  const [claim] = resolveEvidence([{ who: "maint", when: "2026-03-02", quote: "I'm working on this, PR coming soon" }], ctx);
  assert.equal(claim.url, "C1");
  assert.equal(claim.who, "alice");
  assert.equal(claim.role, "");

  const ctx2 = thread([
    { author: "maint", authorAssociation: "MEMBER", body: "Happy to review a PR for this." },
    { author: "newbie", body: "> Happy to review a PR for this.\n\nCan I take it?" },
  ]);
  const [review] = resolveEvidence([{ who: "maint (member)", when: "", quote: "Happy to review a PR for this." }], ctx2);
  assert.equal(review.url, "C1");
  assert.equal(review.role, "maintainer");
});

test("Markdown, links, lists, HTML comments and quote styles do not stop a real quote matching", () => {
  const cases = [
    ["**Note**: this needs a test first", "Note: this needs a test first"],
    ["please update the docs (see `README.md`)", "please update the docs (see README.md)"],
    ["`parse()`'s return value should be null", "parse()'s return value should be null"],
    ["follow the [contributing guide](https://x/CONTRIBUTING.md) and open a PR", "follow the contributing guide and open a PR"],
    ["Happy to review a [PR](https://github.com/o/r/pulls) for this", "Happy to review a PR for this"],
    ["### Steps to reproduce\nrun npm test <!-- describe -->", "Steps to reproduce: run npm test"],
    ["- Keep the old API\n- add a flag instead of changing defaults", "Keep the old API, add a flag instead of changing defaults"],
    ["Happy to review a PR for this,\nas long as it adds a test.", "Happy to review a PR for this."],
    ['add a "strict" option to the parser', "add a 'strict' option to the parser"],
    ["Happy to review a PR for this, as long as it adds a test", "Happy to review a PR [...] as long as it adds a test"],
    ["Happy to review a PR for this, as long as it adds a test", "Happy to review a PR (…) as long as it adds a test"],
  ];
  for (const [body, quote] of cases) {
    const [item] = resolveEvidence([{ who: "m", when: "", quote }], thread([{ author: "m", authorAssociation: "OWNER", body }]));
    assert.equal(item.verified, true, `${JSON.stringify(quote)} should match ${JSON.stringify(body)}`);
  }
});

test("dropping a short word cannot flip a quote's meaning, and short quotes match only whole comments", () => {
  const ctx = thread([
    { author: "m", authorAssociation: "MEMBER", body: "We are going to accept this change once tests pass" },
    { author: "m", authorAssociation: "MEMBER", body: "LGTM!" },
  ]);
  const [negated] = resolveEvidence([{ who: "m", when: "", quote: "Not ... going to accept this change" }], ctx);
  assert.equal(negated.verified, false);
  const [lgtm] = resolveEvidence([{ who: "m", when: "", quote: "LGTM" }], ctx);
  assert.equal(lgtm.verified, true);
  assert.equal(lgtm.url, "C2");
  const [fragment] = resolveEvidence([{ who: "m", when: "", quote: "tests pass" }], ctx);
  assert.equal(fragment.verified, false, "a short fragment of a longer comment is not evidence");
});

test("the model's own quotation marks are not doubled in the digest", () => {
  const [item] = resolveEvidence([{ who: "m", when: "", quote: "“Happy to review a PR for this”" }], thread([{ author: "m", authorAssociation: "OWNER", body: "Happy to review a PR for this" }]));
  assert.equal(item.quote, "Happy to review a PR for this");
  const [line] = evidenceLines([{ ...item }, { who: "x", when: "2026-01-01", quote: '"Plain quoted"', url: "u", role: "", verified: true }]);
  assert.match(line, /^“Happy to review a PR for this”\n/);
  // A verified quote is the commenter's own text: shown exactly, marks and all.
  const [, second] = evidenceLines([item, { who: "x", when: "2026-01-01", quote: '"Plain quoted" is what they wrote', url: "u", role: "", verified: true }]);
  assert.match(second, /^“"Plain quoted" is what they wrote”/);
});

test("generic types in prose survive; real HTML tags do not block a match", () => {
  const ctx = thread([
    { author: "m", authorAssociation: "OWNER", body: "Return a `Vec<u8>` instead of a String here" },
    { author: "n", authorAssociation: "OWNER", body: "<details><summary>Log</summary>boom</details>\nThe fix belongs in the <b>parser</b> module" },
  ]);
  assert.equal(resolveEvidence([{ who: "m", when: "", quote: "Return a Vec<u8> instead of a String here" }], ctx)[0].url, "C1");
  assert.equal(resolveEvidence([{ who: "n", when: "", quote: "The fix belongs in the parser module" }], ctx)[0].url, "C2");
});

// ─── Second review round ──────────────────────────────────────────────────────

const one = (body, quote, extra = {}) =>
  resolveEvidence([{ who: "m", when: "", quote, ...extra }], thread([{ author: "m", authorAssociation: "OWNER", body }]))[0];

test("words a maintainer only quoted inline or asked about stay with the person who said them", () => {
  const ctx = thread([
    { author: "alice", body: "I think we should drop Node 16 support." },
    { author: "maint", authorAssociation: "MEMBER", body: 'Re "we should drop Node 16 support": no, we keep it until April.' },
  ]);
  for (const who of ["", "maint", "Alice Smith"]) {
    const [item] = resolveEvidence([{ who, when: "", quote: "we should drop Node 16 support" }], ctx);
    assert.equal(item.url, "C1", `who=${JSON.stringify(who)}`);
    assert.equal(item.role, "");
  }
  const ctx2 = thread([
    { author: "maint", authorAssociation: "OWNER", body: "Can anyone confirm this only happens on Windows? I can't reproduce on mac." },
  ], { author: "alice", body: "this only happens on Windows", createdAt: "2026-01-01T00:00:00Z" });
  const [question] = resolveEvidence([{ who: "", when: "", quote: "this only happens on Windows" }], ctx2);
  assert.equal(question.url, "https://github.com/o/r/issues/1");
  assert.equal(question.role, "issue author");
});

test("the digest shows the commenter's own words, so a changed sign, operator, or version cannot appear", () => {
  assert.equal(one("parse_amount should return 1 for empty input", "parse_amount should return -1 for empty input").quote, "parse_amount should return 1 for empty input");
  assert.equal(one("amount must be >= 0 here", "amount must be < 0 here").quote, "amount must be >= 0 here");
  assert.equal(one("So we will merge this? Not until the tests pass.", "We will merge this.").quote, "So we will merge this? Not until the tests pass.");
  assert.equal(one("Fixed in v1.2.3 (not in 1.2)", "Fixed in v1.2").quote, "Fixed in v1.2.3 (not in 1.2)");
});

test("an ellipsis cannot hide a word or reorder an instruction", () => {
  assert.equal(one("We will not merge this.", "We will ... merge this").quote, "We will not merge this.");
  assert.equal(one("Don't change the default, add an option instead.", "add an option ... change the default").verified, false);
  const long = `Happy to review a PR. ${"Some unrelated context about the history of this module. ".repeat(6)}Please add a regression test.`;
  // Too long to show whole: dropped rather than stitched, since the gap could hold a "not".
  assert.equal(one(long, "Happy to review a PR ... Please add a regression test").verified, false);
});

test("HTML blockquotes and lazy blockquote lines are never the replier's words", () => {
  const ctx = thread([
    { author: "alice", body: "I'm working on this, PR coming soon" },
    { author: "maint", authorAssociation: "OWNER", body: "<blockquote>I'm working on this, PR coming soon</blockquote>\nAny update?" },
  ]);
  assert.equal(resolveEvidence([{ who: "", when: "", quote: "I'm working on this, PR coming soon" }], ctx)[0].url, "C1");
  const lazy = thread([
    { author: "bob", body: "Got it working locally and I will open the PR tomorrow" },
    { author: "maint", authorAssociation: "OWNER", body: "> Got it working locally\nand I will open the PR tomorrow\n\nAny news?" },
  ]);
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: "Got it working locally and I will open the PR tomorrow" }], lazy)[0].url, "C1");
});

test("markup copied into the quote, numbered lists, fences and clipped words still match", () => {
  const link = "Please follow the [contributing guide](https://github.com/o/r/blob/main/CONTRIBUTING.md) first";
  assert.equal(one(link, link).verified, true);
  assert.equal(one(link, link).quote, "Please follow the contributing guide first");
  assert.equal(one("Before merging:\n1. Add a regression test\n2. Update the changelog", "Add a regression test. Update the changelog").verified, true);
  assert.equal(one("Todo:\n- [x] add a test\n- [x] update docs please", "add a test, update docs please").verified, true);
  // A fenced block makes the comment more than one paragraph: matched, but not shown.
  assert.equal(one("Something like:\n```rust\nfn parse() -> Result<u32>\n```\nshould work", "Something like: fn parse() -> Result<u32> should work").verified, false);
  assert.equal(one("Use `fn parse() -> Result<u32>` there, it should work", "Use fn parse() -> Result<u32> there").verified, true);
  assert.equal(one("This covers negative amounts and zero", "This covers negat").verified, true);
});

// ─── Third review round ───────────────────────────────────────────────────────

test("struck-through text and unchecked template boxes are not statements", () => {
  assert.equal(one("~~Happy to review a PR that adds this option.~~ Edit: we decided against this.", "Happy to review a PR that adds this option").verified, false);
  assert.equal(one("<del>We will accept a PR for this.</del> Update: no longer accepting PRs here.", "We will accept a PR for this").verified, false);
  const ctx = thread([], { author: "op", body: "### Contribution\n- [ ] I am willing to submit a PR for this feature" });
  assert.equal(resolveEvidence([{ who: "op", when: "", quote: "I am willing to submit a PR for this feature" }], ctx)[0].verified, false);
  const checked = thread([], { author: "op", body: "- [x] I am willing to submit a PR for this feature" });
  assert.equal(resolveEvidence([{ who: "op", when: "", quote: "I am willing to submit a PR for this feature" }], checked)[0].verified, true);
});

test("a negation or hedge before the matched words is always shown", () => {
  assert.equal(one("We don't want a new flag for this, just change the default and document it.", "want a new flag for this, just change the default").quote,
    "We don't want a new flag for this, just change the default and document it.");
  assert.equal(one("I'm not convinced we should accept a PR that rewrites the parser.", "we should accept a PR that rewrites the parser").quote,
    "I'm not convinced we should accept a PR that rewrites the parser.");
  const background = "Some background on how this module grew over the years and why it looks the way it does. ".repeat(4);
  assert.equal(one(`Happy to review a PR for this. ${background}That said, I would not accept a PR that changes the default behaviour.`,
    "Happy to review a PR for this ... accept a PR that changes the default behaviour").verified, false);
  // The same "not" in a paragraph too long to show whole: dropped, never cut.
  assert.equal(one(`Happy to review a PR for this. ${background}That said, I would not accept a PR that changes the default behaviour.`,
    "accept a PR that changes the default behaviour").verified, false);
});

test("inline quotes are detected on every piece and in single quotes", () => {
  const filler = "More context here. ".repeat(3);
  assert.equal(one(`Thanks for the report, I can reproduce it. ${filler}Someone suggested "we should drop Node 16 support" but that is not happening.`,
    "I can reproduce it ... we should drop Node 16 support").verified, false);
  const ctx = thread([
    { author: "alice", body: "I think we should drop Node 16 support." },
    { author: "maint", authorAssociation: "MEMBER", body: "Re 'we should drop Node 16 support': no, we keep it until April." },
  ]);
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: "we should drop Node 16 support" }], ctx)[0].url, "C1");
  const curly = thread([
    { author: "alice", body: "I think we should drop Node 16 support." },
    { author: "maint", authorAssociation: "MEMBER", body: "Re \u2018we should drop Node 16 support\u2019: no." },
  ]);
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: "we should drop Node 16 support" }], curly)[0].url, "C1");
  assert.equal(one("We don't support that, it's out of scope for this release.", "it's out of scope for this release").verified, true, "apostrophes are not quotes");
});

test("code, exponents and identifiers reach the reader exactly as written", () => {
  assert.equal(one("Bump the buffer to 2**20 bytes before merging this change.", "Bump the buffer to 2**20 bytes before merging").quote, "Bump the buffer to 2**20 bytes before merging this change.");
  assert.equal(one("Use `__init__` and cap it at 2 ** 32 bytes please.", "Use __init__ and cap it at 2 ** 32 bytes").quote, "Use `__init__` and cap it at 2 ** 32 bytes please.");
  assert.equal(one("Pass **kwargs through to _private_helper instead.", "Pass kwargs through to _private_helper instead").quote, "Pass **kwargs through to _private_helper instead.");
  assert.equal(one("**Note**: this needs a test first.", "Note: this needs a test first").quote, "Note: this needs a test first.");
});

test("long sentences are shown whole, and emoji are never split", () => {
  const sentence = `Happy to take a PR for this, and I think the approach in the second comment is right, ${"really ".repeat(10)}but please do not start until #1234 lands.`;
  const item = one(sentence, "Happy to take a PR for this");
  assert.equal(item.verified, true);
  const [line] = evidenceLines([{ ...item, when: "2026-03-01" }]);
  assert.match(line, /please do not start until #1234 lands\./);
  const { SPAN_LIMIT } = require("../src/issue-analysis");
  const emoji = `${"a ".repeat((SPAN_LIMIT - 12) / 2)}\u{1F680} ship it`;
  const [rocket] = evidenceLines([{ who: "m", when: "2026-03-01", quote: emoji, url: "u", role: "", verified: true }]);
  assert.ok(rocket.includes("\u{1F680} ship it"), "shown whole, emoji intact");
  const tooLong = evidenceLines([{ who: "m", when: "2026-03-01", quote: "word ".repeat(SPAN_LIMIT), url: "u", role: "", verified: true }]);
  assert.deepEqual(tooLong, [], "longer than the limit is dropped, never cut");
});

// ─── Fourth review round: whole paragraphs or nothing ─────────────────────────

test("hard-wrapped lines, list lead-ins and headings stay with the words they qualify", () => {
  assert.equal(one("I don't think we should\nmerge a PR that changes the default.", "merge a PR that changes the default").quote,
    "I don't think we should merge a PR that changes the default.");
  assert.equal(one("We will not\naccept a PR that adds Windows support, sorry.", "accept a PR that adds Windows support").quote,
    "We will not accept a PR that adds Windows support, sorry.");
  assert.equal(one("Happy to review a PR for this,\nas long as it adds a test.", "Happy to review a PR for this").quote,
    "Happy to review a PR for this, as long as it adds a test.");
  assert.equal(one("Things we won't accept:\n- PRs that change the default parser\n- new runtime dependencies", "PRs that change the default parser").quote,
    "Things we won't accept: • PRs that change the default parser • new runtime dependencies");
  assert.equal(one("## Not planned\nAdding a GUI to the CLI tool", "Adding a GUI to the CLI tool").quote, "Not planned: Adding a GUI to the CLI tool");
  assert.equal(one("We do not plan to support e.g. Windows paths with spaces in the CLI.", "Windows paths with spaces in the CLI").quote,
    "We do not plan to support e.g. Windows paths with spaces in the CLI.");
});

test("an edit note after the quote, in the same comment or a later one by the same person, withdraws it", () => {
  assert.equal(one("Happy to review a PR for this. Edit: no longer needed, fixed in #12.", "Happy to review a PR for this").verified, false);
  assert.equal(one("Happy to review a PR for this.\n\n**EDIT:** never mind, we went with #12 instead.", "Happy to review a PR for this").verified, false);
  assert.equal(one("Happy to review a PR for this.\n\nUpdate: closing in favour of #12.", "Happy to review a PR for this").verified, false);
  const later = thread([
    { author: "maint", authorAssociation: "MEMBER", body: "Happy to review a PR for this." },
    { author: "maint", authorAssociation: "MEMBER", body: "Update: we're no longer accepting PRs here." },
  ]);
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: "Happy to review a PR for this" }], later)[0].verified, false);
  const other = thread([
    { author: "maint", authorAssociation: "MEMBER", body: "Happy to review a PR for this." },
    { author: "maint", authorAssociation: "MEMBER", body: "Pinging for visibility, still open." },
  ]);
  // Any later comment by the same person may change their position: only
  // someone's latest word is shown.
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: "Happy to review a PR for this" }], other)[0].verified, false);
});

test("single-tilde, multi-line and unclosed strikethrough or quote tags are not statements", () => {
  assert.equal(one("~Happy to review a PR for this.~ Edit: fixed in #12.", "Happy to review a PR for this").verified, false);
  assert.equal(one("~~Happy to review a PR for this,\nas long as it adds a test.~~\nEdit: fixed in #12, closing.", "Happy to review a PR for this").verified, false);
  assert.equal(one("Thoughts so far.\n\n<del>We will happily accept a PR that adds this flag to the parser", "We will happily accept a PR that adds this flag").verified, false);
  assert.equal(one("<blockquote>Happy to review a PR that adds this flag", "Happy to review a PR that adds this flag").verified, false);
  assert.equal(one("Use ~/.config/app and keep ~200 entries.", "Use ~/.config/app and keep ~200 entries").verified, true, "a lone ~ is not a strike");
});

test("the tail of a comment cut by the length cap is never shown as complete; emoji are never split", async () => {
  const { buildIssueContext } = require("../src/issue-context");
  const client = {
    fetchRepoDetails: async () => ({}),
    fetchIssueFull: async () => ({ number: 1, title: "t", html_url: "I", body: "b", user: { login: "op" }, labels: [], assignees: [], state: "open" }),
    fetchAllIssueComments: async () => [{ id: 1, html_url: "C1", user: { login: "m" }, author_association: "OWNER", created_at: "2026-01-01T00:00:00Z", body: `${"x".repeat(1199)}\u{1F680} tail` }],
    fetchLinkedPullRequests: async () => [],
    fetchContributingGuide: async () => null,
  };
  const context = await buildIssueContext("o/r", 1, { client, includeFiles: false });
  assert.equal(context.comments[0].url, "C1");
  assert.equal(context.comments[0].truncated, true);
  assert.ok(!/[\uD800-\uDBFF]$/.test(context.comments[0].body), "no half emoji at the cut");
  const cut = thread([{ author: "m", authorAssociation: "OWNER", body: "First paragraph is fine.\n\nHappy to review a PR for this as long as", truncated: true }]);
  assert.equal(resolveEvidence([{ who: "m", when: "", quote: "Happy to review a PR for this" }], cut)[0].verified, false);
  // Nothing from a cut comment: an edit note may sit in the part we lost.
  assert.equal(resolveEvidence([{ who: "m", when: "", quote: "First paragraph is fine" }], cut)[0].verified, false);
});

// ─── Fifth review round ───────────────────────────────────────────────────────

test("a verified paragraph up to the limit reaches Telegram whole, qualifier included", () => {
  const paragraph = "Happy to review a PR that adds the --strict flag to the parser, and I think the approach sketched in the second comment by the reporter last week is the right one because it keeps the old behaviour as default and avoids a breaking release. But please do not start until #1234 lands.";
  const item = one(paragraph, "Happy to review a PR that adds the --strict flag to the parser");
  assert.equal(item.verified, true);
  const [line] = evidenceLines([item]);
  assert.match(line, /please do not start until #1234 lands\.\u201d/);
});

test("an edit note above the quote, in any common form, withdraws it", () => {
  const quote = "Happy to review a PR that adds a --strict flag to the parser";
  for (const note of [
    "**Edit:** never mind, this was fixed in #45, closing.",
    "UPDATE: no longer needed.",
    "> [!IMPORTANT]\n> Update: we are no longer accepting outside PRs for this issue.",
    "\u26a0\ufe0f Update: closing.",
    "***Edit:*** fixed elsewhere.",
    "- Edit: fixed elsewhere.",
    "Correction: we will not take this.",
  ]) {
    assert.equal(one(`${note}\n\n${quote}.`, quote).verified, false, note);
    assert.equal(one(`${quote}.\n\n${note}`, quote).verified, false, note);
  }
  assert.equal(one(`${quote}. Please update the docs too.`, quote).verified, true, "the word update mid-line is not an edit note");
});

test("a comment of several paragraphs is never quoted, so no lead-in or heading can be lost", () => {
  for (const [body, quote] of [
    ["Things we won't accept:\n\n- PRs that change the default parser\n- new runtime dependencies", "PRs that change the default parser"],
    ["## Not planned\n\nAdding a GUI to the CLI tool", "Adding a GUI to the CLI tool"],
    ["If nobody from the core team picks this up by v3:\n\nHappy to review a PR that rewrites the parser.", "Happy to review a PR that rewrites the parser"],
    ["**Won't fix:**\n\nAdding a GUI frontend to the CLI tool.", "Adding a GUI frontend to the CLI tool"],
  ]) assert.equal(one(body, quote).verified, false, body);
  // One paragraph is shown whole, lead-in included.
  assert.equal(one("**Won't fix:** adding a GUI frontend to the CLI tool.", "adding a GUI frontend to the CLI tool").quote, "Won't fix: adding a GUI frontend to the CLI tool.");
});

test("exponents and products are never read as bold", () => {
  assert.equal(one("Use a buffer of 2**20 bytes, and at most 2**30 total.", "Use a buffer of 2**20 bytes").quote, "Use a buffer of 2**20 bytes, and at most 2**30 total.");
  assert.equal(one("Compute a**b and c**d separately.", "Compute a**b and c**d separately").quote, "Compute a**b and c**d separately.");
});

// ─── Sixth review round: fail closed ──────────────────────────────────────────

test("edit notes in any common wording withdraw the comment", () => {
  const Q = "Happy to review a PR that adds a --strict flag to the parser";
  for (const note of [
    "Thanks for the detailed report btw. EDIT: never mind, fixed in #12, closing.",
    "Thanks for the report (edit: fixed in #12, no PR needed).",
    "Quick update: we went with #12, no PR needed.",
    "Later edit: fixed in #12.",
    "EDIT2: fixed in #12.",
    "@alice update: fixed in #12.",
    "Addendum: we decided against this.",
    "Disregard the above, fixed in #12.",
    "Actually, never mind, fixed in #12.",
    "On second thought, we won't take this.",
    "Edited to add: fixed in #12.",
    "Edit (Mar 5): fixed in #12.",
  ]) assert.equal(one(`${Q}.\n\n${note}`, Q).verified, false, note);
  assert.equal(one(`${Q}. Please also update the changelog.`, Q).verified, true, "the plain verb update is not a note");
});

test("only a person's latest comment in the thread is quoted, and only from a thread read in full", () => {
  const Q = "Happy to review a PR that adds a --strict flag to the parser";
  const replied = thread([
    { author: "maint", authorAssociation: "MEMBER", body: `${Q}.` },
    { author: "alice", body: "Is this still open for a PR?" },
    { author: "maint", authorAssociation: "MEMBER", body: "> Is this still open for a PR?\n\nChanged my mind on the flag, sorry." },
  ]);
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: Q }], replied)[0].verified, false);
  const partial = { ...thread([{ author: "maint", authorAssociation: "MEMBER", body: `${Q}.` }]), commentsComplete: false };
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: Q }], partial)[0].verified, false);
  const full = { ...thread([{ author: "maint", authorAssociation: "MEMBER", body: `${Q}.` }]), commentsComplete: true };
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: Q }], full)[0].verified, true);
  const opLater = thread([{ author: "op", body: "Never mind, I found a workaround." }], { author: "op", body: "I am willing to submit a PR for this feature." });
  assert.equal(resolveEvidence([{ who: "op", when: "", quote: "I am willing to submit a PR for this feature" }], opLater)[0].verified, false, "the issue author's later comment counts too");
});

function serveComments(total, failPage = 0) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    if (page === failPage) return { ok: false, status: 502, headers: new Map(), json: async () => ({}) };
    const start = (page - 1) * 100;
    const batch = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) => ({ id: start + i + 1, body: `c${start + i + 1}` }));
    return { ok: true, status: 200, headers: new Map(), json: async () => batch };
  };
  return () => { global.fetch = realFetch; };
}

test("the comment fetch says whether the whole thread was read", async () => {
  const github = require("../src/github");
  const fetchFor = (total) => github.fetchAllIssueComments({ comments: total, comments_url: "https://api.github.com/repos/o/r/issues/1/comments" });
  const cases = [
    [20, 0, true, "a short thread, every page loaded"],
    [30, 0, false, "trimmed to the first 5 and last 20"],
    [250, 0, false, "middle pages never fetched"],
    [20, 1, false, "the only page failed"],
    [150, 2, false, "the last page failed"],
  ];
  for (const [total, failPage, complete, why] of cases) {
    const restore = serveComments(total, failPage);
    try {
      assert.equal((await fetchFor(total)).complete, complete, why);
    } finally {
      restore();
    }
  }
  const restore = serveComments(21);
  try {
    assert.equal((await fetchFor(20)).complete, true, "a stale count that undercounts by one still reads page 1 fully");
  } finally {
    restore();
  }
});

test("headings and loose-list lead-ins come along or the quote is not shown", () => {
  assert.equal(one("We will NOT accept PRs that:\n\n- change the default parser\n\n- add new runtime dependencies to the core package", "add new runtime dependencies to the core package").verified, false);
  assert.equal(one("## Out of scope\n\nA GUI frontend for the CLI.\n\nRewriting the parser in Rust.", "Rewriting the parser in Rust").verified, false);
  assert.equal(one("Some context first.\n\n- add new runtime dependencies to the core package", "add new runtime dependencies to the core package").verified, false);
});

test("tildes and markers inside code never strike text, and real strikes inside a shown paragraph hide it", () => {
  assert.equal(one("Happy to review a PR for this. Read the config from `~/.config/app` first and only fall back to `~/.app` for old installs.", "Happy to review a PR for this").quote,
    "Happy to review a PR for this. Read the config from `~/.config/app` first and only fall back to `~/.app` for old installs.");
  const ctx = thread([
    { author: "alice", body: "I'm working on this, PR coming soon" },
    { author: "maint", authorAssociation: "OWNER", body: "Still reproduces with `~~`:\n```js\nconst n = ~~value;\n\nconsole.log(n);\n```\n\n> I'm working on this, PR coming soon\n\nAny update? Otherwise this is up for grabs." },
  ]);
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: "I'm working on this, PR coming soon" }], ctx)[0].url, "C1");
  assert.equal(one("We ~~will~~ might take a PR for this.", "take a PR for this").verified, false);
});

test("a wrapped line starting with a number keeps its number", () => {
  assert.equal(one("Happy to review a PR for this.\nWe support up to\n10. Anything more is out of scope.", "Happy to review a PR for this").quote,
    "Happy to review a PR for this. We support up to 10. Anything more is out of scope.");
});

test("pathological 60 KB bodies resolve quickly (no regex backtracking blowups)", () => {
  for (const body of ["`".repeat(60000), "``````````\n".repeat(6000), "~a ".repeat(20000), "<del>".repeat(10000), "10. x\n".repeat(10000), "[".repeat(60000), "\n \n".repeat(20000)]) {
    const started = Date.now();
    resolveEvidence([{ who: "", when: "", quote: "some quote that is not there at all" }], thread([{ author: "a", body }], { body }));
    assert.ok(Date.now() - started < 1500, `${JSON.stringify(body.slice(0, 12))}… took ${Date.now() - started} ms`);
  }
});

// ─── Seventh review round ─────────────────────────────────────────────────────

test("a context built from a partly fetched thread trusts no quote", async () => {
  const { buildIssueContext } = require("../src/issue-context");
  const comments = Object.assign([{ id: 1, html_url: "C1", user: { login: "m" }, author_association: "OWNER", created_at: "2026-01-01T00:00:00Z", body: "Happy to review a PR for this." }], { complete: false });
  const client = {
    fetchRepoDetails: async () => ({}),
    fetchIssueFull: async () => ({ number: 1, title: "t", html_url: "I", body: "b", comments: 40, user: { login: "op" }, labels: [], assignees: [], state: "open" }),
    fetchAllIssueComments: async () => comments,
    fetchLinkedPullRequests: async () => [],
    fetchContributingGuide: async () => null,
  };
  const context = await buildIssueContext("o/r", 1, { client, includeFiles: false });
  assert.equal(context.commentsComplete, false);
  assert.equal(resolveEvidence([{ who: "m", when: "", quote: "Happy to review a PR for this" }], context)[0].verified, false);
  comments.complete = true;
  const whole = await buildIssueContext("o/r", 1, { client, includeFiles: false });
  assert.equal(resolveEvidence([{ who: "m", when: "", quote: "Happy to review a PR for this" }], whole)[0].verified, true);
});

test("an edit note in any style is either shown with the quote or stops it", () => {
  const Q = "Happy to review a PR that adds a --strict flag to the parser";
  for (const tail of ["### Update\nWe went with #12 instead.", "**Edit** \u2014 fixed in #12.", "_Edit_: fixed in #12", "<b>Edit</b>: fixed in #12.", "Edit on March 5: fixed in #12", "EDIT\nFixed in #12, closing."]) {
    const separate = one(`${Q}.\n\n${tail}`, Q);
    assert.equal(separate.verified, false, tail);
    const inline = one(`${Q}. ${tail.replace(/\n/g, " ")}`, Q);
    assert.ok(!inline.verified || /12/.test(inline.quote), `inline ${tail}: hidden, or shown with the note`);
  }
});

test("a blockquote inside a list item and an HTML comment inside code are handled", () => {
  const ctx = thread([
    { author: "alice", body: "We should switch the default parser to the strict mode." },
    { author: "maint", authorAssociation: "OWNER", body: "1. > We should switch the default parser to the strict mode.\n   Not happening before v3, sorry." },
  ]);
  assert.equal(resolveEvidence([{ who: "maint", when: "", quote: "We should switch the default parser to the strict mode" }], ctx)[0].url, "C1");
  assert.equal(one("Happy to review a PR for this. Use `<!--` to open and `-->` to close, but only in templates.", "Happy to review a PR for this").quote,
    "Happy to review a PR for this. Use `<!--` to open and `-->` to close, but only in templates.");
  assert.equal(one("Happy to review a PR for this. <!-- unfinished thought", "Happy to review a PR for this").verified, false);
});

// ─── Eighth review round ──────────────────────────────────────────────────────

test("the reporter's comments are never quoted, since the issue text may be newer", () => {
  const ctx = thread([{ author: "op", body: "I'll open a PR for this over the weekend." }],
    { author: "op", body: "parse_amount accepts negative values.\n\nStatus 2026-04: not working on this anymore, anyone can pick it up." });
  assert.equal(resolveEvidence([{ who: "op", when: "", quote: "I'll open a PR for this over the weekend" }], ctx)[0].verified, false);
});

test("a reply is never shown without the words it answers", () => {
  for (const [question, reply, quote] of [
    ["Is there any reason not to accept a PR that adds the --strict flag?", "> Is there any reason not to accept a PR that adds the --strict flag?\n\nNo.", "No."],
    ["I think we should close this as won't fix", "<blockquote>I think we should close this as won't fix</blockquote>\n\nAgreed.", "Agreed."],
    ["Would you accept a PR that only updates the docs?", "> Would you accept a PR that only updates the docs?\n\nYes, go ahead, happy to review it.", "Yes, go ahead, happy to review it."],
  ]) {
    const ctx = thread([{ author: "alice", body: question }, { author: "maint", authorAssociation: "OWNER", body: reply }]);
    assert.equal(resolveEvidence([{ who: "maint", when: "", quote }], ctx)[0].verified, false, reply);
  }
});

test("verified comments reach Telegram verbatim: quote marks kept, backticks literal, HTML escaped", () => {
  const empty = one('"" should not be accepted as a package name; a PR that rejects it is welcome.', "should not be accepted as a package name");
  assert.match(evidenceLines([empty])[0], /^\u201c"" should not be accepted/);
  const code = one("Use `` `x` `` in the template, PR welcome for the docs fix", "PR welcome for the docs fix");
  const [line] = evidenceLines([code]);
  assert.ok(line.includes("Use `` `x` `` in the template"), line);
  assert.ok(!line.includes("<code>"), "no generated markup inside the quote");
  const html = one("Happy to take a PR: `a < b && c > d` must hold.", "Happy to take a PR");
  assert.ok(evidenceLines([html])[0].includes("`a &lt; b &amp;&amp; c &gt; d`"));
});

// ─── Ninth review round ───────────────────────────────────────────────────────

test("superscript or subscript makes a comment unquotable, and entities decode once", () => {
  assert.equal(one("PR welcome: the step size must be 10<sup>-6</sup>, not 10<sup>6</sup>.", "PR welcome: the step size must be 10").verified, false);
  assert.equal(one("Happy to take a PR that escapes `<` as &amp;lt; in issue titles instead of dropping it.", "Happy to take a PR that escapes").quote,
    "Happy to take a PR that escapes `<` as &lt; in issue titles instead of dropping it.");
});

test("a comment 360-364 days old reads 1y ago, not 0y ago", () => {
  const { formatAge } = require("../src/issue-tracking");
  const now = Date.parse("2026-11-11T00:00:00Z");
  assert.equal(formatAge(new Date(now - 362 * 86400000).toISOString(), now), "1y ago");
  assert.equal(formatAge(new Date(now - 800 * 86400000).toISOString(), now), "2y ago");
});
