'use strict';
require('dotenv').config();

// `npm run setup`                  fields for the opportunities table
// `npm run setup -- --subscribers` fields for the Subscribers table, including
//                                  the Profile column personal matching needs
const SUBSCRIBERS = process.argv.includes('--subscribers');
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_REF = SUBSCRIBERS
  ? (process.env.AIRTABLE_SUBSCRIBERS_TABLE || 'Subscribers')
  : process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_API_KEY;
let TABLE_ID = TABLE_REF;

if (!BASE_ID || !TABLE_REF || !TOKEN) {
  console.error('Missing AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, or AIRTABLE_API_KEY in .env');
  process.exit(1);
}

const SUBSCRIBER_FIELDS = [
  { name: 'ChatId',        type: 'singleLineText' },
  { name: 'BotId',         type: 'singleLineText' },
  { name: 'Type',          type: 'singleLineText' },
  { name: 'Title',         type: 'singleLineText' },
  { name: 'Username',      type: 'singleLineText' },
  { name: 'First Name',    type: 'singleLineText' },
  { name: 'Last Name',     type: 'singleLineText' },
  { name: 'Subscribed At', type: 'singleLineText' },
  { name: 'Last Seen At',  type: 'singleLineText' },
  { name: 'Profile',       type: 'multilineText' },
];

const OPPORTUNITY_FIELDS = [
  { name: 'Opportunity',       type: 'singleLineText' },
  { name: 'Date',              type: 'date',           options: { dateFormat: { name: 'iso' } } },
  { name: 'Repo',              type: 'singleLineText' },
  { name: 'Effort',            type: 'singleSelect',   options: { choices: [{ name: 'low' }, { name: 'medium' }, { name: 'high' }] } },
  { name: 'Status',            type: 'singleSelect',   options: { choices: [{ name: 'New' }, { name: 'In Progress' }, { name: 'Done' }] } },
  { name: 'Priority',          type: 'singleSelect',   options: { choices: [{ name: 'High' }, { name: 'Medium' }, { name: 'Low' }] } },
  { name: 'Owner',             type: 'singleLineText' },
  { name: 'Due Date',          type: 'date',           options: { dateFormat: { name: 'iso' } } },
  { name: 'Why It Qualifies',  type: 'multilineText' },
  { name: 'Suggested Action',  type: 'multilineText' },
  { name: 'Clarity Tip',       type: 'multilineText' },
  { name: 'Why It Matters',    type: 'multilineText' },
  { name: 'Quick Plan',        type: 'multilineText' },
  { name: 'Issue URL',         type: 'url' },
  { name: 'PR URL',            type: 'url' },
  { name: 'Next Step',         type: 'multilineText' },
  { name: 'Activity Log',      type: 'multilineText' },
  {
    name: 'Last Updated',
    type: 'dateTime',
    options: {
      dateFormat: { name: 'iso' },
      timeFormat: { name: '24hour' },
      timeZone: 'utc',
    },
  },
  { name: 'Code Skeleton',     type: 'multilineText' },
  // Tracking + deep analysis (added later; all optional)
  { name: 'Source',            type: 'singleLineText' },
  { name: 'Source URL',        type: 'url' },
  { name: 'Issue Updated At',  type: 'singleLineText' },
  { name: 'Score',             type: 'number',         options: { precision: 0 } },
  { name: 'Impact',            type: 'singleSelect',   options: { choices: [{ name: 'low' }, { name: 'medium' }, { name: 'high' }] } },
  { name: 'Maintainer Wants',  type: 'multilineText' },
  { name: 'Files To Change',   type: 'multilineText' },
  { name: 'Open Questions',    type: 'multilineText' },
  { name: 'Analysis',          type: 'multilineText' },
  { name: 'Labels',            type: 'singleLineText' },
  { name: 'Language',          type: 'singleLineText' },
];

const FIELDS = SUBSCRIBERS ? SUBSCRIBER_FIELDS : OPPORTUNITY_FIELDS;

// The fields endpoint wants a table id; accept a name too.
async function resolveTableId() {
  if (/^tbl[A-Za-z0-9]{10,}$/.test(TABLE_REF)) return TABLE_REF;
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Could not list tables (${res.status}). The token needs schema.bases:read.`);
  const table = ((await res.json()).tables || []).find(entry => entry.name === TABLE_REF || entry.id === TABLE_REF);
  if (!table) throw new Error(`No table named "${TABLE_REF}" in this base. Create it (or set AIRTABLE_SUBSCRIBERS_TABLE) and run again.`);
  return table.id;
}

async function createField(field) {
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables/${TABLE_ID}/fields`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(field),
    }
  );

  const data = await res.json();

  if (res.ok) {
    console.log(`  ✓ Created: ${field.name}`);
  } else if (
    data.error?.type === 'DUPLICATE_FIELD_NAME' ||
    data.error?.type === 'DUPLICATE_OR_EMPTY_FIELD_NAME' ||
    data.error?.message?.includes('already exists')
  ) {
    console.log(`  ~ Skipped (exists): ${field.name}`);
  } else if (res.status === 403) {
    console.error('\n  Permission denied. Update your Airtable token:');
    console.error('  → airtable.com/create/tokens → edit token → add scope: schema.bases:write');
    process.exit(1);
  } else {
    console.error(`  ✗ Failed ${field.name}: ${JSON.stringify(data.error || data)}`);
  }
}

async function run() {
  console.log(`Setting up Airtable table: ${TABLE_REF} in base: ${BASE_ID}\n`);

  // Quick connectivity check
  try {
    const ping = await fetch('https://api.airtable.com/v0/meta/whoami', {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!ping.ok) throw new Error(`Auth failed: ${ping.status}`);
  } catch (e) {
    console.error(`\nCannot reach Airtable API: ${e.message}`);
    console.error('\nAlternative: create fields manually in Airtable UI:');
    FIELDS.forEach(f => console.error(`  + ${f.name} (${f.type})`));
    process.exit(1);
  }

  TABLE_ID = await resolveTableId();
  for (const field of FIELDS) {
    await createField(field);
  }
  console.log(SUBSCRIBERS
    ? '\nDone! Subscribers can now save their GitHub profile and skills.'
    : '\nDone! Run `npm run scan` to test the full pipeline.');
}

run().catch(e => { console.error(e.message); process.exit(1); });
