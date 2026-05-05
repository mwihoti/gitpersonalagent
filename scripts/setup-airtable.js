'use strict';
require('dotenv').config();

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_ID = process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_API_KEY;

if (!BASE_ID || !TABLE_ID || !TOKEN) {
  console.error('Missing AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, or AIRTABLE_API_KEY in .env');
  process.exit(1);
}

const FIELDS = [
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
];

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
  console.log(`Setting up Airtable table: ${TABLE_ID} in base: ${BASE_ID}\n`);

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

  for (const field of FIELDS) {
    await createField(field);
  }
  console.log('\nDone! Run `npm run scan` to test the full pipeline.');
}

run().catch(e => { console.error(e.message); process.exit(1); });
