/**
 * A fix taken through the whole line in a dry run, on the local model: an afternoon Martin ran the line with
 * `LINE_MODE=dry-run`. The GitHub worker recorded what it would have done, numbering its pull request from a billion
 * up, passed its checks and merged it; the line released and verified the merge by the dry run's word, a minute
 * apart, each event marked `dryRun`. Nothing reached GitHub or the shop, and the scoreboard does not count it fixed.
 */
import type { PayloadOf } from '@software-factory/events';
import { commitFor, Item, short } from '../build.ts';

const LOCAL = { local: true };

/** The dry run's pull request, and the commit its merge would have made. */
const PULL_REQUEST = 1_000_000_004;
const MERGE = commitFor('1310/dry-run-merge');
/** A dry run's release is named by its merge, and its version is the merge's commit. */
const RELEASE = `dry-run-${MERGE.slice(0, 12)}`;
const SHORT = short(MERGE);
/** What it would have replaced: the stable version then. */
const PREVIOUS = 'v0.9.10';
/** How far apart the dry run's release events are: `LINE_DRY_RUN_RELEASE_SECONDS`. */
const EVERY = 60;

const step = (weight: number): PayloadOf<'canary.stepped'> => ({
  release: RELEASE,
  version: MERGE,
  weight,
  analysis: { phase: 'successful', requests: null, measures: [] },
  dryRun: true,
});

export default new Item('1310', '2026-10-05T13:10:00+01:00')
  .probeTicket('0:00', {
    check: 'the products sort by name',
    route: '/products',
    version: PREVIOUS,
    symptom: 'wrong-result',
    summary: 'Products journey: sorted by name, “anchor” came after “Zinc bucket”, twice in a row',
    exchange: { method: 'GET', url: '/products?sort=name', status: 200, timings: { firstByteMs: 19, totalMs: 26 } },
    title: 'Sorting by name puts lower case last',
    category: 'functional',
    severity: 'degraded',
    description: 'Sort the products by name, and every name that starts in lower case comes after Z.',
    story:
      'The products journey sorted the shop by name and found “anchor” after “Zinc bucket”, twice in a row: the sort compared capital letters before small ones. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:10', '6:40', { calls: 3, input: 30_000, output: 2_600, cached: 0.3 }, LOCAL)
  .at('6:50', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'Sorting by name ignores the case of the first letter',
    criteria: [
      {
        given: 'products called “anchor” and “Zinc bucket”',
        when: 'the products are sorted by name',
        expect: '“anchor” comes first',
      },
      { given: 'the products sorted by price', when: 'the page is shown', expect: 'nothing has changed' },
    ],
    scope: ['src/pages/products.ts', 'test/products.test.ts'],
    // The existing test pinned the order the probe found wrong, so the spec names it: the coder may rewrite it.
    contradicts: [{ file: 'test/products.test.ts', test: 'the products page > sorts by name, capitals first' }],
    risks: ['test-loosening'],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '7:00', '41:20', { calls: 24, input: 410_000, output: 10_200, cached: 0.84 }, LOCAL)
  .pushed('41:30', 'coder', `A fix pushed to PR #${PULL_REQUEST}, in a dry run`, {
    number: PULL_REQUEST,
    title: 'fix(products): sort names whatever their case',
    branch: 'factory/1310-sort-by-name',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/products.ts', added: 1, removed: 1 },
      { path: 'test/products.test.ts', added: 15, removed: 4 },
    ],
  })
  .gates('41:40', { pullRequest: PULL_REQUEST, testsFirst: { failing: 1, of: 1 } })
  .calls('reviewer', '44:30', '52:00', { calls: 4, input: 62_000, output: 3_900, cached: 0.5 }, LOCAL)
  .at('52:10', 'review.submitted', 'reviewer', `Review of PR #${PULL_REQUEST}: Approved`, {
    pullRequest: PULL_REQUEST,
    verdict: 'approved',
    note: 'The sort compares names as a reader would, and the test sorts the two names the probe saw.',
    findings: [],
  })
  .calls('describer', '52:20', '55:00', { calls: 2, input: 28_000, output: 2_100, cached: 0.2 }, LOCAL)
  .at('55:10', 'work-item.summarised', 'describer', 'Summary written', {
    title: 'Sorting by name puts lower case last',
    description:
      'Sorted by name, names in lower case came after Z. Fixed in a dry run on the local model: nothing reached GitHub or the shop.',
    story:
      'The products journey found “anchor” after “Zinc bucket” when the shop sorted by name. Martin ran the line in a dry run that afternoon, on the local model, so the planner, the coder and the reviewer all worked for nothing, and the GitHub worker recorded what it would have done instead of doing it. The coder wrote a test with the two names first, then compared names whatever their case. Every check passed and the reviewer approved.',
  })
  .at('55:11', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: `The fix in pull request #${PULL_REQUEST} has passed its gates and review, and waits for Martin to merge it`,
  })
  // The dry run's GitHub worker merges its own pull requests after a while. No deploy can carry such a merge, so it
  // is not held for one: it waits at Release for the dry run's release, which starts a minute later.
  .at('57:11', 'pull-request.merged', 'factory', `The factory merged PR #${PULL_REQUEST}`, {
    number: PULL_REQUEST,
    commit: MERGE,
    by: 'factory',
  })
  .at('58:11', 'release.started', 'factory', `${SHORT} released in a dry run: nothing shipped`, {
    release: RELEASE,
    version: MERGE,
    previous: PREVIOUS,
    commit: MERGE,
    watched: true,
    steps: [25, 50].map((weight) => ({ weight, pauseSeconds: EVERY, analysis: true })),
    dryRun: true,
  })
  .at('59:11', 'canary.stepped', 'factory', 'Canary at 25% in a dry run: nothing ran', step(25))
  .at('1:00:11', 'canary.stepped', 'factory', 'Canary at 50% in a dry run: nothing ran', step(50))
  .at('1:01:11', 'release.promoted', 'factory', `${SHORT} promoted in a dry run: nothing shipped`, {
    release: RELEASE,
    version: MERGE,
    previous: PREVIOUS,
    commit: MERGE,
    watched: true,
    dryRun: true,
  })
  .at('1:01:40', 'verification.finished', 'factory', `Cleared on ${SHORT}, by the dry run’s word`, {
    outcome: 'cleared',
    sense: 'probe',
    check: 'the products sort by name',
    version: MERGE,
    against: PREVIOUS,
    pages: [],
    dryRun: true,
  })
  .at('1:01:41', 'work-item.closed', 'factory', 'Verified by the dry run’s word, and closed', {
    outcome: 'verified',
    reason: 'The dry run’s word: its release never shipped, so no sense looked',
  });
