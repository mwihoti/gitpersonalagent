'use strict';
const Q = window.QueueModel;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const createTag = (label, className = '') => `<span class="tag ${className}">${label}</span>`;
const state = {
  items: [], repos: [], health: {}, learning: null, catalog: null, area: '', inspection: null,
  repoChoice: '', repoLimit: 12, inspectView: { query: '', hideClaimed: false, limit: 25 }, inspectBusy: false,
  filters: { status: 'Open', repo: '', priority: '', search: '', sort: 'fit' }, limit: 20,
  view: 'queue', selected: null, draft: null, dirty: false, saving: false, running: false,
  loaded: false, queueScroll: 0, route: '', pendingRoute: null, undo: null,
  key: sessionStorage.getItem('danagent.apiKey') || '', accessPromise: null, accessResolve: null,
};
const statuses = ['Open', 'New', 'In Progress', 'Done', 'Dismissed', 'Closed'];

function shortDate(value, includeTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date().toDateString() === date.toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString() === date.toDateString();
  const day = today ? 'Today' : yesterday ? 'Yesterday' : date.toLocaleDateString(undefined, { day:'numeric', month:'short' });
  return includeTime ? `${day}, ${date.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })}` : day;
}
function age(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '—';
  const hours = Math.max(0, Math.floor((Date.now() - time) / 3600000));
  return hours < 24 ? `${hours} h` : hours < 168 ? `${Math.floor(hours / 24)} d` : `${Math.floor(hours / 168)} w`;
}
function scoreHtml(item, bar = true) {
  const n = Q.score(item);
  return `<span class="score-cell"><span class="score-value${n >= 80 ? ' high' : ''}">${n || '—'}</span>${bar ? `<span class="score-track" aria-hidden="true"><span style="width:${n}%"></span></span>` : ''}</span>`;
}
function ref(item) { const match = String(item.issueUrl || '').match(/\/(?:issues|pull)\/(\d+)/); return `${item.repo || 'Repository'}${match ? ` #${match[1]}` : ''}`; }
function labelHtml(label) { return createTag(escapeHtml(label), /bug/i.test(label) ? 'tag-bug' : /good first|help wanted/i.test(label) ? 'tag-good' : ''); }
function showNotice(message = '', error = false) { $('page-notice').textContent = message; $('page-notice').classList.toggle('hidden', !message); $('page-notice').classList.toggle('is-error', error); }
let toastTimer;
function toast(message, undo = null) {
  clearTimeout(toastTimer);
  state.undo = undo;
  $('toast-text').textContent = message;
  $('undo-button').classList.toggle('hidden', !undo);
  $('toast').classList.remove('hidden');
  if (!undo) toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000);
}
function info(title, html) { $('info-title').textContent = title; $('info-content').innerHTML = html; $('info-dialog').showModal(); }

