'use strict';

// Backlog hygiene for the tracked queue.
//
// Items that were recommended but never touched pile up: the issue closed
// upstream, somebody else took it, or it simply sat there for months. This
// module decides, per record, whether to close it, note the new owner, or
// archive it, so the workbench shows a queue instead of a history.
// Pure planning; writes happen through recordIssueEvents.

const github = require('./github');
const { isDoneStatus, normalizeUrl } = require('./issue-tracking');

const DAY = 86400000;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function inProgress(record) {
  return /progress|active|doing|working/i.test(String(record.status || '')) || Boolean(record.owner);
}

// Any sign a person looked at this record. Bot lines start with "[bot".
function hasHumanInput(record) {
  if (record.owner || record.prUrl || record.nextStep || record.dueDate) return true;
  const humanLines = String(record.activityLog || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('[bot'));
  return humanLines.length > 0;
}

function ageDays(record, now) {
  const stamp = new Date(record.date || record.lastUpdated || '').getTime();
  return Number.isNaN(stamp) ? 0 : Math.floor((now - stamp) / DAY);
}

function describe(record, extra) {
  return {
    recordId: record.id,
    title: record.opportunity,
    repo: record.repo,
    issueUrl: record.issueUrl,
    ageDays: extra.ageDays,
    ...extra,
  };
}

// records: normalized Airtable rows. Returns { actions, checked, skipped }.
async function planQueueRefresh(records = [], options = {}) {
  const {
    now = Date.now(),
    archiveDays = envNumber('QUEUE_ARCHIVE_DAYS', 90),
    maxChecks = envNumber('QUEUE_STATUS_CHECKS', 60),
    fetchStatus = github.fetchIssueStatus,
    skipUrls = new Set(),
    logger = console,
  } = options;

  const stamp = new Date(now).toISOString().slice(0, 10);
  const candidates = records
    .filter(record => record.issueUrl && !isDoneStatus(record.status) && !inProgress(record))
    .filter(record => !skipUrls.has(normalizeUrl(record.issueUrl)))
    // Oldest first: that is where the dead weight is.
    .sort((a, b) => ageDays(b, now) - ageDays(a, now));

  const actions = [];
  let checked = 0;
  const seenUrls = new Set();

  for (const record of candidates) {
    const key = normalizeUrl(record.issueUrl);
    if (seenUrls.has(key)) continue; // duplicate rows: the dedupe script handles those
    seenUrls.add(key);

    const age = ageDays(record, now);
    const untouched = !hasHumanInput(record);

    // Archive on age alone when the record was never touched: no GitHub call
    // needed, and it is the common case for an old backlog.
    if (untouched && age >= archiveDays) {
      actions.push(describe(record, {
        action: 'archive',
        ageDays: age,
        reason: `untouched for ${age} days`,
        event: {
          recordId: record.id,
          activityLog: record.activityLog,
          status: 'Done',
          line: `[bot ${stamp}] auto-archived: untouched for ${age} days [outcome archived]`,
          touch: false,
        },
      }));
      continue;
    }

    if (checked >= maxChecks) continue;
    const ref = github.parseIssueUrl(record.issueUrl);
    if (!ref) continue;
    checked += 1;
    let status = null;
    try {
      status = await fetchStatus(ref.repo, ref.number);
    } catch (error) {
      logger.warn(`  Queue refresh: could not check ${record.issueUrl}: ${error.message}`);
    }
    if (!status) continue;

    if (status.state === 'closed') {
      const how = status.stateReason === 'not_planned' ? 'closed as not planned' : 'closed';
      actions.push(describe(record, {
        action: 'close',
        ageDays: age,
        reason: `issue ${how} upstream`,
        event: {
          recordId: record.id,
          activityLog: record.activityLog,
          status: 'Done',
          line: `[bot ${stamp}] issue ${how} upstream [outcome closed-upstream]`,
          touch: false,
        },
      }));
      continue;
    }

    if (status.assignees && status.assignees.length) {
      const reason = `assigned to ${status.assignees.join(', ')}`;
      if (!String(record.activityLog || '').includes(reason)) {
        actions.push(describe(record, {
          action: 'note',
          ageDays: age,
          reason,
          event: {
            recordId: record.id,
            activityLog: record.activityLog,
            line: `[bot ${stamp}] ${reason}`,
            touch: false,
          },
        }));
      }
    }
  }

  const counts = { archive: 0, close: 0, note: 0 };
  for (const action of actions) counts[action.action] += 1;
  return { actions, counts, checked, candidates: candidates.length };
}

module.exports = {
  hasHumanInput,
  planQueueRefresh,
};
