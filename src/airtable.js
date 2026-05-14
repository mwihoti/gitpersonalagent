'use strict';
const Airtable = require('airtable');
const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

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
    if (!field) continue;

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
    lastUpdated: fields['Last Updated'] || '',
  };
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
  return [
    record.Date || record.date || '',
    record.Repo || record.repo || '',
    record.Opportunity || record.opportunity || '',
    record['Issue URL'] || record.issueUrl || '',
  ].join('::');
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
  if (updates.dueDate) fields['Due Date'] = updates.dueDate;
  if (updates.prUrl) fields['PR URL'] = updates.prUrl;
  if (updates.nextStep !== undefined) fields['Next Step'] = updates.nextStep;
  if (updates.activityLog !== undefined) fields['Activity Log'] = updates.activityLog;
  if (updates.quickPlan !== undefined) fields['Quick Plan'] = updates.quickPlan;
  fields['Last Updated'] = new Date().toISOString();
  return fields;
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
        'Last Updated': item.lastUpdated,
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

function derivePriority(item) {
  if (item.effort === 'low') return 'High';
  if (item.effort === 'medium') return 'Medium';
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
    Effort: item.effort || 'medium',
    Priority: derivePriority(item),
    Status: 'New',
    'Quick Plan': digest.quick_plan,
    'Last Updated': createdAt,
  }));
  const localSeed = Date.now();
  const localRecords = records.map((fields, index) => ({
    id: `local-${localSeed}-${index}`,
    ...fields,
  }));

  if (!isAirtableConfigured()) {
    await prependLocalRecords(localRecords);
    console.log(`  Saved ${localRecords.length} opportunities to local store`);
    return;
  }

  try {
    const table = getBase()(config.airtable.tableName);
    const normalizedRecords = await Promise.all(records.map(fields => normalizeFieldsForAirtable(fields)));
    const airtableRecords = normalizedRecords.map(fields => ({
      fields,
    }));

    // Airtable max 10 records per create call
    for (let i = 0; i < airtableRecords.length; i += 10) {
      await table.create(airtableRecords.slice(i, i + 10));
    }

    await prependLocalRecords(localRecords);
    console.log(`  Saved ${airtableRecords.length} opportunities to Airtable`);
  } catch (error) {
    if (!shouldFallbackToLocal(error) && !shouldFallbackForSchema(error)) throw error;
    console.warn(`  Airtable save fallback: ${error.message}`);
    await prependLocalRecords(localRecords);
    console.log(`  Saved ${localRecords.length} opportunities to local store`);
  }
}

module.exports = {
  saveDigest,
  listOpportunities,
  updateOpportunity,
  isAirtableConfigured,
};
