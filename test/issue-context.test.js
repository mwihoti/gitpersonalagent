'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildIssueContext, extractPaths, extractSymbols, excerptAround } = require('../src/issue-context');

test('extractPaths finds repo-relative paths and backticked filenames, ignoring links and images', () => {
  const text = [
    'The bug lives in `common/json_parse.c` and src/lib/parser.rs (see docs/README.md).',
    'Screenshot: shot.png and https://example.com/foo/bar.js should be ignored.',
    'Also touch `Cargo.toml` and the `tests/test_json.py` fixture.',
  ].join('\n');

  const paths = extractPaths(text);
  assert.deepEqual(paths, ['common/json_parse.c', 'src/lib/parser.rs', 'docs/README.md', 'tests/test_json.py', 'Cargo.toml']);
});

test('extractSymbols keeps identifiers and drops paths and short tokens', () => {
  const text = 'Fix `json_to_s64` like `json_to_u64` was fixed; see `Descriptor::descriptor_id()` and `common/json_parse.c`, not `foo`.';
  const symbols = extractSymbols(text, ['common/json_parse.c']);
  assert.deepEqual(symbols, ['json_to_s64', 'json_to_u64', 'descriptor_id']);
});

test('excerptAround centers on the symbol and reports line numbers', () => {
  const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
  lines[199] = 'bool json_to_s64(const char *buffer)';
  const content = lines.join('\n');

  const excerpt = excerptAround(content, 'json_to_s64', { before: 5, after: 10 });
  assert.equal(excerpt.startLine, 195);
  assert.equal(excerpt.endLine, 209);
  assert.match(excerpt.text, /json_to_s64/);
  assert.equal(excerpt.matchedSymbol, 'json_to_s64');

  const head = excerptAround(content, 'missing_symbol', { before: 5, after: 10 });
  assert.equal(head.startLine, 1);
  assert.equal(head.matchedSymbol, '');

  const capped = excerptAround(content, '', { after: 300, maxChars: 50 });
  assert.ok(capped.text.length <= 52);
  assert.match(capped.text, /…$/);
});

test('buildIssueContext assembles thread, PR files as hints, and source excerpts', async () => {
  const calls = [];
  const client = {
    fetchRepoDetails: async () => ({ full_name: 'o/r', html_url: 'https://github.com/o/r', language: 'C', default_branch: 'main', stargazers_count: 5, topics: [] }),
    fetchIssueFull: async () => ({
      number: 9, title: 'json_to_s64 accepts hex', html_url: 'https://github.com/o/r/issues/9',
      body: 'Please fix `json_to_s64` like `json_to_u64`.', labels: [{ name: 'bug' }], user: { login: 'rep' },
      assignees: [], state: 'open', created_at: '2025-01-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', comments: 1,
    }),
    fetchAllIssueComments: async () => [{ id: 1, user: { login: 'maint' }, author_association: 'OWNER', created_at: '2025-01-02T00:00:00Z', body: 'Yes please.' }],
    fetchLinkedPullRequests: async () => [
      { number: 20, title: 'Fix', url: 'https://github.com/o/r/pull/20', author: 'x', state: 'open', sameRepo: true, repo: 'o/r' },
      { number: 3, title: 'Other', url: 'https://github.com/z/z/pull/3', author: 'y', state: 'open', sameRepo: false, repo: 'z/z' },
    ],
    fetchContributingGuide: async () => ({ path: 'CONTRIBUTING.md', url: 'https://github.com/o/r/blob/main/CONTRIBUTING.md', content: 'Run make check.' }),
    fetchPullRequestFiles: async (_repo, number) => {
      calls.push(`files:${number}`);
      return [{ path: 'common/json_parse.c' }, { path: 'CHANGELOG.md' }];
    },
    fetchRepoFile: async (_repo, filePath) => {
      calls.push(`file:${filePath}`);
      if (filePath !== 'common/json_parse.c') return null;
      return { path: filePath, url: 'u', content: 'int a;\nbool json_to_s64(const char *b) {}\nint c;' };
    },
    searchCode: async () => { calls.push('search'); return []; },
  };

  const context = await buildIssueContext('o/r', 9, { client });

  assert.equal(context.issue.title, 'json_to_s64 accepts hex');
  assert.equal(context.comments[0].author, 'maint');
  assert.equal(context.claim.claimed, true);
  assert.equal(context.claim.reason, 'open PR #20 by x');
  assert.deepEqual(calls.filter(c => c.startsWith('files:')), ['files:20']);
  assert.deepEqual(context.mentionedSymbols, ['json_to_s64', 'json_to_u64']);
  assert.equal(context.files.length, 1);
  assert.equal(context.files[0].path, 'common/json_parse.c');
  assert.equal(context.files[0].reason, 'touched by PR #20 (open)');
  assert.match(context.files[0].text, /json_to_s64/);
  assert.equal(context.contributing.path, 'CONTRIBUTING.md');
});
