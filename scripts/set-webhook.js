'use strict';
// Register (or remove) the Telegram webhook so incoming messages are delivered
// to /api/telegram instead of being long-polled.
//
//   node scripts/set-webhook.js                       → register using PUBLIC_BASE_URL
//   node scripts/set-webhook.js https://app.vercel.app → register using an explicit URL
//   node scripts/set-webhook.js --keep-pending        → also deliver the queued backlog
//   node scripts/set-webhook.js --delete              → remove the webhook (back to polling)
//   node scripts/set-webhook.js --info                → show current webhook status
//   node scripts/set-webhook.js <url> --force         → skip the env-mismatch guard
//
// If the tokens/secret live only in the host's sensitive env, let the
// deployment register itself:  curl -X POST <url>/api/setup-webhook
const { setTelegramCommands } = require('../src/whatsapp');
const { listBots } = require('../src/bots');
const { registerWebhooks } = require('../src/webhook-setup');

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

  // Guard against the classic foot-gun: registering from a machine whose .env
  // does not match the deployment. If the deployment expects a secret (or
  // serves more bots) and this shell has none, every update would be rejected
  // and the bot would go silent.
  if (!process.argv.includes('--force')) {
    try {
      const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) }).then((res) => res.json());
      const remote = health.config || {};
      const problems = [];
      if (remote.webhookSecret && !secret) {
        problems.push('the deployment has TELEGRAM_WEBHOOK_SECRET set, but this shell does not');
      }
      if (Number(remote.telegramBots) > bots.length) {
        problems.push(`the deployment serves ${remote.telegramBots} bots, but this shell only has ${bots.length} token(s)`);
      }
      if (problems.length) {
        console.error('Refusing to register: this environment does not match the deployment.');
        for (const problem of problems) console.error(`  - ${problem}`);
        console.error('\nLet the deployment register itself instead (it already has the right values):');
        console.error(`  curl -X POST ${baseUrl}/api/setup-webhook`);
        console.error('Add  -H "X-API-Key: <DAN_AGENT_API_KEY>"  if the dashboard key is set. Use --force to override.');
        process.exit(1);
      }
    } catch (error) {
      console.warn(`Could not compare with ${baseUrl}/api/health (${error.message}); continuing.`);
    }
  }

  if (!secret) {
    console.warn('Warning: TELEGRAM_WEBHOOK_SECRET is not set — the endpoint will accept unsigned requests.');
  }

  // Every bot gets its own URL so the webhook knows which one to reply through.
  const result = await registerWebhooks({ baseUrl, secret, keepPending, setCommands: setTelegramCommands });
  for (const item of result.bots) {
    if (item.ok) console.log(`${item.bot} → ${item.url}`);
    else console.error(`${item.bot}: failed to set webhook — ${item.error}`);
  }

  if (!result.ok) process.exit(1);
  console.log('\nCommand menus registered. Send /start to each bot to test.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
