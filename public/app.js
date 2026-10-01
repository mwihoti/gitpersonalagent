const state = {
  opportunities: [],
  filtered: [],
  repositories: [],
  selectedId: null,
  storage: 'loading',
  currentPage: 1,
  pageSize: 20,
  apiKey: window.sessionStorage.getItem('danagent.apiKey') || '',
  ecosystem: { areas: [], projects: [], activeArea: '' },
};

const els = {
  list: document.getElementById('opportunities-list'),
  statusFilter: document.getElementById('status-filter'),
  priorityFilter: document.getElementById('priority-filter'),
  searchInput: document.getElementById('search-input'),
  metricTotal: document.getElementById('metric-total'),
  metricProgress: document.getElementById('metric-progress'),
  metricDone: document.getElementById('metric-done'),
  metricHigh: document.getElementById('metric-high'),
  storageBadge: document.getElementById('storage-badge'),
  currentRunBadge: document.getElementById('current-run-badge'),
  lastRunSummary: document.getElementById('last-run-summary'),
  recentRunsList: document.getElementById('recent-runs-list'),
  runScanButton: document.getElementById('run-scan-button'),
  scanStatus: document.getElementById('scan-status'),
  detailEmpty: document.getElementById('detail-empty'),
  detailForm: document.getElementById('detail-form'),
  detailRepo: document.getElementById('detail-repo'),
  detailSource: document.getElementById('detail-source'),
  detailTitle: document.getElementById('detail-title'),
  detailIssueLink: document.getElementById('detail-issue-link'),
  detailStatus: document.getElementById('detail-status'),
  detailPriority: document.getElementById('detail-priority'),
  detailOwner: document.getElementById('detail-owner'),
  detailDueDate: document.getElementById('detail-due-date'),
  detailNextStep: document.getElementById('detail-next-step'),
  detailPrUrl: document.getElementById('detail-pr-url'),
  detailActivityLog: document.getElementById('detail-activity-log'),
  detailQuickPlan: document.getElementById('detail-quick-plan'),
  detailQualifies: document.getElementById('detail-qualifies'),
  detailAction: document.getElementById('detail-action'),
  detailMatters: document.getElementById('detail-matters'),
  detailTip: document.getElementById('detail-tip'),
  detailCode: document.getElementById('detail-code'),
  detailAnalyzeButton: document.getElementById('detail-analyze-button'),
  detailLive: document.getElementById('detail-live'),
  learningBadge: document.getElementById('learning-badge'),
  learningSummary: document.getElementById('learning-summary'),
  learningTags: document.getElementById('learning-tags'),
  detailAnalysis: document.getElementById('detail-analysis'),
  saveStatus: document.getElementById('save-status'),
  paginationSummary: document.getElementById('pagination-summary'),
  prevPageButton: document.getElementById('prev-page-button'),
  nextPageButton: document.getElementById('next-page-button'),
  repoForm: document.getElementById('repo-form'),
  repoInput: document.getElementById('repo-input'),
  repoStatus: document.getElementById('repo-status'),
  watchlistForm: document.getElementById('watchlist-form'),
  watchlistInput: document.getElementById('watchlist-input'),
  watchlistStatus: document.getElementById('watchlist-status'),
  watchlistList: document.getElementById('watchlist-list'),
  repoResults: document.getElementById('repo-results'),
  repoResultsName: document.getElementById('repo-results-name'),
  repoResultsCount: document.getElementById('repo-results-count'),
  repoIssuesList: document.getElementById('repo-issues-list'),
  ecosystemStatus: document.getElementById('ecosystem-status'),
  ecosystemAreas: document.getElementById('ecosystem-areas'),
  ecosystemProjects: document.getElementById('ecosystem-projects'),
};

// ── Bitcoin ecosystem starter ───────────────────────────────────────────
//
// The first thing a new contributor sees. /api/bitcoin-projects is static and
// unauthenticated, so this panel fills in even before a dashboard key is
// entered — someone can browse the ecosystem without credentials.

function renderEcosystemAreas() {
  const areas = state.ecosystem.areas.filter(area => area.projectCount > 0);
  els.ecosystemAreas.innerHTML = [
    { area: '', label: 'All areas', projectCount: state.ecosystem.projects.length },
    ...areas,
  ].map(area => `
    <button type="button" class="ecosystem-chip${state.ecosystem.activeArea === area.area ? ' is-active' : ''}"
            data-area="${escapeHtml(area.area)}" aria-pressed="${state.ecosystem.activeArea === area.area}" title="${escapeHtml(area.blurb || '')}">
      ${escapeHtml(area.label)}<span>${area.projectCount}</span>
    </button>
  `).join('');

  els.ecosystemAreas.querySelectorAll('.ecosystem-chip').forEach(node => {
    node.addEventListener('click', () => {
      state.ecosystem.activeArea = node.dataset.area;
      renderEcosystemAreas();
      renderEcosystemProjects();
    });
  });
}

