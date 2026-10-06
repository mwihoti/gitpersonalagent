/* Shared presentation rules. Loaded by the browser and exercised by Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function displayStatus(item) {
    const status = String(item.status || 'New');
    const log = String(item.activityLog || '');
    if (/done|closed|complete|dropped|skip|dismiss/i.test(status)) {
      const outcome = [...log.matchAll(/\[outcome ([^\]]+)\]/gi)].at(-1)?.[1];
      if (outcome === 'completed' || outcome === 'merged') return 'Done';
      if (outcome === 'dismissed') return 'Dismissed';
      if (/\[outcome (?:archived|closed-upstream)\]/i.test(log)) return 'Closed';
      if (/\[dismiss reason:|dismissed/i.test(log) || /dismiss|skip|dropped/i.test(status)) return 'Dismissed';
      return 'Done';
    }
    return /progress|active|doing|working/i.test(status) ? 'In Progress' : 'New';
  }
  function isOpen(item) { return ['New', 'In Progress'].includes(displayStatus(item)); }
  function editableStatus(item) {
    const status = displayStatus(item);
    return status === 'In Progress' ? 'In Progress' : status === 'New' ? 'New' : 'Done';
  }
  function parsePlan(value) {
    const lines = Array.isArray(value) ? value : String(value || '').split('\n');
    return lines.filter(line => String(line).trim()).map(line => {
      const match = String(line).trim().match(/^(?:[-*]\s*)?\[([ xX])\]\s*(.*)$/);
      return match ? { done: match[1].toLowerCase() === 'x', text: match[2] }
        : { done: false, text: String(line).replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim() };
    }).filter(step => step.text);
  }
  function serializePlan(steps) { return steps.map(step => `- [${step.done ? 'x' : ' '}] ${step.text.trim()}`).join('\n'); }
  function availability(item) { return item.analysis?.analysis?.currentState || 'unchecked'; }
  function score(item) { const n = Number(item.score); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
  function labels(item) {
    if (Array.isArray(item.labels)) return item.labels;
    return String(item.labels || '').split(',').map(label => label.trim()).filter(Boolean);
  }
  function repositoryChoices(items = [], watched = [], projects = []) {
    const repos = new Map();
    function entry(name) {
      const repo = String(name || '').trim();
      if (!repo) return null;
      const key = repo.toLowerCase();
      if (!repos.has(key)) repos.set(key, { repo, watching: false, totalIssues: 0, openMatches: 0, bestScore: 0 });
      return repos.get(key);
    }
    for (const item of items) {
      const choice = entry(item.repo);
      if (!choice) continue;
      choice.totalIssues += 1;
      if (isOpen(item)) { choice.openMatches += 1; choice.bestScore = Math.max(choice.bestScore, score(item)); }
    }
    for (const project of projects) {
      const choice = entry(project.repo);
      if (choice) choice.project = project;
    }
    for (const watchedRepo of watched) {
      const choice = entry(watchedRepo.repo);
      if (choice) Object.assign(choice, watchedRepo, { watching: true });
    }
    return [...repos.values()].sort((a, b) => Number(b.watching) - Number(a.watching)
      || Number(b.totalIssues > 0) - Number(a.totalIssues > 0) || a.repo.localeCompare(b.repo));
  }
  function filterIssues(items, filters) {
    const search = String(filters.search || '').toLowerCase().trim();
    return items.filter(item => {
      const status = displayStatus(item);
      const statusMatch = filters.status === 'Open' ? isOpen(item) : !filters.status || status === filters.status;
      const haystack = [item.opportunity, item.repo, item.owner, item.nextStep, ...labels(item)].join(' ').toLowerCase();
      return statusMatch && (!filters.repo || String(item.repo).toLowerCase() === filters.repo.toLowerCase())
        && (!filters.priority || item.priority === filters.priority) && (!search || haystack.includes(search));
    }).sort((a, b) => {
      const progress = Number(displayStatus(b) === 'In Progress') - Number(displayStatus(a) === 'In Progress');
      if (progress) return progress;
      if (filters.sort === 'recent') return String(b.issueUpdatedAt || b.lastUpdated || b.date).localeCompare(String(a.issueUpdatedAt || a.lastUpdated || a.date));
      if (filters.sort === 'priority') {
        const ranks = { High: 3, Medium: 2, Low: 1 };
        const diff = (ranks[b.priority] || 0) - (ranks[a.priority] || 0);
        if (diff) return diff;
      }
      return score(b) - score(a) || String(b.date).localeCompare(String(a.date));
    });
  }
  function normalizeUrl(value) { return String(value || '').trim().toLowerCase().replace(/\/+$/, ''); }
  function isClaimed(issue) { return Boolean(issue && issue.claim && issue.claim.claimed); }
  function byFit(a, b) {
    return (Number(b.issueFitScore) || 0) - (Number(a.issueFitScore) || 0)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  }
  // Fold a fresh listing into what is already on screen. An issue the user has
  // already read in detail keeps that detail when the new listing only has a
  // quick score for it, so "read the next 20" adds to the view instead of
  // replacing it.
  function mergeInspection(previous, next) {
    if (!next) return previous || null;
    if (!previous || previous.repo !== next.repo) return next;
    const known = new Map((previous.issues || []).map(issue => [issue.number, issue]));
    const issues = (next.issues || []).map(issue => {
      const before = known.get(issue.number);
      return !issue.detailChecked && before && before.detailChecked ? before : issue;
    }).sort(byFit);
    return { ...next, issues, detailChecked: issues.filter(issue => issue.detailChecked).length };
  }
  // What the repo check shows for the current filters: every issue is
  // reachable, rows are paged, and each carries its place in the user's queue.
  function inspectionView(repo, queueItems = [], options = {}) {
    const { query = '', hideClaimed = false, limit = 25 } = options;
    const queued = new Map(queueItems.filter(item => item.issueUrl).map(item => [normalizeUrl(item.issueUrl), item]));
    const needle = String(query).toLowerCase().trim().replace(/^#/, '');
    const all = (repo.issues || []).map(issue => ({ issue, claimed: isClaimed(issue), queued: queued.get(normalizeUrl(issue.url)) || null }));
    const matching = all.filter(row => {
      if (hideClaimed && row.claimed) return false;
      if (!needle) return true;
      const text = [row.issue.title, String(row.issue.number), ...labels(row.issue), row.issue.claim && row.issue.claim.reason].join(' ').toLowerCase();
      return text.includes(needle);
    });
    const open = all.filter(row => !row.claimed);
    return {
      rows: matching.slice(0, limit),
      matching: matching.length,
      total: all.length,
      claimed: all.length - open.length,
      goodFirst: all.filter(row => labels(row.issue).some(label => /good first issue/i.test(label))).length,
      strong: open.filter(row => (Number(row.issue.issueFitScore) || 0) >= 70).length,
      checked: all.filter(row => row.issue.detailChecked).length,
      queuedCount: all.filter(row => row.queued).length,
      remaining: Math.max(0, matching.length - limit),
    };
  }
  function initials(value) { return String(value || '').split(/[\s._-]+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); }
  function activityEntries(value) {
    const clean = text => text.replace(/\s*\[(?:ranking baseline:|outcome |dismiss reason:)[^\]]+\]/gi, '').trim();
    return String(value || '').split('\n').filter(line => line.trim()).map(line => {
      const dashboard = line.match(/^\[dashboard ([^\]]+)\]\s*(.*)$/);
      const bot = line.match(/^\[(?:bot|scan|telegram|pr)\s+([^\]]+)\]\s*(.*)$/i);
      return dashboard ? { text: clean(dashboard[2]), at: dashboard[1], who: 'Dashboard' }
        : bot ? { text: clean(bot[2]), at: bot[1], who: 'Bot' }
        : { text: clean(line), at: '', who: '' };
    }).reverse();
  }
  return { displayStatus, isOpen, editableStatus, parsePlan, serializePlan, availability, score, labels, repositoryChoices, filterIssues, initials, activityEntries, mergeInspection, inspectionView };
});
