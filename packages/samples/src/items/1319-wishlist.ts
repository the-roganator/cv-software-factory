/**
 * Held at Build by the spend cap: the reviewer sent the first attempt back, and the coder's second step reached the
 * work item's cap part way through. The gateway refused its next calls, three within a minute, which it recorded as
 * one refusal, and the line holds the work for Martin.
 */
import { Item } from '../build.ts';

export default new Item('1319', '2026-10-06T11:30:00+01:00')
  .probeTicket('0:00', {
    check: 'the wishlist keeps what is added',
    route: '/wishlist',
    version: 'v0.9.7',
    symptom: 'wrong-result',
    summary: 'Wishlist journey: the list was empty after a second item was added',
    exchange: { method: 'POST', url: '/wishlist', status: 303, timings: { firstByteMs: 12, totalMs: 16 } },
    title: 'The wishlist empties itself',
    category: 'functional',
    severity: 'broken',
    description: 'Add a second thing to the wishlist, and the first one goes.',
    story:
      'The wishlist journey added a ladder and then a bucket, and found only the bucket. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:20', '3:10', { calls: 5, input: 97_000, output: 6_700, cached: 0.3 })
  .at('3:20', 'spec.written', 'planner', 'Spec written: 2 criteria, 3 paths in scope', {
    outcome: 'The wishlist keeps everything added to it, in the order it was added',
    criteria: [
      { given: 'a ladder on the wishlist', when: 'a bucket is added', expect: 'both are on it, the ladder first' },
      { given: 'a wishlist of three', when: 'one is removed', expect: 'the other two stay' },
    ],
    scope: ['src/pages/wishlist.ts', 'src/wishlist.ts', 'test/wishlist.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '3:30', '19:40', { calls: 34, input: 1_700_000, output: 52_000, cached: 0.7 })
  .pushed('19:50', 'coder', 'A fix pushed to PR #1320', {
    number: 1320,
    title: 'fix(wishlist): keep what is already on it',
    branch: 'factory/1319-wishlist',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/wishlist.ts', added: 11, removed: 6 },
      { path: 'test/wishlist.test.ts', added: 24, removed: 0 },
    ],
  })
  .gates('20:00', { pullRequest: 1320, testsFirst: { failing: 2, of: 2 } })
  .calls('reviewer', '22:30', '26:40', { calls: 6, input: 315_000, output: 20_000, cached: 0.4 })
  .at('26:50', 'review.submitted', 'reviewer', 'Review of PR #1320: Changes requested: 1 blocking finding', {
    pullRequest: 1320,
    verdict: 'changes-requested',
    note: 'The list now keeps its items, but removing one still drops every item after it.',
    findings: [
      {
        path: 'src/wishlist.ts',
        line: 22,
        blocking: true,
        criterion: 2,
        comment: 'Removing the second of three drops the third as well: the splice takes everything after it.',
      },
    ],
  })
  .at('26:51', 'work.returned', 'reviewer', '#1319 · round 2 · 1 blocking', {
    from: 'review',
    to: 'build',
    reason: 'Review asked for changes: removing one item still drops every item after it',
    round: 2,
    blocking: 1,
  })
  .calls('coder', '27:00', '41:20', { calls: 36, input: 1_820_000, output: 56_000, cached: 0.7 })
  .at('41:30', 'hold.started', 'factory', 'Held for Martin at build', {
    stage: 'build',
    kind: 'held',
    cause: 'spend',
    reason: 'The work item has spent $5.03 on models, and may spend $5.00',
    limitUsd: 5,
  })
  // Written after the hold, so every event before keeps its id; in time it comes first.
  .at('41:22', 'action.refused', 'factory', 'The gateway refused 3 model calls: the work item’s cap', {
    mechanism: 'gateway',
    action: 'A model call by the coder agent, the work item’s cap',
    output: 'The work item has spent $5.03 on models, and may spend $5.00: the gateway takes no more of its calls.',
    guardrails: [7],
    count: 3,
    lastAt: '2026-10-06T11:11:24.000Z',
  });
