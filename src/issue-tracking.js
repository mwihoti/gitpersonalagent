'use strict';

// Pure helpers that turn "what we already saved" plus "what GitHub says today"
// into a changelog: new issues, issues with fresh activity, issues that closed
// or got claimed, and issues we are still tracking. No I/O lives here so the
// behaviour is easy to test.

const DONE_STATUS = /\b(done|closed|complete|completed|shipped|merged|dropped|won'?t|skip|skipped)\b/i;

function normalizeUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function isDoneStatus(status) {
  return DONE_STATUS.test(String(status || ''));
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// records: normalized rows from airtable.listOpportunities(). Newest first.
function buildSeenMap(records = []) {
  const seen = new Map();
  for (const record of records) {
    const key = normalizeUrl(record.issueUrl);
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      existing.duplicates += 1;
      // Keep the earliest scan date as "tracked since".
      if (record.date && (!existing.trackedSince || record.date < existing.trackedSince)) {
        existing.trackedSince = record.date;
      }
      continue;
    }
    seen.set(key, {
      recordId: record.id || '',
      issueUrl: record.issueUrl || '',
      repo: record.repo || '',
      opportunity: record.opportunity || '',
      status: record.status || 'New',
      issueUpdatedAt: String(record.issueUpdatedAt || '').trim(),
      trackedSince: record.date || '',
      lastUpdated: record.lastUpdated || '',
      activityLog: record.activityLog || '',
      owner: record.owner || '',
      prUrl: record.prUrl || '',
      duplicates: 0,
    });
  }
  return seen;
}

function annotateIssue(issue, seen) {
  const tracked = seen.get(normalizeUrl(issue.url));
  if (!tracked) {
    return { ...issue, seenBefore: false, hasNewActivity: false };
  }
  const currentUpdatedAt = String(issue.updatedAt || '').trim();
  // Rows saved before the "Issue Updated At" column existed have no baseline.
  // We cannot tell whether they changed, so treat them as unchanged and let
  // the scan record today's timestamp as the baseline.
  const needsBaseline = Boolean(currentUpdatedAt) && !tracked.issueUpdatedAt;
  const hasNewActivity = Boolean(currentUpdatedAt) && !needsBaseline && currentUpdatedAt !== tracked.issueUpdatedAt;
  return {
    ...issue,
    seenBefore: true,
    hasNewActivity,
    needsBaseline,
    previousUpdatedAt: tracked.issueUpdatedAt,
    trackedStatus: tracked.status,
    trackedRecordId: tracked.recordId,
    trackedSince: tracked.trackedSince,
    trackedOwner: tracked.owner,
  };
}

function annotateRepoData(repoData = [], seen = new Map()) {
  return repoData.map(repo => ({
    ...repo,
    issues: (repo.issues || []).map(issue => annotateIssue(issue, seen)),
  }));
}

// Decide which issues the model should look at. Returns the filtered repo data
// and what was skipped, so the digest can explain itself.
function selectIssuesForModel(repoData = [], options = {}) {
  const { dedupe = true, includeClaimed = process.env.DIGEST_INCLUDE_CLAIMED === 'true' } = options;
  const skipped = { unchanged: [], claimed: [], trackedDone: [] };

  const filtered = repoData.map(repo => {
    const issues = (repo.issues || []).filter(issue => {
      if (!includeClaimed && issue.claim && issue.claim.claimed) {
        skipped.claimed.push(issue);
        return false;
      }
      if (!dedupe || !issue.seenBefore) return true;
      if (isDoneStatus(issue.trackedStatus)) {
        skipped.trackedDone.push(issue);
        return false;
      }
      if (!issue.hasNewActivity) {
        skipped.unchanged.push(issue);
        return false;
      }
      return true;
    });
    return { ...repo, issues };
  });

  return { repoData: filtered, skipped };
}

function perRepoLimit() {
  return envNumber('DIGEST_MAX_PER_REPO', 2);
}

function capPerRepo(items = [], max = perRepoLimit()) {
  if (!max) return items;
  const counts = new Map();
  return items.filter(item => {
    const repo = String(item.repo || '').toLowerCase();
    const count = counts.get(repo) || 0;
    if (count >= max) return false;
    counts.set(repo, count + 1);
    return true;
  });
}

function formatAge(value, now = Date.now()) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.max(0, Math.floor((now - date.getTime()) / 86400000));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// Tracked records worth re-checking against GitHub: still open on our side,
// recent enough to matter, capped so a big backlog cannot blow the run budget.
function pickTrackedForStatusCheck(seen, options = {}) {
  const {
    maxDays = envNumber('DIGEST_TRACK_DAYS', 21),
    limit = envNumber('DIGEST_STATUS_CHECKS', 30),
    now = Date.now(),
    skipUrls = new Set(),
  } = options;

  const cutoff = now - maxDays * 86400000;
  return [...seen.values()]
    .filter(entry => entry.recordId && !isDoneStatus(entry.status))
    .filter(entry => !skipUrls.has(normalizeUrl(entry.issueUrl)))
    .filter(entry => {
      const stamp = new Date(entry.lastUpdated || entry.trackedSince || '').getTime();
      return Number.isNaN(stamp) ? true : stamp >= cutoff;
    })
    .sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')))
    .slice(0, limit);
}

function findIssue(repoData, url) {
  const key = normalizeUrl(url);
  for (const repo of repoData) {
    for (const issue of repo.issues || []) {
      if (normalizeUrl(issue.url) === key) return { ...issue, repo: repo.repo };
    }
  }
  return null;
}

// digest: model output after enrichment. statusResults: fetchIssueStatus()
// results for tracked issues that were not in today's scan.
function buildChanges({ digest, repoData = [], seen = new Map(), statusResults = [], skipped = {} }) {
  const items = digest.contest_digest || [];
  const fresh = [];
  const updated = [];
  const inDigest = new Set();

  for (const item of items) {
    const key = normalizeUrl(item.issue_url);
    if (key) inDigest.add(key);
    const tracked = key ? seen.get(key) : null;
    if (!tracked) {
      fresh.push(item.issue_url || '');
      continue;
    }
    updated.push({
      issue_url: item.issue_url,
      previous_updated_at: tracked.issueUpdatedAt,
      latest_comment: item.latest_comment || null,
    });
  }

  const closed = [];
  const claimed = [];
  const describe = (entry, extra = {}) => ({
    issue_url: entry.issueUrl,
    repo: entry.repo,
    title: entry.opportunity,
    record_id: entry.recordId,
    tracked_since: entry.trackedSince,
    ...extra,
  });

  // Tracked issues that appeared in today's scan already carry fresh state.
  for (const entry of seen.values()) {
    if (isDoneStatus(entry.status)) continue;
    const key = normalizeUrl(entry.issueUrl);
    if (inDigest.has(key)) continue;
    const live = findIssue(repoData, entry.issueUrl);
    if (live && live.claim && live.claim.claimed) {
      claimed.push(describe(entry, { reason: live.claim.reason, by: live.claim.by, pr_url: live.claim.prUrl }));
    }
  }

  for (const status of statusResults) {
    if (!status) continue;
    const entry = seen.get(normalizeUrl(status.url));
    if (!entry || isDoneStatus(entry.status)) continue;
    if (status.state === 'closed') {
      closed.push(describe(entry, {
        reason: status.stateReason === 'not_planned' ? 'closed as not planned' : 'closed',
        closed_at: status.closedAt,
      }));
    } else if (status.assignees && status.assignees.length) {
      claimed.push(describe(entry, {
        reason: `assigned to ${status.assignees.join(', ')}`,
        by: status.assignees[0],
        pr_url: '',
      }));
    }
  }

  const flagged = new Set([...closed, ...claimed].map(entry => normalizeUrl(entry.issue_url)));
  const stillOpen = (skipped.unchanged || [])
    .filter(issue => !flagged.has(normalizeUrl(issue.url)))
    .map(issue => ({
      issue_url: issue.url,
      repo: issue.repo || (seen.get(normalizeUrl(issue.url)) || {}).repo || '',
      title: issue.title,
      tracked_since: issue.trackedSince || '',
      updated_at: issue.updatedAt || '',
      fit_score: Number(issue.issueFitScore || 0),
    }))
    .sort((a, b) => b.fit_score - a.fit_score);

  return {
    new: fresh,
    updated,
    closed,
    claimed,
    still_open: stillOpen,
    skipped_claimed: (skipped.claimed || []).length,
    skipped_unchanged: (skipped.unchanged || []).length,
  };
}

function isStale(entry, options = {}) {
  const { days = envNumber('DIGEST_STALE_DAYS', 14), now = Date.now() } = options;
  if (isDoneStatus(entry.status)) return false;
  const stamp = new Date(entry.lastUpdated || entry.trackedSince || '').getTime();
  if (Number.isNaN(stamp)) return false;
  return now - stamp > days * 86400000;
}

// Week-in-review over the tracked queue: what was added, finished, is being
// worked on, and has gone quiet. Used by the Monday digest.
function buildWeeklyReview(seen, options = {}) {
  const { days = 7, now = Date.now() } = options;
  const cutoff = now - days * 86400000;
  const within = value => {
    const stamp = new Date(value || '').getTime();
    return !Number.isNaN(stamp) && stamp >= cutoff;
  };
  const describe = entry => ({
    issue_url: entry.issueUrl,
    repo: entry.repo,
    title: entry.opportunity,
    status: entry.status,
    owner: entry.owner,
    tracked_since: entry.trackedSince,
    pr_url: entry.prUrl,
  });

  const entries = [...seen.values()];
  const added = entries.filter(entry => within(entry.trackedSince)).map(describe);
  const done = entries.filter(entry => isDoneStatus(entry.status) && within(entry.lastUpdated)).map(describe);
  const inProgress = entries.filter(entry => /progress|active|doing|working/i.test(String(entry.status || ''))).map(describe);
  const stale = entries.filter(entry => isStale(entry, { now })).map(describe).slice(0, 10);
  const openCount = entries.filter(entry => !isDoneStatus(entry.status)).length;

  return { days, added, done, in_progress: inProgress, stale, open_count: openCount };
}

// Records that need their first "Issue Updated At" written, capped so a large
// backlog is backfilled over a few runs instead of hammering Airtable.
function baselineEvents(repoData = [], limit = envNumber('DIGEST_BASELINE_WRITES', 40)) {
  const events = [];
  for (const repo of repoData) {
    for (const issue of repo.issues || []) {
      if (events.length >= limit) return events;
      if (issue.needsBaseline && issue.trackedRecordId) {
        events.push({ recordId: issue.trackedRecordId, issueUpdatedAt: issue.updatedAt });
      }
    }
  }
  return events;
}

module.exports = {
  annotateRepoData,
  baselineEvents,
  buildWeeklyReview,
  isStale,
  buildChanges,
  buildSeenMap,
  capPerRepo,
  formatAge,
  isDoneStatus,
  normalizeUrl,
  perRepoLimit,
  pickTrackedForStatusCheck,
  selectIssuesForModel,
};
