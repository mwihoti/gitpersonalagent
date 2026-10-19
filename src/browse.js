'use strict';
// Interactive repo browser for the Telegram bot.
//
// /repos shows the repositories the scans currently cover as buttons. Tapping
// one lists its ten best open issues, re-sortable in place (best fit, good
// first issues, high-priority work), with a switch back to the all-repos view,
// which reads the saved queue. Everything is read-only, so the buttons work
// for every subscriber, not only the owner.
//
// Callback data (Telegram caps it at 64 bytes):
//   b:l            the repository list
//   b:a:<sort>     all repos (the queue), sorted
//   b:r:<sort>:<owner/repo>
// Sorts: f = best fit, g = good first issues, p = high priority.

const { labelNames } = require('./repo-insights');

// Queue records store labels as a comma-separated string; live issues as
// GitHub's array. Normalise both.
function anyLabels(value) {
  if (Array.isArray(value)) return labelNames(value);
  return String(value || '').split(',').map(label => label.trim().toLowerCase()).filter(Boolean);
}
const { isDoneStatus } = require('./issue-tracking');

const SORTS = {
  f: 'Best fit',
  g: 'Good first',
  p: 'High priority',
};
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PRIORITY_LABEL = /^(bug|p[01]|priority|critical|urgent|high[ -]priority)$/i;

function parseCallback(data) {
  const parts = String(data || '').split(':');
  if (parts[0] !== 'b') return null;
  if (parts[1] === 'l') return { view: 'list' };
  const sort = SORTS[parts[2]] ? parts[2] : 'f';
  if (parts[1] === 'a') return { view: 'all', sort };
  if (parts[1] === 'r') {
    const repo = parts.slice(3).join(':');
    if (!REPO_PATTERN.test(repo) || repo.length > 50) return null;
    return { view: 'repo', sort, repo };
  }
  return null;
}

