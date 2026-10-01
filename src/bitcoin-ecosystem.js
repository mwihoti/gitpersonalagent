'use strict';
// Curated map of the Bitcoin open-source ecosystem.
//
// The scanner used to treat Bitcoin as a fallback: if your watchlist was empty
// it scraped the BitcoinDevs good-first-issue board, and if that scrape failed
// the scan had nothing to look at. This module makes the ecosystem itself a
// first-class input — a named, categorised list of repositories that actually
// take outside contributions, so a newcomer gets a useful queue on day one
// without configuring anything.
//
// Every entry below was checked against the GitHub API: the repo resolves, is
// not archived, and the language is the one GitHub reports. Archived projects
// are deliberately absent — they cannot merge your PR.
//
// Entry shape:
//   repo      owner/name on GitHub
//   area      one of AREAS below
//   language  primary language as GitHub reports it
//   level     newcomer | intermediate | deep — how much Bitcoin-specific
//             context you need before the code makes sense, NOT how hard the
//             language is
//   blurb     one line, what the project is

const AREAS = {
  core: {
    label: 'Consensus & node',
    blurb: 'The base layer: validation, policy, P2P, and the reference implementation.',
  },
  lightning: {
    label: 'Lightning',
    blurb: 'Payment channels, routing, and the node implementations that run them.',
  },
  wallet: {
    label: 'Wallets & keys',
    blurb: 'Where users hold coins: desktop, mobile, and hardware signing.',
  },
  library: {
    label: 'Libraries & primitives',
    blurb: 'The cryptography and protocol libraries everything else is built on.',
  },
  privacy: {
    label: 'Privacy',
    blurb: 'Coinjoin, payjoin, and reducing what the chain reveals about users.',
  },
  payments: {
    label: 'Payments & merchant',
    blurb: 'Accepting bitcoin: checkout, invoicing, and self-hosted processing.',
  },
  ecash: {
    label: 'Ecash & L2',
    blurb: 'Federated custody, ecash mints, sidechains, and newer layers.',
  },
  mining: {
    label: 'Mining',
    blurb: 'Pool protocols and the software that connects hashrate to the network.',
  },
  infra: {
    label: 'Infrastructure & explorers',
    blurb: 'Indexers, explorers, and the node-running tooling the ecosystem depends on.',
  },
  design: {
    label: 'Design & UX',
    blurb: 'Interface patterns and design systems for bitcoin products.',
  },
  education: {
    label: 'Education & docs',
    blurb: 'Books, guides, and protocol documentation.',
  },
};

