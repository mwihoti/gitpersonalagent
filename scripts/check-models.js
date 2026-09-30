'use strict';
// Verifies every configured model provider and model with a one-line prompt.
//
//   npm run check-models              probe the configured chain
//   npm run check-models -- --list    also list every model your keys can use
//
// Exit code 1 when nothing works, so it can gate a deploy or a CI step.
require('dotenv').config();
const { describeProviders, listAvailableModels, probeModels } = require('../src/providers');

const NOT_CHAT = /whisper|tts|guard|embed|moderation|playai|speech|image|vision-preview|compound/i;

async function main() {
  const chain = describeProviders();
  if (!chain.length) {
    console.log('No cloud provider configured. Set GEMINI_API_KEY, GROQ_API_KEY, XAI_API_KEY, or FALLBACK_API_KEY.');
    console.log('Scans will use local Ollama, or the deterministic digest if Ollama is not running.');
    process.exit(1);
  }

  console.log('Provider chain (tried top to bottom):');
  for (const provider of chain) console.log(`  ${provider.label}: ${provider.models.join(' > ')}`);
  console.log('');

  const results = await probeModels();
  for (const r of results) {
    const mark = r.ok ? 'OK  ' : 'FAIL';
    console.log(`${mark} ${r.provider.padEnd(9)} ${r.model.padEnd(34)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.detail}`);
  }

  if (process.argv.includes('--list')) {
    console.log('\nModels available to your keys:');
    for (const entry of await listAvailableModels()) {
      if (entry.error) {
        console.log(`  ${entry.label}: could not list (${entry.error})`);
        continue;
      }
      const chat = entry.models.filter(id => !NOT_CHAT.test(id));
      console.log(`  ${entry.label} (${chat.length} chat models):`);
      for (const id of chat) console.log(`    ${id}`);
      console.log(`  → set ${entry.provider.toUpperCase()}_MODELS=first-choice,second-choice to change the order`);
    }
  }

  const working = results.filter(r => r.ok);
  const first = working[0];
  console.log('');
  if (first) {
    console.log(`${working.length} of ${results.length} models work. Scans will use ${first.provider} / ${first.model} first.`);
    if (working.length < 2) {
      console.log('Only one working model means no fallback. Run `npm run check-models -- --list` and add a second one.');
    }
  } else {
    console.log('No model answered. Scans will fall back to the deterministic digest.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
