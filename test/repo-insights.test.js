'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildIssueFitScore, buildIssueInsight, buildRepoOverview } = require('../src/repo-insights');

test('buildRepoOverview creates a readable project summary', () => {
  const overview = buildRepoOverview({
    full_name: 'peer-observer/peer-observer',
    html_url: 'https://github.com/peer-observer/peer-observer',
    description: 'Observe Bitcoin peers and extract network data.',
    language: 'Rust',
    stargazers_count: 42,
    forks_count: 8,
    open_issues_count: 13,
    topics: ['bitcoin', 'p2p', 'metrics'],
  });

  assert.match(overview.projectSummary, /Observe Bitcoin peers/i);
  assert.match(overview.projectSummary, /Primary language: Rust/i);
  assert.match(overview.projectSummary, /bitcoin, p2p, metrics/i);
});

test('buildIssueInsight summarizes expectation and creates a quick plan', () => {
  const issue = {
    title: 'Dashboard descriptions are missing',
    body: 'We have many dashboards but users cannot tell what each one shows. We should add explanations and examples for each dashboard.',
    labels: [{ name: 'docs' }, { name: 'help wanted' }],
  };

  const comments = [{
    body: 'A good first version could cover the most-used dashboards first and explain how maintainers interpret the graphs.',
    user: { login: 'maintainer' },
    created_at: '2026-05-01T10:00:00Z',
  }];

  const insight = buildIssueInsight(issue, comments);

  assert.match(insight.conversationSummary, /dashboards/i);
  assert.match(insight.expectationSummary, /docs|explanation|examples/i);
  assert.equal(insight.quickPlan.length, 4);
  assert.equal(insight.recentConversation[0].author, 'maintainer');
});

test('buildIssueFitScore prefers scoped, active, contributor-friendly issues', () => {
  const strong = buildIssueFitScore({
    title: 'Improve dashboard docs',
    body: 'Document the dashboard panels and add examples for users.',
    labels: [{ name: 'docs' }, { name: 'good first issue' }, { name: 'help wanted' }],
    comments: 2,
    updated_at: new Date().toISOString(),
  }, [{
    body: 'A first pass covering the main dashboards would already help.',
  }]);

  const weak = buildIssueFitScore({
    title: 'Design a full anomaly detection architecture',
    body: 'This probably needs broad design work across tools before implementation.',
    labels: [{ name: 'enhancement' }],
    comments: 0,
    updated_at: '2024-01-01T00:00:00Z',
  }, []);

  assert.ok(strong.issueFitScore > weak.issueFitScore);
  assert.match(strong.issueFitLabel, /High fit|Medium fit/);
  assert.equal(strong.issueRecommendation, 'Recommended first PR');
  assert.match(strong.issueComplexity, /Quick win|Medium/);
  assert.equal(weak.issueRecommendation, 'Avoid for first pass');
});
