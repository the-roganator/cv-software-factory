/**
 * An improvement part way out behind its flag. Martin asked for delivery dates on each product page; the planner named
 * the flag, `delivery-dates`, Martin approved the spec and the pull request, and it shipped in v0.9.5, beside #1296's
 * fix, with the flag off. He widened it to Checks, which asks for no passkey, and later to Preview, with his passkey.
 * It waits for him at Preview: Share comes next, and while a canary is in flight it can't be taken.
 */
import { commitFor, Item } from '../build.ts';
import { shot } from '../captures.ts';

/** The flag the spec names, and the one the Flags panel draws. */
export const FLAG = 'delivery-dates';

/**
 * The front page, which the probes picture while a spec names no pages, with the flag off and on. The change is to the
 * product pages, so it is the same to the pixel. The probes picture it in light and in dark: the app as published sets no colour scheme of its own, so the two are
 * the same picture.
 */
const HOME = shot('published/home', 'v0.9.5');

export default new Item('1294', '2026-10-03T07:50:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin asked for an improvement from the console', {
    kind: 'improvement',
    title: 'Delivery dates on each product',
    sample: true,
    category: 'improvement',
  })
  .at('0:00', 'improvement.requested', 'martin', 'Martin asked for an improvement: Delivery dates on each product', {
    words:
      'Delivery dates on each product. Each product page should say when an order placed today would arrive, counting only the days we dispatch on.',
    steppedUp: true,
  })
  .calls('planner', '0:20', '3:30', { calls: 3, input: 39_000, output: 3_100, cached: 0.3 })
  .at('3:40', 'spec.written', 'planner', `Spec: four acceptance criteria, behind the ${FLAG} flag`, {
    outcome: `Each product page says when an order placed today would arrive, behind the ${FLAG} flag`,
    criteria: [
      {
        given: 'the flag is on',
        when: 'a product page is shown',
        expect: 'it says when an order placed today would arrive',
      },
      { given: 'it is Friday after noon', when: 'a product page is shown', expect: 'the date given is Tuesday' },
      { given: 'a product that is out of stock', when: 'its page is shown', expect: 'no date is given' },
      { given: 'the flag is off', when: 'any product page is shown', expect: 'it is as before' },
    ],
    scope: ['src/pages/product.ts', 'src/delivery.ts', 'src/flags.ts', 'public/site.css', 'test/delivery.test.ts'],
    risks: [],
    rollout: `Ships behind the ${FLAG} flag, off, which Martin widens a stage at a time.`,
    flag: FLAG,
  })
  .at('3:41', 'hold.started', 'factory', 'Waiting for Martin to approve the spec', {
    stage: 'plan',
    kind: 'approval',
    cause: 'spec',
    reason: 'An improvement is built only once Martin has approved its spec.',
  })
  .at('12:00', 'hold.answered', 'martin', 'Martin approved the spec', { decision: 'approved' })
  .calls('coder', '12:30', '30:00', { calls: 24, input: 640_000, output: 14_100, cached: 0.86 })
  .pushed('30:30', 'coder', 'Tests first, with the flag on and off · PR #1295', {
    number: 1295,
    title: 'feat(products): say when an order would arrive',
    branch: 'factory/1294-delivery-dates',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/product.ts', added: 22, removed: 2 },
      { path: 'src/delivery.ts', added: 31, removed: 0 },
      { path: 'src/flags.ts', added: 3, removed: 0 },
      { path: 'public/site.css', added: 6, removed: 0 },
      { path: 'test/delivery.test.ts', added: 58, removed: 0 },
    ],
  })
  .gates('30:40', { pullRequest: 1295 })
  .calls('reviewer', '33:00', '38:00', { calls: 2, input: 52_000, output: 2_700, cached: 0.5 })
  .at('38:10', 'review.submitted', 'reviewer', 'Review of PR #1295: Approved', {
    pullRequest: 1295,
    verdict: 'approved',
    note: 'Every criterion has a test with the flag on, and the last with it off; the dates follow the dispatch days.',
    findings: [],
  })
  .at('38:11', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'An improvement’s pull request waits for Martin to merge it, whatever the autonomy level',
  })
  .at('1:23:00', 'pull-request.merged', 'martin', 'Martin merged PR #1295', {
    number: 1295,
    commit: commitFor('1294/merge'),
    by: 'martin',
  })
  // Out in v0.9.5 beside #1296's fix, with the flag off: nobody sees a change.
  .released(
    '1:24:20',
    'v0.9.5',
    'v0.9.4',
    [
      {
        summary: 'Canary at 25%: every price above zero on the canary',
        errorRate: { canary: 0.0019, baseline: 0.0021 },
        p99Ms: { canary: 129, baseline: 131 },
        journeys: { canary: [24, 24], baseline: [23, 24] },
      },
      {
        errorRate: { canary: 0.002, baseline: 0.0021 },
        p99Ms: { canary: 130, baseline: 132 },
        journeys: { canary: [24, 24], baseline: [23, 24] },
      },
    ],
    { promotion: `v0.9.5 promoted to 100%, the ${FLAG} flag off` },
  )
  // Verify's baseline with the flag off, on the version it shipped in, before Martin widened it.
  .at(
    '1:31:00',
    'flag.checked',
    'factory',
    `${FLAG} with the flag off, on v0.9.5: 22 of 24 checks passed`,
    {
      stage: 'off',
      flag: FLAG,
      version: 'v0.9.5',
      revision: 'r4',
      journeys: { passed: 22, ran: 24 },
      notClean: [
        {
          sense: 'probe',
          check: 'search-finds-products',
          route: '/search',
          failed: true,
          message: 'A search for a product named on the page found nothing',
        },
        { sense: 'probe', check: 'contact-sends', route: '/contact', failed: false, message: 'took longer than 120 s' },
      ],
      pages: [
        { page: '/', route: '/', scheme: 'light', off: HOME.hash },
        { page: '/', route: '/', scheme: 'dark', off: HOME.hash },
      ],
    },
    [HOME],
  )
  .at('2:10:00', 'flag.staged', 'martin', `Martin widened ${FLAG} from Off to Checks`, {
    flag: FLAG,
    from: { stage: 'off' },
    to: { stage: 'checks' },
    action: 'flag.to-checks',
    revision: 'r5',
    steppedUp: false,
  })
  .at(
    '2:16:00',
    'flag.checked',
    'factory',
    `${FLAG} at Checks: passed`,
    {
      stage: 'checks',
      flag: FLAG,
      version: 'v0.9.5',
      revision: 'r5',
      moveRevision: 'r5',
      against: 'v0.9.5',
      outcome: 'passed',
      journeys: { base: { passed: 22, ran: 24 }, change: { passed: 22, ran: 24 } },
      regressions: [],
      pages: [
        { page: '/', route: '/', scheme: 'light', off: HOME.hash, on: HOME.hash, changed: 0 },
        { page: '/', route: '/', scheme: 'dark', off: HOME.hash, on: HOME.hash, changed: 0 },
      ],
    },
    [HOME],
  )
  .at('5:30:00', 'flag.staged', 'martin', `Martin widened ${FLAG} from Checks to Preview`, {
    flag: FLAG,
    from: { stage: 'checks' },
    to: { stage: 'preview' },
    action: 'flag.widen',
    revision: 'r6',
    steppedUp: true,
  })
  .at('5:36:00', 'flag.checked', 'factory', `${FLAG} at Preview: passed`, {
    stage: 'preview',
    flag: FLAG,
    version: 'v0.9.5',
    revision: 'r6',
    moveRevision: 'r6',
    against: 'v0.9.5',
    outcome: 'passed',
    journeys: { base: { passed: 22, ran: 24 }, change: { passed: 23, ran: 25 } },
    regressions: [],
    device: { allowed: ['cookie preview'], kept: [] },
  })
  .at('5:36:01', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Delivery dates on each product',
    description:
      'Each product page says when an order would arrive, behind its flag. It shipped off, and Martin has widened it to Preview.',
    story:
      'Martin asked for each product page to say when an order would arrive. The planner wrote a spec naming its flag, delivery-dates, the one page it changes and four acceptance criteria, proved by the pull request’s own tests with the flag on and off. Martin approved the spec and the pull request, and it shipped in v0.9.5 with the flag off. Since then it has gone out a stage at a time, each one Martin’s.',
  });