function renderEcosystemProjects() {
  const { activeArea, projects } = state.ecosystem;
  const watched = new Set(state.repositories.map(item => String(item.repo).toLowerCase()));
  const visible = activeArea
    ? projects.filter(project => project.area === activeArea)
    : projects;

  if (!visible.length) {
    els.ecosystemProjects.innerHTML = '<div class="detail-empty">No projects in this area yet.</div>';
    return;
  }

  els.ecosystemProjects.innerHTML = visible.map(project => {
    const isWatched = watched.has(project.repo.toLowerCase());
    return `
      <article class="ecosystem-card">
        <div class="ecosystem-card-head">
          <a href="https://github.com/${escapeHtml(project.repo)}" target="_blank" rel="noreferrer">${escapeHtml(project.repo)}</a>
          <span class="ecosystem-level level-${escapeHtml(project.level)}">${escapeHtml({ newcomer: 'Newcomer friendly', intermediate: 'Some experience', deep: 'Protocol experience' }[project.level] || project.level)}</span>
        </div>
        <p>${escapeHtml(project.blurb)}</p>
        <div class="ecosystem-card-foot">
          <span class="ecosystem-lang">${escapeHtml(project.language)}</span>
          <button type="button" class="button button-secondary ecosystem-add"
                  data-repo="${escapeHtml(project.repo)}" ${isWatched ? 'disabled' : ''}>
            ${isWatched ? 'Watching' : 'Add to watchlist'}
          </button>
        </div>
      </article>
    `;
  }).join('');

  els.ecosystemProjects.querySelectorAll('.ecosystem-add').forEach(node => {
    node.addEventListener('click', () => {
      addEcosystemProject(node).catch(error => {
        els.ecosystemStatus.textContent = error.message;
      });
    });
  });
}

