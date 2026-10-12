'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchBitcoinDevsIssues,
  parseBitcoinDevsIssues,
  repositoriesFromIssues,
} = require('../src/bitcoindevs');

test('parseBitcoinDevsIssues extracts good first issue records from hydration data', () => {
  const html = `
    <script>
      self.__next_f.push([1,"{\\"url\\":\\"https://github.com/bitcoin/bitcoin/issues/35399\\",\\"publishedAt\\":\\"2026-05-28T00:00:00Z\\",\\"title\\":\\"Remove template\\",\\"labels\\":[\\"good first issue\\"],\\"owner\\":\\"bitcoin\\",\\"repo\\":\\"bitcoin\\",\\"number\\":35399}"]);
      self.__next_f.push([1,"{\\"url\\":\\"https://github.com/lightningnetwork/lnd/issues/5062\\",\\"publishedAt\\":\\"2021-03-02T00:00:00Z\\",\\"title\\":\\"Routing bug\\",\\"labels\\":[\\"bug\\"],\\"owner\\":\\"lightningnetwork\\",\\"repo\\":\\"lnd\\",\\"number\\":5062}"]);
    </script>
  `;

  const issues = parseBitcoinDevsIssues(html);

  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    repo: 'bitcoin/bitcoin',
    number: 35399,
    title: 'Remove template',
    url: 'https://github.com/bitcoin/bitcoin/issues/35399',
    publishedAt: '2026-05-28T00:00:00Z',
    labels: ['good first issue'],
  });
});

test('repositoriesFromIssues returns unique repos in issue order', () => {
  const repos = repositoriesFromIssues([
    { repo: 'bitcoin/bitcoin' },
    { repo: 'payjoin/rust-payjoin' },
    { repo: 'bitcoin/bitcoin' },
  ]);

  assert.deepEqual(repos, ['bitcoin/bitcoin', 'payjoin/rust-payjoin']);
});

const row = (repo, number, labels, date) =>
  `{\\"url\\":\\"https://github.com/${repo}/issues/${number}\\",\\"publishedAt\\":\\"${date}\\",\\"title\\":\\"T${number}\\",\\"labels\\":[${labels.map(l => `\\"${l}\\"`).join(',')}],\\"number\\":${number}}`;

test('parsing without a required label returns every listed issue', () => {
  const html = [row('a/one', 1, ['bug'], '2026-01-01T00:00:00Z'), row('b/two', 2, [], '2026-01-02T00:00:00Z')].join('\n');
  assert.equal(parseBitcoinDevsIssues(html).length, 0);
  assert.deepEqual(parseBitcoinDevsIssues(html, { requiredLabel: '' }).map(issue => issue.repo), ['b/two', 'a/one']);
});

test('discovery lists every project, seeds only good first issues, and caps only on request', async () => {
  const html = Array.from({ length: 20 }, (_, i) => row(`org/repo-${i}`, i + 1, i % 4 === 0 ? ['good first issue'] : ['bug'], `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`)).join('\n');
  const prevFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => html });
  try {
    const all = await fetchBitcoinDevsIssues({ url: 'https://example.test/page' });
    assert.equal(all.repos.length, 20, 'no 12-repo cap any more');
    assert.equal(all.listedIssues, 20);
    assert.equal(all.issues.length, 5, 'only good first issues become seeds');
    assert.equal(all.repos[0], 'org/repo-19', 'newest first');

    const capped = await fetchBitcoinDevsIssues({ url: 'https://example.test/page', maxRepos: 3 });
    assert.equal(capped.repos.length, 3);
    assert.ok(capped.issues.every(issue => capped.repos.includes(issue.repo)));
  } finally {
    global.fetch = prevFetch;
  }
});
