/**
 * Still on the line at the samples' end, after a return of each kind: the gates sent the coder's first attempt back
 * for a failing unit test, the reviewer sent its second back for a case the spec asks for, and the coder is at work
 * on its third round. One review of two so far.
 */
import { Item } from '../build.ts';

const UNIT_FAILED = `✕ Unit tests                      required check · failed in 23s
  search › lists a product once when two of its words match     ✓
  search › keeps the results in the catalogue's order           ✕ expected Brush, wire before Brush, soft
  41 of 42 tests passed`;

export default new Item('1325', '2026-10-06T15:05:00+01:00')
  .probeTicket('0:00', {
    check: 'search results are each a product',
    route: '/search',
    version: 'v0.9.7',
    symptom: 'wrong-result',
    summary: 'Search journey: a search for “brush” lists the first brush twice',
    exchange: { method: 'GET', url: '/search?q=brush', status: 200, timings: { firstByteMs: 16, totalMs: 24 } },
    title: 'Search lists the first result twice',
    category: 'functional',
    severity: 'degraded',
    description: 'Search for anything with more than one match, and the first one is listed twice.',
    story:
      'The search journey searched for “brush” and found the first brush listed twice. Triage opened a ticket from the probe’s own request.',
  })
  .at('0:10', 'issue.opened', 'factory', 'Opened issue #1333 in the-roganator/cv-worlds-worst-website', {
    repository: 'the-roganator/cv-worlds-worst-website',
    number: 1333,
  })
  .calls('planner', '0:20', '2:10', { calls: 3, input: 30_000, output: 2_000, cached: 0.3 })
  .at('2:20', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'Each search result is listed once',
    criteria: [
      { given: 'a search for “brush”', when: 'the results are shown', expect: 'each brush is listed once' },
      { given: 'a search with one match', when: 'the results are shown', expect: 'it is listed once' },
    ],
    scope: ['src/pages/search.ts', 'test/search.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:30', '8:10', { calls: 13, input: 230_000, output: 4_900, cached: 0.86 })
  .pushed('8:20', 'coder', 'A fix pushed to PR #1326', {
    number: 1326,
    title: 'fix(search): list each result once',
    branch: 'factory/1325-search-repeats',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/search.ts', added: 3, removed: 4 },
      { path: 'test/search.test.ts', added: 15, removed: 0 },
    ],
  })
  .gates('8:30', {
    pullRequest: 1326,
    failure: { check: 'Unit tests', summary: '1 of 42 tests failed', output: UNIT_FAILED },
    testsFirst: { failing: 1, of: 2 },
  })
  .at('10:55', 'work.returned', 'factory', '#1325 · round 2 · 1 check failed', {
    from: 'gates',
    to: 'build',
    reason: 'The gates failed: Unit tests',
    round: 2,
    failed: ['Unit tests'],
  })
  .calls('coder', '11:00', '13:50', { calls: 6, input: 120_000, output: 2_100, cached: 0.9 })
  .pushed('14:00', 'coder', 'Round 2 pushed to PR #1326', {
    number: 1326,
    title: 'fix(search): list each result once',
    branch: 'factory/1325-search-repeats',
    attempt: 2,
    testsFirst: true,
    files: [{ path: 'src/pages/search.ts', added: 2, removed: 1 }],
  })
  .gates('14:10', { pullRequest: 1326, attempt: 2, testsFirst: { failing: 1, of: 2 } })
  .calls('reviewer', '16:40', '18:20', { calls: 2, input: 31_000, output: 1_600, cached: 0.5 })
  .at('18:30', 'review.submitted', 'reviewer', 'Review of PR #1326: Changes requested: 1 blocking finding', {
    pullRequest: 1326,
    verdict: 'changes-requested',
    note: 'The repeat is gone for “brush”, but a search with one match is not tested, and the spec asks for it.',
    findings: [
      {
        path: 'test/search.test.ts',
        line: 21,
        blocking: true,
        criterion: 2,
        comment: 'Nothing tests a search with a single match. Add the case the spec’s second criterion names.',
      },
    ],
  })
  .at('18:31', 'work.returned', 'reviewer', '#1325 · round 3 · 1 blocking', {
    from: 'review',
    to: 'build',
    reason: 'Review asked for changes: a search with one match is not tested',
    round: 3,
    blocking: 1,
  });
