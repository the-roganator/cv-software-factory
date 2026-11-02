/**
 * An improvement Martin asked for: specified, approved, built behind a flag, shipped with it off, widened a stage at a
 * time to everyone (Verify's comparison at Share passing first), and closed as verified once the app held it there. Its
 * flag stays in Flags, Martin's to turn off.
 */
import { commitFor, Item } from '../build.ts';
import { changed, shot } from '../captures.ts';

/**
 * The front page the probes picture while a spec names no pages, with the flag off and on: the same to the pixel. The probes picture it in light and in dark: the app as published sets no colour scheme of its own, so the two are
 * the same picture.
 */
const HOME_OFF = shot('published/home', 'v0.9.0');
const HOME_ON = shot('last-one/home', 'v0.9.0');

export default new Item('1271', '2026-10-01T10:05:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin asked for an improvement from the console', {
    kind: 'improvement',
    title: 'Say when it is the last one',
    sample: true,
    category: 'improvement',
  })
  .at('0:00', 'improvement.requested', 'martin', 'Martin asked for an improvement: Say when it is the last one', {
    words:
      'Say when it is the last one. When a product has only one left, its card should say so under the price, so nobody misses it.',
    steppedUp: true,
  })
  .calls('planner', '0:20', '3:00', { calls: 3, input: 41_000, output: 3_300, cached: 0.3 })
  .at(
    '3:10',
    'spec.written',
    'planner',
    'Spec: three acceptance criteria, behind the last-one flag',
    {
      outcome: 'A product with one left says so on its card, behind the last-one flag',
      criteria: [
        {
          given: 'a product with one in stock',
          when: 'its card is shown',
          expect: 'it says “The last one” under the price',
        },
        { given: 'a product with more than one', when: 'its card is shown', expect: 'the card is as before' },
        { given: 'the flag is off', when: 'any card is shown', expect: 'every card is as before' },
      ],
      scope: ['src/pages/cards.ts', 'src/flags.ts', 'public/site.css', 'test/cards.test.ts'],
      risks: [],
      rollout: 'Ships behind the last-one flag, off, which Martin widens a stage at a time.',
      flag: 'last-one',
    },
    [shot('published/products', 'v0.8.5')],
  )
  .at('3:11', 'hold.started', 'factory', 'Waiting for Martin to approve the spec', {
    stage: 'plan',
    kind: 'approval',
    cause: 'spec',
    reason: 'An improvement is built only once Martin has approved its spec.',
  })
  .at('5:00', 'hold.answered', 'martin', 'Martin approved the spec', { decision: 'approved' })
  .calls('coder', '5:10', '14:20', { calls: 22, input: 610_000, output: 13_500, cached: 0.87 })
  .pushed('14:30', 'coder', 'Tests first, then the change · PR #1273', {
    number: 1273,
    title: 'feat(cards): say when it is the last one',
    branch: 'factory/1271-the-last-one',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/cards.ts', added: 6, removed: 1 },
      { path: 'src/flags.ts', added: 9, removed: 0 },
      { path: 'public/site.css', added: 9, removed: 0 },
      { path: 'test/cards.test.ts', added: 44, removed: 0 },
    ],
  })
  .gates('14:40', { pullRequest: 1273 })
  .calls('reviewer', '17:10', '19:30', { calls: 2, input: 46_000, output: 2_600, cached: 0.5 })
  .at('19:40', 'review.submitted', 'reviewer', 'Approved, with one suggestion taken', {
    pullRequest: 1273,
    verdict: 'approved',
    note: 'Suggested the tag be words as well as colour, so it reads without the green; the coder made it so.',
    findings: [
      {
        path: 'src/pages/cards.ts',
        line: 18,
        blocking: false,
        criterion: 1,
        comment: 'Say it in words as well as colour, so the tag reads without the green.',
      },
    ],
  })
  .at('19:50', 'pull-request.merged', 'factory', 'PR #1273 merged: low risk, so no one needed to approve it', {
    number: 1273,
    commit: commitFor('1271/merge'),
    by: 'factory',
  })
  .released(
    '20:30',
    'v0.9.0',
    'v0.8.5',
    [
      {
        errorRate: { canary: 0.002, baseline: 0.0021 },
        p99Ms: { canary: 130, baseline: 132 },
        journeys: { canary: [24, 24], baseline: [24, 24] },
      },
      {
        errorRate: { canary: 0.0021, baseline: 0.002 },
        p99Ms: { canary: 131, baseline: 132 },
        journeys: { canary: [24, 24], baseline: [24, 24] },
      },
    ],
    { promotion: 'v0.9.0 promoted to 100%, the last-one flag off' },
  )
  // Verify's baseline with the flag off, on the version it shipped in, before Martin widened it.
  .at(
    '24:00',
    'flag.checked',
    'factory',
    'last-one with the flag off, on v0.9.0: 24 of 24 checks passed',
    {
      stage: 'off',
      flag: 'last-one',
      version: 'v0.9.0',
      revision: 'none',
      journeys: { passed: 24, ran: 24 },
      notClean: [],
      pages: [
        { page: '/', route: '/', scheme: 'light', off: HOME_OFF.hash },
        { page: '/', route: '/', scheme: 'dark', off: HOME_OFF.hash },
      ],
    },
    [HOME_OFF],
  )
  .at('27:00', 'flag.staged', 'martin', 'Martin widened last-one from Off to Checks', {
    flag: 'last-one',
    from: { stage: 'off' },
    to: { stage: 'checks' },
    action: 'flag.to-checks',
    revision: 'r1',
    steppedUp: false,
  })
  .at(
    '33:00',
    'flag.checked',
    'factory',
    'last-one at Checks: passed',
    {
      stage: 'checks',
      flag: 'last-one',
      version: 'v0.9.0',
      revision: 'r1',
      moveRevision: 'r1',
      against: 'v0.9.0',
      outcome: 'passed',
      journeys: { base: { passed: 24, ran: 24 }, change: { passed: 24, ran: 24 } },
      regressions: [],
      pages: [
        {
          page: '/',
          route: '/',
          scheme: 'light',
          off: HOME_OFF.hash,
          on: HOME_ON.hash,
          changed: changed('last-one/home'),
        },
        {
          page: '/',
          route: '/',
          scheme: 'dark',
          off: HOME_OFF.hash,
          on: HOME_ON.hash,
          changed: changed('last-one/home'),
        },
      ],
    },
    [HOME_OFF, HOME_ON],
  )
  .at('1:10:00', 'flag.staged', 'martin', 'Martin widened last-one from Checks to Preview', {
    flag: 'last-one',
    from: { stage: 'checks' },
    to: { stage: 'preview' },
    action: 'flag.widen',
    revision: 'r2',
    steppedUp: true,
  })
  .at('1:16:00', 'flag.checked', 'factory', 'last-one at Preview: passed', {
    stage: 'preview',
    flag: 'last-one',
    version: 'v0.9.0',
    revision: 'r2',
    moveRevision: 'r2',
    against: 'v0.9.0',
    outcome: 'passed',
    journeys: { base: { passed: 24, ran: 24 }, change: { passed: 25, ran: 25 } },
    regressions: [],
    device: { allowed: ['cookie preview'], kept: [] },
  })
  .at('2:30:00', 'flag.staged', 'martin', 'Martin widened last-one from Preview to Share 50%', {
    flag: 'last-one',
    from: { stage: 'preview' },
    to: { stage: 'share', share: 50 },
    action: 'flag.widen',
    revision: 'r3',
    steppedUp: true,
  })
  .at('4:30:00', 'flag.compared', 'factory', 'last-one at Share 50%: flag on against off passed', {
    flag: 'last-one',
    share: 50,
    moveRevision: 'r3',
    // From a minute after the move, the time the app has to hold it. Five requests a second for 7,140 s, split by
    // which of the generator's 101 ids flagd puts on each side of last-one at 50%: 46 on, 55 off.
    window: { from: '2026-10-01T11:36:00.000Z', to: '2026-10-01T13:35:00.000Z' },
    setAsideMinutes: 0,
    outcome: 'passed',
    sides: {
      on: { requests: 16259, errorRate: 0.0097, p99Ms: 41 },
      off: { requests: 19441, errorRate: 0.0101, p99Ms: 40 },
    },
  })
  .at('5:00:00', 'flag.staged', 'martin', 'Martin widened last-one from Share 50% to Everyone', {
    flag: 'last-one',
    from: { stage: 'share', share: 50 },
    to: { stage: 'everyone' },
    action: 'flag.widen',
    revision: 'r4',
    steppedUp: true,
  })
  .at('5:01:00', 'work-item.closed', 'factory', 'Closed: last-one is on for everyone', {
    outcome: 'verified',
    reason: "Martin widened last-one to Everyone, after Verify's comparison at Share passed",
  })
  .at('5:01:01', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Say when it is the last one',
    description:
      'A product with one left now says “The last one” on its card. It shipped behind a flag, off, which Martin widened a stage at a time to everyone.',
    story:
      'Martin asked for products with one left to say so on their cards, so nobody has to open a product to find it is the last. The planner wrote a spec with three acceptance criteria, and Martin approved it. The coder wrote the tests first, then the change, behind the last-one flag. Every check passed, the reviewer’s one suggestion was taken, and v0.9.0 went out behind a canary with the flag off. Martin widened it a stage at a time: Checks, Preview, then half the traffic generator’s requests, where Verify compared the two sides and found them alike, and then everyone, where the line closed it as verified. Only the pages that list products changed.',
  });