async function addEcosystemProject(button) {
  const repo = button.dataset.repo;
  button.disabled = true;
  button.textContent = 'Adding…';
  els.ecosystemStatus.textContent = `Adding ${repo}…`;
  try {
    const res = await authorizedFetch('/api/repositories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
    if (!res.ok) throw new Error(await readErrorResponse(res));
    await loadRepositories();
    els.ecosystemStatus.textContent = `${repo} added to your watchlist.`;
    renderEcosystemProjects();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Add to watchlist';
    throw error;
  }
}

async function loadBitcoinProjects() {
  const res = await fetch('/api/bitcoin-projects');
  if (!res.ok) throw new Error(await readErrorResponse(res));
  const payload = await res.json();
  state.ecosystem.areas = payload.areas || [];
  state.ecosystem.projects = payload.projects || [];
  els.ecosystemStatus.textContent = `${state.ecosystem.projects.length} projects across ${state.ecosystem.areas.filter(a => a.projectCount).length} areas`;
  renderEcosystemAreas();
  renderEcosystemProjects();
}

function renderRepositories() {
  if (!state.repositories.length) {
    els.watchlistList.innerHTML = '<div class="detail-empty"><strong>No repositories yet</strong><p>Add a repository above or <a href="#projects">browse Bitcoin projects</a>. With an empty watchlist, scans use BitcoinDevs and the project directory.</p></div>';
    syncEcosystemWatchState();
    return;
  }

  els.watchlistList.innerHTML = state.repositories.map(item => `
    <article class="watchlist-item">
      <div>
        <strong>${escapeHtml(item.repo)}</strong>
        <p>${escapeHtml(item.addedAt ? `Added ${new Date(item.addedAt).toLocaleString()}` : 'Ready for scheduled scans')}</p>
      </div>
      <div class="watchlist-actions">
        <button type="button" class="button button-secondary watchlist-inspect" data-repo="${escapeHtml(item.repo)}">Inspect</button>
        <button type="button" class="button button-secondary watchlist-remove" data-id="${escapeHtml(item.id)}">Remove</button>
      </div>
    </article>
  `).join('');

  syncEcosystemWatchState();

  els.watchlistList.querySelectorAll('.watchlist-inspect').forEach(node => {
    node.addEventListener('click', () => {
      inspectRepository(node.dataset.repo).catch(error => {
        els.repoStatus.textContent = error.message;
      });
    });
  });

  els.watchlistList.querySelectorAll('.watchlist-remove').forEach(node => {
    node.addEventListener('click', () => {
      removeRepository(node.dataset.id).catch(error => {
        els.watchlistStatus.textContent = error.message;
      });
    });
  });
}

// Adding or removing a repo anywhere changes which ecosystem cards read
// "Watching", so keep the starter panel in step.
function syncEcosystemWatchState() {
  if (state.ecosystem.projects.length) renderEcosystemProjects();
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function getVisibleOpportunities() {
  if (!state.repositories.length) {
    return state.opportunities;
  }

  const watchedRepos = new Set(state.repositories.map(item => normalizeText(item.repo)));
  return state.opportunities.filter(item => watchedRepos.has(normalizeText(item.repo)));
}

function renderLearning(learning) {
  if (!learning || !learning.sampleSize) {
    els.learningBadge.textContent = 'No history yet';
    els.learningSummary.textContent = 'The issues you take, finish, or dismiss help rank future suggestions. Dismissal reasons from Telegram count too.';
    els.learningTags.innerHTML = '';
    return;
  }
  const c = learning.counts || {};
  els.learningBadge.textContent = `${learning.sampleSize} outcomes · ${learning.confidence}% confidence`;
  els.learningSummary.textContent = learning.summary || '';
  els.learningTags.innerHTML = [
    createTag(`${c.merged || 0} merged`, 'tag-open'),
    createTag(`${c.pr_opened || 0} PRs open`),
    createTag(`${c.claimed || 0} claimed`),
    createTag(`${c.dismissed || 0} dismissed`, 'tag-stale'),
    ...(learning.boostedRepos || []).map(repo => createTag(`▲ ${escapeHtml(repo)}`, 'tag-open')),
    ...(learning.penalizedRepos || []).map(repo => createTag(`▼ ${escapeHtml(repo)}`, 'tag-stale')),
    ...(learning.dislikedLabels || []).map(label => createTag(`skips ${escapeHtml(label)}`, 'tag-stale')),
  ].join('');
}

function renderStats() {
  const visible = getVisibleOpportunities();
  const total = visible.length;
  const inProgress = visible.filter(item => item.status === 'In Progress').length;
  const done = visible.filter(item => item.status === 'Done').length;
  const high = visible.filter(item => item.priority === 'High').length;

  els.metricTotal.textContent = String(total);
  els.metricProgress.textContent = String(inProgress);
  els.metricDone.textContent = String(done);
  els.metricHigh.textContent = String(high);
  els.storageBadge.textContent = state.storage === 'airtable' ? 'Saved to Airtable' : state.storage === 'local' ? 'Saved locally' : state.storage;
}

function renderHealth(payload) {
  const currentRun = payload.currentRun;
  const recentRuns = payload.recentRuns || [];
  els.currentRunBadge.textContent = currentRun ? `Running • ${currentRun.trigger}` : 'Idle';

  const lastRun = recentRuns[0];
  if (!lastRun) {
    els.lastRunSummary.textContent = 'No scans recorded yet.';
    els.recentRunsList.innerHTML = '<div class="detail-empty">Your completed scans will appear here.</div>';
    return;
  }

  const duration = typeof lastRun.durationMs === 'number'
    ? `${Math.round(lastRun.durationMs / 100) / 10}s`
    : 'unknown duration';
  els.lastRunSummary.textContent = `Last scan: ${new Date(lastRun.startedAt).toLocaleString()} · ${lastRun.opportunities || 0} issues found · ${duration}`;

  els.recentRunsList.innerHTML = recentRuns.map(run => `
    <article class="watchlist-item">
      <div>
        <strong>${escapeHtml(run.status || 'Unknown')} · ${escapeHtml(run.trigger || 'unknown')}</strong>
        <p>${escapeHtml(new Date(run.startedAt).toLocaleString())} · ${run.repositories || 0} repositories · ${run.opportunities || 0} issues saved</p>
      </div>
      <div class="watchlist-actions">
        ${createTag(`${Math.round((run.durationMs || 0) / 100) / 10}s`)}
      </div>
    </article>
  `).join('');
}

function applyFilters() {
  const status = els.statusFilter.value;
  const priority = els.priorityFilter.value;
  const search = normalizeText(els.searchInput.value);

  state.filtered = getVisibleOpportunities().filter(item => {
    const matchesStatus = !status || item.status === status;
    const matchesPriority = !priority || item.priority === priority;
    const haystack = [
      item.repo,
      item.opportunity,
      item.nextStep,
      item.activityLog,
      item.owner,
    ].map(normalizeText).join(' ');
    const matchesSearch = !search || haystack.includes(search);
    return matchesStatus && matchesPriority && matchesSearch;
  });

  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  if (state.currentPage > totalPages) state.currentPage = totalPages;
  if (state.currentPage < 1) state.currentPage = 1;

  renderList();
}

function statusClass(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '-');
}

function createTag(label, className = '') {
  return `<span class="tag ${className}">${label}</span>`;
}

function formatHistoryDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const STALE_DAYS = 14;

function isStale(item) {
  if (/done|closed|complete|dropped/i.test(String(item.status || ''))) return false;
  const stamp = new Date(item.lastUpdated || item.date || '').getTime();
  if (Number.isNaN(stamp)) return false;
  return Date.now() - stamp > STALE_DAYS * 86400000;
}

function formatAgeShort(value) {
  const stamp = new Date(value || '').getTime();
  if (Number.isNaN(stamp)) return '';
  const days = Math.floor((Date.now() - stamp) / 86400000);
  if (days <= 0) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// Fetches the live GitHub state for the selected item and renders the strip.
async function loadLiveState(item) {
  els.detailLive.classList.remove('hidden');
  els.detailLive.innerHTML = '<span class="save-status">Checking GitHub…</span>';
  const params = new URLSearchParams({ url: item.issueUrl, since: item.issueUpdatedAt || '' });
  const res = await authorizedFetch(`/api/issue-status?${params}`);
  if (!res.ok) {
    els.detailLive.innerHTML = `<span class="save-status">${escapeHtml(await readErrorResponse(res))}</span>`;
    return;
  }
  const live = await res.json();
  if (state.selectedId !== item.id) return;
  const openPRs = (live.linkedPRs || []).filter(pr => pr.state === 'open' && pr.sameRepo !== false);
  const parts = [
    createTag(live.state === 'closed' ? `Closed${live.stateReason ? ` (${escapeHtml(live.stateReason.replace(/_/g, ' '))})` : ''}` : 'Open upstream', live.state === 'closed' ? 'tag-closed' : 'tag-open'),
    live.changedSinceSaved ? createTag('Changed since saved', 'tag-changed') : '',
    live.assignees && live.assignees.length ? createTag(`Assigned: ${escapeHtml(live.assignees.join(', '))}`) : createTag('Unassigned'),
    live.claim && live.claim.claimed ? createTag(`Claimed: ${escapeHtml(live.claim.reason)}`, 'tag-stale') : '',
    ...openPRs.map(pr => `<a class="tag" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">Open PR #${pr.number}${pr.author ? ` by ${escapeHtml(pr.author)}` : ''}</a>`),
    live.updatedAt ? createTag(`Updated ${escapeHtml(formatAgeShort(live.updatedAt))}`) : '',
  ];
  if (live.latestComment) {
    parts.push(`<div class="live-comment"><strong>${escapeHtml(live.latestComment.author)}</strong> ${escapeHtml(formatAgeShort(live.latestComment.createdAt))}: ${escapeHtml(live.latestComment.body)}</div>`);
  }
  els.detailLive.innerHTML = parts.filter(Boolean).join('');
}

function renderList() {
  const focusedId = document.activeElement?.classList.contains('list-item')
    ? document.activeElement.dataset.id : null;
  els.list.setAttribute('aria-busy', 'false');
  if (!state.filtered.length) {
    els.paginationSummary.textContent = '0 issues';
    els.prevPageButton.disabled = true;
    els.nextPageButton.disabled = true;
    const hasFilters = els.statusFilter.value || els.priorityFilter.value || els.searchInput.value;
    els.list.innerHTML = hasFilters
      ? '<div class="detail-empty"><strong>No matching issues</strong><p>Try a different search or clear the status and priority filters.</p><button type="button" class="button button-secondary" data-clear-filters>Clear filters</button></div>'
      : '<div class="detail-empty"><strong>Your queue is empty</strong><p>Run a scan to find open issues in your watchlist. If you haven’t added any projects, the scan checks BitcoinDevs and the project directory.</p><button type="button" class="button button-secondary" data-run-scan>Run your first scan</button><a class="text-link" href="#projects">Browse projects →</a></div>';
    showEmptyState();
    return;
  }

  const start = (state.currentPage - 1) * state.pageSize;
  const end = start + state.pageSize;
  const visibleItems = state.filtered.slice(start, end);
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  els.paginationSummary.textContent = `Showing ${start + 1}-${Math.min(end, state.filtered.length)} of ${state.filtered.length}`;
  els.prevPageButton.disabled = state.currentPage === 1;
  els.nextPageButton.disabled = state.currentPage >= totalPages;

  let lastDate = null;
  els.list.innerHTML = visibleItems.map(item => {
    const dateHeader = item.date !== lastDate
      ? `<div class="history-divider">${escapeHtml(formatHistoryDate(item.date))}</div>`
      : '';
    lastDate = item.date;
    return `
    ${dateHeader}
    <button type="button" class="list-item ${item.id === state.selectedId ? 'active' : ''}" data-id="${escapeHtml(item.id)}" aria-pressed="${item.id === state.selectedId}">
      <span class="list-item-header">
        <span class="issue-title">${escapeHtml(item.opportunity)}</span>
      </span>
      <span class="list-repo">${escapeHtml(item.repo)}</span>
      <span class="list-meta">
        ${createTag(escapeHtml(item.status || 'New'), `status-${statusClass(item.status)}`)}
        ${item.priority === 'High' ? createTag('High priority', 'priority-high') : ''}
        ${createTag(`${escapeHtml(item.effort || 'medium')} effort`)}
        ${isStale(item) ? createTag('Quiet for 14+ days', 'tag-stale') : ''}
      </span>
      <span class="list-footer">
        ${item.owner ? createTag(`Owner: ${escapeHtml(item.owner)}`) : ''}
        ${item.dueDate ? createTag(`Due: ${escapeHtml(item.dueDate)}`) : ''}
      </span>
    </button>
  `;
  }).join('');

  els.list.querySelectorAll('.list-item').forEach(node => {
    node.addEventListener('click', () => selectOpportunity(node.dataset.id, true));
    if (node.dataset.id === focusedId) node.focus({ preventScroll: true });
  });
}

function showEmptyState() {
  els.detailEmpty.classList.remove('hidden');
  els.detailForm.classList.add('hidden');
}

function selectOpportunity(id, focusDetail = false) {
  state.selectedId = id;
  renderList();

  const item = state.filtered.find(entry => entry.id === id)
    || getVisibleOpportunities().find(entry => entry.id === id);
  if (!item) {
    showEmptyState();
    return;
  }

  els.detailEmpty.classList.add('hidden');
  els.detailForm.classList.remove('hidden');
  els.detailRepo.textContent = item.repo || 'Unassigned repo';
  els.detailSource.textContent = [
    item.source ? `Source ${item.source}` : '',
    item.score ? `Score ${item.score}` : '',
    item.issueUpdatedAt ? `Issue updated ${new Date(item.issueUpdatedAt).toLocaleString()}` : '',
  ].filter(Boolean).join(' • ');
  els.detailTitle.textContent = item.opportunity || 'Untitled issue';
  els.detailIssueLink.href = item.issueUrl || '#';
  els.detailIssueLink.style.visibility = item.issueUrl ? 'visible' : 'hidden';
  els.detailStatus.value = item.status || 'New';
  els.detailPriority.value = item.priority || 'Medium';
  els.detailOwner.value = item.owner || '';
  els.detailDueDate.value = item.dueDate || '';
  els.detailNextStep.value = item.nextStep || '';
  els.detailPrUrl.value = item.prUrl || '';
  els.detailActivityLog.value = item.activityLog || '';
  els.detailQuickPlan.value = item.quickPlan || '';
  els.detailQualifies.textContent = item.whyItQualifies || 'No recommendation notes saved.';
  els.detailAction.textContent = item.suggestedAction || 'No suggested change saved.';
  els.detailMatters.textContent = item.whyItMatters || 'No impact notes saved.';
  els.detailTip.textContent = item.clarityTip || 'No test instructions saved.';
  els.detailCode.textContent = item.codeSkeleton || '// No suggested code saved.';
  renderDetailAnalysis(item.analysis || null);
  if (item.issueUrl) {
    loadLiveState(item).catch(error => {
      els.detailLive.innerHTML = `<span class="save-status">${escapeHtml(error.message)}</span>`;
    });
  } else {
    els.detailLive.classList.add('hidden');
  }
  els.detailAnalyzeButton.disabled = !item.issueUrl;
  els.detailAnalyzeButton.textContent = item.analysis ? 'Re-analyze issue' : 'Analyze issue';
  const summary = [
    item.date ? `Scan date ${item.date}` : '',
    item.lastUpdated ? `Last updated ${new Date(item.lastUpdated).toLocaleString()}` : '',
  ].filter(Boolean).join(' • ');
  els.saveStatus.textContent = summary;
  if (focusDetail && window.matchMedia('(max-width: 840px)').matches) {
    els.detailTitle.focus({ preventScroll: true });
    els.detailForm.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function rememberApiKey(apiKey) {
  state.apiKey = apiKey;
  if (apiKey) {
    window.sessionStorage.setItem('danagent.apiKey', apiKey);
    return;
  }
  window.sessionStorage.removeItem('danagent.apiKey');
}

async function readErrorResponse(res) {
  try {
    const payload = await res.clone().json();
    return payload.error || `Request failed with status ${res.status}`;
  } catch {
    return `Request failed with status ${res.status}`;
  }
}

async function authorizedFetch(url, options = {}, retry = true) {
  const headers = new Headers(options.headers || {});
  if (state.apiKey) {
    headers.set('X-API-Key', state.apiKey);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status !== 401 || !retry) {
    return response;
  }

  const nextApiKey = window.prompt('Enter the dashboard API key.', state.apiKey || '');
  if (!nextApiKey) {
    rememberApiKey('');
    return response;
  }

  rememberApiKey(nextApiKey.trim());
  return authorizedFetch(url, options, false);
}

async function loadOpportunities() {
  els.scanStatus.textContent = 'Loading issues…';
  const res = await authorizedFetch('/api/opportunities');
  if (!res.ok) {
    throw new Error(await readErrorResponse(res));
  }
  const payload = await res.json();
  state.opportunities = payload.opportunities || [];
  state.storage = payload.storage || 'unknown';
  state.currentPage = 1;
  renderLearning(payload.learning || null);
  renderStats();
  applyFilters();

  if (!state.selectedId && state.filtered[0]) {
    selectOpportunity(state.filtered[0].id);
  } else if (state.selectedId) {
    selectOpportunity(state.selectedId);
  }
  els.scanStatus.textContent = 'Ready';
}

async function loadRepositories() {
  const res = await authorizedFetch('/api/repositories');
  if (!res.ok) {
    throw new Error(await readErrorResponse(res));
  }
  const payload = await res.json();
  state.repositories = payload.repositories || [];
  renderRepositories();
  renderStats();
  applyFilters();
}

async function loadHealth() {
  const res = await authorizedFetch('/api/health');
  if (!res.ok) {
    throw new Error(await readErrorResponse(res));
  }
  renderHealth(await res.json());
}

const STATE_LABELS = {
  available: ['Available', 'state-available'],
  claimed: ['Claimed by someone', 'state-taken'],
  has_open_pr: ['Has an open PR', 'state-taken'],
  likely_done: ['Likely already done', 'state-taken'],
  stale: ['Stale', 'state-unclear'],
  blocked: ['Blocked', 'state-unclear'],
  needs_design: ['Needs design first', 'state-unclear'],
  needs_clarification: ['Needs clarification', 'state-unclear'],
};

function levelTag(label, value) {
  return value ? createTag(`${label} ${escapeHtml(value)}`) : '';
}

// Turns an analysis result ({ analysis, context, model, ... }) into HTML.
function analysisHtml(result) {
  const a = result.analysis || {};
  const ctx = result.context || {};
  const [stateLabel, stateClass] = STATE_LABELS[a.currentState] || ['Unknown', 'state-unclear'];
  const when = result.analyzedAt ? new Date(result.analyzedAt).toLocaleString() : '';
  const block = (title, body) => (body ? `<section><h4>${title}</h4>${body}</section>` : '');
  const listBlock = (title, items, ordered = false) => (items && items.length
    ? block(title, `<${ordered ? 'ol' : 'ul'}>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
    : '');

  const meta = `
    <div class="analysis-meta">
      <strong class="${stateClass}">${escapeHtml(stateLabel)}</strong>
      ${levelTag('Effort', a.effort)}
      ${levelTag('Impact', a.impact)}
      ${a.confidence ? createTag(`Confidence ${a.confidence}%`) : ''}
      ${createTag(result.model === 'heuristic' ? 'Heuristic (no model)' : 'Model analysis')}
      ${when ? `<span class="save-status">${escapeHtml(when)}${result.cached ? ' · cached' : ''}</span>` : ''}
    </div>
    ${a.stateReason ? `<p>${escapeHtml(a.stateReason)}</p>` : ''}
  `;

  const evidence = (a.evidence || []).length
    ? block('Evidence from the thread', a.evidence.map(item => `
        <blockquote class="analysis-quote">${escapeHtml(item.quote)}<cite>${escapeHtml(item.who)}${item.when ? ` · ${escapeHtml(item.when)}` : ''}</cite></blockquote>
      `).join(''))
    : '';

  const files = (a.filesToChange || []).length
    ? block('Files to change', `<ul>${a.filesToChange.map(file => `
        <li><code>${escapeHtml(file.path)}</code>${file.verified ? ' ✓' : ''}${file.why ? ` — ${escapeHtml(file.why)}` : ''}</li>
      `).join('')}</ul>`)
    : '';

  const prs = (ctx.pullRequests || []).length
    ? block('Linked pull requests', `<ul>${ctx.pullRequests.map(pr => `
        <li><a href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(pr.sameRepo === false && pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`)}</a> (${escapeHtml(pr.state)}${pr.author ? ` by ${escapeHtml(pr.author)}` : ''}) ${escapeHtml(pr.title || '')}</li>
      `).join('')}</ul>`)
    : '';

  const sources = (ctx.files || []).length
    ? block('Source consulted', `<ul>${ctx.files.map(file => `
        <li><a href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer"><code>${escapeHtml(file.path)}</code></a> lines ${file.startLine}-${file.endLine} · ${escapeHtml(file.reason)}</li>
      `).join('')}${ctx.contributing ? `<li><a href="${escapeHtml(ctx.contributing.url)}" target="_blank" rel="noreferrer">${escapeHtml(ctx.contributing.path)}</a></li>` : ''}</ul>`)
    : '';

  const conversation = (ctx.comments || []).length
    ? block('Recent conversation', `<div class="repo-comment-list">${ctx.comments.map(comment => `
        <article class="repo-comment">
          <strong>${escapeHtml(comment.author)}</strong>
          <span>${escapeHtml(String(comment.createdAt || '').slice(0, 10))}</span>
          <p>${escapeHtml(comment.body)}</p>
        </article>
      `).join('')}</div>`)
    : '';

  return [
    meta,
    block('Summary', `<p>${escapeHtml(a.summary || '')}</p>`),
    block('What the maintainer wants', `<p>${escapeHtml(a.maintainerWants || '')}</p>`),
    evidence,
    listBlock('Plan', a.plan, true),
    files,
    listBlock('Ask before starting', a.openQuestions),
    a.validation ? block('Validation', `<p><code>${escapeHtml(a.validation)}</code></p>`) : '',
    a.firstCommentDraft ? block('Draft comment for the issue', `<p>${escapeHtml(a.firstCommentDraft)}</p>`) : '',
    prs,
    sources,
    conversation,
    a.codeSkeleton ? block('Suggested code', `<pre>${escapeHtml(a.codeSkeleton)}</pre>`) : '',
  ].join('');
}

function renderDetailAnalysis(result) {
  if (!result || !result.analysis) {
    els.detailAnalysis.classList.add('hidden');
    els.detailAnalysis.innerHTML = '';
    return;
  }
  els.detailAnalysis.classList.remove('hidden');
  els.detailAnalysis.innerHTML = analysisHtml(result);
}

async function requestIssueAnalysis(payload) {
  const res = await authorizedFetch('/api/issue-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await readErrorResponse(res));
  }
  return res.json();
}

// Workbench: analyze the selected opportunity, store it on the record, and
// pre-fill the plan fields (left unsaved so the user stays in control).
async function analyzeSelectedOpportunity() {
  const item = state.opportunities.find(entry => entry.id === state.selectedId);
  if (!item || !item.issueUrl) return;
  const force = Boolean(item.analysis);
  els.detailAnalyzeButton.disabled = true;
  els.saveStatus.textContent = 'Reading the issue, thread, linked PRs, and source…';
  try {
    const result = await requestIssueAnalysis({ url: item.issueUrl, recordId: item.id, force });
    item.analysis = result;
    renderDetailAnalysis(result);
    const a = result.analysis || {};
    if (a.plan && a.plan.length) {
      els.detailQuickPlan.value = a.plan.map((step, index) => `${index + 1}. ${step}`).join('\n');
      if (!els.detailNextStep.value.trim()) {
        els.detailNextStep.value = a.plan[0];
      }
    }
    if (a.codeSkeleton) {
      els.detailCode.textContent = a.codeSkeleton;
    }
    if (a.validation) {
      els.detailTip.textContent = a.validation;
    }
    els.saveStatus.textContent = 'Analysis ready. Review the suggested plan, then save your changes.';
    els.detailAnalyzeButton.textContent = 'Re-analyze issue';
  } finally {
    els.detailAnalyzeButton.disabled = false;
  }
}

// Repo scout: analyze one issue card in place.
async function analyzeRepoIssue(button) {
  const url = button.dataset.url;
  const card = button.closest('.repo-issue-card');
  const target = card.querySelector('.repo-analysis-target');
  button.disabled = true;
  button.textContent = 'Analyzing…';
  try {
    const result = await requestIssueAnalysis({ url, force: button.dataset.force === 'true' });
    target.classList.remove('hidden');
    target.innerHTML = analysisHtml(result);
    button.textContent = 'Re-analyze';
    button.dataset.force = 'true';
  } catch (error) {
    target.classList.remove('hidden');
    target.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    button.textContent = 'Analyze';
  } finally {
    button.disabled = false;
  }
}

function renderRepoIssues(repo) {
  els.repoResults.classList.remove('hidden');
  const overview = repo.overview || {};
  els.repoResultsName.textContent = overview.name || repo.repo;
  els.repoResultsCount.textContent = `${repo.issues.length} open issues found`;

  if (!repo.issues.length) {
    els.repoIssuesList.innerHTML = '<div class="detail-empty">No open issues were found for this repository.</div>';
    return;
  }

  const projectSummary = overview.projectSummary
    ? `
      <article class="repo-overview-card">
        <div class="repo-overview-header">
          <div>
            <p class="eyebrow">Project overview</p>
            <h4>${escapeHtml(overview.name || repo.repo)}</h4>
          </div>
          ${overview.url ? `<a href="${escapeHtml(overview.url)}" target="_blank" rel="noreferrer" class="button button-secondary">Open repo</a>` : ''}
        </div>
        <p>${escapeHtml(overview.projectSummary)}</p>
        <div class="list-meta">
          ${overview.language ? createTag(overview.language) : ''}
          ${typeof overview.stars === 'number' ? createTag(`${overview.stars} stars`) : ''}
          ${typeof overview.openIssues === 'number' ? createTag(`${overview.openIssues} open issues`) : ''}
          ${(overview.topics || []).slice(0, 4).map(topic => createTag(escapeHtml(topic))).join('')}
        </div>
      </article>
    `
    : '';

  const renderIssueCard = issue => `
    <article class="repo-issue-card">
      <div class="list-item-header">
        <h4>${escapeHtml(issue.title)}</h4>
        <div class="watchlist-actions">
          <button type="button" class="button button-secondary repo-analyze-button" data-url="${escapeHtml(issue.url)}">Analyze</button>
          <a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer" class="button button-secondary">Open</a>
        </div>
      </div>
      <section class="analysis-card repo-analysis-target hidden"></section>
      <p>${escapeHtml((issue.body || '').slice(0, 180) || 'No issue description provided.')}</p>
      <div class="list-meta">
        ${createTag(`#${issue.number}`)}
        ${createTag(issue.updatedAt ? issue.updatedAt.slice(0, 10) : 'Open')}
        ${createTag(`${issue.issueFitScore || 0}/100`, `fit-${statusClass(issue.issueFitLabel || 'low fit')}`)}
        ${createTag(issue.issueFitLabel || 'Low fit', `fit-${statusClass(issue.issueFitLabel || 'low fit')}`)}
        ${createTag(issue.issueComplexity || 'Medium', `complexity-${statusClass(issue.issueComplexity || 'medium')}`)}
        ${issue.claim && issue.claim.claimed ? createTag(`Claimed: ${escapeHtml(issue.claim.reason)}`, 'fit-low-fit') : ''}
        ${(issue.labels || []).slice(0, 4).map(label => createTag(escapeHtml(label))).join('')}
      </div>
      <p class="save-status">This estimate uses labels and discussion keywords. Analyze the issue to check the full thread, linked pull requests, and source files.</p>
      <section class="repo-insight-block">
        <h5>Issue fit score</h5>
        <p>${escapeHtml(issue.issueFitReason || 'No fit rationale available yet.')}</p>
      </section>
      <div class="repo-insight-grid">
        <section class="repo-insight-block">
          <h5>What is happening</h5>
          <p>${escapeHtml(issue.conversationSummary || 'No discussion summary available yet.')}</p>
        </section>
        <section class="repo-insight-block">
          <h5>Likely requirements</h5>
          <p>${escapeHtml(issue.expectationSummary || 'No expectation summary available yet.')}</p>
        </section>
      </div>
      <section class="repo-insight-block">
        <h5>Suggested starting steps</h5>
        <ol class="repo-plan-list">
          ${(issue.quickPlan || []).map(step => `<li>${escapeHtml(step)}</li>`).join('')}
        </ol>
      </section>
      <section class="repo-insight-block">
        <h5>Recent conversation</h5>
        ${(issue.recentConversation || []).length ? `
          <div class="repo-comment-list">
            ${issue.recentConversation.map(comment => `
              <article class="repo-comment">
                <strong>${escapeHtml(comment.author)}</strong>
                <span>${escapeHtml(comment.createdAt ? comment.createdAt.slice(0, 10) : '')}</span>
                <p>${escapeHtml(comment.body)}</p>
              </article>
            `).join('')}
          </div>
        ` : '<p>No comments yet. The issue body is still the main source of context.</p>'}
      </section>
    </article>
  `;

  const recommended = repo.issues.filter(issue => issue.issueRecommendation === 'Recommended first PR');
  const consider = repo.issues.filter(issue => issue.issueRecommendation === 'Worth considering');
  const avoid = repo.issues.filter(issue => issue.issueRecommendation === 'Avoid for first pass');

  const renderSection = (title, subtitle, issues) => issues.length ? `
    <section class="repo-section">
      <div class="repo-section-heading">
        <div>
          <p class="eyebrow">${escapeHtml(subtitle)}</p>
          <h4>${escapeHtml(title)}</h4>
        </div>
      </div>
      <div class="repo-issues-list">
        ${issues.map(renderIssueCard).join('')}
      </div>
    </section>
  ` : '';

  els.repoIssuesList.innerHTML = [
    projectSummary,
    renderSection('Recommended first PRs', 'Best first pass', recommended),
    renderSection('Worth considering next', 'Medium scope', consider),
    renderSection('Avoid for first pass', 'Later work', avoid),
  ].join('');

  if (!recommended.length && !consider.length && !avoid.length) {
    els.repoIssuesList.innerHTML = projectSummary;
  }
}

async function checkRepoIssues(event) {
  if (event) event.preventDefault();
  const repo = els.repoInput.value.trim();
  if (!repo) {
    els.repoStatus.textContent = 'Enter a GitHub repo URL or owner/repo.';
    return;
  }

  els.repoStatus.textContent = 'Checking repository issues';
  const res = await authorizedFetch('/api/repo-issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to inspect repository');
  }

  renderRepoIssues(data.repo);
  els.repoStatus.textContent = `Loaded ${data.repo.issues.length} issues for ${data.repo.repo}`;
}

async function inspectRepository(repo) {
  document.getElementById('repo-check').open = true;
  els.repoInput.value = repo;
  await checkRepoIssues();
}

async function addRepositoryToWatchlist(event) {
  event.preventDefault();
  const repo = els.watchlistInput.value.trim();
  if (!repo) {
    els.watchlistStatus.textContent = 'Enter a GitHub repo URL or owner/repo.';
    return;
  }

  els.watchlistStatus.textContent = 'Adding repository';
  const res = await authorizedFetch('/api/repositories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to add repository');
  }

  els.watchlistInput.value = '';
  els.watchlistStatus.textContent = `${data.repository.repo} added to your watchlist.`;
  await loadRepositories();
  await inspectRepository(data.repository.repo);
}

async function removeRepository(id) {
  els.watchlistStatus.textContent = 'Removing repository';
  const res = await authorizedFetch(`/api/repositories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to remove repository');
  }
  els.watchlistStatus.textContent = 'Repository removed from your watchlist.';
  await loadRepositories();
}

async function saveCurrentOpportunity(event) {
  event.preventDefault();
  const item = state.opportunities.find(entry => entry.id === state.selectedId);
  if (!item) return;

  els.saveStatus.textContent = 'Saving...';

  const payload = {
    status: els.detailStatus.value,
    priority: els.detailPriority.value,
    owner: els.detailOwner.value.trim(),
    dueDate: els.detailDueDate.value,
    nextStep: els.detailNextStep.value.trim(),
    prUrl: els.detailPrUrl.value.trim(),
    activityLog: els.detailActivityLog.value.trim(),
    quickPlan: els.detailQuickPlan.value.trim(),
  };

  const res = await authorizedFetch(`/api/opportunities/${encodeURIComponent(item.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to save changes');
  }

  const idx = state.opportunities.findIndex(entry => entry.id === item.id);
  state.opportunities[idx] = data.opportunity;
  renderStats();
  applyFilters();
  selectOpportunity(item.id);
  els.saveStatus.textContent = 'Saved';
}

async function triggerScan() {
  els.runScanButton.disabled = true;
  els.scanStatus.textContent = 'Running scan';
  try {
    const res = await authorizedFetch('/api/scan', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Scan failed');
    }
    await loadOpportunities();
    await loadHealth();
    els.scanStatus.textContent = `${data.reused ? 'Existing scan loaded' : 'Scan complete'} · ${data.digest?.contest_digest?.length || 0} issues found`;
  } catch (error) {
    els.scanStatus.textContent = error.message;
  } finally {
    els.runScanButton.disabled = false;
  }
}

function wireEvents() {
  const filterChanged = () => { state.currentPage = 1; applyFilters(); };
  els.statusFilter.addEventListener('change', filterChanged);
  els.priorityFilter.addEventListener('change', filterChanged);
  els.searchInput.addEventListener('input', () => {
    state.currentPage = 1;
    applyFilters();
  });
  els.prevPageButton.addEventListener('click', () => {
    if (state.currentPage > 1) {
      state.currentPage -= 1;
      renderList();
    }
  });
  els.nextPageButton.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.currentPage < totalPages) {
      state.currentPage += 1;
      renderList();
    }
  });
  els.list.addEventListener('click', event => {
    if (event.target.closest('[data-clear-filters]')) {
      els.statusFilter.value = '';
      els.priorityFilter.value = '';
      els.searchInput.value = '';
      filterChanged();
    }
    if (event.target.closest('[data-run-scan]')) els.runScanButton.click();
  });
  els.detailForm.addEventListener('submit', event => {
    saveCurrentOpportunity(event).catch(error => {
      els.saveStatus.textContent = error.message;
    });
  });
  els.repoForm.addEventListener('submit', event => {
    checkRepoIssues(event).catch(error => {
      els.repoStatus.textContent = error.message;
    });
  });
  els.watchlistForm.addEventListener('submit', event => {
    addRepositoryToWatchlist(event).catch(error => {
      els.watchlistStatus.textContent = error.message;
    });
  });
  els.detailAnalyzeButton.addEventListener('click', () => {
    analyzeSelectedOpportunity().catch(error => {
      els.saveStatus.textContent = error.message;
      els.detailAnalyzeButton.disabled = false;
    });
  });
  els.repoIssuesList.addEventListener('click', event => {
    const button = event.target.closest('.repo-analyze-button');
    if (button) analyzeRepoIssue(button);
  });
  els.runScanButton.addEventListener('click', () => {
    triggerScan().catch(error => {
      els.scanStatus.textContent = error.message;
      els.runScanButton.disabled = false;
    });
  });
}

wireEvents();
loadRepositories().catch(error => {
  els.watchlistStatus.textContent = error.message;
});
loadOpportunities().catch(error => {
  els.scanStatus.textContent = error.message;
  els.list.setAttribute('aria-busy', 'false');
  els.paginationSummary.textContent = 'Couldn’t load issues';
  els.list.innerHTML = `<div class="detail-empty">${escapeHtml(error.message)}</div>`;
});
loadHealth().catch(error => {
  els.lastRunSummary.textContent = error.message;
});
loadBitcoinProjects().catch(error => {
  els.ecosystemStatus.textContent = error.message;
});
