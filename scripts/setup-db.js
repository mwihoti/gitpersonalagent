'use strict';
// Creates (or completes) the Postgres schema this app uses.
//
//   npm run setup
//
// Safe to run repeatedly: everything is IF NOT EXISTS, and columns added in
// later versions are appended to existing tables.
require('dotenv').config();
const db = require('../src/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS opportunities (
    id text PRIMARY KEY,
    date text, opportunity text, repo text, effort text, status text, priority text,
    owner text, due_date text, issue_url text, pr_url text,
    suggested_action text, next_step text, activity_log text, quick_plan text,
    why_it_qualifies text, why_it_matters text, clarity_tip text, code_skeleton text,
    source text, source_url text, issue_updated_at text,
    score double precision, impact text, maintainer_wants text, files_to_change text,
    open_questions text, analysis text, labels text, language text, last_updated text
  )`,
  `CREATE INDEX IF NOT EXISTS opportunities_issue_url ON opportunities (lower(issue_url))`,
  `CREATE TABLE IF NOT EXISTS subscribers (
    chat_id text NOT NULL,
    bot_id text NOT NULL DEFAULT '',
    type text, title text, username text, first_name text, last_name text,
    subscribed_at text, last_seen_at text, profile text,
    PRIMARY KEY (chat_id, bot_id)
  )`,
];

async function main() {
  if (!db.isConfigured()) {
    console.error('Set DATABASE_URL in .env (the connection string from your Neon project).');
    process.exit(1);
  }
  for (const statement of STATEMENTS) {
    await db.query(statement);
    console.log(`  ✓ ${statement.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 70)}…`);
  }
  const tables = await db.query(
    `SELECT table_name, (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name) AS columns
     FROM information_schema.tables t WHERE table_schema = 'public' ORDER BY table_name`,
  );
  for (const table of tables) console.log(`  table ${table.table_name}: ${table.columns} columns`);
  console.log('\nDone! The bot and the dashboard can now save.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
