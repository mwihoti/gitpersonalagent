'use strict';
const cron = require('node-cron');
const { runScan } = require('./src/run-scan');
const { listenForCommands } = require('./src/whatsapp');
const config = require('./src/config');

async function run(options = {}) {
  try {
    return await runScan(options);
  } catch (err) {
    console.error('\nAgent error:', err.message);
    process.exitCode = 1;
  }
}

// CLI: node agent.js [--scan | --schedule]
const arg = process.argv[2];

if (!arg || arg === '--scan') {
  run().then(() => {
    if (!arg) process.exit(0);
  });
} else if (arg === '--schedule') {
  const schedule = config.schedule;
  console.log(`Scheduling agent with cron: "${schedule}"`);
  console.log('Running initial scan now...\n');

  run();

  cron.schedule(schedule, () => {
    run();
  }, { timezone: 'Africa/Nairobi' });

  console.log('\nAgent running. Press Ctrl+C to stop.');
} else if (arg === '--bot') {
  // Runs the cron schedule AND listens for /scan commands from Telegram.
  // Use this mode when deploying to Railway/Render/VPS.
  const schedule = config.schedule;
  console.log(`Bot mode: cron="${schedule}", Telegram commands enabled`);
  console.log('Running initial scan now...\n');

  run();

  cron.schedule(schedule, () => {
    run();
  }, { timezone: 'Africa/Nairobi' });

  listenForCommands(run);  // non-blocking — loops internally
} else {
  console.error(`Unknown argument: ${arg}`);
  console.error('Usage: node agent.js [--scan | --schedule | --bot]');
  process.exit(1);
}
