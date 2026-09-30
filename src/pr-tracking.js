'use strict';

// Engineering follow-through: once an item is claimed, watch the pull request
// (reviews, CI, mergeability, merge) and nudge work that has gone quiet.

const github = require('./github');
const { formatAge, isDoneStatus } = require('./issue-tracking');

const STALL_DAYS = Number(process.env.PR_STALL_DAYS) || 5;
const MAX_CHECKS = Number(process.env.PR_STATUS_CHECKS) || 20;

function inProgress(record) {
  return /progress|active|doing|working/i.test(String(record.status || ''));
}

function daysSince(value, now = Date.now()) {
  const stamp = new Date(value || '').getTime();
  if (Number.isNaN(stamp)) return null;
  return Math.floor((now - stamp) / 86400000);
}

// Reduce a PR snapshot to one actionable state.
function classifyPullRequest(pr) {
  if (!pr) return { state: 'unknown', detail: 'PR could not be loaded' };
  if (pr.merged) return { state: 'merged', detail: `merged ${formatAge(pr.mergedAt)}` };
  if (pr.state === 'closed') return { state: 'closed', detail: 'closed without merging' };
  if (pr.draft) return { state: 'draft', detail: 'still a draft' };
  if (pr.mergeableState === 'dirty') return { state: 'needs_rebase', detail: 'has conflicts with the base branch' };
  if (pr.ci === 'failure') return { state: 'ci_failing', detail: `CI failing${pr.ciDetail ? ` (${pr.ciDetail})` : ''}` };
  if (pr.reviewState === 'changes_requested') {
    return { state: 'changes_requested', detail: `changes requested${pr.reviewer ? ` by ${pr.reviewer}` : ''}` };
  }
  if (pr.reviewState === 'approved') return { state: 'approved', detail: `approved${pr.reviewer ? ` by ${pr.reviewer}` : ''}, waiting for merge` };
  if (pr.ci === 'pending') return { state: 'ci_pending', detail: 'CI still running' };
  if (pr.reviewComments > 0) return { state: 'in_review', detail: `${pr.reviewComments} review comment${pr.reviewComments === 1 ? '' : 's'}` };
  return { state: 'awaiting_review', detail: 'no review yet' };
}

// Your move, or theirs?
function ballIsInYourCourt(state) {
  return ['needs_rebase', 'ci_failing', 'changes_requested', 'draft', 'in_review'].includes(state);
}

// records: normalized Airtable rows. fetchers are injectable for tests.
async function buildEngineeringReport(records = [], options = {}) {
  const {
    now = Date.now(),
    fetchPullRequest = github.fetchPullRequestSnapshot,
    logger = console,
    githubLogins = String(process.env.GITHUB_LOGINS || process.env.GITHUB_LOGIN || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    linkedPRsByIssue = new Map(),
  } = options;

  const active = records.filter(record => inProgress(record) && !isDoneStatus(record.status));
  const prs = [];
  const nudges = [];
  const events = [];
  let checks = 0;

  for (const record of active) {
    let prUrl = record.prUrl;

    // Auto-link: an open PR on the issue by one of the configured logins.
    if (!prUrl && githubLogins.length) {
      const linked = linkedPRsByIssue.get(String(record.issueUrl || '').toLowerCase()) || [];
      const mine = linked.find(pr => pr.state !== 'closed' && githubLogins.includes(String(pr.author || '').toLowerCase()));
      if (mine) {
        prUrl = mine.url;
        events.push({
          recordId: record.id,
          activityLog: record.activityLog,
          prUrl,
          line: `[bot ${new Date(now).toISOString().slice(0, 10)}] linked your PR ${prUrl}`,
        });
      }
    }

    if (!prUrl) {
      const days = daysSince(record.lastUpdated || record.date, now);
      if (days !== null && days >= STALL_DAYS) {
        nudges.push({
          recordId: record.id,
          title: record.opportunity,
          issueUrl: record.issueUrl,
          repo: record.repo,
          owner: record.owner,
          days,
          detail: `in progress for ${days} days with no PR linked`,
        });
      }
      continue;
    }

    const ref = github.parseIssueUrl(prUrl);
    if (!ref || checks >= MAX_CHECKS) continue;
    checks += 1;
    let snapshot = null;
    try {
      snapshot = await fetchPullRequest(ref.repo, ref.number);
    } catch (error) {
      logger.warn(`  PR check skipped for ${prUrl}: ${error.message}`);
    }
    const { state, detail } = classifyPullRequest(snapshot);
    const days = snapshot ? daysSince(snapshot.updatedAt, now) : null;
    prs.push({
      recordId: record.id,
      title: record.opportunity,
      issueUrl: record.issueUrl,
      prUrl,
      repo: ref.repo,
      number: ref.number,
      owner: record.owner,
      state,
      detail,
      yourMove: ballIsInYourCourt(state),
      daysSinceUpdate: days,
      prTitle: snapshot ? snapshot.title : '',
    });

    const stamp = new Date(now).toISOString().slice(0, 10);
    if (state === 'merged') {
      events.push({
        recordId: record.id,
        activityLog: record.activityLog,
        status: 'Done',
        line: `[bot ${stamp}] PR merged ${prUrl} [outcome merged]`,
      });
    } else if (state === 'closed') {
      events.push({
        recordId: record.id,
        activityLog: record.activityLog,
        line: `[bot ${stamp}] PR closed without merge ${prUrl}`,
      });
    } else if (ballIsInYourCourt(state) && days !== null && days >= STALL_DAYS) {
      nudges.push({
        recordId: record.id,
        title: record.opportunity,
        issueUrl: record.issueUrl,
        prUrl,
        repo: ref.repo,
        owner: record.owner,
        days,
        detail: `${detail}, untouched for ${days} days`,
      });
    }
  }

  const order = ['changes_requested', 'ci_failing', 'needs_rebase', 'approved', 'in_review', 'ci_pending', 'awaiting_review', 'draft', 'merged', 'closed', 'unknown'];
  prs.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));

  return {
    prs,
    nudges,
    events,
    counts: {
      active: active.length,
      yourMove: prs.filter(pr => pr.yourMove).length,
      merged: prs.filter(pr => pr.state === 'merged').length,
    },
  };
}

module.exports = {
  buildEngineeringReport,
  classifyPullRequest,
  ballIsInYourCourt,
};
