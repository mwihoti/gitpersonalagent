'use strict';
const Airtable = require('airtable');
const fs = require('fs/promises');
const path = require('path');
const config = require('./config');
const { buildSeenMap } = require('./issue-tracking');

let base = null;
let tableSchemaPromise = null;
let localWriteQueue = Promise.resolve();
const LOCAL_DATA_DIR = process.env.DAN_AGENT_DATA_DIR || (process.env.VERCEL
  ? path.join('/tmp', 'danagent-data')
  : path.join(__dirname, '..', 'data'));
const LOCAL_DATA_FILE = path.join(LOCAL_DATA_DIR, 'opportunities.json');

function isAirtableConfigured() {
  return Boolean(config.airtable.apiKey && config.airtable.baseId);
}

function shouldFallbackToLocal(error) {
  const code = error && typeof error === 'object' ? error.code : '';
  return ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(code);
}

function shouldFallbackForSchema(error) {
  const message = String(error && error.message ? error.message : '');
  return message.includes('Unknown field name') || message.includes('Insufficient permissions to create new select option');
}

function getBase() {
  if (!base) {
    if (!isAirtableConfigured()) {
      throw new Error('Airtable not configured — set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env');
    }
    Airtable.configure({ apiKey: config.airtable.apiKey });
    base = new Airtable().base(config.airtable.baseId);
  }
  return base;
}

