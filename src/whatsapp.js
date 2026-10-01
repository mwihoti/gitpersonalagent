"use strict";
const config = require("./config");
const {
  readSubscribers,
  upsertSubscriber,
  removeSubscriber,
} = require("./subscribers");
const { listBots, primaryBot } = require("./bots");
const { formatAge, normalizeUrl } = require("./issue-tracking");
const { updateOpportunity } = require("./airtable");
const { analyzeIssue } = require("./issue-analysis");
const { parseIssueUrl } = require("./github");
const { DISMISS_REASONS } = require("./feedback");

// ─── WhatsApp via CallMeBot ───────────────────────────────────────────────────

async function sendWhatsApp(message) {
  const { phone, apiKey } = config.whatsapp;
  if (!phone || !apiKey) return false;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      console.log("  WhatsApp notification sent");
      return true;
    }
    console.warn(`  WhatsApp failed: ${res.status}`);
    return false;
  } catch (e) {
    console.warn(`  WhatsApp error: ${e.message}`);
    return false;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function normalizeChatId(chatId) {
  return String(chatId || "").trim();
}

function adminChatId() {
  return normalizeChatId(config.telegram.chatId);
}

function isAdminChat(chatId) {
  const admin = adminChatId();
  return Boolean(admin && normalizeChatId(chatId) === admin);
}

async function isSubscriber(chatId, botId) {
  const normalized = normalizeChatId(chatId);
  if (!normalized) return false;
  if (isAdminChat(normalized)) return true;
  const subscribers = await readSubscribers(botId).catch(() => []);
  return subscribers.some(
    (item) => normalizeChatId(item.chatId) === normalized,
  );
}

function normalizeCommand(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  const first = normalized.split(/\s+/)[0];
  return first.replace(/^\/+/, "").split("@")[0];
}

function parseScanMode(text) {
  const parts = String(text || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(1);
  const mode = parts[0] || "default";
  if (mode === "all" || mode === "everything") return "all";
  if (
    mode === "goodfirst" ||
    mode === "good-first" ||
    mode === "good_first" ||
    mode === "good"
  )
    return "goodfirst";
  if (mode === "medium" || mode === "med") return "medium";
  return "default";
}

function scanModeLabel(mode) {
  if (mode === "all") return "all open issues";
  if (mode === "goodfirst") return "good first issues";
  if (mode === "medium") return "medium-effort issues";
  return "top prioritized issues";
}

// botId scopes the list to one bot's audience. options.includeAdmin adds the
// TELEGRAM_CHAT_ID owner chat — only do that for the bot the owner actually
// started, otherwise Telegram rejects the send.
async function listTelegramSubscribers(botId, options = {}) {
  const { includeAdmin = true } = options;
  const subscribers = await readSubscribers(botId).catch(() => []);
  const ids = subscribers
    .map((item) => normalizeChatId(item.chatId))
    .filter(Boolean);
  const admin = includeAdmin ? adminChatId() : "";
  return [...new Set([admin, ...ids].filter(Boolean))];
}

async function subscribeTelegramChat(chat, botId) {
  const chatId = normalizeChatId(chat && chat.id);
  if (!chatId) throw new Error("Cannot subscribe Telegram chat without an id");

  return upsertSubscriber({
    chatId,
    botId: botId || "",
    type: chat.type || "",
    title: chat.title || "",
    username: chat.username || "",
    firstName: chat.first_name || "",
    lastName: chat.last_name || "",
  });
}

async function unsubscribeTelegramChat(chatId, botId) {
  return removeSubscriber(chatId, botId);
}

function messageText(message) {
  return typeof message === "string" ? message : String((message && message.text) || "");
}

async function telegramCall(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

// message: string or { text, replyMarkup }
async function sendTelegramToChat(chatId, message, botToken, options = {}) {
  const token = botToken || config.telegram.botToken;
  if (!token || !chatId) return false;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const text = messageText(message);
  const payload = { chat_id: chatId, text };
  if (message && typeof message === "object" && message.replyMarkup) {
    payload.reply_markup = message.replyMarkup;
  }
  if (options.parseMode) {
    payload.parse_mode = options.parseMode;
    payload.disable_web_page_preview = true;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      console.log("  Telegram notification sent");
      return true;
    }
    const err = await res.json();
    // A formatting error in one message should not lose the whole digest:
    // retry once as plain text.
    if (options.parseMode && res.status === 400) {
      console.warn(`  Telegram rejected formatted message (${err.description}); retrying as plain text`);
      const plain = message && typeof message === "object"
        ? { ...message, text: stripHtml(text) }
        : stripHtml(text);
      return sendTelegramToChat(chatId, plain, botToken, {});
    }
    console.warn(`  Telegram failed: ${err.description}`);
    return false;
  } catch (e) {
    console.warn(`  Telegram error: ${e.message}`);
    return false;
  }
}

// Sends to every configured bot's own audience, each through its own token.
async function sendTelegram(message, options = {}) {
  let bots = listBots();
  if (!bots.length) return false;

  // An on-demand scan answers through the bot it was requested on
  // (SCAN_REPLY_BOT); otherwise the configured order stands.
  const preferred = String(process.env.SCAN_REPLY_BOT || '').trim();
  if (preferred) {
    bots = [...bots].sort((a, b) => Number(b.botId === preferred) - Number(a.botId === preferred));
  }

  // Someone subscribed to two bots gets the digest once, not once per bot.
  const delivered = new Set();
  let sentAny = false;
  for (const bot of bots) {
    const chatIds = (await listTelegramSubscribers(bot.botId, {
      includeAdmin: bot.isPrimary,
    })).filter((chatId) => !delivered.has(chatId));
    if (!chatIds.length) continue;

    const results = await Promise.all(
      chatIds.map((chatId) => sendTelegramToChat(chatId, message, bot.token, options)),
    );
    results.forEach((ok, index) => {
      if (ok) delivered.add(chatIds[index]);
    });
    sentAny = sentAny || results.some(Boolean);
  }
  return sentAny;
}

async function setTelegramCommands(botToken) {
  const token = botToken || config.telegram.botToken;
  if (!token) return false;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "start", description: "Subscribe to daily updates" },
            { command: "stop", description: "Unsubscribe from daily updates" },
            {
              command: "status",
              description: "Check whether the bot is running",
            },
            { command: "help", description: "Show available commands" },
            { command: "analyze", description: "Deep read of one issue: /analyze <issue url>" },
            { command: "pr", description: "Link your PR: /pr <issue url> <pr url>" },
            {
              command: "scan",
              description: "Run scan: /scan all, /scan goodfirst, /scan medium",
            },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    return res.ok;
  } catch (e) {
    console.warn(`  Telegram command menu skipped: ${e.message}`);
    return false;
  }
}