function requestKey() {
  if (state.accessPromise) return state.accessPromise;
  $('access-error').textContent = '';
  $('access-key').value = state.key;
  $('access-dialog').returnValue = '';
  $('access-dialog').showModal();
  state.accessPromise = new Promise(resolve => { state.accessResolve = resolve; });
  return state.accessPromise;
}
async function api(url, options = {}, retry = true) {
  const headers = new Headers(options.headers || {});
  if (state.key) headers.set('X-API-Key', state.key);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && retry) {
    if (await requestKey()) return api(url, options, false);
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Try again.'); }
  if (response.status === 401) throw new Error('The dashboard key wasn’t accepted. Use Workspace access to try again.');
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
async function loadItems() {
  const data = await api('/api/opportunities');
  state.items = data.opportunities || [];
  state.learning = data.learning;
  state.loaded = true;
  $('storage-status').textContent = data.storage === 'airtable' ? 'Saved to Airtable' : data.storage === 'local' ? 'Saved locally' : 'Storage connected';
  renderQueue(); renderRepos(); renderRanking();
}
async function loadRepos() { state.repos = (await api('/api/repositories')).repositories || []; renderRepos(); updateCounts(); }
async function loadHealth() {
  state.health = await api('/api/health');
  const bots = state.health.config?.telegramBots || 0;
  $('telegram-status').innerHTML = `<i aria-hidden="true"></i>${bots ? 'Telegram configured' : 'Telegram not configured'}`;
  $('telegram-status').classList.toggle('configured', !!bots);
  const github = state.health.config?.githubAuth?.status;
  if (github === 'rejected' || github === 'anonymous') showNotice(github === 'rejected'
    ? 'GitHub rejected the server’s access token, so issue lookups are limited to 60 an hour. Replace GITHUB_TOKEN in the hosting settings.'
    : 'No GitHub token is set, so issue lookups are limited to 60 an hour. Add GITHUB_TOKEN in the hosting settings.', true);
  renderScans(); renderRepos(); renderHeader();
}
function updateCounts() {
  $('queue-count').textContent = state.loaded ? state.items.filter(Q.isOpen).length : '—';
  $('repos-count').textContent = repositoryChoices().length;
  $('repos-count').title = 'Repositories available from your queue, watchlist, and project directory';
}
function repositoryChoices() { return Q.repositoryChoices(state.items, state.repos, state.catalog?.projects || []); }
function renderHeader() {
  const run = state.health.recentRuns?.[0];
  const scans = `<span class="muted">${run ? `Last scan ${escapeHtml(shortDate(run.startedAt, true).toLowerCase())}` : 'No scans yet'}</span><button type="button" class="button" data-scan ${state.running ? 'disabled' : ''}>${state.running ? 'Scanning…' : 'Scan now'}</button>`;
  $('page-title').classList.remove('hidden');
  $('page-subtitle').classList.remove('hidden');
  $('page-title').textContent = state.view === 'repos' ? 'Repos' : state.view === 'scans' ? 'Scans' : 'Queue';
  document.title = `${state.view === 'issue' ? state.draft?.opportunity || 'Issue' : $('page-title').textContent} · dan/queue`;
  if (state.view === 'issue' && state.draft) {
    $('page-title').classList.add('hidden');
    $('page-subtitle').innerHTML = `<span class="breadcrumb"><a id="back-to-queue" class="back-link" href="#queue"><span aria-hidden="true">←</span> Back to queue</a><span>${escapeHtml(ref(state.draft))}</span></span>`;
    const dismissed = Q.displayStatus(state.draft) === 'Dismissed';
    $('page-actions').innerHTML = `<span class="muted" id="save-indicator" role="status">${state.dirty ? 'Unsaved changes' : 'Saved'}</span><button type="button" class="button button-secondary" data-${dismissed ? 'restore' : 'dismiss'}>${dismissed ? 'Restore issue' : 'Dismiss'}</button>${safeUrl(state.draft.issueUrl) ? `<a class="button button-secondary" href="${escapeHtml(safeUrl(state.draft.issueUrl))}" target="_blank" rel="noreferrer">Open on GitHub</a>` : ''}<button class="button" type="submit" form="detail-form" id="save-button" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button>`;
  } else if (state.view === 'repos') {
    $('page-subtitle').textContent = `${repositoryChoices().length} available · ${state.repos.length} watched`;
    $('page-actions').innerHTML = '<button class="button button-secondary" type="button" data-schedule>View schedule</button>';
  } else if (state.view === 'scans') {
    $('page-subtitle').textContent = state.health.currentRun ? 'A scan is running' : scheduleText();
    $('page-actions').innerHTML = scans;
  } else {
    const latest = state.items.map(item => item.date).filter(Boolean).sort().at(-1);
    const n = state.items.filter(item => Q.displayStatus(item) === 'New' && item.date === latest).length;
    $('page-subtitle').textContent = state.loaded ? n ? `${n} new in the latest scan` : 'Your open issues and work in progress' : 'Loading issues…';
    $('page-actions').innerHTML = scans;
  }
}
function scheduleText() {
  const schedule = state.health.schedule;
  if (!schedule) return 'Schedule managed by your deployment';
  const match = schedule.cron?.match(/^(\d+) (\d+) \* \* \*$/);
  return match ? `Scheduled daily at ${String(match[2]).padStart(2,'0')}:${String(match[1]).padStart(2,'0')} · ${schedule.timezone}` : `Scheduled scans · ${schedule.timezone}`;
}
function renderQueue() {
  updateCounts();
  $('status-tabs').innerHTML = statuses.map(status => {
    const n = state.items.filter(item => status === 'Open' ? Q.isOpen(item) : Q.displayStatus(item) === status).length;
    if (status === 'Closed' && !n && state.filters.status !== status) return '';
    return `<button type="button" class="status-tab${state.filters.status === status ? ' active' : ''}" data-status="${status}" aria-pressed="${state.filters.status === status}">${status === 'In Progress' ? 'In progress' : status}<span>${state.loaded ? n : '—'}</span></button>`;
  }).join('');
  const repos = [...new Set([...state.items.map(item => item.repo), ...state.repos.map(repo => repo.repo)])].filter(Boolean).sort();
  $('repo-filter').innerHTML = '<option value="">Any repo</option>' + repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('');
  $('repo-filter').value = state.filters.repo;
  const filtered = Q.filterIssues(state.items, state.filters);
  const visible = filtered.slice(0, state.limit);
  $('queue-body').setAttribute('aria-busy', !state.loaded);
  if (!state.loaded) {
    $('queue-body').innerHTML = '<div class="empty-state">Loading your issues…</div>';
  } else if (!filtered.length) {
    const empty = !state.items.length;
    $('queue-body').innerHTML = `<div class="empty-state"><strong>${empty ? 'Your queue is empty' : 'No matching issues'}</strong><p>${empty ? 'Watch a repository and run a scan to find open issues. An empty watchlist uses the Bitcoin project directory.' : 'Try another repository, status, or search.'}</p><button class="button button-secondary" type="button" ${empty ? 'data-scan' : 'data-clear-filters'}>${empty ? 'Run your first scan' : 'Clear filters'}</button></div>`;
  } else {
    let group = '';
    $('queue-body').innerHTML = `<table class="queue-table"><caption class="sr-only">Contribution issues, sorted by ${escapeHtml(state.filters.sort)}</caption><colgroup><col class="fit-col"><col><col class="labels-col"><col class="effort-col"><col class="age-col"><col class="status-col"><col class="owner-col"></colgroup><thead><tr><th scope="col">Fit</th><th scope="col">Issue</th><th scope="col">Labels</th><th scope="col">Effort</th><th scope="col" title="Latest recorded GitHub activity">Updated</th><th scope="col">Status</th><th scope="col">Owner</th></tr></thead><tbody>${visible.map(item => {
      const status = Q.displayStatus(item);
      const nextGroup = status === 'In Progress' ? 'In progress' : state.filters.sort === 'recent' ? shortDate(item.issueUpdatedAt || item.date) : 'Best matches';
      const divider = nextGroup !== group ? `<tr class="group-row"><th colspan="7" scope="rowgroup">${escapeHtml(nextGroup)}</th></tr>` : '';
      group = nextGroup;
      const availability = Q.availability(item);
      const taken = ['claimed', 'has_open_pr', 'likely_done'].includes(availability);
      return `${divider}<tr class="issue-row${state.selected === item.id ? ' selected' : ''}" data-issue="${escapeHtml(item.id)}"><td>${scoreHtml(item)}</td><td><span class="issue-reference">${escapeHtml(ref(item))}</span><a class="issue-link" href="#issue/${encodeURIComponent(item.id)}">${escapeHtml(item.opportunity || 'Untitled issue')}</a></td><td><div class="labels">${Q.labels(item).slice(0, 3).map(labelHtml).join('')}${taken ? createTag(availability === 'has_open_pr' ? 'Open PR' : 'Taken', 'tag-warn') : ''}</div></td><td>${escapeHtml(item.effort || 'Unclear')}</td><td class="muted" title="${escapeHtml(item.issueUpdatedAt || '')}">${age(item.issueUpdatedAt)}</td><td class="status-${status === 'New' ? 'new' : status === 'In Progress' ? 'progress' : status.toLowerCase()}">${status === 'In Progress' ? 'In progress' : status}</td><td>${item.owner ? `<span class="avatar" title="${escapeHtml(item.owner)}" aria-label="Owner: ${escapeHtml(item.owner)}">${escapeHtml(Q.initials(item.owner))}</span>` : '<span class="muted">–</span>'}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  $('queue-pagination').innerHTML = state.loaded ? `<span>Showing ${visible.length} of ${filtered.length}.${state.items.length && state.items.length !== filtered.length ? ` ${state.items.length} tracked in total.` : ''}</span>${visible.length < filtered.length ? '<button class="text-button" type="button" data-more>Show the rest</button>' : ''}` : '';
  if (state.view === 'queue') renderHeader();
}

function setDirty() {
  state.dirty = true;
  if ($('save-indicator')) $('save-indicator').textContent = 'Unsaved changes';
}
function readDraft() {
  if (!state.draft) return;
  Object.assign(state.draft, {
    status: $('detail-status').value, priority: $('detail-priority').value, owner: $('detail-owner').value.trim(),
    dueDate: $('detail-due').value, prUrl: $('detail-pr').value.trim(), nextStep: $('detail-next').value.trim(),
  });
}
function renderPlan() {
  const steps = state.draft.steps;
  $('plan-progress').textContent = steps.length ? `${steps.filter(step => step.done).length} of ${steps.length} complete` : '';
  $('plan-list').innerHTML = steps.length ? steps.map((step, i) => `<div class="plan-step"><input id="plan-step-${i}" type="checkbox" data-step="${i}" ${step.done ? 'checked' : ''}><label for="plan-step-${i}">${escapeHtml(step.text)}</label><button type="button" class="step-remove" data-remove-step="${i}" aria-label="Remove step ${i + 1}">×</button></div>`).join('') : '<p class="muted">Add your own steps, or analyze the issue for a suggested plan.</p>';
}
function renderActivity() {
  const entries = Q.activityEntries(state.draft.activityLog);
  $('activity-list').innerHTML = entries.length ? entries.map(entry => `<article class="activity-entry"><p>${escapeHtml(entry.text)}</p><span>${escapeHtml([entry.who, entry.at ? shortDate(entry.at, true) : ''].filter(Boolean).join(', '))}</span></article>`).join('') : '<p class="muted">Your work notes and status changes will appear here.</p>';
}
function renderIssue(item) {
  state.selected = item.id;
  state.draft = { ...item, steps: Q.parsePlan(item.quickPlan || item.analysis?.analysis?.plan || item.nextStep || item.suggestedAction) };
  state.dirty = false;
  $('detail-title').textContent = item.opportunity || 'Untitled issue';
  const a = item.analysis?.analysis || {};
  const issue = item.analysis?.context?.issue;
  $('detail-summary').textContent = issue ? `Opened ${shortDate(issue.createdAt).toLowerCase()}${issue.author ? ` by ${issue.author}` : ''}. ${issue.commentsCount || 0} comments.` : `Tracked ${shortDate(item.date).toLowerCase()}.${item.issueUpdatedAt ? ` Last GitHub activity ${shortDate(item.issueUpdatedAt, true).toLowerCase()}.` : ''}`;
  $('detail-score').textContent = Q.score(item) || '—';
  $('detail-score').parentElement.classList.toggle('is-unscored', !Q.score(item));
  const reasons = [...new Set([item.whyItQualifies, a.maintainerWants || item.maintainerWants, a.stateReason].filter(Boolean))];
  $('detail-reasons').innerHTML = reasons.length ? reasons.map(reason => `<p>${escapeHtml(reason)}</p>`).join('') : '<p class="muted">No ranking explanation is saved. Analyze the issue to inspect the discussion.</p>';
  $('detail-status').value = Q.editableStatus(item);
  $('detail-priority').value = item.priority || 'Medium';
  $('detail-owner').value = item.owner || '';
  $('detail-due').value = item.dueDate || '';
  $('detail-pr').value = item.prUrl || '';
  $('detail-next').value = item.nextStep || '';
  $('activity-note').value = '';
  $('new-step').value = '';
  renderPlan(); renderActivity(); renderCode(a.codeSkeleton || item.codeSkeleton);
  $('detail-analysis').innerHTML = item.analysis?.analysis ? analysisHtml(item.analysis) : '';
  $('detail-analysis').classList.toggle('hidden', !item.analysis?.analysis);
  $('analysis-status').textContent = item.analysis?.analysis ? 'Analysis saved with this issue.' : 'Read the discussion and source before starting.';
  $('analyze-button').disabled = !safeUrl(item.issueUrl);
  $('analyze-button').textContent = item.analysis ? 'Refresh analysis' : 'Analyze issue';
  $('recommendation-notes').innerHTML = [['Suggested change', item.suggestedAction], ['Expected impact', item.whyItMatters], ['How to test it', item.clarityTip], ['Files to change', item.filesToChange], ['Open questions', item.openQuestions]].filter(([, text]) => text).map(([title, text]) => `<section><h4>${title}</h4><p>${escapeHtml(text)}</p></section>`).join('') + (item.source ? `<section><h4>Source</h4><p>${safeUrl(item.sourceUrl) ? `<a href="${escapeHtml(safeUrl(item.sourceUrl))}" target="_blank" rel="noreferrer">${escapeHtml(item.source)}</a>` : escapeHtml(item.source)}</p></section>` : '') || '<p class="muted">No additional notes saved.</p>';
  $('detail-live').innerHTML = '<span class="muted">Checking GitHub…</span>';
  renderHeader();
  if (safeUrl(item.issueUrl)) loadLive(item); else $('detail-live').innerHTML = '';
}
function renderCode(code) { $('detail-code').textContent = code || ''; $('code-section').classList.toggle('hidden', !code); }
async function loadLive(item) {
  try {
    const data = await api(`/api/issue-status?${new URLSearchParams({ url: item.issueUrl, since: item.issueUpdatedAt || '' })}`);
    if (state.selected !== item.id || state.view !== 'issue') return;
    const prs = (data.linkedPRs || []).filter(pr => pr.state === 'open' && pr.sameRepo !== false);
    $('detail-live').innerHTML = [createTag(data.state === 'closed' ? 'Closed on GitHub' : 'Open on GitHub', data.state === 'closed' ? 'tag-closed' : 'tag-good'), data.assignees?.length ? createTag(`Assigned to ${escapeHtml(data.assignees.join(', '))}`) : createTag('Unassigned'), data.claim?.claimed ? createTag('Claimed in the discussion', 'tag-warn') : '', ...prs.map(pr => `<a class="tag tag-warn" href="${escapeHtml(safeUrl(pr.url))}" target="_blank" rel="noreferrer">Open PR #${escapeHtml(pr.number)}</a>`)].join('');
  } catch (error) { if (state.selected === item.id) $('detail-live').textContent = `GitHub check unavailable: ${error.message}`; }
}
function appendActivity(message) { state.draft.activityLog = [state.draft.activityLog, `[dashboard ${new Date().toISOString()}] ${message}`].filter(Boolean).join('\n'); }
function addNote() { const note = $('activity-note').value.trim(); if (!note) return; appendActivity(note.replace(/\n/g, ' ')); $('activity-note').value = ''; setDirty(); renderActivity(); }
function addStep() { const text = $('new-step').value.trim(); if (!text) return; state.draft.steps.push({text,done:false}); $('new-step').value = ''; setDirty(); renderPlan(); $('new-step').focus(); }
async function saveIssue({ dismiss = false } = {}) {
  if (!state.draft || state.saving) return false;
  if (!$('detail-form').reportValidity()) return false;
  state.saving = true;
  readDraft();
  if ($('new-step').value.trim()) addStep();
  if ($('activity-note').value.trim()) addNote();
  const original = state.items.find(item => item.id === state.selected);
  const previousLog = state.draft.activityLog;
  if (original && Q.editableStatus(original) !== state.draft.status) appendActivity(`Status changed to ${state.draft.status}`);
  if (original && original.priority !== state.draft.priority) appendActivity(`Priority changed to ${state.draft.priority}`);
  if (!dismiss && original && Q.editableStatus(original) !== 'Done' && state.draft.status === 'Done') appendActivity('Marked done [outcome completed]');
  const payload = { status: state.draft.status, priority: state.draft.priority, owner: state.draft.owner, dueDate: state.draft.dueDate, prUrl: state.draft.prUrl, nextStep: state.draft.nextStep, quickPlan: Q.serializePlan(state.draft.steps), activityLog: state.draft.activityLog };
  renderHeader();
  try {
    const data = await api(`/api/opportunities/${encodeURIComponent(state.selected)}`, {method:'PUT',body:JSON.stringify(payload)});
    const index = state.items.findIndex(item => item.id === state.selected);
    state.items[index] = data.opportunity;
    state.draft = {...data.opportunity, steps:Q.parsePlan(data.opportunity.quickPlan)};
    state.dirty = false;
    renderActivity(); renderQueue(); renderRepos();
    toast('Changes saved.');
    return true;
  } catch (error) { state.draft.activityLog = previousLog; showNotice(`Couldn’t save: ${error.message}`, true); return false; }
  finally { state.saving = false; renderHeader(); }
}
async function analyzeIssue() {
  const item = state.draft;
  if (!item) return;
  readDraft();
  $('analyze-button').disabled = true;
  $('analysis-status').textContent = 'Reading the issue, discussion, pull requests, and source files…';
  try {
    const result = await api('/api/issue-analysis', {method:'POST',body:JSON.stringify({url:item.issueUrl, recordId:item.id, force:!!item.analysis})});
    if (state.selected !== item.id || state.view !== 'issue') return;
    state.items.find(entry => entry.id === item.id).analysis = result;
    state.draft.analysis = result;
    $('detail-analysis').innerHTML = analysisHtml(result);
    $('detail-analysis').classList.remove('hidden');
    const a = result.analysis || {};
    if (!state.draft.steps.length && a.plan?.length) { state.draft.steps = Q.parsePlan(a.plan); renderPlan(); setDirty(); }
    if (!$('detail-next').value && a.plan?.[0]) { $('detail-next').value = a.plan[0]; setDirty(); }
    if (a.codeSkeleton) renderCode(a.codeSkeleton);
    $('analysis-status').textContent = 'Analysis ready. Review the suggested steps before saving your plan.';
    renderQueue();
  } catch (error) { if (state.selected === item.id) $('analysis-status').textContent = error.message; }
  finally { if (state.selected === item.id) { $('analyze-button').disabled = false; $('analyze-button').textContent = 'Refresh analysis'; } }
}

async function dismissIssue(event) {
  event.preventDefault();
  const id = state.selected;
  const original = state.items.find(item => item.id === id);
  if (!original) return;
  const before = {status:original.status, activityLog:original.activityLog || ''};
  readDraft();
  state.draft.status = 'Done';
  $('detail-status').value = 'Done';
  appendActivity(`Dismissed (${ $('dismiss-reason').value }) [dismiss reason: ${ $('dismiss-reason').value }] [outcome dismissed]`);
  setDirty();
  const saved = await saveIssue({dismiss:true});
  if (!saved) return;
  $('dismiss-dialog').close();
  state.filters.status = 'Open';
  navigate('#queue');
  toast('Issue dismissed.', async () => {
    const data = await api(`/api/opportunities/${encodeURIComponent(id)}`, {method:'PUT',body:JSON.stringify(before)});
    state.items[state.items.findIndex(item => item.id === id)] = data.opportunity;
    renderQueue(); renderRepos();
    toast('Dismissal undone.');
    loadItems().catch(error => showNotice(error.message,true));
  });
  loadItems().catch(error => showNotice(error.message,true));
}
async function restoreIssue() {
  state.draft.status = 'New';
  $('detail-status').value = 'New';
  appendActivity('Restored to the queue');
  setDirty();
  await saveIssue();
  loadItems().catch(error => showNotice(error.message,true));
}
function renderRepos() {
  updateCounts();
  const runs = state.health.recentRuns || [];
  const choices = repositoryChoices();
  const groups = [
    ['Watching', choices.filter(repo => repo.watching)],
    ['In your queue', choices.filter(repo => !repo.watching && repo.totalIssues)],
    ['Project directory', choices.filter(repo => !repo.watching && !repo.totalIssues)],
  ];
  $('repo-picker').innerHTML = '<option value="">Select a repository…</option>' + groups.filter(([, repos]) => repos.length).map(([label, repos]) => `<optgroup label="${label}">${repos.map(repo => `<option value="${escapeHtml(repo.repo)}">${escapeHtml(repo.repo)}${repo.openMatches ? ` · ${repo.openMatches} in your queue` : ''}</option>`).join('')}</optgroup>`).join('');
  $('repo-picker').value = state.repoChoice;
  const tracked = choices.filter(repo => repo.watching || repo.totalIssues);
  const visible = tracked.slice(0, state.repoLimit);
  if (!tracked.length) {
    $('watched-repos').innerHTML = '<div class="empty-state"><strong>Choose your first repository</strong><p>Select a project above to check its issues, or enter any GitHub repository.</p></div>';
  } else {
    $('watched-repos').innerHTML = `<table class="repo-table"><caption class="sr-only">Repositories in your queue and watchlist</caption><colgroup><col class="repo-name-col"><col><col><col><col><col class="repo-actions-col"></colgroup><thead><tr><th scope="col">Repository</th><th scope="col">In your queue</th><th scope="col">Best fit now</th><th scope="col">Last scanned</th><th scope="col">Included in scans</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${visible.map(repo => {
      const run = runs.find(run => run.status === 'completed' && run.repositoryNames?.includes(repo.repo));
      return `<tr><td class="repo-name"><button type="button" class="repo-choose" data-choose-repo="${escapeHtml(repo.repo)}">${escapeHtml(repo.repo)}</button></td><td><button type="button" class="text-button" data-repo-matches="${escapeHtml(repo.repo)}" aria-label="Show the ${repo.openMatches} issues from ${escapeHtml(repo.repo)} in your queue">${repo.openMatches}</button></td><td>${scoreHtml({score:repo.bestScore},false)}</td><td class="muted">${repo.watching && repo.enabled === false ? 'Paused' : run ? escapeHtml(shortDate(run.startedAt,true)) : 'Not recorded'}</td><td>${repo.watching ? `<button type="button" class="switch" role="switch" aria-checked="${repo.enabled !== false}" aria-label="Include ${escapeHtml(repo.repo)} in scans" data-toggle-repo="${escapeHtml(repo.id)}"></button>` : '<span class="muted">Not watching</span>'}</td><td>${repo.watching ? `<button class="text-button" type="button" data-remove-repo="${escapeHtml(repo.id)}">Remove</button>` : `<button class="text-button" type="button" data-watch="${escapeHtml(repo.repo)}">Watch</button>`}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  $('repos-pagination').innerHTML = tracked.length ? `<span>Showing ${visible.length} of ${tracked.length} repositories in your queue and watchlist.</span>${visible.length < tracked.length ? '<button class="text-button" type="button" data-more-repos>Show the rest</button>' : ''}` : '';
  if (state.inspection) renderInspection();
  if (state.catalog) renderDirectory();
  if (state.view === 'repos') renderHeader();
}
function openRepoQueue(repo) {
  state.filters = { ...state.filters, repo, status: 'Open', search: '', priority: '' };
  state.limit = 20;
  state.queueScroll = 0;
  $('search-input').value = '';
  $('priority-filter').value = '';
  renderQueue();
  navigate('#queue');
}
async function chooseRepo(repo) {
  state.repoChoice = repo;
  $('repo-picker').value = repo;
  const choice = repositoryChoices().find(choice => choice.repo.toLowerCase() === repo.toLowerCase());
  $('repo-input').value = choice?.repo || repo;
  document.querySelector('.repo-inspection').scrollIntoView({ block: 'start', behavior: 'smooth' });
  await inspectRepo({ preventDefault() {}, currentTarget: $('repo-form') });
}
function inspectionRow({ issue, claimed, queued }) {
  const url = safeUrl(issue.url);
  const shown = (issue.labels || []).slice(0, 3).map(label => labelHtml(typeof label === 'string' ? label : label.name)).join('');
  const meta = [
    issue.updatedAt ? `updated ${age(issue.updatedAt)} ago` : '',
    issue.comments ? `${issue.comments} comment${issue.comments === 1 ? '' : 's'}` : '',
    issue.latestComment?.author ? `last by ${escapeHtml(issue.latestComment.author)}` : '',
  ].filter(Boolean).join(' · ');
  const flags = [
    queued ? `<a class="tag tag-good" href="#issue/${encodeURIComponent(queued.id)}">In your queue</a>` : '',
    claimed ? createTag(escapeHtml(`Claimed: ${issue.claim.reason}`), 'tag-warn') : '',
    issue.claim?.stale ? createTag('Stale claim', 'tag-warn') : '',
    issue.detailChecked ? '' : createTag('Quick score', ''),
  ].join('');
  return `<div class="inspected-issue${claimed ? ' is-claimed' : ''}">${scoreHtml({ score: issue.issueFitScore }, false)}<div class="inspected-body"><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><span class="muted">#${escapeHtml(issue.number)}</span> ${escapeHtml(issue.title)}</a><div class="inspected-meta">${shown}${meta ? `<span class="muted">${meta}</span>` : ''}${flags}</div></div></div>`;
}
function renderInspectionList() {
  const repo = state.inspection;
  if (!repo || !$('inspect-list')) return;
  const view = Q.inspectionView(repo, state.items, state.inspectView);
  const total = repo.totalOpenIssues ?? view.total;
  const filtered = view.matching !== view.total;
  $('inspect-list').innerHTML = view.rows.map(inspectionRow).join('')
    || `<p class="muted">${view.total ? 'No issues match these filters.' : 'This repository has no open issues.'}</p>`;
  const unread = view.total - view.checked;
  const minutes = Math.max(1, Math.ceil((repo.github?.rateLimitedFor || 0) / 60));
  const note = [
    repo.truncated ? `Listing the ${repo.openItems} most recently updated open items (issues and pull requests together); this repository has more.` : '',
    repo.rateLimited ? `GitHub’s rate limit was reached, so some issues could not be read in detail${repo.github?.rateLimitedFor ? `; it resets in about ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}.` : '',
    repo.github?.rejected ? 'The server’s GitHub token was rejected, so these requests ran anonymously.' : '',
  ].filter(Boolean).join(' ');
  $('inspect-footer').innerHTML = `<p class="inspection-footer">Showing ${view.rows.length} of ${filtered ? `${view.matching} matching (${view.total} total)` : view.total} open issues. ${view.checked} read in detail; the other ${unread} are scored from labels, age, and activity only. ${note}</p><div class="inspect-actions">${view.remaining ? `<button class="button button-secondary" type="button" data-inspect-more>Show ${Math.min(25, view.remaining)} more</button>` : ''}${unread ? `<button class="button button-secondary" type="button" data-inspect-detail ${state.inspectBusy ? 'disabled' : ''}>${state.inspectBusy ? 'Reading…' : `Read the next ${Math.min(20, unread)} in detail`}</button>` : ''}</div>`;
  $('inspect-count').textContent = filtered ? `${view.matching} of ${total}` : `${total}`;
}
function renderInspection() {
  const repo = state.inspection;
  const overview = repo.overview || {};
  const watched = state.repos.some(item => item.repo.toLowerCase() === repo.repo.toLowerCase());
  const view = Q.inspectionView(repo, state.items, { limit: 0 });
  const total = repo.totalOpenIssues ?? view.total;
  const pulls = typeof overview.openIssues === 'number' && !repo.truncated ? Math.max(0, overview.openIssues - total) : 0;
  const queuedHere = repositoryChoices().find(choice => choice.repo.toLowerCase() === repo.repo.toLowerCase())?.openMatches || 0;
  $('repo-inspection-result').innerHTML = `<div class="inspection-header"><div><h2>${escapeHtml(repo.repo)}</h2><p>${escapeHtml(overview.description || overview.projectSummary || '')}</p></div><div class="inspection-buttons">${queuedHere ? `<button class="button button-secondary" type="button" data-view-queue="${escapeHtml(repo.repo)}">${queuedHere} in your queue</button>` : ''}<button class="button" type="button" data-watch="${escapeHtml(repo.repo)}" ${watched ? 'disabled' : ''}>${watched ? 'Watching' : 'Add to watchlist'}</button></div></div><div class="repo-metrics"><div><strong>${total}</strong><span>open issues${pulls ? ` (plus ${pulls} pull requests)` : ''}</span></div><div><strong>${view.goodFirst}</strong><span>good first issue${view.goodFirst === 1 ? '' : 's'}</span></div><div><strong>${view.strong}</strong><span>unclaimed matches above 70</span></div><div><strong>${escapeHtml(overview.language || '—')}</strong><span>primary language</span></div></div><div class="inspect-toolbar"><label class="sr-only" for="inspect-search">Filter issues</label><input id="inspect-search" type="search" placeholder="Filter by title, label, or number" value="${escapeHtml(state.inspectView.query)}"><label class="check"><input id="inspect-hide-claimed" type="checkbox" ${state.inspectView.hideClaimed ? 'checked' : ''}> Hide claimed</label><span class="muted"><span id="inspect-count"></span> shown</span></div><div id="inspect-list"></div><div id="inspect-footer"></div>`;
  renderInspectionList();
}
async function inspectMoreDetail() {
  const repo = state.inspection;
  if (!repo || state.inspectBusy) return;
  state.inspectBusy = true;
  renderInspectionList();
  try {
    const next = (await api('/api/repo-issues', { method: 'POST', body: JSON.stringify({ repo: repo.repo, skip: repo.detailDepth || repo.detailChecked || 0, detail: 20 }) })).repo;
    state.inspection = Q.mergeInspection(repo, next);
  } catch (error) { toast(error.message); }
  finally { state.inspectBusy = false; renderInspectionList(); }
}
async function inspectRepo(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('repo-check-status').textContent = 'Listing every open issue…';
  try {
    state.inspection = (await api('/api/repo-issues',{method:'POST',body:JSON.stringify({repo:$('repo-input').value.trim()})})).repo;
    state.inspectView = { query: '', hideClaimed: false, limit: 25 };
    renderInspection();
    $('repo-check-status').textContent = `Listed ${state.inspection.totalOpenIssues ?? state.inspection.issues.length} open issues in ${state.inspection.repo}.`;
  } catch (error) { $('repo-check-status').textContent = error.message; }
  finally { button.disabled = false; }
}
async function watchRepo(repo) {
  const data = await api('/api/repositories',{method:'POST',body:JSON.stringify({repo})});
  await loadRepos();
  toast(`${data.repository.repo} added to your watchlist.`);
}
async function toggleRepo(id, button) {
  const repo = state.repos.find(item => item.id === id);
  if (!repo) return;
  button.disabled = true;
  try {
    const data = await api(`/api/repositories/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify({enabled:repo.enabled === false})});
    state.repos[state.repos.findIndex(item => item.id === id)] = data.repository;
    renderRepos();
    toast(`${repo.repo} ${data.repository.enabled ? 'included in scans' : 'paused'}.`);
  } catch (error) { button.disabled = false; showNotice(error.message,true); }
}
async function removeRepo(id) {
  const repo = state.repos.find(item => item.id === id);
  await api(`/api/repositories/${encodeURIComponent(id)}`,{method:'DELETE'});
  await loadRepos();
  toast(`${repo?.repo || 'Repository'} removed from your watchlist.`);
}
function renderDirectory() {
  const {areas, projects} = state.catalog;
  $('project-filters').innerHTML = [{area:'',label:'All areas'},...areas].map(area => `<button type="button" data-area="${escapeHtml(area.area)}" aria-pressed="${state.area === area.area}">${escapeHtml(area.label)}</button>`).join('');
  $('project-directory').innerHTML = projects.filter(project => !state.area || project.area === state.area).map(project => {
    const watched = state.repos.some(repo => repo.repo.toLowerCase() === project.repo.toLowerCase());
    return `<article class="project-item"><a href="https://github.com/${escapeHtml(project.repo)}" target="_blank" rel="noreferrer">${escapeHtml(project.repo)}</a><p>${escapeHtml(project.blurb)}</p><div class="section-line"><span>${escapeHtml(project.language)}</span><button class="text-button" type="button" data-watch="${escapeHtml(project.repo)}" ${watched ? 'disabled' : ''}>${watched ? 'Watching' : 'Add to watchlist'}</button></div></article>`;
  }).join('');
}
function renderScans() {
  const runs = [...(state.health.currentRun ? [state.health.currentRun] : []),...(state.health.recentRuns || [])];
  $('scans-table').innerHTML = runs.length ? `<table class="scan-table"><caption class="sr-only">Scan history</caption><colgroup><col class="started-col"><col class="trigger-col"><col><col><col><col></colgroup><thead><tr><th scope="col">Started</th><th scope="col">Trigger</th><th scope="col">Repos</th><th scope="col">Issues read</th><th scope="col" title="Recommendations saved by this scan">Saved</th><th scope="col">Took</th></tr></thead><tbody>${runs.map(run => {
    const trigger = /cron|schedule/i.test(run.trigger) ? 'Schedule' : /telegram/i.test(run.trigger) ? 'Telegram' : /manual|api/i.test(run.trigger) ? 'Dashboard' : run.trigger || 'Unknown';
    const failed = ['failed','partial'].includes(run.status);
    return failed ? `<tr class="scan-error"><td>${escapeHtml(shortDate(run.startedAt,true))}</td><td colspan="5"><div class="scan-error-detail"><span>${escapeHtml(run.error || 'This scan did not finish.')}</span><button class="button button-secondary" type="button" data-run-log="${escapeHtml(run.id)}">Show log</button><button class="button button-secondary" type="button" data-scan ${state.running ? 'disabled' : ''}>Retry</button></div></td></tr>` : `<tr><td>${escapeHtml(shortDate(run.startedAt,true))}${run.status === 'running' ? ' · Running' : ''}</td><td>${escapeHtml(trigger)}</td><td>${run.repositories ?? '—'}</td><td>${run.totalIssues ?? '—'}</td><td><strong>${run.opportunities ?? '—'}</strong></td><td>${run.durationMs != null ? `${Math.round(run.durationMs/1000)} s` : '…'}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty-state"><strong>No scans recorded yet</strong><p>Run a scan to check your repositories and build a history.</p><button class="button button-secondary" type="button" data-scan>Scan now</button></div>';
  if (state.view === 'scans') renderHeader();
}
function renderRanking() {
  const learning = state.learning;
  if (!learning?.sampleSize) {
    $('ranking-summary').innerHTML = '<p class="muted">No ranking adjustments yet. Taking, finishing, and dismissing issues helps rank future suggestions.</p>';
  } else {
    const c = learning.counts || {};
    const parts = [];
    if (learning.boostedRepos?.length) parts.push(`<p>Issues in <strong>${learning.boostedRepos.map(escapeHtml).join(', ')}</strong> get more weight based on your contribution history.</p>`);
    if (learning.dislikedLabels?.length) parts.push(`<p>Issues labelled <strong>${learning.dislikedLabels.map(escapeHtml).join(', ')}</strong> get less weight based on your dismissals.</p>`);
    if (learning.penalizedRepos?.length) parts.push(`<p>You’ve dismissed work in <strong>${learning.penalizedRepos.map(escapeHtml).join(', ')}</strong>; those repositories get less weight.</p>`);
    parts.push(`<p>${c.merged || 0} merged PRs · ${c.completed || 0} completed · ${c.claimed || 0} claimed · ${c.dismissed || 0} dismissed.</p>`);
    $('ranking-summary').innerHTML = parts.join('');
  }
  const reasons = Object.entries(learning?.dismissReasons || {}).sort((a,b)=>b[1]-a[1]);
  const max = Math.max(1,...reasons.map(([,n])=>n));
  $('dismissal-chart').innerHTML = reasons.length ? reasons.map(([reason,n])=>`<div class="chart-row"><span>${escapeHtml(reason)}</span><span class="chart-track" aria-hidden="true"><span style="width:${Math.round(n/max*100)}%"></span></span><span>${n}</span></div>`).join('') : '<p class="muted">No dismissal reasons recorded yet.</p>';
  $('ranking-history').textContent = learning?.sampleSize ? `Based on ${learning.sampleSize} recorded outcomes. Telegram feedback is included.` : 'Your existing issue history stays available.';
  $('reset-ranking-button').disabled = !learning?.sampleSize;
}
async function scan() {
  if (state.running) return;
  state.running = true; renderHeader();
  showNotice('Scan started. You can keep browsing while it runs.');
  try {
    const result = await api('/api/scan',{method:'POST'});
    if (result.queued || result.dispatched) {
      showNotice('Scan queued. The history will update when results are available.');
    } else {
      await loadItems();
      showNotice(`Scan complete. ${result.digest?.contest_digest?.length || result.run?.opportunities || 0} recommendations found.`);
    }
    await loadHealth();
  } catch (error) { showNotice(`Scan failed: ${error.message}`,true); await loadHealth().catch(()=>{}); }
  finally { state.running = false; renderHeader(); }
}
function routeHash(hash) {
  if (hash.startsWith('#issue/')) { try { return {view:'issue',id:decodeURIComponent(hash.slice(7))}; } catch { return {view:'queue'}; } }
  return {view:['#repos','#scans'].includes(hash) ? hash.slice(1) : 'queue'};
}
function showRoute(hash, force = false) {
  if (!force && state.route === (hash || '#queue')) return;
  const route = routeHash(hash);
  if (state.view === 'issue' && state.dirty && !force && (route.view !== 'issue' || route.id !== state.selected)) {
    state.pendingRoute = hash;
    history.replaceState(null,'',state.route || '#queue');
    $('leave-dialog').showModal();
    return;
  }
  if (route.view === 'issue' && !state.loaded) return;
  if (state.view === 'queue') state.queueScroll = window.scrollY;
  const previousView = state.view;
  state.view = route.view;
  state.route = hash || '#queue';
  showNotice();
  ['queue','issue','repos','scans'].forEach(view => $(`${view}-view`).classList.toggle('hidden',view !== state.view));
  document.querySelectorAll('.nav-link').forEach(link => {
    const active = link.dataset.view === (state.view === 'issue' ? 'queue' : state.view);
    if (active) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  });
  if (state.view === 'issue') {
    const item = state.items.find(item => item.id === route.id);
    if (!item) { state.view = 'queue'; history.replaceState(null,'','#queue'); showRoute('#queue',true); showNotice('This issue is no longer in the saved queue.',true); return; }
    if (previousView !== 'issue' || state.selected !== item.id) renderIssue(item);
  }
  renderHeader();
  if (state.view === 'queue') { renderQueue(); requestAnimationFrame(()=>window.scrollTo(0,state.queueScroll)); }
  else window.scrollTo(0,0);
}
function navigate(hash, force = false) {
  if (state.dirty && state.view === 'issue' && !force) { showRoute(hash); return; }
  if (location.hash !== hash) history.pushState(null,'',hash);
  showRoute(hash,force);
}
async function init() {
  const results = await Promise.allSettled([loadItems(),loadRepos(),loadHealth()]);
  const error = results.find(result=>result.status==='rejected');
  if (error) {
    showNotice(error.reason.message,true);
    if (!state.loaded) { $('queue-body').setAttribute('aria-busy','false'); $('queue-body').innerHTML = '<div class="empty-state"><strong>Couldn’t load your queue</strong><p>Check your connection or workspace key, then try again.</p><button class="button button-secondary" type="button" data-retry>Try again</button></div>'; }
  } else {
    showRoute(location.hash || '#queue',true);
  }
  $('access-button').textContent = state.key ? 'Workspace unlocked' : 'Workspace access';
  fetch('/api/bitcoin-projects').then(response => response.ok ? response.json() : null).then(data=>{if(data){state.catalog=data;renderRepos();}}).catch(()=>{});
}

