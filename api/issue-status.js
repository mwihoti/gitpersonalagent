'use strict';
const { fetchIssueStatus, fetchLinkedPullRequests, fetchAllIssueComments, fetchIssueFull, parseIssueUrl } = require('../src/github');
const { detectClaim } = require('../src/repo-insights');
const { requireApiAuth } = require('../src/auth');
const { allowOptions, sendJson } = require('../src/http');

// GET /api/issue-status?url=<issue url>
// Live snapshot for the workbench: open/closed, assignees, linked PRs, the
// latest comment, and whether it changed since the record was saved.
module.exports = async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requireApiAuth(req, res)) return;

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://localhost');
  const issueUrl = url.searchParams.get('url') || '';
  const since = url.searchParams.get('since') || '';
  const ref = parseIssueUrl(issueUrl);
  if (!ref) {
    return sendJson(res, 400, { error: 'Pass a GitHub issue URL as ?url=' });
  }

  try {
    const [status, linkedPRs] = await Promise.all([
      fetchIssueStatus(ref.repo, ref.number),
      fetchLinkedPullRequests(ref.repo, ref.number).catch(() => []),
    ]);
    if (!status) {
      return sendJson(res, 404, { error: `Issue not found: ${ref.repo}#${ref.number}` });
    }

    let latestComment = null;
    let claim = { claimed: false, reason: '' };
    try {
      const issue = await fetchIssueFull(ref.repo, ref.number);
      const comments = await fetchAllIssueComments(issue, { max: 5, head: 0 });
      const last = comments[comments.length - 1];
      latestComment = last
        ? { author: last.user?.login || '', createdAt: last.created_at || '', body: String(last.body || '').slice(0, 400) }
        : null;
      claim = detectClaim(issue, comments, linkedPRs);
    } catch {
      /* status alone is still useful */
    }

    return sendJson(res, 200, {
      ...status,
      linkedPRs,
      latestComment,
      claim,
      changedSinceSaved: Boolean(since) && since !== status.updatedAt,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
};
