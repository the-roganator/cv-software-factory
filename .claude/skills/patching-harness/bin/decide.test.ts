import { describe, expect, it } from 'vitest';
import {
  branchFits,
  certainFail,
  isRoutine,
  moveFits,
  type PullFacts,
  pinsFault,
  printOf,
  probeQuery,
  routineBranch,
  routineMajorBranch,
  saysNotPulled,
  settleMs,
  staleTarget,
  targetOf,
  workflowPins,
} from './decide.ts';

const none = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };

describe('a routine move', () => {
  it('clears nothing, in a lane that moves it', () => {
    expect(isRoutine({ lane: 'worker', clears: none })).toBe(true);
    expect(isRoutine({ lane: 'line', clears: none })).toBe(true);
    expect(isRoutine({ lane: 'worker', clears: { ...none, MEDIUM: 1 } })).toBe(false);
    expect(isRoutine({ lane: 'none', clears: none })).toBe(false);
  });

  it('rides on a branch marked so, across a major or not', () => {
    expect(routineBranch('factory/pin/deploy-base-rollouts-argo-rollouts.yaml-routine-0a1b2c3d')).toBe(true);
    expect(routineBranch('factory/pin/pnpm-lock.yaml-routine-major-0a1b2c3d')).toBe(true);
    expect(routineBranch('factory/pin/pnpm-lock.yaml-major-0a1b2c3d')).toBe(false);
    expect(routineBranch('factory/pin/deploy-base-postgres-statefulset.yaml-0a1b2c3d')).toBe(false);
    expect(routineBranch('forged/routine-0a1b2c3d')).toBe(false);
    expect(routineBranch(undefined)).toBe(false);
  });
});