$('detail-form').addEventListener('submit',event=>{event.preventDefault();saveIssue();});
$('detail-form').addEventListener('input',event=>{if(event.target.id !== 'new-step' && event.target.id !== 'activity-note') {readDraft();setDirty();} else if(event.target.value.trim()) setDirty();});
$('detail-form').addEventListener('change',event=>{
  if(event.target.matches('[data-step]')) {state.draft.steps[Number(event.target.dataset.step)].done=event.target.checked;setDirty();$('plan-progress').textContent=`${state.draft.steps.filter(step=>step.done).length} of ${state.draft.steps.length} complete`;}
});
$('new-step').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addStep();}});
$('add-step-button').addEventListener('click',addStep);
$('add-note-button').addEventListener('click',addNote);
$('analyze-button').addEventListener('click',analyzeIssue);
$('copy-code-button').addEventListener('click',async()=>{try {await navigator.clipboard.writeText($('detail-code').textContent);toast('Code copied.');}catch{toast('Couldn’t copy automatically. Select the code to copy it.');}});
$('repo-form').addEventListener('submit',inspectRepo);
$('repo-picker').addEventListener('change',async event=>{if(event.target.value){try{await chooseRepo(event.target.value);}catch(error){showNotice(error.message,true);}}});
$('watchlist-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;try{await watchRepo($('watchlist-input').value.trim());$('watchlist-input').value='';}catch(error){showNotice(error.message,true);}finally{button.disabled=false;}});
$('dismiss-form').addEventListener('submit',dismissIssue);
['priority','repo','sort'].forEach(filter=> $(`${filter}-filter`).addEventListener('change',event=>{state.filters[filter]=event.target.value;state.limit=20;renderQueue();}));
$('search-input').addEventListener('input',event=>{state.filters.search=event.target.value;state.limit=20;renderQueue();});
$('access-form').addEventListener('submit',event=>{event.preventDefault();state.key=$('access-key').value.trim();sessionStorage.setItem('danagent.apiKey',state.key);$('access-dialog').close('connect');});
$('access-dialog').addEventListener('close',()=>{const resolve=state.accessResolve;const connected=$('access-dialog').returnValue==='connect';state.accessResolve=null;state.accessPromise=null;if(resolve)resolve(connected);});
$('access-button').addEventListener('click',async()=>{if(await requestKey())init();});
$('undo-button').addEventListener('click',async()=>{const undo=state.undo;if(!undo)return;$('undo-button').disabled=true;try{await undo();}catch(error){toast(error.message);}finally{$('undo-button').disabled=false;}});
$('toast-close').addEventListener('click',()=>$('toast').classList.add('hidden'));
$('stay-button').addEventListener('click',()=>{state.pendingRoute=null;$('leave-dialog').close();});
$('discard-button').addEventListener('click',()=>{state.dirty=false;const next=state.pendingRoute;state.pendingRoute=null;$('leave-dialog').close();navigate(next,true);});
$('save-leave-button').addEventListener('click',async()=>{if(await saveIssue()){const next=state.pendingRoute;state.pendingRoute=null;$('leave-dialog').close();navigate(next,true);}});
$('reset-ranking-button').addEventListener('click',()=>$('reset-dialog').showModal());
$('confirm-reset-button').addEventListener('click',async()=>{const button=$('confirm-reset-button');button.disabled=true;try{await api('/api/preferences',{method:'POST',body:JSON.stringify({action:'reset'})});await loadItems();$('reset-dialog').close();toast('Ranking adjustments reset. Your issue history is unchanged.');}catch(error){showNotice(error.message,true);}finally{button.disabled=false;}});
window.addEventListener('popstate',()=>showRoute(location.hash));
window.addEventListener('hashchange',()=>showRoute(location.hash));
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('input',event=>{
  if(event.target.id==='inspect-search'){state.inspectView.query=event.target.value;state.inspectView.limit=25;renderInspectionList();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='inspect-hide-claimed'){state.inspectView.hideClaimed=event.target.checked;state.inspectView.limit=25;renderInspectionList();}
});
document.addEventListener('click',async event=>{
  const link=event.target.closest('a[href^="#"]');
  if(link && /^(#queue|#repos|#scans|#issue\/)/.test(link.getAttribute('href')) && !event.metaKey && !event.ctrlKey && !event.shiftKey){event.preventDefault();navigate(link.getAttribute('href'));return;}
  const button=event.target.closest('button');
  const row=event.target.closest('[data-issue]');
  if(row && !event.target.closest('a,button')){navigate(`#issue/${encodeURIComponent(row.dataset.issue)}`);return;}
  if(!button || button.disabled)return;
  try{
    if(button.hasAttribute('data-close-dialog'))button.closest('dialog').close('cancel');
    if(button.hasAttribute('data-scan'))await scan();
    if(button.hasAttribute('data-retry'))await init();
    if(button.hasAttribute('data-more')){state.limit=state.items.length;renderQueue();}
    if(button.hasAttribute('data-more-repos')){state.repoLimit=repositoryChoices().length;renderRepos();}
    if(button.dataset.status){state.filters.status=button.dataset.status;state.limit=20;renderQueue();}
    if(button.hasAttribute('data-clear-filters')){state.filters={status:'Open',repo:'',priority:'',search:'',sort:'fit'};['priority','repo'].forEach(id=>$(`${id}-filter`).value='');$('sort-filter').value='fit';$('search-input').value='';renderQueue();}
    if(button.hasAttribute('data-remove-step')){state.draft.steps.splice(Number(button.dataset.removeStep),1);setDirty();renderPlan();}
    if(button.hasAttribute('data-dismiss'))$('dismiss-dialog').showModal();
    if(button.hasAttribute('data-restore'))await restoreIssue();
    if(button.dataset.watch){button.disabled=true;try{await watchRepo(button.dataset.watch);}catch(error){button.disabled=false;throw error;}}
    if(button.dataset.toggleRepo)await toggleRepo(button.dataset.toggleRepo,button);
    if(button.dataset.removeRepo)await removeRepo(button.dataset.removeRepo);
    if(button.dataset.repoMatches)openRepoQueue(button.dataset.repoMatches);
    if(button.dataset.viewQueue)openRepoQueue(button.dataset.viewQueue);
    if(button.hasAttribute('data-inspect-more')){state.inspectView.limit+=25;renderInspectionList();}
    if(button.hasAttribute('data-inspect-detail'))await inspectMoreDetail();
    if(button.dataset.chooseRepo)await chooseRepo(button.dataset.chooseRepo);
    if(button.hasAttribute('data-area')){state.area=button.dataset.area;renderDirectory();}
    if(button.dataset.runLog){const run=state.health.recentRuns?.find(run=>run.id===button.dataset.runLog);info('Scan details',`<pre>${escapeHtml(JSON.stringify(run,null,2))}</pre>`);}
    if(button.hasAttribute('data-schedule'))info('Scan schedule',`<p>${escapeHtml(scheduleText())}.</p><p class="muted">Scheduled runs are managed by this deployment. Manual scans are available from Queue and Scans.</p>`);
  }catch(error){showNotice(error.message,true);}
});
setInterval(()=>{if(state.view==='scans' || state.running)loadHealth().catch(()=>{});},15000);
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
      ${a.confidence ? createTag(`Confidence ${escapeHtml(a.confidence)}%`) : ''}
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
        <li><a href="${escapeHtml(safeUrl(pr.url))}" target="_blank" rel="noreferrer">${escapeHtml(pr.sameRepo === false && pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`)}</a> (${escapeHtml(pr.state)}${pr.author ? ` by ${escapeHtml(pr.author)}` : ''}) ${escapeHtml(pr.title || '')}</li>
      `).join('')}</ul>`)
    : '';

  const sources = (ctx.files || []).length
    ? block('Source consulted', `<ul>${ctx.files.map(file => `
        <li><a href="${escapeHtml(safeUrl(file.url))}" target="_blank" rel="noreferrer"><code>${escapeHtml(file.path)}</code></a> lines ${escapeHtml(file.startLine)}–${escapeHtml(file.endLine)} · ${escapeHtml(file.reason)}</li>
      `).join('')}${ctx.contributing ? `<li><a href="${escapeHtml(safeUrl(ctx.contributing.url))}" target="_blank" rel="noreferrer">${escapeHtml(ctx.contributing.path)}</a></li>` : ''}</ul>`)
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

showRoute(location.hash || '#queue',true);
init();
