const state = {
  opportunities: [],
  filtered: [],
  repositories: [],
  selectedId: null,
  storage: 'loading',
  currentPage: 1,
  pageSize: 20,
  apiKey: window.sessionStorage.getItem('danagent.apiKey') || '',
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
  saveStatus: document.getElementById('save-status'),
  paginationSummary: document.getElementById('pagination-summary'),
  prevPageButton: document.getElementById('prev-page-button'),
  nextPageButton: document.getElementById('next-page-button'),
  seeMoreButton: document.getElementById('see-more-button'),
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
};

function renderRepositories() {
  if (!state.repositories.length) {
    els.watchlistList.innerHTML = '<div class="detail-empty">No repositories added yet.</div>';
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

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function getVisibleOpportunities() {
  if (!state.repositories.length) {
    return [];
  }

  const watchedRepos = new Set(state.repositories.map(item => normalizeText(item.repo)));
  return state.opportunities.filter(item => watchedRepos.has(normalizeText(item.repo)));
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
  els.storageBadge.textContent = `Storage: ${state.storage}`;
}

function renderHealth(payload) {
  const currentRun = payload.currentRun;
  const recentRuns = payload.recentRuns || [];
  els.currentRunBadge.textContent = currentRun ? `Running • ${currentRun.trigger}` : 'Idle';

  const lastRun = recentRuns[0];
  if (!lastRun) {
    els.lastRunSummary.textContent = 'No scans recorded yet.';
    els.recentRunsList.innerHTML = '<div class="detail-empty">Run a scan to start building history.</div>';
    return;
  }

  const duration = typeof lastRun.durationMs === 'number'
    ? `${Math.round(lastRun.durationMs / 100) / 10}s`
    : 'unknown duration';
  els.lastRunSummary.textContent = `${lastRun.status} via ${lastRun.trigger} on ${new Date(lastRun.startedAt).toLocaleString()} • ${lastRun.opportunities || 0} opportunities • ${duration}`;

  els.recentRunsList.innerHTML = recentRuns.map(run => `
    <article class="watchlist-item">
      <div>
        <strong>${escapeHtml(String(run.status || 'unknown').toUpperCase())} • ${escapeHtml(run.trigger || 'unknown')}</strong>
        <p>${escapeHtml(new Date(run.startedAt).toLocaleString())} • repos ${run.repositories || 0} • issues ${run.totalIssues || 0} • opportunities ${run.opportunities || 0}</p>
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

function renderList() {
  if (!state.filtered.length) {
    els.paginationSummary.textContent = 'Showing 0 of 0';
    els.prevPageButton.disabled = true;
    els.nextPageButton.disabled = true;
    els.seeMoreButton.disabled = true;
    els.list.innerHTML = state.repositories.length
      ? '<div class="detail-empty">No opportunities match the current filters.</div>'
      : '<div class="detail-empty">Add a repository to the watchlist and run a scan to populate the workbench.</div>';
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
  els.seeMoreButton.disabled = state.currentPage >= totalPages;

  let lastDate = null;
  els.list.innerHTML = visibleItems.map(item => {
    const dateHeader = item.date !== lastDate
      ? `<div class="history-divider">${escapeHtml(formatHistoryDate(item.date))}</div>`
      : '';
    lastDate = item.date;
    return `
    ${dateHeader}
    <article class="list-item ${item.id === state.selectedId ? 'active' : ''}" data-id="${item.id}">
      <div class="list-item-header">
        <h3>${escapeHtml(item.opportunity)}</h3>
      </div>
      <p>${escapeHtml(item.repo)}</p>
      <div class="list-meta">
        ${createTag(item.date || 'No date')}
        ${createTag(item.status, `status-${statusClass(item.status)}`)}
        ${createTag(item.priority, `priority-${statusClass(item.priority)}`)}
        ${createTag(item.effort || 'medium')}
      </div>
      <div class="list-footer">
        ${item.owner ? createTag(`Owner: ${escapeHtml(item.owner)}`) : ''}
        ${item.dueDate ? createTag(`Due: ${escapeHtml(item.dueDate)}`) : ''}
      </div>
    </article>
  `;
  }).join('');

  els.list.querySelectorAll('.list-item').forEach(node => {
    node.addEventListener('click', () => selectOpportunity(node.dataset.id));
  });
}

function showEmptyState() {
  els.detailEmpty.classList.remove('hidden');
  els.detailForm.classList.add('hidden');
}

function selectOpportunity(id) {
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
  els.detailTitle.textContent = item.opportunity || 'Untitled opportunity';
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
  els.detailQualifies.textContent = item.whyItQualifies || 'No qualification note yet.';
  els.detailAction.textContent = item.suggestedAction || 'No suggested action yet.';
  els.detailMatters.textContent = item.whyItMatters || 'No impact note yet.';
  els.detailTip.textContent = item.clarityTip || 'No validation tip yet.';
  els.detailCode.textContent = item.codeSkeleton || '// No code skeleton available yet.';
  const summary = [
    item.date ? `Scan date ${item.date}` : '',
    item.lastUpdated ? `Last updated ${new Date(item.lastUpdated).toLocaleString()}` : '',
  ].filter(Boolean).join(' • ');
  els.saveStatus.textContent = summary;
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
  els.scanStatus.textContent = 'Loading opportunities';
  const res = await authorizedFetch('/api/opportunities');
  if (!res.ok) {
    throw new Error(await readErrorResponse(res));
  }
  const payload = await res.json();
  state.opportunities = payload.opportunities || [];
  state.storage = payload.storage || 'unknown';
  state.currentPage = 1;
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
        <a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer" class="button button-secondary">Open</a>
      </div>
      <p>${escapeHtml((issue.body || '').slice(0, 180) || 'No issue description provided.')}</p>
      <div class="list-meta">
        ${createTag(`#${issue.number}`)}
        ${createTag(issue.updatedAt ? issue.updatedAt.slice(0, 10) : 'Open')}
        ${createTag(`${issue.issueFitScore || 0}/100`, `fit-${statusClass(issue.issueFitLabel || 'low fit')}`)}
        ${createTag(issue.issueFitLabel || 'Low fit', `fit-${statusClass(issue.issueFitLabel || 'low fit')}`)}
        ${createTag(issue.issueComplexity || 'Medium', `complexity-${statusClass(issue.issueComplexity || 'medium')}`)}
        ${(issue.labels || []).slice(0, 4).map(label => createTag(escapeHtml(label))).join('')}
      </div>
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
          <h5>What the maintainer expects</h5>
          <p>${escapeHtml(issue.expectationSummary || 'No expectation summary available yet.')}</p>
        </section>
      </div>
      <section class="repo-insight-block">
        <h5>Quick plan</h5>
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
  els.watchlistStatus.textContent = `${data.repository.repo} added to the scheduled watchlist`;
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
  els.watchlistStatus.textContent = 'Repository removed from the scheduled watchlist';
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
    els.scanStatus.textContent = `${data.reused ? 'Scan reused' : 'Scan completed'}: ${data.digest?.contest_digest?.length || 0} opportunities`;
    await loadOpportunities();
    await loadHealth();
  } catch (error) {
    els.scanStatus.textContent = error.message;
  } finally {
    els.runScanButton.disabled = false;
  }
}

function wireEvents() {
  els.statusFilter.addEventListener('change', applyFilters);
  els.priorityFilter.addEventListener('change', applyFilters);
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
  els.seeMoreButton.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.currentPage < totalPages) {
      state.currentPage += 1;
      renderList();
    }
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
  els.list.innerHTML = `<div class="detail-empty">${escapeHtml(error.message)}</div>`;
});
loadHealth().catch(error => {
  els.lastRunSummary.textContent = error.message;
});