const BITCOIN_PROJECTS = [
  // ── Consensus & node ────────────────────────────────────────────────────
  { repo: 'bitcoin/bitcoin', area: 'core', language: 'C++', level: 'deep', blurb: 'Bitcoin Core — the reference full node implementation.' },
  { repo: 'bitcoin/bips', area: 'core', language: 'Wikitext', level: 'intermediate', blurb: 'Bitcoin Improvement Proposals — the protocol standards process.' },
  { repo: 'bitcoin-core/gui', area: 'core', language: 'C++', level: 'intermediate', blurb: 'The Bitcoin Core Qt GUI, developed in its own repo.' },
  { repo: 'btcsuite/btcd', area: 'core', language: 'Go', level: 'intermediate', blurb: 'A full node written in Go, widely used as a library.' },
  { repo: 'libbitcoin/libbitcoin-system', area: 'core', language: 'C++', level: 'deep', blurb: 'An independent C++ implementation of the Bitcoin protocol.' },
  { repo: 'bitcoin-dev-project/warnet', area: 'core', language: 'Python', level: 'intermediate', blurb: 'Spin up and attack simulated Bitcoin networks for testing.' },

  // ── Lightning ───────────────────────────────────────────────────────────
  { repo: 'lightningnetwork/lnd', area: 'lightning', language: 'Go', level: 'intermediate', blurb: 'LND, a Lightning node implementation in Go.' },
  { repo: 'ElementsProject/lightning', area: 'lightning', language: 'C', level: 'deep', blurb: 'Core Lightning (CLN) — a modular, plugin-driven LN implementation.' },
  { repo: 'ACINQ/eclair', area: 'lightning', language: 'Scala', level: 'deep', blurb: 'Eclair — the Lightning implementation behind Phoenix wallet.' },
  { repo: 'lightningdevkit/rust-lightning', area: 'lightning', language: 'Rust', level: 'intermediate', blurb: 'LDK — Lightning as a library you embed in your own app.' },
  { repo: 'lightning/bolts', area: 'lightning', language: 'Markdown', level: 'intermediate', blurb: 'The BOLT specs that define how Lightning nodes interoperate.' },
  { repo: 'lnbits/lnbits', area: 'lightning', language: 'Python', level: 'newcomer', blurb: 'An extensible Lightning accounts system with a plugin ecosystem.' },
  { repo: 'getAlby/lightning-browser-extension', area: 'lightning', language: 'TypeScript', level: 'newcomer', blurb: 'Alby — Lightning payments in the browser via WebLN.' },
  { repo: 'ZeusLN/zeus', area: 'lightning', language: 'TypeScript', level: 'newcomer', blurb: 'A mobile app for managing a remote Lightning node.' },
  { repo: 'bitcoin-dev-project/sim-ln', area: 'lightning', language: 'Rust', level: 'intermediate', blurb: 'Generate realistic payment traffic across Lightning testnets.' },

  // ── Wallets & keys ──────────────────────────────────────────────────────
  { repo: 'spesmilo/electrum', area: 'wallet', language: 'Python', level: 'newcomer', blurb: 'Electrum — a long-running lightweight desktop wallet.' },
  { repo: 'sparrowwallet/sparrow', area: 'wallet', language: 'Java', level: 'intermediate', blurb: 'Sparrow — a desktop wallet aimed at power users and coin control.' },
  { repo: 'BlueWallet/BlueWallet', area: 'wallet', language: 'TypeScript', level: 'newcomer', blurb: 'A React Native bitcoin and Lightning wallet for iOS and Android.' },
  { repo: 'bitcoin-core/HWI', area: 'wallet', language: 'Python', level: 'intermediate', blurb: 'A Python interface for supported hardware wallets.' },
  { repo: 'bitcoindevkit/bdk', area: 'wallet', language: 'Rust', level: 'intermediate', blurb: 'BDK, a toolkit for building Bitcoin wallets in Rust.' },

  // ── Libraries & primitives ──────────────────────────────────────────────
  { repo: 'bitcoin-core/secp256k1', area: 'library', language: 'C', level: 'deep', blurb: 'The optimised ECDSA and Schnorr library Bitcoin Core signs with.' },
  { repo: 'rust-bitcoin/rust-bitcoin', area: 'library', language: 'Rust', level: 'intermediate', blurb: 'Bitcoin data structures and consensus primitives in Rust.' },
  { repo: 'rust-bitcoin/rust-miniscript', area: 'library', language: 'Rust', level: 'deep', blurb: 'Miniscript — analysable, composable Bitcoin spending policies.' },
  { repo: 'bitcoinjs/bitcoinjs-lib', area: 'library', language: 'JavaScript', level: 'newcomer', blurb: 'A JavaScript library for Bitcoin transactions and keys.' },

  // ── Privacy ─────────────────────────────────────────────────────────────
  { repo: 'payjoin/rust-payjoin', area: 'privacy', language: 'Rust', level: 'intermediate', blurb: 'Payjoin (BIP 78/77) in Rust — breaks the common-input heuristic.' },
  { repo: 'WalletWasabi/WalletWasabi', area: 'privacy', language: 'C#', level: 'intermediate', blurb: 'Wasabi — a desktop wallet built around coinjoin.' },

  // ── Payments & merchant ─────────────────────────────────────────────────
  { repo: 'btcpayserver/btcpayserver', area: 'payments', language: 'C#', level: 'newcomer', blurb: 'BTCPay Server — self-hosted, no-fee payment processing.' },
  { repo: 'BoltzExchange/boltz-backend', area: 'payments', language: 'TypeScript', level: 'intermediate', blurb: 'Boltz — non-custodial swaps between on-chain and Lightning.' },

  // ── Ecash & L2 ──────────────────────────────────────────────────────────
  { repo: 'fedimint/fedimint', area: 'ecash', language: 'Rust', level: 'intermediate', blurb: 'Federated custody plus a Chaumian ecash mint.' },
  { repo: 'cashubtc/nutshell', area: 'ecash', language: 'Python', level: 'newcomer', blurb: 'The reference Cashu ecash mint and wallet.' },
  { repo: 'cashubtc/cdk', area: 'ecash', language: 'Rust', level: 'intermediate', blurb: 'Cashu Development Kit — build ecash mints and wallets in Rust.' },
  { repo: 'ElementsProject/elements', area: 'ecash', language: 'C++', level: 'deep', blurb: 'Elements — the sidechain codebase Liquid runs on.' },
  { repo: 'arkade-os/arkd', area: 'ecash', language: 'Go', level: 'intermediate', blurb: 'Ark — a newer off-chain scaling protocol, still early.' },
  { repo: 'bisq-network/bisq', area: 'ecash', language: 'Java', level: 'intermediate', blurb: 'Bisq — a peer-to-peer exchange with no central custodian.' },

  // ── Mining ──────────────────────────────────────────────────────────────
  { repo: 'stratum-mining/stratum', area: 'mining', language: 'Rust', level: 'deep', blurb: 'Stratum V2 — the protocol giving hashrate control over templates.' },

  // ── Infrastructure & explorers ──────────────────────────────────────────
  { repo: 'mempool/mempool', area: 'infra', language: 'TypeScript', level: 'newcomer', blurb: 'The mempool.space block explorer and fee estimator.' },
  { repo: 'romanz/electrs', area: 'infra', language: 'Rust', level: 'intermediate', blurb: 'An efficient Electrum server you can run over your own node.' },
  { repo: 'Blockstream/esplora', area: 'infra', language: 'JavaScript', level: 'newcomer', blurb: 'The block explorer front end behind blockstream.info.' },
  { repo: 'getumbrel/umbrel', area: 'infra', language: 'TypeScript', level: 'newcomer', blurb: 'A personal server OS with Bitcoin node apps.' },

  // ── Design & UX ─────────────────────────────────────────────────────────
  { repo: 'BitcoinDesign/Guide', area: 'design', language: 'SCSS', level: 'newcomer', blurb: 'The Bitcoin Design Guide — patterns for wallets and bitcoin UX.' },

  // ── Education & docs ────────────────────────────────────────────────────
  { repo: 'bitcoinbook/bitcoinbook', area: 'education', language: 'HTML', level: 'newcomer', blurb: 'Mastering Bitcoin — the book, open for corrections and updates.' },
  { repo: 'bitcoin-dev-project/decoding-bitcoin', area: 'education', language: 'JavaScript', level: 'newcomer', blurb: 'Decoding Bitcoin — interactive lessons on how the protocol works.' },
];

