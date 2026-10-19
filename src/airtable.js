'use strict';
// Opportunity storage: Neon Postgres, with the historical local JSON fallback.
//
// The filename is historical — this module spoke to Airtable until the free
// plan's API-call and record limits made it untenable. The exported interface
// is unchanged, so the rest of the code (and most tests) did not move.
//
// Two layers, same as always:
//   DATABASE_URL set      → the `opportunities` table in Postgres
//   otherwise, or when the network fails → data/opportunities.json
//
// The local file keeps its original shape (one object per record with
// human-readable keys like "Issue URL"), so existing files remain readable.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { buildSeenMap } = require('./issue-tracking');

let localWriteQueue = Promise.resolve();
const LOCAL_DATA_DIR = process.env.DAN_AGENT_DATA_DIR || (process.env.VERCEL
  ? path.join('/tmp', 'danagent-data')
  : path.join(__dirname, '..', 'data'));
const LOCAL_DATA_FILE = path.join(LOCAL_DATA_DIR, 'opportunities.json');

// column name in Postgres · key in the local JSON file · key on records we return
const FIELDS = [
  ['date', 'Date', 'date'],
  ['opportunity', 'Opportunity', 'opportunity'],
  ['repo', 'Repo', 'repo'],
  ['effort', 'Effort', 'effort'],
  ['status', 'Status', 'status'],
  ['priority', 'Priority', 'priority'],
  ['owner', 'Owner', 'owner'],
  ['due_date', 'Due Date', 'dueDate'],
  ['issue_url', 'Issue URL', 'issueUrl'],
  ['pr_url', 'PR URL', 'prUrl'],
  ['suggested_action', 'Suggested Action', 'suggestedAction'],
  ['next_step', 'Next Step', 'nextStep'],
  ['activity_log', 'Activity Log', 'activityLog'],
  ['quick_plan', 'Quick Plan', 'quickPlan'],
  ['why_it_qualifies', 'Why It Qualifies', 'whyItQualifies'],
  ['why_it_matters', 'Why It Matters', 'whyItMatters'],
  ['clarity_tip', 'Clarity Tip', 'clarityTip'],
  ['code_skeleton', 'Code Skeleton', 'codeSkeleton'],
  ['source', 'Source', 'source'],
  ['source_url', 'Source URL', 'sourceUrl'],
  ['issue_updated_at', 'Issue Updated At', 'issueUpdatedAt'],
  ['score', 'Score', 'score'],
  ['impact', 'Impact', 'impact'],
  ['maintainer_wants', 'Maintainer Wants', 'maintainerWants'],
  ['files_to_change', 'Files To Change', 'filesToChange'],
  ['open_questions', 'Open Questions', 'openQuestions'],
  ['analysis', 'Analysis', 'analysis'],
  ['labels', 'Labels', 'labels'],
  ['language', 'Language', 'language'],
  ['last_updated', 'Last Updated', 'lastUpdated'],
];
const COLUMN_BY_FILE_KEY = new Map(FIELDS.map(([column, fileKey]) => [fileKey, column]));
const ALL_COLUMNS = FIELDS.map(([column]) => column);

function isAirtableConfigured() {
  // Historical name, kept so callers did not have to move: "is cloud storage
  // configured".
  return db.isConfigured();
}

function newId() {
  return `rec${crypto.randomBytes(8).toString('hex')}`;
}