function sortButtons(view, sort, repo) {
  const target = view === 'repo' ? `r:$SORT$:${repo}` : 'a:$SORT$';
  return Object.entries(SORTS).map(([key, label]) => ({
    text: `${key === sort ? '✓ ' : ''}${label}`,
    callback_data: `b:${target.replace('$SORT$', key)}`,
  }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ─── Repository list ──────────────────────────────────────────────────────────

function repoListView(repos, queue) {
  const open = (queue || []).filter(item => !isDoneStatus(item.status) && item.issueUrl);
  const counts = new Map();
  for (const item of open) {
    const key = String(item.repo || '').toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const rows = [];
  for (let index = 0; index < repos.length && rows.length < 12; index += 2) {
    rows.push(repos.slice(index, index + 2).map(repo => ({
      // The short name fits a button; the full owner/repo rides in the callback.
      text: repo.split('/')[1] || repo,
      callback_data: `b:r:f:${repo}`,
    })));
  }
  rows.push([{ text: `🌐 All repos (${open.length} in the queue)`, callback_data: 'b:a:f' }]);

  const lines = repos.map(repo => {
    const n = counts.get(repo.toLowerCase()) || 0;
    return `<code>${escapeHtml(repo)}</code>${n ? ` · ${n} in the queue` : ''}`;
  });

  return {
    text: [
      `<b>Repos in the daily scan</b> (${repos.length})`,
      '',
      lines.join('\n'),
      '',
      'Tap a repo for its ten best open issues, or All repos for the cross-repo queue.',
    ].join('\n'),
    replyMarkup: { inline_keyboard: rows },
  };
}

// ─── One repository, live from GitHub ─────────────────────────────────────────

function filterBySort(issues, sort) {
  if (sort === 'g') return issues.filter(issue => labelNames(issue.labels).includes('good first issue'));
  if (sort === 'p') return issues.filter(issue => labelNames(issue.labels).some(label => PRIORITY_LABEL.test(label)));
  return issues;
}

function repoIssuesView(repo, sort, result) {
  const open = (result.issues || []).filter(issue => !(issue.claim && issue.claim.claimed));
  const picked = filterBySort(open, sort)
    .sort((a, b) => Number(b.issueFitScore || 0) - Number(a.issueFitScore || 0)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 10);

  const lines = picked.map(issue => {
    const labels = labelNames(issue.labels).slice(0, 2).join(', ');
    return `<b>${Number(issue.issueFitScore) || '–'}</b> <a href="${escapeHtml(issue.url)}">#${issue.number} ${escapeHtml(clip(issue.title, 70))}</a>${labels ? `\n      ${escapeHtml(labels)}` : ''}`;
  });

  const empty = {
    g: 'No unclaimed good first issues open here right now.',
    p: 'No unclaimed bug or priority-labelled issues open here right now.',
    f: 'No unclaimed open issues found here right now.',
  }[sort];

  return {
    text: [
      `<b>${escapeHtml(repo)}</b> · ${result.totalOpenIssues ?? open.length}${result.truncated ? '+' : ''} open issues · ${SORTS[sort]}`,
      '',
      lines.join('\n') || empty,
      '',
      `${result.truncated ? `Ranked within the ${result.openItems} most recently updated items. ` : ''}Scores are quick estimates from labels, age, and activity. <code>/analyze &lt;issue url&gt;</code> reads the thread before you start.`,
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        sortButtons('repo', sort, repo),
        [{ text: '« Repos', callback_data: 'b:l' }, { text: '🌐 All repos', callback_data: `b:a:${sort}` }],
      ],
    },
  };
}

// ─── All repos: the saved queue ───────────────────────────────────────────────

function allReposView(sort, queue) {
  const open = (queue || []).filter(item => !isDoneStatus(item.status) && item.issueUrl);
  const matching = open.filter(item => {
    if (sort === 'g') return anyLabels(item.labels).includes('good first issue');
    if (sort === 'p') return item.priority === 'High';
    return true;
  }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 10);

  const lines = matching.map(item => [
    `<b>${Number(item.score) || '–'}</b> <a href="${escapeHtml(item.issueUrl)}">${escapeHtml(clip(item.opportunity || item.repo, 70))}</a>`,
    `      <code>${escapeHtml(item.repo)}</code>${item.effort ? ` · ${escapeHtml(item.effort)}` : ''}${sort !== 'p' && item.priority === 'High' ? ' · high priority' : ''}`,
  ].join('\n'));

  const empty = {
    g: 'Nothing labelled good first issue in the queue right now.',
    p: 'Nothing high-priority in the queue right now.',
    f: 'The queue is empty. The daily scan refills it.',
  }[sort];

  return {
    text: [
      `<b>All repos</b> · ${open.length} open in the queue · ${SORTS[sort]}`,
      '',
      lines.join('\n') || empty,
      '',
      'From the latest scans, claims already checked. Tap a repo in « Repos for live issues.',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        sortButtons('all', sort),
        [{ text: '« Repos', callback_data: 'b:l' }],
      ],
    },
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

let targetCache = { at: 0, repos: [] };

function defaultDeps() {
  return {
    // The repositories the scans cover right now, cached for ten minutes so
    // button taps do not refetch the BitcoinDevs page.
    targets: async () => {
      if (targetCache.repos.length && Date.now() - targetCache.at < 600_000) return targetCache.repos;
      const { getScanTargets } = require('./repositories');
      const repos = (await getScanTargets()).repos || [];
      if (repos.length) targetCache = { at: Date.now(), repos };
      return repos;
    },
    scan: (repo, options) => require('./github').scanRepo(repo, options),
    queue: async () => (await require('./airtable').listOpportunities()).opportunities,
  };
}

// request: output of parseCallback, or { view: 'list' } for the /repos command.
async function browseView(request, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };

  if (!request || request.view === 'list') {
    const [repos, queue] = await Promise.all([deps.targets(), deps.queue().catch(() => [])]);
    if (!repos.length) {
      return { text: 'No repositories are configured yet. Add one on the dashboard, or wait for the next scan.', replyMarkup: null };
    }
    return repoListView(repos, queue);
  }

  if (request.view === 'all') {
    return allReposView(request.sort, await deps.queue());
  }

  // Live and cheap: list-data scores only (detail: 0), and for huge repos only
  // the newest few hundred items, so a button tap answers in a few seconds.
  const result = await deps.scan(request.repo, { mode: 'all-open', detail: 0, maxItems: 300 });
  return repoIssuesView(request.repo, request.sort, result);
}

module.exports = {
  SORTS,
  browseView,
  parseCallback,
  repoIssuesView,
  repoListView,
  allReposView,
};