const PROJECTS_BY_REPO = new Map(
  BITCOIN_PROJECTS.map(project => [project.repo.toLowerCase(), project]),
);

// Owner or name fragments that reliably mean "this is a Bitcoin project".
// Used only for repos outside the catalogue — BitcoinDevs discoveries and
// anything a user adds to their own watchlist.
const AREA_HINTS = [
  { area: 'lightning', pattern: /\b(lightning|lnd|bolt|ln-|lnurl|taro|phoenix|zeus|alby)\b|lightning|lnbits/i },
  { area: 'privacy', pattern: /payjoin|coinjoin|joinmarket|wasabi|whirlpool|silentpayment/i },
  { area: 'ecash', pattern: /cashu|fedimint|ecash|liquid|elements|ark|statechain/i },
  { area: 'mining', pattern: /stratum|mining|miner|hashrate|pool/i },
  { area: 'wallet', pattern: /wallet|hwi|seed|descriptor|psbt|signer/i },
  { area: 'payments', pattern: /btcpay|payment|invoice|checkout|merchant|boltz|swap/i },
  { area: 'infra', pattern: /electrs|esplora|mempool|explorer|indexer|umbrel|node/i },
  { area: 'design', pattern: /design|ui-kit|ux/i },
  { area: 'education', pattern: /book|guide|docs|tutorial|learn|topics|decoding/i },
  { area: 'library', pattern: /secp256k1|rust-bitcoin|bitcoinjs|miniscript|\blib/i },
  { area: 'core', pattern: /bitcoin|btc|bips|consensus|validation/i },
];

function normalizeArea(input) {
  const key = String(input || '').trim().toLowerCase();
  if (!key) return '';
  if (AREAS[key]) return key;
  // Accept the human label too, so "/projects lightning" and "/projects
  // Consensus & node" both work.
  const match = Object.entries(AREAS)
    .find(([, meta]) => meta.label.toLowerCase() === key);
  return match ? match[0] : '';
}

