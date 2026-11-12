/** A security release of the base image: the scan's high findings gone, and no page changed. */
import { commitFor, Item } from '../build.ts';

const SCAN = {
  before: { critical: 0, high: 2, medium: 5, low: 11, unknown: 2 },
  after: { critical: 0, high: 0, medium: 3, low: 9, unknown: 2 },
};

/** The lockfile is the same on both sides: the move changes no package, so it has what it had. */
const LOCKFILE = {
  before: { critical: 0, high: 0, medium: 1, low: 2, unknown: 0 },
  after: { critical: 0, high: 0, medium: 1, low: 2, unknown: 0 },
};

export default new Item('1282', '2026-10-02T11:30:00+01:00')
  .at('0:00', 'work-item.opened', 'dependabot', 'Dependabot proposed Node.js 24.21.1, a security release', {
    kind: 'dependency-update',
    title: 'Node.js 24.21.1',
    sample: true,
    category: 'security',
    dependency: { name: 'Node.js base image', ecosystem: 'docker', from: '24.21.0', to: '24.21.1', security: true },
  })
  .pushed('0:02', 'dependabot', 'Dependabot opened PR #1283: node 24.21.0 → 24.21.1', {
    number: 1283,
    title: 'chore(deps): bump node from 24.21.0 to 24.21.1',
    branch: 'dependabot/docker/node-24.21.1',
    attempt: 1,
    testsFirst: false,
    files: [
      { path: 'Dockerfile', added: 1, removed: 1 },
      { path: 'mise.toml', added: 1, removed: 1 },
    ],
  })
  .gates('0:10', {
    pullRequest: 1283,
    more: [['Lockfile scan', 30]],
    details: {
      'Image scan': { summary: 'No critical or high findings; two high findings fewer', findings: SCAN },
      'Lockfile scan': { findings: LOCKFILE },
    },
  })
  .calls('reviewer', '3:00', '5:20', { calls: 2, input: 31_000, output: 1_700, cached: 0.5 })
  .at('5:30', 'review.submitted', 'reviewer', 'Approved; a dependency change, so it waits for Martin', {
    pullRequest: 1283,
    verdict: 'approved',
    note: 'A patch release with two security fixes and no other change.',
    findings: [],
  })
  .at('5:31', 'hold.started', 'factory', 'Waiting for Martin: dependency changes carry a risk tag', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'A dependency change carries a risk tag, so it waits for Martin to approve the merge.',
  })
  .at('8:40', 'hold.answered', 'martin', 'Martin approved the merge', { decision: 'approved' })
  .at('8:45', 'pull-request.merged', 'factory', 'PR #1283 merged', {
    number: 1283,
    commit: commitFor('1282/merge'),
    by: 'factory',
  })
  .released('11:00', 'v0.9.2', 'v0.9.0', [
    {
      errorRate: { canary: 0.002, baseline: 0.0021 },
      p99Ms: { canary: 131, baseline: 133 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
    {
      errorRate: { canary: 0.0019, baseline: 0.0022 },
      p99Ms: { canary: 130, baseline: 133 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  ])
  .verify('22:00', 'Every page matches v0.9.0, to the pixel', {
    check: 'Every page compared with v0.9.0',
    against: 'v0.9.0',
    version: 'v0.9.2',
  })
  .at('22:01', 'work-item.closed', 'factory', 'Closed: verified', {
    outcome: 'verified',
    reason: 'No high findings, and every page matches the version before',
  })
  .at('22:02', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Node.js 24.21.1 security release',
    description:
      'The base image moved to Node.js 24.21.1. The image scan’s two high findings are gone, and no page changed.',
    story:
      'Dependabot moved the app’s base image to the Node.js 24.21.1 security release. The image scan found two high-severity findings in the old image and none in the new one. The reviewer approved and, as a dependency change, it waited for Martin, who approved it. After rollout every page matched its screenshot from the version before, to the pixel.',
  });
