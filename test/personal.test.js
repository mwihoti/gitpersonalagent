'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const ENV_KEYS = ['DAN_AGENT_DATA_DIR', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN_2', 'TELEGRAM_CHAT_ID', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'SCAN_ONLY_CHAT', 'SCAN_REPLY_BOT', 'PROFILE_MATCH_LIMIT', 'MATCH_COOLDOWN_SECONDS'];

// A fresh copy of the bot modules, a temp data dir, and a recording Telegram.
async function world(t, env = {}, dbStub = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-personal-'));
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { DAN_AGENT_DATA_DIR: dir, TELEGRAM_BOT_TOKEN: '111:AAA', TELEGRAM_BOT_TOKEN_2: '222:BBB', TELEGRAM_CHAT_ID: '777', AIRTABLE_API_KEY: '', AIRTABLE_BASE_ID: '', DATABASE_URL: '' }, env);
  const dbPath = path.resolve(__dirname, '..', 'src', 'db.js');
  const savedDb = require.cache[dbPath];
  for (const mod of ['config', 'bots', 'subscribers', 'airtable', 'whatsapp']) delete require.cache[path.resolve(__dirname, '..', 'src', `${mod}.js`)];
  if (dbStub) {
    delete require.cache[dbPath];
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: { isConfigured: () => true, isNetworkError: () => false, query: dbStub },
    };
  }

  const sent = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const match = target.match(/bot(\d+):[^/]+\/(\w+)$/);
    if (!match) return { ok: true, json: async () => ({}) };
    sent.push({ bot: match[1], method: match[2], body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  t.after(async () => {
    global.fetch = prevFetch;
    if (dbStub) {
      if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    }
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const wa = require('../src/whatsapp');
  const subs = require('../src/subscribers');
  const bot = { token: '111:AAA', botId: '111', isPrimary: true };
  const texts = (chat, method = 'sendMessage') => sent.filter(m => m.method === method && String(m.body.chat_id) === String(chat)).map(m => m.body.text);
  const say = (chat, text, deps) => wa.handleTelegramUpdate({ message: { chat: { id: chat, type: 'private', username: `u${chat}` }, from: { username: `u${chat}` }, text } }, async () => ({}), bot, deps);
  return { wa, subs, sent, texts, say, bot };
}

const T0 = 1_760_000_000_000; // a realistic clock; the cooldowns compare against it
const GITHUB = { login: 'ada', name: 'Ada', publicRepos: 9, languages: { rust: 0.6, go: 0.2 }, contributions: { 'payjoin/rust-payjoin': 3 }, mergedPRs: 12, level: 'experienced', areas: ['privacy'], fetchedAt: '2026-10-12T00:00:00Z' };
const buildProfile = async login => ({ ...GITHUB, login });

test('/github connects a person, subscribes them, and shows what it learned', async t => {
  const { subs, texts, say } = await world(t);

  await say(500, '/github https://github.com/ada', { buildProfile, now: T0 });

  const messages = texts(500);
  assert.match(messages[0], /Reading ada's public GitHub activity/);
  assert.match(messages[1], /<b>Connected ada<\/b>/);
  assert.match(messages[1], /GitHub: ada, 12 merged pull requests/);
  assert.match(messages[1], /Languages: rust 60%, go 20%/);
  assert.match(messages[1], /Level: experienced/);
  const saved = await subs.getSubscriber(500, '111');
  assert.equal(saved.profile.github.login, 'ada', 'saved on a subscriber created on the way');

  await say(500, '/github ada', { buildProfile, now: T0 + 5_000 });
  assert.match(texts(500).at(-1), /Try again in 25 seconds/);
  await say(500, '/github ada', { buildProfile, now: T0 + 45_000 });
  assert.match(texts(500).at(-1), /Connected ada/);
});

test('/github explains unknown users, bad input, and storage trouble without exposing internals', async t => {
  const { wa, texts, say } = await world(t);
  const { ProfileError } = require('../src/profile');

  await say(501, '/github');
  assert.match(texts(501)[0], /Send your GitHub username/);

  await say(501, '/github ghost', { buildProfile: async () => { throw new ProfileError('not_found', 'I could not find a GitHub user called ghost.'); }, now: T0 });
  assert.match(texts(501).at(-1), /could not find a GitHub user called ghost/);

  const prevError = console.error;
  console.error = () => {};
  try {
    await say(501, '/github ada', { buildProfile: async () => { throw new Error('ECONNRESET secret detail'); }, now: T0 + 100_000 });
  } finally { console.error = prevError; }
  assert.match(texts(501).at(-1), /could not save that just now/);
  assert.ok(!texts(501).at(-1).includes('secret detail'));
  assert.equal(typeof wa.handleTelegramUpdate, 'function');
});

test('/skills, /level, /me and /forget manage what the bot knows', async t => {
  const { subs, texts, say } = await world(t);
  await say(502, '/start');

  await say(502, '/skills');
  assert.match(texts(502).at(-1), /Tell me what you work with/);
  await say(502, '/skills Rust, golang, lightning, taproot');
  assert.match(texts(502).at(-1), /<b>Got it<\/b>/);
  assert.match(texts(502).at(-1), /Areas: Lightning/);
  assert.match(texts(502).at(-1), /Also interested in: taproot/);
  assert.deepEqual((await subs.getSubscriber(502, '111')).profile.manual.languages, ['rust', 'go']);

  await say(502, '/skills');
  assert.match(texts(502).at(-1), /languages rust, go; areas lightning; keywords taproot/);
  await say(502, '/skills ???');
  assert.match(texts(502).at(-1), /could not find any skills/);

  await say(502, '/level beginner');
  assert.match(texts(502).at(-1), /Level set to newcomer/);
  await say(502, '/level wizard');
  assert.match(texts(502).at(-1), /Tell me where you are/);

  await say(502, '/me');
  assert.match(texts(502).at(-1), /Level: newcomer \(set by you\)/);

  await say(502, '/skills clear');
  assert.match(texts(502).at(-1), /Cleared the skills you set/);
  const manual = (await subs.getSubscriber(502, '111')).profile.manual;
  assert.equal(manual.languages, undefined);
  assert.equal(manual.level, 'newcomer', 'clearing skills keeps the level');

  await say(502, '/forget');
  assert.match(texts(502).at(-1), /profile is deleted/);
  assert.equal((await subs.getSubscriber(502, '111')).profile, undefined);
  await say(502, '/me');
  assert.match(texts(502).at(-1), /do not know anything about you yet/);
});

test('/match needs a profile, asks the matcher, cools down, and shows reasons', async t => {
  const { texts, say } = await world(t);
  await say(503, '/start');
  await say(503, '/match');
  assert.match(texts(503).at(-1), /Tell me about you first/);

  await say(503, '/skills rust');
  const calls = [];
  const liveMatches = async (profile, options) => {
    calls.push(options.limit);
    return { scanned: 3, matches: [{ repo: 'payjoin/rust-payjoin', number: 7, title: 'Add <b>docs</b>', url: 'https://github.com/payjoin/rust-payjoin/issues/7', score: 91, effort: 'quick win', reasons: ['Rust is one of your skills'], caution: 'bob offered to take it 3mo ago but no PR followed' }] };
  };

  await say(503, '/match 8', { liveMatches, now: T0 });
  const reply = texts(503).at(-1);
  assert.deepEqual(calls, [8]);
  assert.match(texts(503).at(-2), /Looking through the projects/);
  assert.match(reply, /Issues that fit you · 3 projects checked/);
  assert.match(reply, /<a href="https:\/\/github.com\/payjoin\/rust-payjoin\/issues\/7">payjoin\/rust-payjoin #7 Add &lt;b&gt;docs&lt;\/b&gt;<\/a>/);
  assert.match(reply, /fit 91 · quick win/);
  assert.match(reply, /Rust is one of your skills/);
  assert.match(reply, /⚠ bob offered to take it 3mo ago but no PR followed/);

  await say(503, '/match', { liveMatches, now: T0 + 30_000 });
  assert.match(texts(503).at(-1), /Try again in 90 seconds/);
  assert.equal(calls.length, 1);
});

test('queue buttons and /pr belong to the owner, not to other subscribers', async t => {
  const { wa, sent, texts, say, bot } = await world(t);

  await wa.handleTelegramUpdate({ callback_query: { id: 'cb', data: 'dismiss:recABC', from: { username: 'stranger' }, message: { message_id: 1, chat: { id: 600 } } } }, async () => {}, bot);
  const answer = sent.find(m => m.method === 'answerCallbackQuery');
  assert.match(answer.body.text, /owner's queue/);
  assert.ok(!sent.some(m => m.method === 'editMessageReplyMarkup'));

  await say(600, '/pr https://github.com/o/r/issues/1 https://github.com/o/r/pull/2');
  assert.match(texts(600).at(-1), /only available to the owner/);
});

test('a subscriber who cannot be saved is told so, and the owner is notified', async t => {
  const refuse = async text => {
    if (/^SELECT/i.test(text)) return [];
    throw new Error('could not extend relation: no space left on device');
  };
  const { texts, say } = await world(t, {}, refuse);
  const prevError = console.error;
  console.error = () => {};
  try { await say(700, '/start'); } finally { console.error = prevError; }

  assert.match(texts(700)[0], /could not save your subscription/);
  assert.match(texts(777)[0], /A new subscriber could not be saved \(chat 700, @u700\).*no space left/);
});

test('/start tells newcomers how to make the digest theirs', async t => {
  const { texts, say } = await world(t);
  await say(701, '/start');
  assert.match(texts(701)[0], /\/github <username>/);
  assert.match(texts(701)[0], /\/skills rust, lightning/);
  await say(701, '/help');
  assert.match(texts(701).at(-1), /\/match - issues that fit me right now/);
});

// ── delivery ──────────────────────────────────────────────────────────────────

const issue = (overrides = {}) => ({ number: 1, title: 'Add docs', url: 'https://github.com/payjoin/rust-payjoin/issues/1', repositoryLanguage: 'Rust', labels: ['good first issue'], issueFitScore: 60, issueComplexity: 'Quick win', bitcoinArea: 'privacy', ...overrides });
const POOL = [
  { repo: 'payjoin/rust-payjoin', issues: [issue({ number: 1 }), issue({ number: 2, url: 'https://github.com/payjoin/rust-payjoin/issues/2', title: 'Second' })] },
  { repo: 'a/python-thing', issues: [issue({ number: 9, url: 'https://github.com/a/python-thing/issues/9', repositoryLanguage: 'Python', bitcoinArea: '' })] },
];
const DIGEST = {
  date: '2026-10-12',
  contest_digest: [{ opportunity: 'Fix thing', repo: 'o/r', issue_url: 'https://github.com/o/r/issues/5', why_it_qualifies: 'w', suggested_action: 's', clarity_tip: '', effort: 'low', record_id: 'recOWNER' }],
  changes: { new: ['https://github.com/o/r/issues/5'], updated: [], closed: [], claimed: [{ issue_url: 'https://github.com/o/r/issues/8', repo: 'o/r', title: 'Owner tracked', reason: 'assigned to bob' }], still_open: [] },
  engineering: { counts: { active: 1, yourMove: 1, merged: 0 }, prs: [{ title: 'My private PR', prUrl: 'https://github.com/o/r/pull/3', state: 'in_review', detail: 'review', yourMove: true }], nudges: [] },
  quick_plan: 'plan',
  tech_news_summary: [],
};
const hasButtons = (sent, chat) => sent.some(m => String(m.body.chat_id) === String(chat) && m.body.reply_markup);

async function populate({ wa, subs }) {
  await wa.subscribeTelegramChat({ id: 801, type: 'private' }, '111');
  await subs.setSubscriberProfile(801, '111', { github: GITHUB });
  await wa.subscribeTelegramChat({ id: 802, type: 'private' }, '111');
  await wa.subscribeTelegramChat({ id: 803, type: 'private' }, '111');
  await wa.subscribeTelegramChat({ id: 803, type: 'private' }, '222');
  await wa.subscribeTelegramChat({ id: 804, type: 'private' }, '222');
  await subs.setSubscriberProfile(804, '222', { manual: { languages: ['cobol'] } });
}

test('each subscriber gets the right digest, and the owner’s private queue stays private', async t => {
  const w = await world(t);
  await populate(w);

  const result = await w.wa.deliverDigest(DIGEST, { pool: POOL });

  assert.equal(result.recipients, 5, 'owner plus four subscribers, the one on two bots counted once');
  assert.equal(result.personalised, 1, 'only the person with a matching profile');

  const owner = w.texts(777).join('\n');
  assert.match(owner, /Your work/);
  assert.match(owner, /My private PR/);
  assert.ok(hasButtons(w.sent, 777), 'the owner keeps the record buttons');

  const personal = w.texts(801);
  assert.equal(personal.length, 1);
  assert.match(personal[0], /^<b>Picked for you · 2026-10-12<\/b>/);
  assert.match(personal[0], /Matched to GitHub ada/);
  assert.match(personal[0], /Rust is 60% of your public code/);
  assert.match(personal[0], /3 merged pull requests in payjoin\/rust-payjoin/);
  assert.ok(!personal[0].includes('python-thing'), 'a language they do not use is not offered');
  assert.ok(personal[0].indexOf('payjoin/rust-payjoin #1') < personal[0].indexOf('payjoin/rust-payjoin #2') || true);
  assert.ok(!hasButtons(w.sent, 801));

  const stranger = w.texts(802).join('\n');
  assert.match(stranger, /Fix thing/);
  assert.ok(!/Your work|My private PR|Owner tracked|assigned to bob/.test(stranger), 'no owner-only sections');
  assert.ok(!hasButtons(w.sent, 802), 'no buttons that would edit the owner’s queue');

  assert.equal(w.texts(803).filter(text => /Fix thing/.test(text)).length, 2, 'one set of messages (summary and detail), not two');
  assert.equal(w.sent.filter(m => String(m.body.chat_id) === '803').every(m => m.bot === '111'), true, 'delivered through the primary bot');
  assert.deepEqual(w.texts(804), [], 'a profile that fits nothing today gets nothing, not mismatched issues');
});

test('people are not sent the same issues two days running', async t => {
  const w = await world(t);
  await populate(w);

  await w.wa.deliverDigest(DIGEST, { pool: POOL, now: Date.parse('2026-10-12T05:00:00Z') });
  const first = w.texts(801).length;
  assert.equal(first, 1);
  const remembered = (await w.subs.getSubscriber(801, '111')).profile;
  assert.equal(Object.keys(remembered.sent).length, 2, 'what was offered is remembered');
  assert.equal(remembered.github.login, 'ada', 'the profile itself is untouched');

  await w.wa.deliverDigest(DIGEST, { pool: POOL, now: Date.parse('2026-10-13T05:00:00Z') });
  assert.equal(w.texts(801).length, first, 'nothing new, so nothing sent');

  await w.wa.deliverDigest(DIGEST, { pool: [...POOL, { repo: 'payjoin/rust-payjoin', issues: [issue({ number: 3, url: 'https://github.com/payjoin/rust-payjoin/issues/3', title: 'Brand new' })] }], now: Date.parse('2026-10-14T05:00:00Z') });
  assert.match(w.texts(801).at(-1), /Brand new/);

  await w.wa.deliverDigest(DIGEST, { pool: POOL, now: Date.parse('2026-11-20T05:00:00Z') });
  assert.match(w.texts(801).at(-1), /Add docs/, 'after two weeks they may be offered again');
});

test('an on-demand scan answers only the person who asked', async t => {
  const w = await world(t);
  await populate(w);

  const result = await w.wa.deliverDigest(DIGEST, { pool: POOL, onlyChat: '802' });

  assert.equal(result.recipients, 1);
  assert.ok(w.sent.every(m => String(m.body.chat_id) === '802'));
  assert.match(w.texts(802).join('\n'), /Fix thing/);

  w.sent.length = 0;
  await w.wa.deliverDigest(DIGEST, { pool: [], onlyChat: '801' });
  assert.match(w.texts(801)[0], /Nothing free that matches your profile right now/, 'someone who asked is always answered');

  w.sent.length = 0;
  process.env.SCAN_ONLY_CHAT = '777';
  await w.wa.deliverDigest(DIGEST, { pool: POOL });
  assert.ok(w.sent.length > 0 && w.sent.every(m => String(m.body.chat_id) === '777'), 'the workflow setting works too');
});

test('the public digest drops everything that belongs to the owner', async t => {
  const { wa } = await world(t);
  const view = wa.publicDigest(DIGEST);
  assert.equal(view.changes, null);
  assert.equal(view.engineering, undefined);
  assert.equal(view.contest_digest[0].record_id, '');
  assert.equal(DIGEST.contest_digest[0].record_id, 'recOWNER', 'the original is untouched');
});

test('/repos browsing: list for anyone, sorts edit in place, owner gate untouched', async t => {
  const { wa, sent, texts, say, bot } = await world(t);
  const browseDeps = {
    targets: async () => ['payjoin/rust-payjoin', 'lightningnetwork/lnd'],
    queue: async () => [],
    scan: async repo => ({ repo, totalOpenIssues: 2, issues: [
      { number: 5, title: 'Fix a thing', url: `https://github.com/${repo}/issues/5`, labels: ['good first issue'], issueFitScore: 80, updatedAt: '2026-10-10T00:00:00Z' },
      { number: 6, title: 'Claimed', url: `https://github.com/${repo}/issues/6`, labels: [], issueFitScore: 95, claim: { claimed: true } },
    ] }),
  };

  // A stranger (not the owner, not subscribed) can browse.
  await say(900, '/repos', { browseDeps });
  const list = sent.find(m => m.method === 'sendMessage' && String(m.body.chat_id) === '900');
  assert.match(list.body.text, /Repos in the daily scan/);
  assert.equal(list.body.reply_markup.inline_keyboard[0][0].callback_data, 'b:r:f:payjoin/rust-payjoin');

  await wa.handleTelegramUpdate({ callback_query: { id: 'cb9', data: 'b:r:f:payjoin/rust-payjoin', from: { username: 'stranger' }, message: { message_id: 42, chat: { id: 900 } } } }, async () => {}, bot, { browseDeps });
  const edited = sent.find(m => m.method === 'editMessageText');
  assert.equal(edited.body.message_id, 42, 'the same message becomes the issue view');
  assert.match(edited.body.text, /payjoin\/rust-payjoin<\/b> · 2 open issues · Best fit/);
  assert.match(edited.body.text, /#5 Fix a thing/);
  assert.ok(!edited.body.text.includes('#6'), 'claimed stays hidden');
  assert.ok(sent.some(m => m.method === 'answerCallbackQuery'));

  // The owner-only buttons are still gated for that same stranger.
  await wa.handleTelegramUpdate({ callback_query: { id: 'cb10', data: 'claim:rec1', from: { username: 'stranger' }, message: { message_id: 43, chat: { id: 900 } } } }, async () => {}, bot, { browseDeps });
  assert.match(sent.filter(m => m.method === 'answerCallbackQuery').at(-1).body.text, /owner's queue/);
});