// ─── Unified send (Telegram first, WhatsApp as fallback) ─────────────────────

async function sendNotification(message, options = {}) {
  const messages = Array.isArray(message) ? message : [message];
  let sentAny = false;

  for (const item of messages) {
    const sent = await sendTelegram(item, options);
    sentAny = sentAny || sent;
    if (!sent) {
      const text = messageText(item);
      await sendWhatsApp(options.parseMode ? stripHtml(text) : text);
    }
  }

  return sentAny;
}

// ─── Message formatter ────────────────────────────────────────────────────────
//
// Digest messages are Telegram HTML: titles are links, commands are <code>.
// Every piece of model or GitHub text goes through html() so stray < > & in
// issue titles cannot break the message.

const TELEGRAM_MESSAGE_LIMIT = 3900;
const DIGEST_PARSE_MODE = "HTML";

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, limit) {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function effortLabel(value) {
  const effort = cleanText(value || "medium").toLowerCase();
  if (effort === "low") return "LOW";
  if (effort === "high") return "HIGH";
  return "MED";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Escape, then render `inline code` spans from model text as <code>.
function html(value) {
  return escapeHtml(cleanText(value)).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isEmptyTip(value) {
  const text = cleanText(value).toLowerCase().replace(/[.!]+$/, "");
  return !text || ["n/a", "na", "none", "not applicable", "no tip", "-", "tbd"].includes(text);
}

function link(title, url, limit = 100) {
  const text = html(truncate(title, limit));
  return url ? `<a href="${escapeHtml(cleanText(url))}">${text}</a>` : text;
}

function envLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// "opened 2y ago · last comment 3mo ago by alice · unassigned · open PR #12"
function activityLine(item) {
  const parts = [];
  if (item.issue_created_at) parts.push(`opened ${formatAge(item.issue_created_at)}`);
  const comment = item.latest_comment;
  if (comment && comment.createdAt) {
    parts.push(`last comment ${formatAge(comment.createdAt)}${comment.author ? ` by ${comment.author}` : ""}`);
  } else if (item.issue_updated_at) {
    parts.push(`updated ${formatAge(item.issue_updated_at)}`);
  }
  const assignees = item.assignees || [];
  if (assignees.length) parts.push(`assigned to ${assignees.join(", ")}`);
  else if (item.issue_created_at || item.issue_updated_at) parts.push("unassigned");
  const openPRs = (item.linked_prs || []).filter((pr) => pr.state === "open" && pr.sameRepo !== false);
  if (openPRs.length) parts.push(`open PR #${openPRs.map((pr) => pr.number).join(", #")}`);
  if (item.claim && item.claim.stale && item.claim.by) parts.push(`stale claim by ${item.claim.by}`);
  return html(parts.join(" · "));
}

function indexLine(item, index) {
  const first = `${index}. [${effortLabel(item.effort)}] ${link(item.opportunity, item.issue_url, 90)}`;
  const meta = [html(item.repo || "Unknown repo"), activityLine(item)].filter(Boolean).join(" · ");
  return `${first}\n    ${meta}`;
}

function commentLine(comment) {
  if (!comment || !comment.body) return "";
  const who = comment.author ? `${comment.author}: ` : "";
  return html(`${who}“${truncate(comment.body, 160)}”`);
}

function trackedLine(entry) {
  const meta = [entry.repo, entry.reason, entry.tracked_since ? `tracked since ${entry.tracked_since}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `• ${link(entry.title, entry.issue_url, 80)}\n    ${html(meta)}`;
}

function fitMessage(message, footer) {
  if (message.length <= TELEGRAM_MESSAGE_LIMIT) return message;

  const allowed = TELEGRAM_MESSAGE_LIMIT - footer.length - 2;
  let cut = message.slice(0, Math.max(0, allowed));
  // Cut on a line boundary so we never split an HTML tag.
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > allowed / 2) cut = cut.slice(0, lastBreak);
  return `${cut.trim()}\n\n${footer}`;
}

// Splits digest items into the changelog buckets the summary is built from.
function classifyDigest(digest) {
  const items = Array.isArray(digest.contest_digest) ? digest.contest_digest : [];
  const changes = digest.changes || null;
  const numbered = items.map((item, index) => ({ item, index: index + 1 }));
  if (!changes) {
    return { changes: null, numbered, fresh: numbered, updated: [], repeated: [], updatedByUrl: new Map() };
  }

  const updatedByUrl = new Map(
    (changes.updated || []).map((entry) => [normalizeUrl(entry.issue_url), entry]),
  );
  const repeatedUrls = new Set((changes.repeated || []).map((entry) => normalizeUrl(entry.issue_url)));
  const updated = numbered.filter(({ item }) => updatedByUrl.has(normalizeUrl(item.issue_url)));
  const repeated = numbered.filter(({ item }) => repeatedUrls.has(normalizeUrl(item.issue_url)));
  const fresh = numbered.filter(({ item }) => {
    const key = normalizeUrl(item.issue_url);
    return !updatedByUrl.has(key) && !repeatedUrls.has(key);
  });
  return { changes, numbered, fresh, updated, repeated, updatedByUrl };
}

function buildDigestMessage(digest) {
  const { changes, numbered, fresh, updated, repeated, updatedByUrl } = classifyDigest(digest);
  const indexLimit = envLimit("DIGEST_INDEX_LIMIT", 12);
  const closedLimit = envLimit("DIGEST_CLOSED_LIMIT", 6);
  const stillOpenLimit = envLimit("DIGEST_STILL_OPEN_LIMIT", 8);
  const date = cleanText(digest.date) || new Date().toISOString().slice(0, 10);
  const sections = [];

  const renderIndex = (entries) =>
    entries.slice(0, indexLimit).map(({ item, index }) => indexLine(item, index)).join("\n");

  if (!changes) {
    sections.push(`<b>Top opportunities</b>\n${
      numbered.length ? renderIndex(numbered) : "No implementation opportunities were returned in this scan."
    }`);
    if (numbered.length > indexLimit) {
      sections.push(`Showing ${indexLimit} of ${numbered.length}. The rest are in the dashboard.`);
    }
  } else {
    const closed = changes.closed || [];
    const claimed = changes.claimed || [];
    const stillOpen = changes.still_open || [];
    sections.push(
      `New ${fresh.length} · Updated ${updated.length}${repeated.length ? ` · Seen before ${repeated.length}` : ""} · Closed ${closed.length} · Claimed ${claimed.length} · Still open ${stillOpen.length}`,
    );

    if (digest.persistence_error) {
      sections.push(`⚠ New items were not saved: ${html(digest.persistence_error)}. They have no buttons and will show as new again. Free space with <code>npm run dedupe-airtable -- --apply</code>.`);
    }
    if (fresh.length) {
      sections.push(`<b>New today</b>\n${renderIndex(fresh)}`);
    }
    if (updated.length) {
      const lines = updated.slice(0, indexLimit).map(({ item, index }) => {
        const entry = updatedByUrl.get(normalizeUrl(item.issue_url)) || {};
        const comment = commentLine(entry.latest_comment || item.latest_comment);
        return `${indexLine(item, index)}${comment ? `\n    ${comment}` : ""}`;
      });
      sections.push(`<b>Updated since last digest</b>\n${lines.join("\n")}`);
    }
    if (!fresh.length && !updated.length && !repeated.length) {
      sections.push(
        stillOpen.length
          ? `No new or updated opportunities today. ${stillOpen.length} tracked issue${stillOpen.length === 1 ? " is" : "s are"} unchanged.`
          : "No new opportunities today.",
      );
    }
    if (repeated.length) {
      sections.push(`<b>Seen before, still worth a look</b>\n${renderIndex(repeated)}`);
    }
    if (closed.length || claimed.length) {
      const all = [...closed, ...claimed];
      const lines = all.slice(0, closedLimit).map((entry) => trackedLine(entry));
      const more = all.length > closedLimit ? `\n…and ${all.length - closedLimit} more in the dashboard` : "";
      sections.push(`<b>Closed or claimed since last digest</b>\n${lines.join("\n")}${more}`);
    }
    if (stillOpen.length) {
      const lines = stillOpen.slice(0, stillOpenLimit).map((entry) => {
        const meta = [entry.repo, entry.tracked_since ? `tracked since ${entry.tracked_since}` : ""]
          .filter(Boolean)
          .join(" · ");
        return `• ${link(entry.title, entry.issue_url, 80)} · ${html(meta)}`;
      });
      const more = stillOpen.length > stillOpenLimit ? `\n…and ${stillOpen.length - stillOpenLimit} more` : "";
      sections.push(`<b>Still open</b>\n${lines.join("\n")}${more}`);
    }
  }

  if (digest.engineering && (digest.engineering.prs.length || digest.engineering.nudges.length)) {
    sections.push(engineeringSection(digest.engineering));
  }

  if (digest.weekly_review) {
    sections.push(weeklyReviewSection(digest.weekly_review));
  }

  const hk = digest.housekeeping;
  if (hk && (hk.archive || hk.close)) {
    const bits = [hk.close ? `${hk.close} closed upstream` : "", hk.archive ? `${hk.archive} archived after ${process.env.QUEUE_ARCHIVE_DAYS || 90} days untouched` : ""].filter(Boolean);
    sections.push(`Housekeeping: ${html(bits.join(", "))}.`);
  }

  if (numbered.length && digest.quick_plan) {
    sections.push(`<b>Execution plan</b>\n${html(truncate(digest.quick_plan, 500))}`);
  }

  const news = Array.isArray(digest.tech_news_summary)
    ? digest.tech_news_summary.slice(0, 4).map((n) => `- ${html(truncate(n, 180))}`).join("\n")
    : html(truncate(digest.tech_news_summary || "", 500));
  if (news) {
    sections.push(`<b>Signal summary</b>\n${news}`);
  }

  sections.push("Open the dashboard for code skeletons, issue context, and team notes.");

  const message = `<b>Repository Intelligence Digest</b> · ${html(date)}\n\n${sections.join("\n\n")}`;
  return fitMessage(message, "Message shortened. Open the dashboard for the full digest.");
}

function weeklyReviewSection(review) {
  const line = entry => `• ${link(entry.title, entry.issue_url, 70)} · ${html([entry.repo, entry.owner ? `owner ${entry.owner}` : ""].filter(Boolean).join(" · "))}`;
  const block = (title, entries, limit = 6) => (entries && entries.length
    ? `${title} (${entries.length})\n${entries.slice(0, limit).map(line).join("\n")}${entries.length > limit ? `\n…and ${entries.length - limit} more` : ""}`
    : "");
  const parts = [
    `<b>This week</b> · ${review.open_count} open in the queue`,
    block("Added", review.added),
    block("Finished", review.done),
    block("In progress", review.in_progress),
    block("Gone quiet", review.stale),
  ].filter(Boolean);
  return parts.join("\n");
}

const PR_STATE_LABELS = {
  changes_requested: "Changes requested",
  ci_failing: "CI failing",
  needs_rebase: "Needs rebase",
  approved: "Approved",
  in_review: "In review",
  ci_pending: "CI running",
  awaiting_review: "Awaiting review",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  unknown: "Unknown",
};

function engineeringSection(report) {
  const lines = [`<b>Your work</b> · ${report.counts.active} in progress · ${report.counts.yourMove} need you`];
  for (const pr of report.prs.slice(0, 8)) {
    const flag = pr.yourMove ? "→ " : pr.state === "merged" ? "✔ " : "· ";
    lines.push(`${flag}${link(pr.title, pr.prUrl, 70)} · ${html(PR_STATE_LABELS[pr.state] || pr.state)}${pr.detail ? `: ${html(pr.detail)}` : ""}`);
  }
  for (const nudge of report.nudges.slice(0, 5)) {
    lines.push(`⏳ ${link(nudge.title, nudge.prUrl || nudge.issueUrl, 70)} · ${html(nudge.detail)}`);
  }
  if (report.nudges.some((n) => !n.prUrl)) {
    lines.push(`Link a PR with <code>/pr &lt;issue url&gt; &lt;pr url&gt;</code>`);
  }
  return lines.join("\n");
}

// Inline buttons that write back to the record: claim it, or drop it.
function opportunityKeyboard(item) {
  if (!item.record_id) return null;
  const id = String(item.record_id).slice(0, 50);
  return {
    inline_keyboard: [[
      { text: "I'll take it", callback_data: `claim:${id}` },
      { text: "Not for me", callback_data: `dismiss:${id}` },
    ]],
  };
}

function buildOpportunityMessage(item, index, total, options = {}) {
  const footer = "Open the dashboard for the code skeleton and work log.";
  const tag = options.tag ? ` · ${html(options.tag)}` : "";
  const head = [
    `<b>Opportunity ${index} of ${total}</b>${tag}`,
    `[${effortLabel(item.effort)}] ${link(item.opportunity, item.issue_url, 120)}`,
    "",
    `Repo: ${html(item.repo || "Unknown repo")}`,
    `Issue: ${html(item.issue_url || "No issue URL")}`,
    `Source: ${html(item.source || "scan")} · Score: ${Number(item.score || 0) || "n/a"}`,
  ];
  const activity = activityLine(item);
  if (activity) head.push(activity);
  const linkedPRs = (item.linked_prs || []).slice(0, 3);
  if (linkedPRs.length) {
    head.push(`Linked PRs: ${linkedPRs.map((pr) => {
      const label = pr.sameRepo === false && pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
      return `${link(label, pr.url, 60)} (${html(pr.state)})`;
    }).join(", ")}`);
  }
  const comment = options.comment || (options.tag === "UPDATED" ? commentLine(item.latest_comment) : "");
  if (comment) head.push(`New comment: ${comment}`);

  const body = [];
  if (item.maintainer_wants) {
    body.push(`<b>Maintainer wants</b>\n${html(truncate(item.maintainer_wants, 450))}`);
  }
  if (item.current_state && item.current_state !== "available" && item.state_reason) {
    body.push(`<b>State</b>\n${html(item.current_state.replace(/_/g, " "))}: ${html(truncate(item.state_reason, 200))}`);
  }
  body.push(`<b>Why</b>\n${html(truncate(item.why_it_qualifies, 450))}`);
  const planSteps = Array.isArray(item.analysis?.analysis?.plan) ? item.analysis.analysis.plan : [];
  if (planSteps.length) {
    body.push(`<b>Plan</b>\n${planSteps.slice(0, 5).map((step, i) => `${i + 1}. ${html(truncate(step, 160))}`).join("\n")}`);
  } else {
    body.push(`<b>Next</b>\n${html(truncate(item.suggested_action, 550))}`);
  }
  const files = (item.files_to_change || []).slice(0, 4);
  if (files.length) {
    body.push(`<b>Files</b>\n${files.map((file) => `• <code>${escapeHtml(file.path)}</code>${file.why ? ` — ${html(truncate(file.why, 90))}` : ""}`).join("\n")}`);
  }
  const questions = (item.open_questions || []).slice(0, 2);
  if (questions.length) {
    body.push(`<b>Ask first</b>\n${questions.map((q) => `• ${html(truncate(q, 160))}`).join("\n")}`);
  }
  if (!isEmptyTip(item.clarity_tip)) {
    const tip = truncate(item.clarity_tip, 300);
    // Short tips are usually a bare command: render them as code.
    const looksLikeCommand = tip.length <= 80 && !/[.!?]\s|\s(and|then|or)\s/i.test(tip) && !tip.includes("`");
    body.push(`<b>Check</b>\n${looksLikeCommand ? `<code>${escapeHtml(tip)}</code>` : html(tip)}`);
  }

  const message = `${head.join("\n")}\n\n${body.join("\n\n")}\n\n${footer}`;
  const text = fitMessage(message, "Opportunity shortened. Open the dashboard for the full detail.");
  const replyMarkup = opportunityKeyboard(item);
  return replyMarkup ? { text, replyMarkup } : text;
}

function buildDigestMessages(digest) {
  const detailLimit = envLimit("DIGEST_DETAIL_LIMIT", 8);
  const { changes, fresh, updated, repeated, updatedByUrl } = classifyDigest(digest);
  // New and updated items get a detail message. Repeats only appear when a
  // scan was explicitly run without dedupe, so they are detailed too.
  const repeatedKeys = new Set(repeated.map(({ item }) => normalizeUrl(item.issue_url)));
  const detailed = [...fresh, ...updated, ...repeated]
    .sort((a, b) => a.index - b.index)
    .slice(0, detailLimit);

  return [
    buildDigestMessage(digest),
    ...detailed.map(({ item }, position) => {
      const key = normalizeUrl(item.issue_url);
      const isUpdated = Boolean(changes) && updatedByUrl.has(key);
      const entry = isUpdated ? updatedByUrl.get(key) : null;
      return buildOpportunityMessage(item, position + 1, detailed.length, {
        tag: changes ? (isUpdated ? "UPDATED" : repeatedKeys.has(key) ? "SEEN BEFORE" : "NEW") : "",
        comment: entry ? commentLine(entry.latest_comment || item.latest_comment) : "",
      });
    }),
  ];
}

function analysisReply(result) {
  const a = result.analysis || {};
  const ctx = result.context || {};
  const issue = ctx.issue || {};
  const lines = [
    `<b>${html(issue.title || result.issueUrl)}</b>`,
    html(result.issueUrl),
    `State: ${html(String(a.currentState || "").replace(/_/g, " "))}${a.stateReason ? ` — ${html(truncate(a.stateReason, 160))}` : ""}`,
    `Effort ${html(a.effort)} · Impact ${html(a.impact)} · Confidence ${a.confidence || 0}%${result.model === "heuristic" ? " · heuristic" : ""}`,
  ];
  if (a.maintainerWants) lines.push("", `<b>Maintainer wants</b>\n${html(truncate(a.maintainerWants, 500))}`);
  if ((a.plan || []).length) lines.push("", `<b>Plan</b>\n${a.plan.slice(0, 6).map((step, i) => `${i + 1}. ${html(truncate(step, 160))}`).join("\n")}`);
  if ((a.filesToChange || []).length) lines.push("", `<b>Files</b>\n${a.filesToChange.slice(0, 5).map((f) => `• <code>${escapeHtml(f.path)}</code>`).join("\n")}`);
  if ((a.openQuestions || []).length) lines.push("", `<b>Ask first</b>\n${a.openQuestions.slice(0, 3).map((q) => `• ${html(truncate(q, 160))}`).join("\n")}`);
  if (a.validation) lines.push("", `<b>Check</b>\n<code>${escapeHtml(truncate(a.validation, 120))}</code>`);
  return fitMessage(lines.join("\n"), "Shortened. Open the dashboard for the full analysis.");
}

async function handleCallbackQuery(query, bot) {
  const active = bot || primaryBot() || {};
  const token = active.token || config.telegram.botToken;
  const botId = active.botId || "";
  const chatId = normalizeChatId(query.message && query.message.chat && query.message.chat.id);
  const answer = (text) => telegramCall(token, "answerCallbackQuery", { callback_query_id: query.id, text }).catch(() => null);

  const match = String(query.data || "").match(/^(claim|dismiss|why):([^:]+)(?::(\w+))?$/);
  if (!match) return answer("Unknown action");
  if (!(await isSubscriber(chatId, botId))) return answer("Subscribe with /start first");

  const [, action, recordId, reasonKey] = match;
  const who = (query.from && (query.from.username || query.from.first_name)) || "telegram";
  const stamp = new Date().toISOString().slice(0, 10);
  const editButtons = (rows) => (query.message
    ? telegramCall(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: rows },
    }).catch(() => null)
    : null);

  try {
    const existing = await findActivityLog(recordId);
    const appendLog = (line) => (existing ? `${existing}\n${line}` : line);
    if (action === "claim") {
      await updateOpportunity(recordId, {
        status: "In Progress",
        owner: who,
        activityLog: appendLog(`[telegram ${stamp}] claimed by ${who}`),
      });
      await answer(`Assigned to ${who}`);
      await editButtons([[{ text: `✔ Taken by ${who}`, callback_data: "noop" }]]);
    } else if (action === "dismiss") {
      await updateOpportunity(recordId, {
        status: "Done",
        activityLog: appendLog(`[telegram ${stamp}] dismissed by ${who}`),
      });
      await answer("Dismissed. Why? (helps future picks)");
      await editButtons([
        Object.entries(DISMISS_REASONS).map(([key, label]) => ({ text: label, callback_data: `why:${recordId}:${key}` })),
      ]);
    } else {
      const reason = DISMISS_REASONS[reasonKey] || "other";
      await updateOpportunity(recordId, {
        activityLog: appendLog(`[telegram ${stamp}] [dismiss reason: ${reason}]`),
      });
      await answer(`Noted: ${reason}`);
      await editButtons([[{ text: `✖ Dismissed · ${reason}`, callback_data: "noop" }]]);
    }
  } catch (e) {
    return answer(`Could not update: ${e.message}`);
  }
  return true;
}

async function findActivityLog(recordId) {
  try {
    const { listOpportunities } = require("./airtable");
    const { opportunities } = await listOpportunities();
    const record = opportunities.find((item) => item.id === recordId);
    return record ? record.activityLog || "" : "";
  } catch {
    return "";
  }
}

async function handleTelegramUpdate(update, onScan, bot) {
  if (update && update.callback_query) {
    return handleCallbackQuery(update.callback_query, bot);
  }
  const msg = update && update.message;
  if (!msg || !msg.chat) return;

  const active = bot || primaryBot() || {};
  const botId = active.botId || "";
  const token = active.token || config.telegram.botToken;

  const command = normalizeCommand(msg.text);
  const chatId = normalizeChatId(msg.chat.id);
  const reply = (text) => sendTelegramToChat(chatId, text, token);

  if (command === "start" || command === "subscribe") {
    await subscribeTelegramChat(msg.chat, botId);
    await reply(
      "You are subscribed. You will receive the daily Repository Intelligence Digest here. Send /stop to unsubscribe.\n\nScan commands:\n/scan - top prioritized issues\n/scan goodfirst - good first issues\n/scan medium - medium-effort issues",
    );
  } else if (command === "stop" || command === "unsubscribe") {
    await unsubscribeTelegramChat(chatId, botId);
    await reply("You are unsubscribed. Send /start any time to subscribe again.");
  } else if (command === "scan") {
    if (!(await isSubscriber(chatId, botId))) {
      await reply(
        "You need to be subscribed to trigger scans. Send /start to subscribe first.",
      );
      return;
    }
    const scanMode = parseScanMode(msg.text);
    await reply(`Got it — starting ${scanModeLabel(scanMode)} scan now...`);
    try {
      // chatId lets serverless callers report back to the requester; runScan
      // ignores the extra keys, so long-polling mode is unaffected.
      const result = await onScan({
        trigger: `telegram-${scanMode}`,
        scanMode,
        dedupe: false,
        chatId,
        botId,
      });
      // Serverless callers hand the scan off elsewhere and return a status note.
      if (result && result.message) {
        await reply(result.message);
      }
    } catch (e) {
      await reply(`Scan failed: ${e.message}`);
    }
  } else if (command === "pr") {
    if (!(await isSubscriber(chatId, botId))) {
      await reply("Subscribe with /start first.");
      return;
    }
    const urls = String(msg.text || "").match(/https?:\/\/github\.com\/\S+/gi) || [];
    const issueRef = urls.map((u) => ({ u, ref: parseIssueUrl(u) })).find((x) => x.ref && /\/issues\//i.test(x.u));
    const prRef = urls.map((u) => ({ u, ref: parseIssueUrl(u) })).find((x) => x.ref && /\/pull\//i.test(x.u));
    if (!issueRef || !prRef) {
      await reply("Usage: /pr <issue url> <pr url>");
      return;
    }
    try {
      const { listOpportunities } = require("./airtable");
      const { opportunities } = await listOpportunities();
      const record = opportunities.find((item) => normalizeUrl(item.issueUrl) === normalizeUrl(issueRef.u));
      if (!record) {
        await reply("That issue is not in the queue yet. Run /scan or add it from the dashboard first.");
        return;
      }
      const who = (msg.from && (msg.from.username || msg.from.first_name)) || record.owner || "telegram";
      const stamp = new Date().toISOString().slice(0, 10);
      await updateOpportunity(record.id, {
        prUrl: prRef.u,
        status: "In Progress",
        owner: record.owner || who,
        activityLog: `${record.activityLog ? `${record.activityLog}\n` : ""}[telegram ${stamp}] linked PR ${prRef.u}`,
      });
      await reply(`Linked. I will track ${prRef.u} for reviews, CI, and merge.`);
    } catch (e) {
      await reply(`Could not link: ${e.message}`);
    }
  } else if (command === "analyze" || command === "analyse") {
    if (!(await isSubscriber(chatId, botId))) {
      await reply("You need to be subscribed to analyze issues. Send /start first.");
      return;
    }
    const urlMatch = String(msg.text || "").match(/https?:\/\/github\.com\/\S+/i);
    const ref = urlMatch ? parseIssueUrl(urlMatch[0]) : null;
    if (!ref) {
      await reply("Send the issue link, e.g. /analyze https://github.com/owner/repo/issues/123");
      return;
    }
    await reply("Reading the issue, thread, linked PRs, and source…");
    try {
      const result = await analyzeIssue({ url: urlMatch[0] });
      await sendTelegramToChat(chatId, analysisReply(result), token, { parseMode: DIGEST_PARSE_MODE });
    } catch (e) {
      await reply(`Analysis failed: ${e.message}`);
    }
  } else if (command === "status") {
    await reply(
      (await isSubscriber(chatId, botId))
        ? "Bot is running. Send /scan to trigger a scan, or /stop to unsubscribe from digests."
        : "Bot is running. You will receive daily updates if subscribed. Send /start to subscribe or /stop to unsubscribe.",
    );
  } else if (command === "help") {
    await reply(
      (await isSubscriber(chatId, botId))
        ? "Commands:\n/start - subscribe to daily updates\n/stop - unsubscribe\n/status - check bot\n/analyze <issue url> - deep read of one issue\n/pr <issue url> <pr url> - link your PR so I track it\n/scan - top prioritized issues\n/scan all - broad open-issue scan\n/scan goodfirst - good first issues\n/scan medium - medium-effort issues"
        : "Commands:\n/start - subscribe to daily updates\n/stop - unsubscribe\n/status - check bot",
    );
  }
}

async function listenForCommands(onScan) {
  const { botToken } = config.telegram;
  if (!botToken) {
    console.warn("Telegram bot not configured — command listener disabled");
    return;
  }

  const bots = listBots();
  const admin = adminChatId();
  console.log(
    admin
      ? `Telegram bot listening publicly (${bots.length} bot${bots.length === 1 ? "" : "s"}). Admin scan chat: ${admin}`
      : `Telegram bot listening publicly (${bots.length} bot${bots.length === 1 ? "" : "s"}). Set TELEGRAM_CHAT_ID to enable admin /scan.`,
  );

  // Each bot has its own update stream and its own getUpdates offset, so poll
  // them in parallel rather than sequentially.
  await Promise.all(bots.map((bot) => pollBot(bot, onScan, admin)));
}

async function pollBot(bot, onScan, admin) {
  let offset = 0;
  await setTelegramCommands(bot.token);
  if (admin && bot.isPrimary) {
    await sendTelegramToChat(
      admin,
      "Bot started. Public users can send /start to subscribe. Admin can send /scan.",
      bot.token,
    );
  }

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message","callback_query"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
      if (!res.ok) {
        // 409 means a webhook is registered for this bot; polling can't also run.
        if (res.status === 409) {
          console.warn(
            `  Bot ${bot.botId}: getUpdates conflict (409) — a webhook is set. Run scripts/set-webhook.js --delete to poll instead.`,
          );
          await sleep(30_000);
        } else {
          await sleep(5000);
        }
        continue;
      }

      const { result } = await res.json();
      for (const update of result) {
        offset = update.update_id + 1;
        try {
          await handleTelegramUpdate(update, onScan, bot);
        } catch (e) {
          console.warn("Update handler error:", e.message);
        }
      }
    } catch (e) {
      if (e.name !== "TimeoutError") console.warn("Poll error:", e.message);
      await sleep(3000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  sendNotification,
  DIGEST_PARSE_MODE,
  stripHtml,
  messageText,
  handleCallbackQuery,
  buildDigestMessage,
  buildDigestMessages,
  listenForCommands,
  handleTelegramUpdate,
  listTelegramSubscribers,
  subscribeTelegramChat,
  unsubscribeTelegramChat,
  sendTelegramToChat,
  setTelegramCommands,
  normalizeCommand,
  parseScanMode,
};