async function getTableSchema() {
  if (!isAirtableConfigured()) return null;
  if (!tableSchemaPromise) {
    tableSchemaPromise = fetch(`https://api.airtable.com/v0/meta/bases/${config.airtable.baseId}/tables`, {
      headers: { Authorization: `Bearer ${config.airtable.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    }).then(async res => {
      if (!res.ok) {
        throw new Error(`Failed to fetch Airtable schema: ${res.status}`);
      }
      const data = await res.json();
      const table = (data.tables || []).find(entry =>
        entry.id === config.airtable.tableName || entry.name === config.airtable.tableName
      );
      if (!table) {
        throw new Error(`Airtable table not found in schema: ${config.airtable.tableName}`);
      }
      return table;
    }).catch(error => {
      tableSchemaPromise = null;
      throw error;
    });
  }
  return tableSchemaPromise;
}

function normalizeChoiceValue(value, choices) {
  if (!value || !Array.isArray(choices) || choices.length === 0) return value;

  const exact = choices.find(choice => choice.name === value);
  if (exact) return exact.name;

  const normalized = String(value).trim().toLowerCase();
  const caseInsensitive = choices.find(choice => String(choice.name).trim().toLowerCase() === normalized);
  if (caseInsensitive) return caseInsensitive.name;

  const synonyms = {
    new: ['new', 'todo', 'to do', 'backlog', 'queued'],
    'in progress': ['in progress', 'active', 'doing', 'working'],
    done: ['done', 'complete', 'completed', 'shipped', 'closed'],
    high: ['high', 'urgent', 'p1'],
    medium: ['medium', 'normal', 'p2'],
    low: ['low', 'later', 'p3'],
  };

  const candidates = synonyms[normalized] || [normalized];
  const synonymMatch = choices.find(choice => candidates.includes(String(choice.name).trim().toLowerCase()));
  return synonymMatch ? synonymMatch.name : null;
}

async function normalizeFieldsForAirtable(fields) {
  const schema = await getTableSchema();
  if (!schema) return fields;

  const fieldMap = new Map((schema.fields || []).map(field => [field.name, field]));
  const normalized = { ...fields };

  for (const [name, value] of Object.entries(fields)) {
    const field = fieldMap.get(name);
    if (!field) {
      delete normalized[name];
      continue;
    }

    if ((field.type === 'singleSelect' || field.type === 'multipleSelects') && value) {
      const mapped = normalizeChoiceValue(value, field.options?.choices || []);
      if (mapped) {
        normalized[name] = mapped;
      } else {
        delete normalized[name];
      }
    }
  }

  return normalized;
}

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

function toFields(updates) {
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
  fields['Last Updated'] = new Date().toISOString();
  return fields;
}

function appendActivity(existing, line) {
  const current = String(existing || '').trim();
  const addition = String(line || '').trim();
  if (!addition) return current;
  return current ? `${current}\n${addition}` : addition;
}

async function listOpportunities() {
  const localRows = await readLocalRecords();
  const localRecords = localRows.map(row => normalizeRecord(row.id, row));

  if (isAirtableConfigured()) {
    try {
      const table = getBase()(config.airtable.tableName);
      const rows = await table.select({
        sort: [{ field: 'Date', direction: 'desc' }],
        pageSize: 100,
      }).all();
      const airtableRecords = rows.map(row => normalizeRecord(row.id, row.fields));
      const merged = sortRecords(deduplicateRecords([
        ...airtableRecords,
        ...localRecords.filter(row => isLocalId(row.id)),
      ]));
      const snapshot = merged.map(item => ({
        id: item.id,
        Date: item.date,
        Opportunity: item.opportunity,
        Repo: item.repo,
        Effort: item.effort,
        Status: item.status,
        Priority: item.priority,
        Owner: item.owner,
        'Due Date': item.dueDate,
        'Issue URL': item.issueUrl,
        'PR URL': item.prUrl,
        'Suggested Action': item.suggestedAction,
        'Next Step': item.nextStep,
        'Activity Log': item.activityLog,
        'Quick Plan': item.quickPlan,
        'Why It Qualifies': item.whyItQualifies,
        'Why It Matters': item.whyItMatters,
        'Clarity Tip': item.clarityTip,
        'Code Skeleton': item.codeSkeleton,
        Source: item.source,
        'Source URL': item.sourceUrl,
        'Issue Updated At': item.issueUpdatedAt,
        Score: item.score,
        'Last Updated': item.lastUpdated,
        Impact: item.impact,
        Labels: item.labels,
        Language: item.language,
        'Maintainer Wants': item.maintainerWants,
        'Files To Change': item.filesToChange,
        'Open Questions': item.openQuestions,
        Analysis: item.analysis ? JSON.stringify(item.analysis) : '',
      }));
      await syncLocalRecords(snapshot);
      return {
        opportunities: merged,
        storage: 'airtable',
      };
    } catch (error) {
      if (!shouldFallbackToLocal(error)) throw error;
      console.warn(`  Airtable unavailable, using local store: ${error.code}`);
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

// Everything we have ever recommended, keyed by issue URL. Reads Airtable
// when configured (so it works on GitHub Actions and Vercel, where the local
// file is empty on every run) and falls back to the local store otherwise.
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
    return currentUpdatedAt && previousUpdatedAt !== currentUpdatedAt;
  });

  return {
    ...digest,
    contest_digest: contestDigest,
    deduped_opportunities: (digest.contest_digest || []).length - contestDigest.length,
  };
}

async function updateOpportunity(id, updates) {
  const fields = toFields(updates);
  const isLocalRecord = String(id).startsWith('local-');
  if (isLocalRecord) {
    return serializeLocalWrite(async () => {
      const rows = await readLocalRecords();
      const idx = rows.findIndex(row => row.id === id);
      if (idx === -1) {
        throw new Error(`Opportunity not found: ${id}`);
      }

      rows[idx] = { ...rows[idx], ...fields };
      await writeLocalRecords(rows);
      return normalizeRecord(rows[idx].id, rows[idx]);
    });
  }

  if (isAirtableConfigured()) {
    try {
      const table = getBase()(config.airtable.tableName);
      const normalizedFields = await normalizeFieldsForAirtable(fields);
      const updated = await table.update(id, normalizedFields);
      return normalizeRecord(updated.id, updated.fields);
    } catch (error) {
      if (!shouldFallbackToLocal(error) && !shouldFallbackForSchema(error)) throw error;
      console.warn(`  Airtable update fallback for ${id}: ${error.message}`);
    }
  }

  return serializeLocalWrite(async () => {
    const rows = await readLocalRecords();
    const idx = rows.findIndex(row => row.id === id);
    if (idx === -1) {
      throw new Error(`Opportunity not found: ${id}`);
    }

    rows[idx] = { ...rows[idx], ...fields };
    await writeLocalRecords(rows);
    return normalizeRecord(rows[idx].id, rows[idx]);
  });
}

// Apply follow-up changes to records we already track: new upstream activity,
// closure, or a claim. Each entry: { recordId, activityLog, line, status?, issueUpdatedAt? }.
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
      await updateOpportunity(event.recordId, updates);
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

/**
 * Save a digest result to Airtable.
 * Table columns expected:
 *   Date (date), Opportunity (text), Repo (text), Effort (single select),
 *   Why It Qualifies (long text), Suggested Action (long text),
 *   Clarity Tip (long text), Issue URL (url), Quick Plan (long text), Status (single select)
 */
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

  const describe = rows => rows.map(row => ({ id: row.id, issueUrl: row['Issue URL'] || row.fields?.['Issue URL'] || '' }));

  if (!isAirtableConfigured()) {
    await prependLocalRecords(localRecords);
    console.log(`  Saved ${localRecords.length} opportunities to local store`);
    return describe(localRecords);
  }

  try {
    const table = getBase()(config.airtable.tableName);
    const normalizedRecords = await Promise.all(records.map(fields => normalizeFieldsForAirtable(fields)));
    const airtableRecords = normalizedRecords.map(fields => ({
      fields,
    }));

    // Airtable max 10 records per create call
    const created = [];
    for (let i = 0; i < airtableRecords.length; i += 10) {
      const batch = await table.create(airtableRecords.slice(i, i + 10));
      created.push(...batch);
    }

    // Mirror Airtable ids locally so the snapshot and the buttons agree.
    const mirrored = created.map((row, index) => ({ ...localRecords[index], id: row.id }));
    await prependLocalRecords(mirrored.length ? mirrored : localRecords);
    console.log(`  Saved ${airtableRecords.length} opportunities to Airtable`);
    return created.map(row => ({ id: row.id, issueUrl: row.fields?.['Issue URL'] || row.get?.('Issue URL') || '' }));
  } catch (error) {
    if (!shouldFallbackToLocal(error) && !shouldFallbackForSchema(error)) throw error;
    console.warn(`  Airtable save fallback: ${error.message}`);
    await prependLocalRecords(localRecords);
    console.log(`  Saved ${localRecords.length} opportunities to local store`);
    return describe(localRecords);
  }
}

// Delete Airtable rows by id (used by the dedupe script). Local mirror is
// pruned too so the dashboard does not resurrect them.
async function deleteOpportunities(ids = []) {
  if (!ids.length) return 0;
  let removed = 0;
  if (isAirtableConfigured()) {
    const table = getBase()(config.airtable.tableName);
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      await table.destroy(batch);
      removed += batch.length;
    }
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
  const table = getBase()(config.airtable.tableName);
  const rows = await table.select({ pageSize: 100 }).all();
  return rows.map(row => normalizeRecord(row.id, row.fields));
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
