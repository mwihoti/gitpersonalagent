'use strict';
const config = require('./config');
const { getScanRepositories } = require('./repositories');

// ─── RSS parser (handles both RSS 2.0 and Atom) ───────────────────────────────

function parseRSS(xml) {
  const items = [];

  // RSS 2.0 <item> blocks
  const rssItems = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of rssItems) {
    const title = extractField(block, 'title');
    const link  = extractField(block, 'link') || extractField(block, 'guid');
    const date  = extractField(block, 'pubDate') || extractField(block, 'dc:date') || '';
    const desc  = extractField(block, 'description') || '';
    if (title) items.push({ title, url: link, date: normalizeDate(date), snippet: stripHtml(desc).slice(0, 160) });
  }

  // Atom <entry> blocks
  if (items.length === 0) {
    const atomItems = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
    for (const block of atomItems) {
      const title   = extractField(block, 'title');
      const linkTag = block.match(/<link[^>]+href="([^"]+)"/)?.[1] || '';
      const date    = extractField(block, 'updated') || extractField(block, 'published') || '';
      const desc    = extractField(block, 'summary') || extractField(block, 'content') || '';
      if (title) items.push({ title, url: linkTag, date: date.slice(0, 10), snippet: stripHtml(desc).slice(0, 160) });
    }
  }

  return items;
}

function extractField(xml, tag) {
  // Try CDATA first, then plain text
  const cdata = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1];
  if (cdata) return cdata.trim();
  const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1];
  return plain?.trim() || '';
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDate(raw) {
  if (!raw) return '';
  try { return new Date(raw).toISOString().slice(0, 10); } catch { return raw.slice(0, 10); }
}

// ─── Relevance filter ─────────────────────────────────────────────────────────

const RELEVANT_KEYWORDS = [
  'bitcoin', 'blockchain', 'crypto', 'defi', 'web3', 'smart contract',
  'ai', 'llm', 'agent', 'openai', 'anthropic', 'gemini', 'model', 'developer', 'api',
  'rust', 'typescript', 'javascript', 'open source', 'github', 'startup', 'funding',
  'layer 2', 'layer2', 'ethereum', 'solana', 'nft', 'token', 'wallet',
];

function isRelevant(item) {
  const text = (item.title + ' ' + item.snippet).toLowerCase();
  return RELEVANT_KEYWORDS.some(kw => text.includes(kw));
}

// ─── Generic RSS fetcher ──────────────────────────────────────────────────────

async function fetchRSS(name, url, maxItems = 5) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DanAgent/1.0)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseRSS(xml)
      .filter(isRelevant)
      .slice(0, maxItems)
      .map(item => ({ ...item, source: name }));
    return items;
  } catch {
    return [];
  }
}

// ─── Hacker News (Algolia API — already working) ──────────────────────────────

async function fetchHackerNews() {
  const queries = ['open source engineering', 'github developer tools', 'bitcoin layer'];
  const results = [];
  for (const q of queries) {
    try {
      const since = Math.floor((Date.now() - 7 * 86400000) / 1000);
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=4&numericFilters=created_at_i>${since}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const hit of data.hits || []) {
        results.push({
          source: 'HackerNews',
          title: hit.title,
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          date: hit.created_at?.slice(0, 10),
          snippet: '',
        });
      }
    } catch {}
  }
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.title)) return false;
    seen.add(r.title);
    return true;
  }).slice(0, 6);
}

// ─── GitHub Releases ──────────────────────────────────────────────────────────

async function fetchGitHubReleases() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;
  const results = [];
  const repos = await getScanRepositories();
  for (const repo of repos) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=2`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const releases = await res.json();
      for (const r of releases) {
        if (!r.draft) results.push({
          source: 'GitHub Release',
          title: `${repo} ${r.tag_name}: ${r.name || r.tag_name}`,
          url: r.html_url,
          date: r.published_at?.slice(0, 10),
          snippet: (r.body || '').slice(0, 150),
        });
      }
    } catch {}
  }
  return results;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function fetchNews() {
  console.log('  Fetching tech news...');

  const [hn, releases, ...rssFeeds] = await Promise.all([
    fetchHackerNews(),
    fetchGitHubReleases(),

    // General tech & startup
    fetchRSS('TechCrunch',    'https://techcrunch.com/feed/', 4),
    fetchRSS('Wired',         'https://www.wired.com/feed/rss', 3),
    fetchRSS('Ars Technica',  'https://feeds.arstechnica.com/arstechnica/index', 3),

    // Developer & AI focused
    fetchRSS('TLDR Tech',     'https://tldr.tech/api/rss/tech', 4),
    fetchRSS('The Batch',     'https://www.deeplearning.ai/the-batch/feed/', 3),
    fetchRSS('Morning Brew',  'https://api.morningbrew.com/v2/rss/feed?pub=tech', 3),

    // Engineering / platform focused
    fetchRSS('GitHub Blog',   'https://github.blog/feed/', 3),
    fetchRSS('Vercel Blog',   'https://vercel.com/blog/rss.xml', 3),
  ]);

  const allRss = rssFeeds.flat();
  const total = hn.length + releases.length + allRss.length;

  // Group by source for the log
  const sourceSummary = [...new Set(allRss.map(r => r.source))]
    .map(s => `${s}:${allRss.filter(r => r.source === s).length}`)
    .join(', ');

  console.log(`    → ${total} news items (${hn.length} HN, ${releases.length} releases, ${allRss.length} rss [${sourceSummary}])`);

  return {
    hackerNews: hn,
    githubReleases: releases,
    rssFeeds: allRss,
  };
}

module.exports = { fetchNews };
