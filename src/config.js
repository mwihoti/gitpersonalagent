'use strict';
require('dotenv').config();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

module.exports = {
  github: {
    token: process.env.GITHUB_TOKEN || '',
    repos: (process.env.GITHUB_REPOS || 'stacks-network/stacks-core,stacks-network/rendezvous,stx-labs/connect,stx-labs/clarinet,stx-labs/token-metadata-api')
      .split(',').map(r => r.trim()).filter(Boolean),
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'gemma3:12b',
  },
  airtable: {
    apiKey: process.env.AIRTABLE_API_KEY || '',
    baseId: process.env.AIRTABLE_BASE_ID || '',
    tableName: process.env.AIRTABLE_TABLE_NAME || 'Contest Opportunities',
  },
  whatsapp: {
    phone: process.env.WHATSAPP_PHONE || '',
    apiKey: process.env.WHATSAPP_APIKEY || '',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  dashboard: {
    apiKey: process.env.DAN_AGENT_API_KEY || '',
  },
  schedule: process.env.SCAN_SCHEDULE || '0 8 * * *',
};