function findProject(repo) {
  return PROJECTS_BY_REPO.get(String(repo || '').trim().toLowerCase()) || null;
}

function isBitcoinProject(repo) {
  return Boolean(findProject(repo) || classifyRepo(repo).area);
}

// Returns { area, label, source } — source is 'catalog' when we know the repo
// and 'inferred' when the area came from the name. Callers that care about
// certainty (ranking does) should check it.
function classifyRepo(repo) {
  const known = findProject(repo);
  if (known) {
    return {
      area: known.area,
      label: AREAS[known.area].label,
      level: known.level,
      source: 'catalog',
    };
  }

  const name = String(repo || '');
  for (const hint of AREA_HINTS) {
    if (hint.pattern.test(name)) {
      return {
        area: hint.area,
        label: AREAS[hint.area].label,
        level: '',
        source: 'inferred',
      };
    }
  }

  return { area: '', label: '', level: '', source: 'unknown' };
}

function parseListEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

// Areas the contributor wants to work in, e.g. BITCOIN_FOCUS_AREAS=lightning,privacy
function preferredAreas() {
  return parseListEnv('BITCOIN_FOCUS_AREAS')
    .map(normalizeArea)
    .filter(Boolean);
}

function listProjects(filters = {}) {
  const { area, language, level, limit } = filters;
  const wantedArea = area ? normalizeArea(area) : '';
  const wantedLanguage = String(language || '').trim().toLowerCase();
  const wantedLevel = String(level || '').trim().toLowerCase();

  const matched = BITCOIN_PROJECTS.filter(project => {
    if (wantedArea && project.area !== wantedArea) return false;
    if (wantedLanguage && project.language.toLowerCase() !== wantedLanguage) return false;
    if (wantedLevel && project.level !== wantedLevel) return false;
    return true;
  });

  return limit > 0 ? matched.slice(0, limit) : matched;
}

// Scan targets for someone who has configured nothing. Spread across areas
// rather than taking the first N of the catalogue, so a default scan surveys
// the ecosystem instead of drilling into consensus code. Honours
// BITCOIN_FOCUS_AREAS and PREFERRED_LANGUAGES when they are set.
function seedRepositories(limit = 12) {
  const focus = preferredAreas();
  const languages = parseListEnv('PREFERRED_LANGUAGES').map(item => item.toLowerCase());

  const eligible = BITCOIN_PROJECTS.filter(project => {
    if (focus.length && !focus.includes(project.area)) return false;
    if (languages.length && !languages.includes(project.language.toLowerCase())) return false;
    return true;
  });

  // Fall back progressively rather than returning nothing when the filters are
  // narrow: focus alone, then the whole catalogue.
  const pool = eligible.length
    ? eligible
    : (focus.length ? BITCOIN_PROJECTS.filter(p => focus.includes(p.area)) : BITCOIN_PROJECTS);
  const source = pool.length ? pool : BITCOIN_PROJECTS;

  // Round-robin across areas, newcomer-friendly projects first within each.
  const byArea = new Map();
  const rank = { newcomer: 0, intermediate: 1, deep: 2 };
  for (const project of source) {
    if (!byArea.has(project.area)) byArea.set(project.area, []);
    byArea.get(project.area).push(project);
  }
  for (const group of byArea.values()) {
    group.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
  }

  const picked = [];
  const queues = Array.from(byArea.values());
  let depth = 0;
  while (picked.length < limit) {
    let tookOne = false;
    for (const group of queues) {
      if (depth >= group.length) continue;
      picked.push(group[depth].repo);
      tookOne = true;
      if (picked.length >= limit) break;
    }
    if (!tookOne) break;
    depth += 1;
  }

  return picked;
}

function areaSummary() {
  return Object.entries(AREAS).map(([key, meta]) => ({
    area: key,
    label: meta.label,
    blurb: meta.blurb,
    projectCount: BITCOIN_PROJECTS.filter(project => project.area === key).length,
  }));
}

module.exports = {
  AREAS,
  BITCOIN_PROJECTS,
  areaSummary,
  classifyRepo,
  findProject,
  isBitcoinProject,
  listProjects,
  normalizeArea,
  preferredAreas,
  seedRepositories,
};
