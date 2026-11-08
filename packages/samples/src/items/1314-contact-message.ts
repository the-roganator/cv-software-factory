/**
 * The canary in flight as the samples end: Martin merged the fix in the morning and his deploy in the afternoon, and
 * v0.9.13 has passed its 25% step and is being measured at 50%, against v0.9.12. The background analysis looks at
 * errors and latency each minute, and the line records each look a pass later: the first before the canary has had
 * the 100 requests that judge them, and the journeys, a Job of their own, once, on their own.
 */
import { commitFor, digestFor, Item, type LookFigures, started, stepped } from '../build.ts';

/**
 * Each version's figures over the three minutes to a look, at five requests a second, 900 in all: the canary has a
 * quarter of them from the release's start (a request at its first look, a second in) until the 50% step, then half.
 * Errors and latency are looked at a second past each minute; the journeys, after 90 seconds and every three minutes,
 * run a Job of about a minute.
 */
const look = (canary: number, errorRate: [number, number], p99Ms: [number, number]): LookFigures => ({
  requests: { canary, baseline: 900 - canary },
  errorRate: { canary: errorRate[0], baseline: errorRate[1] },
  p99Ms: { canary: p99Ms[0], baseline: p99Ms[1] },
});

export default new Item('1314', '2026-10-06T09:00:00+01:00')
  .probeTicket('0:00', {
    check: 'the contact form keeps the message',
    route: '/contact',
    version: 'v0.9.12',
    symptom: 'wrong-result',
    summary: 'Contact journey: after a send the shop refused, the message box was empty, twice in a row',
    exchange: { method: 'POST', url: '/contact', status: 503, timings: { firstByteMs: 22, totalMs: 25 } },
    title: 'The contact form loses your message',
    category: 'functional',
    severity: 'broken',
    description: 'When sending the contact form fails, the message is gone, and the visitor has to type it again.',
    story:
      'The contact journey’s message was refused with a 503, as it is when the shop’s mail is busy, and the form came back with its message box empty, twice in a row. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:10', '1:50', { calls: 2, input: 36_000, output: 2_500, cached: 0.3 })
  .at('2:00', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'A message survives a send that fails',
    criteria: [
      {
        given: 'a message in the contact form',
        when: 'sending it fails',
        expect: 'the form still holds the message, with the shop’s apology above it',
      },
      { given: 'a message in the contact form', when: 'sending it works', expect: 'the shop thanks the visitor' },
    ],
    scope: ['src/pages/contact.ts', 'test/contact.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:10', '39:30', { calls: 19, input: 520_000, output: 11_800, cached: 0.84 })
  .pushed('40:00', 'coder', 'A fix pushed to PR #1316', {
    number: 1316,
    title: 'fix(contact): keep the message when sending fails',
    branch: 'factory/1314-contact-message',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/contact.ts', added: 9, removed: 3 },
      { path: 'test/contact.test.ts', added: 27, removed: 0 },
    ],
  })
  .gates('40:10', { pullRequest: 1316, testsFirst: { failing: 1, of: 2 } })
  .calls('reviewer', '44:00', '46:00', { calls: 2, input: 44_000, output: 2_300, cached: 0.5 })
  .at('46:10', 'review.submitted', 'reviewer', 'Review of PR #1316: Approved', {
    pullRequest: 1316,
    verdict: 'approved',
    note: 'The form is drawn again from what was sent, and the test makes the send fail through the shop.',
    findings: [],
  })
  .calls('describer', '46:20', '48:00', { calls: 1, input: 23_000, output: 1_200, cached: 0.2 })
  .at('48:10', 'work-item.summarised', 'describer', 'Summary written', {
    title: 'The contact form loses your message',
    description:
      'A contact message was lost when sending it failed. The fix draws the form again with the message in it.',
    story:
      'The contact journey found that a message was cleared when sending it failed, so the visitor had to type it again. The planner asked for the message to survive a failed send. The coder wrote a test that makes the send fail through the shop, watched it fail, then drew the form again from what was sent. Every check passed and the reviewer approved.',
  })
  .at('48:11', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'The fix in pull request #1316 has passed its gates and review, and waits for Martin to merge it',
  })
  .at('1:10:00', 'pull-request.merged', 'martin', 'Martin merged PR #1316', {
    number: 1316,
    commit: commitFor('1314/merge'),
    by: 'martin',
  })
  .at('1:10:01', 'hold.started', 'factory', 'Waiting for a deploy pull request to carry the fix', {
    stage: 'release',
    kind: 'approval',
    cause: 'deploy',
    reason: 'The fix in pull request #1316 is merged, and waits for a deploy pull request to carry it to the shop',
  })
  // Its build's signing failed, and the deploy watch proposes no build its pipeline did not sign: once signing has had
  // its half hour, the line says so on the work item, naming the job. Martin runs the job again, and the build is
  // signed; the App opens the deploy pull request that carries it.
  .at(
    '1:46:00',
    'build.unsigned',
    'factory',
    `The build of ${commitFor('1314/merge').slice(0, 7)} that carries it was never signed: sign and attest did not succeed, so no deploy pull request carries it`,
    {
      commit: commitFor('1314/merge'),
      image: 'the-roganator/cv-worlds-worst-website',
      digest: digestFor('1314/merge'),
      signature: 'unsigned',
      reason: `the-roganator/cv-worlds-worst-website@${digestFor('1314/merge')} has no signature`,
      job: { run: 18_812_345_678, id: 53_412_345_678, name: 'sign and attest' },
    },
  )
  .at(
    '2:03:00',
    'build.signed',
    'factory',
    `A build that carries it, of ${commitFor('1314/merge').slice(0, 7)}, is signed by its pipeline`,
    { commit: commitFor('1314/merge'), digest: digestFor('1314/merge') },
  )
  .deploy('2:05:00', 1330, 1, 'checking')
  .deploy('2:09:30', 1330, 1, 'passed')
  .deploy('6:16:00', 1330, 1, 'merged')
  .at(
    '6:18:00',
    'release.started',
    'rollouts',
    'v0.9.13 signed and admitted; canary started',
    started('v0.9.13', 'v0.9.12'),
  )
  .looked('6:18:12', '6:18:01', 'v0.9.13', 25, look(1, [0, 0.0021], [124, 130]))
  .looked('6:19:12', '6:19:01', 'v0.9.13', 25, look(76, [0.0021, 0.0021], [126, 131]))
  .looked('6:20:12', '6:20:01', 'v0.9.13', 25, look(151, [0.0018, 0.0022], [128, 130]))
  .looked('6:20:52', '6:20:38', 'v0.9.13', 25, {
    ...look(198, [0.0019, 0.0021], [127, 130]),
    journeys: { canary: [24, 24], baseline: [24, 24] },
  })
  .at(
    '6:21:00',
    'canary.stepped',
    'rollouts',
    'Canary at 25%: the analysis passed',
    stepped('v0.9.13', 25, {
      errorRate: { canary: 0.0018, baseline: 0.0021 },
      p99Ms: { canary: 127, baseline: 130 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    }),
  )
  .looked('6:21:12', '6:21:01', 'v0.9.13', 50, look(226, [0.0018, 0.0021], [127, 130]))
  .looked('6:22:12', '6:22:01', 'v0.9.13', 50, look(301, [0.0017, 0.0022], [129, 131]))
  .looked('6:23:12', '6:23:01', 'v0.9.13', 50, look(376, [0.0019, 0.0021], [128, 130]));