function parseAnalysis(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatFiles(files) {
  return (files || []).map(file => `${file.path}${file.why ? ` — ${file.why}` : ''}`).join('\n');
}

// Local-file row (human-readable keys) → the record shape callers use.
function normalizeRecord(id, fields = {}) {
  return {
    id,
    date: fields.Date || '',
    opportunity: fields.Opportunity || '',
    repo: fields.Repo || '',
    effort: fields.Effort || 'medium',
    status: fields.Status || 'New',
    priority: fields.Priority || 'Medium',
    owner: fields.Owner || '',
    dueDate: fields['Due Date'] || '',
    issueUrl: fields['Issue URL'] || '',
    prUrl: fields['PR URL'] || '',
    suggestedAction: fields['Suggested Action'] || '',
    nextStep: fields['Next Step'] || '',
    activityLog: fields['Activity Log'] || '',
    quickPlan: fields['Quick Plan'] || '',
    whyItQualifies: fields['Why It Qualifies'] || '',
    whyItMatters: fields['Why It Matters'] || '',
    clarityTip: fields['Clarity Tip'] || '',
    codeSkeleton: fields['Code Skeleton'] || '',
    source: fields.Source || '',
    sourceUrl: fields['Source URL'] || '',
    issueUpdatedAt: fields['Issue Updated At'] || '',
    score: fields.Score || 0,
    lastUpdated: fields['Last Updated'] || '',
    impact: fields.Impact || '',
    labels: fields.Labels || '',
    language: fields.Language || '',
    maintainerWants: fields['Maintainer Wants'] || '',
    filesToChange: fields['Files To Change'] || '',
    openQuestions: fields['Open Questions'] || '',
    analysis: parseAnalysis(fields.Analysis),
  };
}

// Postgres row → the same record shape.
function recordFromRow(row) {
  const fields = {};
  for (const [column, fileKey] of FIELDS) {
    if (row[column] !== null && row[column] !== undefined) fields[fileKey] = row[column];
  }
  return normalizeRecord(row.id, fields);
}

// A record back into local-file keys, so the snapshot mirror stays readable.
function fileRowFromRecord(record) {
  const row = { id: record.id };
  for (const [, fileKey, camelKey] of FIELDS) {
    const value = camelKey === 'analysis'
      ? (record.analysis ? JSON.stringify(record.analysis) : '')
      : record[camelKey];
    if (value !== undefined && value !== null && value !== '') row[fileKey] = value;
  }
  return row;
}

// ─── Local file store ─────────────────────────────────────────────────────────

async function ensureLocalStore() {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
  try {
    await fs.access(LOCAL_DATA_FILE);
  } catch {
    await fs.writeFile(LOCAL_DATA_FILE, '[]\n', 'utf8');
  }
}

async function readLocalRecords() {
  await ensureLocalStore();
  const raw = await fs.readFile(LOCAL_DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeLocalRecords(records) {
  await ensureLocalStore();
  await fs.writeFile(LOCAL_DATA_FILE, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function serializeLocalWrite(task) {
  const next = localWriteQueue.then(task, task);
  localWriteQueue = next.catch(() => {});
  return next;
}

async function prependLocalRecords(records) {
  await serializeLocalWrite(async () => {
    const existing = await readLocalRecords();
    await writeLocalRecords(deduplicateRecords([...records, ...existing]));
  });
}

async function syncLocalRecords(records) {
  await serializeLocalWrite(async () => {
    await writeLocalRecords(deduplicateRecords(records));
  });
}

function recordKey(record) {
  const repo = String(record.Repo || record.repo || '').trim().toLowerCase();
  const issueUrl = String(record['Issue URL'] || record.issueUrl || '').trim().toLowerCase();
  const opportunity = String(record.Opportunity || record.opportunity || '').trim().toLowerCase();

  if (repo && issueUrl) {
    return `${repo}::${issueUrl}`;
  }
  if (repo && opportunity) {
    return `${repo}::${opportunity}`;
  }

  return '';
}

function isLocalId(id) {
  return String(id || '').startsWith('local-');
}

function deduplicateRecords(records) {
  const seen = new Set();
  const result = [];

  for (const record of records) {
    const key = recordKey(record);
    const id = record.id || '';
    const dedupeKey = key || id;
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(record);
  }

  return result;
}

function sortRecords(records) {
  return records.sort((a, b) => {
    const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCmp !== 0) return dateCmp;
    const updatedCmp = String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || ''));
    if (updatedCmp !== 0) return updatedCmp;
    return String(a.opportunity || '').localeCompare(String(b.opportunity || ''));
  });
}

// ─── Update shaping ───────────────────────────────────────────────────────────

function toFields(updates, options = {}) {
  const fields = {};
  if (updates.status !== undefined) fields.Status = updates.status;
  if (updates.priority !== undefined) fields.Priority = updates.priority;
  if (updates.owner !== undefined) fields.Owner = updates.owner;
  if (updates.dueDate !== undefined) fields['Due Date'] = updates.dueDate;
  if (updates.prUrl !== undefined) fields['PR URL'] = updates.prUrl;
  if (updates.nextStep !== undefined) fields['Next Step'] = updates.nextStep;
  if (updates.activityLog !== undefined) fields['Activity Log'] = updates.activityLog;
  if (updates.quickPlan !== undefined) fields['Quick Plan'] = updates.quickPlan;
  if (updates.issueUpdatedAt !== undefined) fields['Issue Updated At'] = updates.issueUpdatedAt;
  if (updates.analysis !== undefined) {
    const result = updates.analysis;
    const a = result && result.analysis ? result.analysis : null;
    fields.Analysis = result ? JSON.stringify(result) : '';
    if (a) {
      fields['Maintainer Wants'] = a.maintainerWants || '';
      fields['Files To Change'] = formatFiles(a.filesToChange);
      fields['Open Questions'] = (a.openQuestions || []).join('\n');
      if (a.codeSkeleton) fields['Code Skeleton'] = a.codeSkeleton;
      if (a.validation) fields['Clarity Tip'] = a.validation;
      if (a.impact) fields.Impact = a.impact;
    }
  }
  // Bot bookkeeping (baselines, upstream notes) must not look like the user
  // touched the record, or stale detection would never fire.
  if (options.touch !== false) fields['Last Updated'] = new Date().toISOString();
  return fields;
}

function appendActivity(existing, line) {
  const current = String(existing || '').trim();
  const addition = String(line || '').trim();
  if (!addition) return current;
  return current ? `${current}\n${addition}` : addition;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

async function fetchAllRows() {
  return db.query(`SELECT id, ${ALL_COLUMNS.join(', ')} FROM opportunities`);
}

async function listOpportunities() {
  const localRows = await readLocalRecords();
  const localRecords = localRows.map(row => normalizeRecord(row.id, row));

  if (isAirtableConfigured()) {
    try {
      const rows = await fetchAllRows();
      const cloudRecords = rows.map(recordFromRow);
      const merged = sortRecords(deduplicateRecords([
        ...cloudRecords,
        ...localRecords.filter(row => isLocalId(row.id)),
      ]));
      await syncLocalRecords(merged.map(fileRowFromRecord)).catch(() => {});
      return {
        opportunities: merged,
        storage: 'postgres',
      };
    } catch (error) {
      if (!db.isNetworkError(error)) throw error;
      console.warn(`  Database unavailable, using local store: ${error.message}`);
    }
  }

  return {
    opportunities: sortRecords(localRecords),
    storage: 'local',
  };
}

// Raw records plus the seen-map, loaded once per scan.
async function loadTrackedRecords() {
  const { opportunities } = await listOpportunities();
  return { records: opportunities, seen: buildSeenMap(opportunities) };
}

// Everything we have ever recommended, keyed by issue URL.
async function loadSeenIssues() {
  const { opportunities } = await listOpportunities();
  return buildSeenMap(opportunities);
}

async function filterUnchangedDigest(digest, seenMap = null) {
  const seen = seenMap || await loadSeenIssues().catch(() => new Map());

  const contestDigest = (digest.contest_digest || []).filter(item => {
    const issueUrl = String(item.issue_url || '').trim().toLowerCase();
    if (!issueUrl || !seen.has(issueUrl)) return true;
    const previousUpdatedAt = seen.get(issueUrl).issueUpdatedAt;
    const currentUpdatedAt = String(item.issue_updated_at || '').trim();
    // No stored baseline means we cannot claim it changed.
    return Boolean(currentUpdatedAt && previousUpdatedAt && previousUpdatedAt !== currentUpdatedAt);
  });

  return {
    ...digest,
    contest_digest: contestDigest,
    deduped_opportunities: (digest.contest_digest || []).length - contestDigest.length,
  };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

async function updateOpportunity(id, updates, options = {}) {
  const fields = toFields(updates, options);
  const applyLocally = () => serializeLocalWrite(async () => {
    const rows = await readLocalRecords();
    const idx = rows.findIndex(row => row.id === id);
    if (idx === -1) {
      throw new Error(`Opportunity not found: ${id}`);
    }

    rows[idx] = { ...rows[idx], ...fields };
    await writeLocalRecords(rows);
    return normalizeRecord(rows[idx].id, rows[idx]);
  });

  if (isLocalId(id)) {
    return applyLocally();
  }

  if (isAirtableConfigured()) {
    try {
      const assignments = [];
      const params = [];
      for (const [fileKey, value] of Object.entries(fields)) {
        const column = COLUMN_BY_FILE_KEY.get(fileKey);
        if (!column) continue;
        params.push(value);
        assignments.push(`${column} = $${params.length}`);
      }
      if (!assignments.length) {
        const existing = await db.query('SELECT * FROM opportunities WHERE id = $1', [id]);
        if (!existing.length) throw new Error(`Opportunity not found: ${id}`);
        return recordFromRow(existing[0]);
      }
      params.push(id);
      const rows = await db.query(
        `UPDATE opportunities SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (!rows.length) throw new Error(`Opportunity not found: ${id}`);
      return recordFromRow(rows[0]);
    } catch (error) {
      if (!db.isNetworkError(error)) throw error;
      console.warn(`  Database update fallback for ${id}: ${error.message}`);
    }
  }

  return applyLocally();
}

// Apply follow-up changes to records we already track: new upstream activity,
// closure, or a claim. Each entry: { recordId, activityLog, line, status?, issueUpdatedAt?, prUrl?, owner?, touch? }.
async function recordIssueEvents(events = []) {
  let applied = 0;
  for (const event of events) {
    if (!event || !event.recordId) continue;
    const updates = {};
    if (event.status) updates.status = event.status;
    if (event.issueUpdatedAt) updates.issueUpdatedAt = event.issueUpdatedAt;
    if (event.prUrl) updates.prUrl = event.prUrl;
    if (event.owner) updates.owner = event.owner;
    if (event.line) updates.activityLog = appendActivity(event.activityLog, event.line);
    if (!Object.keys(updates).length) continue;
    try {
      await updateOpportunity(event.recordId, updates, { touch: event.touch !== false });
      applied += 1;
    } catch (error) {
      console.warn(`  Could not update ${event.recordId}: ${error.message}`);
    }
  }
  return applied;
}

// Priority blends impact (what it is worth) with effort (what it costs).
// Without an impact signal it degrades to the old effort-only rule.
function derivePriority(item) {
  const rank = { low: 0, medium: 1, high: 2 };
  const effort = rank[String(item.effort || 'medium').toLowerCase()] ?? 1;
  const impact = rank[String(item.impact || '').toLowerCase()];
  if (impact === undefined) {
    if (effort === 0) return 'High';
    if (effort === 1) return 'Medium';
    return 'Low';
  }
  const score = impact * 2 - effort;
  if (score >= 2) return 'High';
  if (score >= 0) return 'Medium';
  return 'Low';
}

async function saveDigest(digest) {
  const createdAt = new Date().toISOString();
  if (!(digest.contest_digest || []).length) {
    console.log('  Nothing new to save');
    return [];
  }
  const records = digest.contest_digest.map(item => ({
    Date: digest.date,
    Opportunity: item.opportunity,
    Repo: item.repo || '',
    'Why It Qualifies': item.why_it_qualifies,
    'Suggested Action': item.suggested_action,
    'Clarity Tip': item.clarity_tip || '',
    'Issue URL': item.issue_url || '',
    'Code Skeleton': item.code_skeleton || '',
    'Why It Matters': item.why_it_matters,
    Source: item.source || '',
    'Source URL': item.source_url || '',
    'Issue Updated At': item.issue_updated_at || '',
    Score: item.score || 0,
    Effort: item.effort || 'medium',
    Priority: derivePriority(item),
    Status: 'New',
    'Quick Plan': item.quick_plan || digest.quick_plan,
    'Last Updated': createdAt,
    ...(item.impact ? { Impact: item.impact } : {}),
    ...(item.labels && item.labels.length ? { Labels: [].concat(item.labels).join(', ') } : {}),
    ...(item.language ? { Language: item.language } : {}),
    ...(item.maintainer_wants ? { 'Maintainer Wants': item.maintainer_wants } : {}),
    ...(item.files_to_change && item.files_to_change.length ? { 'Files To Change': formatFiles(item.files_to_change) } : {}),
    ...(item.open_questions && item.open_questions.length ? { 'Open Questions': item.open_questions.join('\n') } : {}),
    ...(item.analysis ? { Analysis: JSON.stringify(item.analysis) } : {}),
  }));
  const localSeed = Date.now();
  const localRecords = records.map((fields, index) => ({
    id: `local-${localSeed}-${index}`,
    ...fields,
  }));

  const describe = rows => rows.map(row => ({ id: row.id, issueUrl: row['Issue URL'] || '' }));

  if (!isAirtableConfigured()) {
    await prependLocalRecords(localRecords);
    console.log(`  Saved ${localRecords.length} opportunities to local store`);
    return describe(localRecords);
  }

  try {
    // One multi-row INSERT for the whole digest.
    const columns = ['id', ...ALL_COLUMNS];
    const params = [];
    const tuples = records.map(fields => {
      const values = [newId()];
      for (const [, fileKey] of FIELDS) {
        values.push(fields[fileKey] !== undefined ? fields[fileKey] : null);
      }
      const placeholders = values.map(value => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const rows = await db.query(
      `INSERT INTO opportunities (${columns.join(', ')}) VALUES ${tuples.join(', ')} RETURNING id, issue_url`,
      params,
    );

    // Mirror the stored ids locally so the snapshot and the buttons agree.
    const mirrored = rows.map((row, index) => ({ ...localRecords[index], id: row.id }));
    await prependLocalRecords(mirrored.length ? mirrored : localRecords);
    console.log(`  Saved ${rows.length} opportunities to the database`);
    return rows.map(row => ({ id: row.id, issueUrl: row.issue_url || '' }));
  } catch (error) {
    if (!db.isNetworkError(error)) throw error;
    console.warn(`  Database save fallback: ${error.message}`);
    await prependLocalRecords(localRecords);
    console.log(`  Saved ${localRecords.length} opportunities to local store`);
    return describe(localRecords);
  }
}

// Delete rows by id (used by the dedupe script). Local mirror is pruned too so
// the dashboard does not resurrect them.
async function deleteOpportunities(ids = []) {
  if (!ids.length) return 0;
  let removed = 0;
  if (isAirtableConfigured()) {
    const rows = await db.query('DELETE FROM opportunities WHERE id = ANY($1) RETURNING id', [ids]);
    removed = rows.length;
  }
  await serializeLocalWrite(async () => {
    const rows = await readLocalRecords();
    const drop = new Set(ids);
    await writeLocalRecords(rows.filter(row => !drop.has(row.id)));
  });
  return removed || ids.length;
}

// Every raw row (no dedupe), for maintenance scripts.
async function listRawOpportunities() {
  if (!isAirtableConfigured()) {
    const rows = await readLocalRecords();
    return rows.map(row => normalizeRecord(row.id, row));
  }
  const rows = await fetchAllRows();
  return rows.map(recordFromRow);
}

module.exports = {
  derivePriority,
  deleteOpportunities,
  listRawOpportunities,
  saveDigest,
  filterUnchangedDigest,
  loadSeenIssues,
  loadTrackedRecords,
  recordIssueEvents,
  listOpportunities,
  updateOpportunity,
  isAirtableConfigured,
};
