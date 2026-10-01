'use strict';
// Records the demo as a deterministic frame sequence.
//
// Nothing here depends on wall-clock timing: every frame is produced by setting
// the page to an exact state (scroll offset, cursor position, caption) and then
// taking one screenshot. That makes scrolling perfectly smooth and the whole
// run reproducible, which a real-time screen capture is not.
//
// Usage:
//   npm run dev                      # dashboard on :3000
//   npm run demo:seed                # real open issues into the local store
//   DEMO_BASE=http://localhost:3000 npm run demo:record
//   npm run demo:encode              # frames → demo/bitcoin-contributor-demo.mp4
//
// Env: DEMO_BASE, DEMO_FRAMES, CHROME_PATH.
//
// Re-run all four after any dashboard redesign — the captions are written
// against the panels, so a UI change can leave them describing something that
// is no longer on screen.

const fs = require('fs');
const path = require('path');
// puppeteer-core is a dev-only dependency of this script, not of the agent.
// Install it on demand:  npm install --no-save puppeteer-core
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.error('This script needs puppeteer-core:\n  npm install --no-save puppeteer-core');
  process.exit(1);
}

const BASE = process.env.DEMO_BASE || 'http://localhost:3000';
const OUT = process.env.DEMO_FRAMES || path.join(__dirname, '..', 'demo', 'frames');
const FPS = 20;
const W = 1280;
const H = 720;
const SCALE = 1.5; // screenshots land at 1920x1080

const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

// ── Overlay injected into every page: caption bar + synthetic cursor ──────
const OVERLAY = `
(() => {
  if (document.getElementById('__demo')) return;
  const style = document.createElement('style');
  style.textContent = \`
    #__cap {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
      padding: 18px 34px 22px;
      background: linear-gradient(to top, rgba(10,14,12,.93) 55%, rgba(10,14,12,0));
      color: #fbf8f1; pointer-events: none;
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 25px; font-weight: 600; line-height: 1.3;
      letter-spacing: -0.01em;
      opacity: 0; transition: opacity .18s ease;
      text-shadow: 0 1px 10px rgba(0,0,0,.55);
    }
    #__cap.on { opacity: 1; }
    #__cap small {
      display: block; font-family: 'IBM Plex Mono', monospace;
      font-size: 14px; font-weight: 500; letter-spacing: .1em;
      text-transform: uppercase; color: #e8874f; margin-bottom: 7px;
    }
    #__cur {
      position: fixed; z-index: 2147483646; width: 22px; height: 22px;
      margin: -11px 0 0 -11px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.9);
      background: rgba(199,90,36,.5);
      box-shadow: 0 2px 10px rgba(0,0,0,.4);
      pointer-events: none; opacity: 0; transition: opacity .15s;
    }
    #__cur.on { opacity: 1; }
    #__cur.tap { animation: __tap .35s ease-out; }
    @keyframes __tap { 0%{transform:scale(1)} 45%{transform:scale(.6)} 100%{transform:scale(1)} }
  \`;
  document.head.append(style);
  const cap = document.createElement('div');
  cap.id = '__cap';
  const cur = document.createElement('div');
  cur.id = '__cur';
  const host = document.createElement('div');
  host.id = '__demo';
  document.body.append(cap, cur, host);
  window.__cap = (kicker, text) => {
    if (!text) { cap.classList.remove('on'); return; }
    cap.innerHTML = '';
    if (kicker) { const s = document.createElement('small'); s.textContent = kicker; cap.append(s); }
    cap.append(document.createTextNode(text));
    cap.classList.add('on');
  };
  window.__cur = (x, y, show) => {
    if (!show) { cur.classList.remove('on'); return; }
    cur.style.left = x + 'px'; cur.style.top = y + 'px';
    cur.classList.add('on');
  };
  window.__tap = () => {
    cur.classList.remove('tap'); void cur.offsetWidth; cur.classList.add('tap');
  };
})();
`;