describe('the kind of move a test stands on', () => {
  const finding = { lane: 'worker', clears: { ...none, HIGH: 1 } };
  const routine = { lane: 'worker', clears: none };
  const major = { lane: 'worker', clears: none, major: true };

  it("is a finding's for a test that is not of a routine update, major or not", () => {
    expect(moveFits(finding, {})).toBe(true);
    expect(moveFits({ ...finding, major: true }, { major: true })).toBe(true);
    expect(moveFits(routine, {})).toBe(false);
    expect(moveFits(major, { major: true })).toBe(false);
  });

  it('is a routine update within its major, or across one, as the test is', () => {
    expect(moveFits(routine, { routine: true })).toBe(true);
    expect(moveFits(major, { routine: true })).toBe(false);
    expect(moveFits(major, { routine: true, major: true })).toBe(true);
    expect(moveFits(routine, { routine: true, major: true })).toBe(false);
    expect(moveFits(finding, { routine: true })).toBe(false);
  });

  it('has a branch of the same kind', () => {
    const plain = 'factory/pin/pnpm-lock.yaml-0a1b2c3d';
    const held = 'factory/pin/pnpm-lock.yaml-major-0a1b2c3d';
    const behind = 'factory/pin/pnpm-lock.yaml-routine-0a1b2c3d';
    const across = 'factory/pin/pnpm-lock.yaml-routine-major-0a1b2c3d';
    expect([plain, held, behind, across].map((b) => branchFits(b, {}))).toEqual([true, true, false, false]);
    expect([plain, held, behind, across].map((b) => branchFits(b, { routine: true }))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect([plain, held, behind, across].map((b) => branchFits(b, { routine: true, major: true }))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(routineMajorBranch(across)).toBe(true);
    expect(branchFits(undefined, {})).toBe(true);
  });
});

describe("a pull request opened from an earlier scan's move", () => {
  it("reads a target's version as a pin title writes it", () => {
    expect(targetOf('chart loki 21.5.0 (a major)')).toBe('21.5.0');
    expect(targetOf('image 18.7-alpine3.24@sha256:0115')).toBe('18.7-alpine3.24');
    expect(targetOf('k3s v1.37.2+k3s1')).toBe('v1.37.2+k3s1');
    expect(targetOf('')).toBeUndefined();
  });

  it('is told by its title naming another target', () => {
    const move = { name: 'loki', to: 'chart loki 21.5.0 (a major)' };
    expect(staleTarget('chore(pin): move loki to 21.4.3', move)).toMatch(
      /to 21\.4\.3, and the scan's move is to 21\.5\.0/,
    );
    expect(staleTarget('chore(pin): move loki to 21.5.0', move)).toBeUndefined();
  });

  it('says nothing of a title that is not that one move’s', () => {
    expect(
      staleTarget('chore(pin): move grafana to 14.5.0', { name: 'loki', to: 'chart loki 21.5.0' }),
    ).toBeUndefined();
    expect(
      staleTarget('chore(pin): move 4 pins in kyverno.yaml', { name: 'loki', to: 'chart loki 21.5.0' }),
    ).toBeUndefined();
    expect(staleTarget('chore(pin): move a to 1', { name: 'a', to: '' })).toBeUndefined();
  });
});

describe('the cheap look at a pull request', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    __typename: 'CheckRun',
    databaseId: 1,
    name: 'title',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    title: '',
    summary: '',
    ...over,
  });
  const node = (checks: unknown[], over: Record<string, unknown> = {}) => ({
    number: 7,
    state: 'OPEN',
    updatedAt: '2026-11-24T00:00:00Z',
    mergedAt: null,
    headRefOid: 'a'.repeat(40),
    isInMergeQueue: false,
    timelineItems: { totalCount: 3 },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: checks.length, nodes: checks } } } }] },
    ...over,
  });
  const required = ['title', 'platform'];

  it('asks for every number under a name of its own', () => {
    const query = probeQuery([7, 12]);
    expect(query).toContain('p7: pullRequest(number: 7)');
    expect(query).toContain('p12: pullRequest(number: 12)');
    expect(query).not.toMatch(/\bmutation\b/);
  });

  it('gives the same print for the same reading, whatever the order of the checks', () => {
    const a = run();
    const b = run({ databaseId: 2, name: 'platform', status: 'IN_PROGRESS', conclusion: null });
    expect(printOf(node([a, b]), required)).toBe(printOf(node([b, a]), required));
  });

  it.each([
    ['a required check finishing', node([run({ status: 'IN_PROGRESS', conclusion: null })]), node([run()])],
    ['a required check failing', node([run()]), node([run({ conclusion: 'FAILURE' })])],
    ['a required check run again', node([run()]), node([run({ databaseId: 9 })])],
    ['a new head', node([run()]), node([run()], { headRefOid: 'b'.repeat(40) })],
    ['the merge', node([run()]), node([run()], { state: 'MERGED', mergedAt: '2026-11-24T01:00:00Z' })],
    ['the merge queue', node([run()]), node([run()], { isInMergeQueue: true })],
    ['a comment or a person’s act', node([run()]), node([run()], { timelineItems: { totalCount: 4 } })],
    ['a title or a label', node([run()]), node([run()], { updatedAt: '2026-11-24T00:05:00Z' })],
    [
      "the gate's words",
      node([run({ name: 'review', summary: 'held' })]),
      node([run({ name: 'review', summary: 'passed as move' })]),
    ],
  ])('changes with %s', (_, before, after) => {
    expect(printOf(before, required)).not.toBe(printOf(after, required));
  });

  it('does not change with a check that is not required', () => {
    const other = run({ databaseId: 5, name: 'senses browser', status: 'IN_PROGRESS', conclusion: null });
    expect(printOf(node([run(), other]), required)).toBe(
      printOf(node([run(), { ...other, status: 'COMPLETED', conclusion: 'FAILURE' }]), required),
    );
  });

  it('cannot stand for a reading with more checks than it lists, or no pull request', () => {
    const cut = node([run()], {
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 101, nodes: [run()] } } } }] },
    });
    expect(printOf(cut, required)).toBeUndefined();
    expect(printOf(null, required)).toBeUndefined();
  });
});

