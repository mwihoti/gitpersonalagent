'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
