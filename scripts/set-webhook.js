'use strict';
// Register (or remove) the Telegram webhook so incoming messages are delivered
// to /api/telegram instead of being long-polled.
//
//   node scripts/set-webhook.js                       → register using PUBLIC_BASE_URL
//   node scripts/set-webhook.js https://app.vercel.app → register using an explicit URL
//   node scripts/set-webhook.js --keep-pending        → also deliver the queued backlog
//   node scripts/set-webhook.js --delete              → remove the webhook (back to polling)
//   node scripts/set-webhook.js --info                → show current webhook status
const { setTelegramCommands } = require('../src/whatsapp');
const { listBots } = require('../src/bots');

const bots = listBots();

function api(token, method, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((res) => res.json());
}

async function describe(bot) {
  const me = await api(bot.token, 'getMe');
  return me.ok && me.result ? `@${me.result.username}` : `bot ${bot.botId}`;
}

async function main() {
  if (!bots.length) {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }

  const arg = process.argv[2];

  if (arg === '--info') {
    for (const bot of bots) {
      const info = await api(bot.token, 'getWebhookInfo');
      console.log(`\n=== ${await describe(bot)} (botId ${bot.botId}) ===`);
      console.log(JSON.stringify(info.result || info, null, 2));
    }
    return;
  }

  if (arg === '--delete') {
    for (const bot of bots) {
      const result = await api(bot.token, 'deleteWebhook', { drop_pending_updates: false });
      console.log(
        `${await describe(bot)}: ${result.ok ? 'webhook removed' : JSON.stringify(result)}`,
      );
    }
    console.log('\nYou can now use long-polling (node agent.js --bot).');
    return;
  }

  // By default the queued backlog is dropped, so stale commands (a /scan from
  // two days ago) don't all fire the moment the bot goes live. --keep-pending
  // delivers it instead, which is how you rescue people who messaged the bot
  // while it was down — Telegram keeps undelivered updates for about 24 hours.
  const keepPending = process.argv.includes('--keep-pending');
  const urlArg = process.argv.slice(2).find((value) => !value.startsWith('--'));
  const baseUrl = (urlArg || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) {
    console.error('Provide the deployment URL as an argument or set PUBLIC_BASE_URL.');
    console.error('  node scripts/set-webhook.js https://your-app.vercel.app');
    process.exit(1);
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('Warning: TELEGRAM_WEBHOOK_SECRET is not set — the endpoint will accept unsigned requests.');
  }

  // Every bot gets its own URL so the webhook knows which one to reply through.
  let failed = false;
  for (const bot of bots) {
    const webhookUrl = `${baseUrl}/api/telegram?bot=${bot.botId}`;
    const result = await api(bot.token, 'setWebhook', {
      url: webhookUrl,
      secret_token: secret || undefined,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: !keepPending,
    });

    const label = await describe(bot);
    if (!result.ok) {
      console.error(`${label}: failed to set webhook —`, result.description || result);
      failed = true;
      continue;
    }

    await setTelegramCommands(bot.token);
    console.log(`${label} → ${webhookUrl}`);
  }

  if (failed) process.exit(1);
  console.log('\nCommand menus registered. Send /start to each bot to test.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
