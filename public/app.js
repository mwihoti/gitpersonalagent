const state = {
  opportunities: [],
  filtered: [],
  selectedId: null,
  storage: 'loading',
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
};

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function renderStats() {
  const total = state.opportunities.length;
  const inProgress = state.opportunities.filter(item => item.status === 'In Progress').length;
  const done = state.opportunities.filter(item => item.status === 'Done').length;
  const high = state.opportunities.filter(item => item.priority === 'High').length;

  els.metricTotal.textContent = String(total);
  els.metricProgress.textContent = String(inProgress);
  els.metricDone.textContent = String(done);
  els.metricHigh.textContent = String(high);
  els.storageBadge.textContent = `Storage: ${state.storage}`;
}

function applyFilters() {
  const status = els.statusFilter.value;
  const priority = els.priorityFilter.value;
  const search = normalizeText(els.searchInput.value);

  state.filtered = state.opportunities.filter(item => {
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
    els.list.innerHTML = '<div class="detail-empty">No opportunities match the current filters.</div>';
    showEmptyState();
    return;
  }

  let lastDate = null;
  els.list.innerHTML = state.filtered.map(item => {
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

  const item = state.opportunities.find(entry => entry.id === id);
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

async function loadOpportunities() {
  els.scanStatus.textContent = 'Loading opportunities';
  const res = await fetch('/api/opportunities');
  if (!res.ok) {
    throw new Error('Failed to load opportunities');
  }
  const payload = await res.json();
  state.opportunities = payload.opportunities || [];
  state.storage = payload.storage || 'unknown';
  renderStats();
  applyFilters();

  if (!state.selectedId && state.filtered[0]) {
    selectOpportunity(state.filtered[0].id);
  } else if (state.selectedId) {
    selectOpportunity(state.selectedId);
  }
  els.scanStatus.textContent = 'Ready';
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

  const res = await fetch(`/api/opportunities/${encodeURIComponent(item.id)}`, {
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
    const res = await fetch('/api/scan', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Scan failed');
    }
    els.scanStatus.textContent = `Scan completed: ${data.digest?.contest_digest?.length || 0} opportunities`;
    await loadOpportunities();
  } catch (error) {
    els.scanStatus.textContent = error.message;
  } finally {
    els.runScanButton.disabled = false;
  }
}

function wireEvents() {
  els.statusFilter.addEventListener('change', applyFilters);
  els.priorityFilter.addEventListener('change', applyFilters);
  els.searchInput.addEventListener('input', applyFilters);
  els.detailForm.addEventListener('submit', event => {
    saveCurrentOpportunity(event).catch(error => {
      els.saveStatus.textContent = error.message;
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
loadOpportunities().catch(error => {
  els.scanStatus.textContent = error.message;
  els.list.innerHTML = `<div class="detail-empty">${escapeHtml(error.message)}</div>`;
});