async function boxCenter(page, selector, nth = 0) {
  return page.evaluate(({ selector, nth }) => {
    const el = document.querySelectorAll(selector)[nth];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, { selector, nth });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none',
           '--disable-lcd-text', '--hide-scrollbars'],
    defaultViewport: { width: W, height: H, deviceScaleFactor: SCALE },
  });

  const page = await browser.newPage();
  // Record in light theme: the dashboard's own palette is the brand.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  let frame = 0;
  async function shoot() {
    await page.screenshot({
      path: path.join(OUT, String(frame).padStart(5, '0') + '.png'),
      type: 'png',
    });
    frame += 1;
  }

  // Hold the current state for `seconds`, optionally driving it per frame.
  async function hold(seconds, perFrame) {
    const n = Math.max(1, Math.round(seconds * FPS));
    for (let i = 0; i < n; i += 1) {
      if (perFrame) await perFrame(i / Math.max(1, n - 1), i);
      await shoot();
    }
  }

  async function caption(kicker, text) {
    await page.evaluate(([k, t]) => window.__cap(k, t), [kicker, text]);
  }

  async function scrollTo(y) {
    await page.evaluate(v => window.scrollTo(0, v), y);
  }

  // Glide the cursor to an element, then click it.
  async function moveAndClick(selector, nth = 0, { seconds = 0.5, click = true } = {}) {
    const target = await boxCenter(page, selector, nth);
    if (!target) {
      const url = await page.url();
      throw new Error(`target not found: ${selector}[${nth}] (page is at ${url})`);
    }
    const from = await page.evaluate(() => window.__lastCur || { x: 640, y: 400 });
    await hold(seconds, async t => {
      const e = easeInOut(t);
      const x = lerp(from.x, target.x, e);
      const y = lerp(from.y, target.y, e);
      await page.evaluate(([x, y]) => { window.__cur(x, y, true); window.__lastCur = { x, y }; }, [x, y]);
    });
    if (click) {
      await page.evaluate(() => window.__tap());
      // Invoke the element's own handler rather than clicking at coordinates.
      // A coordinate click can drift onto a neighbouring project link and
      // navigate the whole page to GitHub, which silently breaks every later
      // scene. The drawn cursor above is what the viewer sees either way.
      await page.evaluate(({ selector, nth }) => {
        const el = document.querySelectorAll(selector)[nth];
        if (el) el.click();
      }, { selector, nth });
      await hold(0.35);
    }
    return target;
  }

  async function goto(url) {
    await page.goto(url, { waitUntil: 'networkidle2' });
    await page.evaluate(OVERLAY);
    await page.evaluate(() => { window.__lastCur = { x: 640, y: 420 }; });
  }

  // ── 1. Title ───────────────────────────────────────────────────────────
  const titleCard = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=IBM+Plex+Mono:wght@500&display=swap">
    <style>
      html,body{margin:0;height:100%;background:#f4f0e8;color:#161f1a;
        font-family:'Sora',system-ui,sans-serif;display:grid;place-items:center}
      .c{max-width:900px;padding:0 60px;text-align:left}
      .k{font-family:'IBM Plex Mono',monospace;font-size:17px;letter-spacing:.16em;
        text-transform:uppercase;color:#8f3814;margin-bottom:26px}
      h1{font-size:68px;line-height:1.03;letter-spacing:-.025em;margin:0;font-weight:700}
      p{margin:26px 0 0;font-size:24px;line-height:1.45;color:#3f4d46;max-width:24ch}
      .r{margin-top:40px;height:3px;width:120px;background:#c75a24}
    </style>
    <div class="c">
      <div class="k">Bitcoin Contributor Intelligence</div>
      <h1>Find the Bitcoin issue<br>that is actually<br>yours to take.</h1>
      <p>Which issues are genuinely unclaimed — before you spend a weekend on one.</p>
      <div class="r"></div>
    </div>
  `);
  await goto(titleCard);
  await hold(3.2);

  // ── 2. The dashboard ───────────────────────────────────────────────────
  await goto(BASE + '/');
  await caption(null, 'One dashboard. 42 Bitcoin projects, 11 areas.');
  await hold(2.6);

  // ── 3. Pick an area ────────────────────────────────────────────────────
  const panelY = await page.evaluate(() =>
    document.querySelector('.ecosystem-panel').getBoundingClientRect().top + window.scrollY - 70);
  await caption('Start here', 'Start from the part of Bitcoin you want to work in.');
  await hold(1.4, async t => { await scrollTo(lerp(0, panelY, easeInOut(t))); });
  await hold(0.9);

  // Chips: All areas, Consensus, Lightning, Wallets, Libraries, Privacy, ...
  await caption('Start here', 'Lightning — nine projects, from LND to the BOLT specs.');
  await moveAndClick('.ecosystem-chip', 2);
  await hold(1.9);

  await caption('Start here', 'Privacy, ecash, mining, design — each its own corner.');
  await moveAndClick('.ecosystem-chip', 7);
  await hold(1.7);

  await moveAndClick('.ecosystem-chip', 1);
  await hold(1.7);

  await caption('Start here', 'The tag is Bitcoin context needed — not difficulty.');
  await moveAndClick('.ecosystem-chip', 5);
  await hold(2.3);

  // ── 4. Add to watchlist ────────────────────────────────────────────────
  await caption('Start here', 'Add one and every scan starts tracking its issues.');
  await moveAndClick('.ecosystem-add', 0, { seconds: 0.6 });
  await hold(2.4);

  // ── 5. The queue, from real issues ─────────────────────────────────────
  const queueY = await page.evaluate(() =>
    document.querySelector('.filters-panel').getBoundingClientRect().top + window.scrollY - 60);
  const fromY = await page.evaluate(() => window.scrollY);
  await caption(null, 'This morning: real open issues, ranked and filtered.');
  await hold(1.6, async t => { await scrollTo(lerp(fromY, queueY, easeInOut(t))); });
  await hold(2.6);

  await caption(null, 'Assigned issues and ones with an open PR never reach here.');
  await hold(2.8, async t => { await scrollTo(queueY + easeInOut(t) * 200); });

  // ── 6. One issue ───────────────────────────────────────────────────────
  await caption(null, 'Open one for the plan, the files, and the questions to ask.');
  await moveAndClick('.list-item', 1, { seconds: 0.6 });
  await hold(1.0);
  const detY = await page.evaluate(() => {
    const el = document.querySelector('.detail-panel') || document.querySelector('#detail-form');
    return el ? el.getBoundingClientRect().top + window.scrollY - 60 : window.scrollY;
  });
  const beforeDet = await page.evaluate(() => window.scrollY);
  await hold(1.3, async t => { await scrollTo(lerp(beforeDet, detY, easeInOut(t))); });
  await hold(2.6);
  await page.evaluate(() => window.__cur(0, 0, false));
  await hold(2.4, async t => { await scrollTo(detY + easeInOut(t) * 420); });

  // ── 7 & 8. State machine + Telegram, from the walkthrough ──────────────
  await goto(BASE + '/walkthrough.html');

  const thesisY = await page.evaluate(() =>
    document.querySelector('.thesis').getBoundingClientRect().top + window.scrollY - 80);
  await page.evaluate(v => window.scrollTo(0, v - 320), thesisY);
  await caption('The whole point', 'One field decides whether you start.');
  await hold(1.5, async t => { await scrollTo(lerp(thesisY - 320, thesisY, easeInOut(t))); });
  await hold(3.4);
  await caption('The whole point', 'available · claimed · has_open_pr · likely_done · stale');
  await hold(3.0);

  // The walkthrough puts the chat mock in a narrow right-hand column, which is
  // too small to read at 1080p. Collapse that one step to a single column for
  // the recording so the thread fills the frame.
  await page.evaluate(() => {
    const step = document.querySelector('#tg').closest('.step');
    const css = document.createElement('style');
    css.textContent = `
      #__wide .split { grid-template-columns: minmax(0, 1fr) !important; }
      #__wide .aside { display: none !important; }
      #__wide .step-body > p { display: none !important; }
    `;
    document.head.append(css);
    step.id = '__wide';
  });

  // Keep the newest bubble in frame as the thread grows.
  const followChat = async () => {
    const y = await page.evaluate(() => {
      const mock = document.querySelector('#tg').closest('.mock');
      const r = mock.getBoundingClientRect();
      const bottom = r.bottom + window.scrollY;
      return Math.max(0, bottom - window.innerHeight + 96);
    });
    return y;
  };

  const tgTop = await page.evaluate(() =>
    document.querySelector('#tg').closest('.mock').getBoundingClientRect().top + window.scrollY - 80);
  const beforeTg = await page.evaluate(() => window.scrollY);
  await caption('Telegram', 'The same thing from your phone.');
  await hold(1.6, async t => { await scrollTo(lerp(beforeTg, tgTop, easeInOut(t))); });
  await hold(1.6);

  await caption('Telegram', 'Three commands need no account at all.');
  await moveAndClick('.key', 3, { seconds: 0.6 });
  const afterIssues = await followChat();
  const beforeFollow = await page.evaluate(() => window.scrollY);
  await hold(1.1, async t => { await scrollTo(lerp(beforeFollow, afterIssues, easeInOut(t))); });
  await caption('Telegram', '/issues reads the last scan — it answers instantly.');
  await hold(3.2);
  await page.evaluate(() => window.__cur(0, 0, false));
  await hold(1.0);

  // ── 9. End card ────────────────────────────────────────────────────────
  const endCard = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=IBM+Plex+Mono:wght@500&display=swap">
    <style>
      html,body{margin:0;height:100%;background:#161f1a;color:#f4f0e8;
        font-family:'Sora',system-ui,sans-serif;display:grid;place-items:center}
      .c{max-width:900px;padding:0 60px}
      h1{font-size:50px;line-height:1.1;letter-spacing:-.02em;margin:0 0 24px;font-weight:700}
      p{margin:0;font-size:22px;line-height:1.5;color:#c2c7c2;max-width:30ch}
      .m{margin-top:38px;font-family:'IBM Plex Mono',monospace;font-size:17px;color:#e8874f}
    </style>
    <div class="c">
      <h1>Self-hosted.<br>Your token, your bot,<br>your data.</h1>
      <p>Runs inside free tiers: GitHub Actions for scans, a webhook for the bot.</p>
      <div class="m">The project list is one file — PRs welcome.</div>
    </div>
  `);
  await goto(endCard);
  await hold(3.6);

  await browser.close();
  console.log(`captured ${frame} frames (${(frame / FPS).toFixed(1)}s at ${FPS}fps)`);
})().catch(e => { console.error(e); process.exit(1); });