describe('a failure that is certain before the limit', () => {
  const pull = (over: Partial<PullFacts> = {}): PullFacts => ({
    number: 5,
    state: 'open',
    title: 'chore(pin): move loki to 21.5.0',
    head: 'h1',
    red: [],
    pending: [],
    touched: [],
    ...over,
  });

  it('is a merge of what must not merge, and nothing else of it', () => {
    expect(certainFail({ mustHold: true, pulls: [pull({ state: 'merged' })] })).toBe('#5 merged, and must not');
    expect(certainFail({ mustHold: true, pulls: [pull({ red: ['title'] })] })).toBeUndefined();
    expect(certainFail({ mustHold: true, pulls: [pull({ state: 'closed' })] })).toBeUndefined();
    expect(certainFail({ mustHold: true, pulls: [] })).toBeUndefined();
  });

  it('is more than one pull request for a move, or its one closed unmerged', () => {
    expect(certainFail({ mustHold: false, pulls: [pull(), pull({ number: 6 })] })).toBe('2 pull requests, not one');
    expect(certainFail({ mustHold: false, pulls: [pull({ state: 'closed' })] })).toBe('#5 closed unmerged');
  });

  it('is a merge a person touched, or one of an earlier scan’s target', () => {
    expect(
      certainFail({ mustHold: false, pulls: [pull({ state: 'merged', touched: ['approved by martin'] })] }),
    ).toMatch(/touched: approved by martin/);
    const moves = [{ name: 'loki', to: 'chart loki 21.6.0 (a major)' }];
    expect(certainFail({ mustHold: false, pulls: [pull({ state: 'merged' })], moves })).toMatch(/21\.5\.0.*21\.6\.0/);
    expect(
      certainFail({
        mustHold: false,
        pulls: [pull({ state: 'merged' })],
        moves: [{ name: 'loki', to: 'chart loki 21.5.0' }],
      }),
    ).toBeUndefined();
  });

  it('is a red head only once the App has said it writes it no more', () => {
    const red = pull({ red: ['title'] });
    expect(certainFail({ mustHold: false, pulls: [red] })).toBeUndefined();
    expect(certainFail({ mustHold: false, pulls: [red], spent: ['another'] })).toBeUndefined();
    expect(certainFail({ mustHold: false, pulls: [{ ...red, pending: ['platform'] }], spent: ['h1'] })).toBeUndefined();
    expect(certainFail({ mustHold: false, pulls: [red], spent: ['h1'] })).toMatch(/#5 red \(title\)/);
  });

  it('is nothing while the move may still merge and deploy', () => {
    expect(certainFail({ mustHold: false, pulls: [] })).toBeUndefined();
    expect(certainFail({ mustHold: false, pulls: [pull({ pending: ['platform'] })] })).toBeUndefined();
    expect(certainFail({ mustHold: false, pulls: [pull({ state: 'merged' })] })).toBeUndefined();
  });
});

describe("the scan's word on an image not read", () => {
  it('is its opening words and then the image, on one line', () => {
    const image = 'ghcr.io/anchore/grype';
    expect(saysNotPulled(`Image not read: ${image}:unread@sha256:59dc: could not be read`, image)).toBe(true);
    expect(saysNotPulled(`Image not read: a stage: ${image}:unread: MANIFEST_UNKNOWN`, image)).toBe(true);
    expect(saysNotPulled(`Read: ${image}`, image)).toBe(false);
    expect(saysNotPulled(`${image} first\nImage not read: another/image: gone`, image)).toBe(false);
  });
});

describe('how long nothing after is', () => {
  it("is nine of the worker's passes, and three minutes at least", () => {
    expect(settleMs(60)).toBe(9 * 60_000);
    expect(settleMs(15)).toBe(3 * 60_000);
    expect(settleMs(undefined)).toBe(9 * 60_000);
    expect(settleMs(0)).toBe(9 * 60_000);
  });
});

describe("the app's pins of the factory's workflows", () => {
  const repo = 'example/factory-copy';
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const caller = (commit: string, file: string) =>
    `jobs:\n  call:\n    uses: ${repo}/.github/workflows/${file}@${commit} # main\n    steps:\n      - uses: actions/checkout@${'c'.repeat(40)} # v6\n`;

  it('reads each pin, and no other action’s', () => {
    expect(workflowPins(caller(a, 'review.yml'), repo)).toEqual([{ workflow: 'review.yml', commit: a }]);
    expect(workflowPins(caller(a, 'review.yml'), 'example/factory')).toEqual([]);
  });

  it('passes when every pin is at the one commit', () => {
    const files = { 'x.yml': caller(a, 'review.yml'), 'y.yml': caller(a, 'codeql.yml') };
    expect(pinsFault(files, repo, a, 2)).toBeUndefined();
  });

  it('names a pin left behind, and a count that is not the one expected', () => {
    const files = { 'x.yml': caller(a, 'review.yml'), 'y.yml': caller(b, 'codeql.yml') };
    expect(pinsFault(files, repo, a, 2)).toBe('y.yml at bbbbbbb, not aaaaaaa');
    expect(pinsFault(files, repo, a, 6)).toMatch(/^2 pins of .*, not 6$/);
  });
});
