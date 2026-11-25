import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branchFits,
  certainFail,
  isRoutine,
  moveFits,
  type PullFacts,
  pickScan,
  pinsFault,
  pinWatchLine,
  printOf,
  probeQuery,
  routineBranch,
  routineMajorBranch,
  type ScanRun,
  saysNotPulled,
  settleMs,
  staleTarget,
  targetOf,
  unreadMoves,
  withSetting,
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

describe('the scan that confirms a run', () => {
  const run = (id: number, over: Partial<ScanRun> = {}): ScanRun => ({
    id,
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    headSha: 'late',
    createdAt: `2026-11-25T03:${String(id).padStart(2, '0')}:00Z`,
    ...over,
  });
  const late = (sha: string) => sha === 'late';

  it('is the newest finished scan on a commit that holds every merge', () => {
    expect(pickScan([run(1), run(5), run(3, { headSha: 'early' })], late)).toEqual({ use: run(5) });
  });

  it('is never one GitHub cancelled: the one that replaced it is taken, or waited for', () => {
    const dispatched = run(48, { event: 'workflow_dispatch', conclusion: 'cancelled' });
    const pushed = run(50);
    expect(pickScan([dispatched, pushed], late)).toEqual({ use: pushed });
    const queued = run(50, { status: 'queued', conclusion: null });
    expect(pickScan([dispatched, queued], late)).toEqual({ wait: queued });
  });

  it('takes a finished one before waiting for a newer, since either confirms', () => {
    expect(pickScan([run(2), run(9, { status: 'in_progress', conclusion: null })], late)).toEqual({ use: run(2) });
  });

  it('is dispatched when no scan is on a commit that holds the merges, or the only ones left nothing', () => {
    expect(pickScan([run(1, { headSha: 'early' })], late)).toEqual({ dispatch: true });
    expect(pickScan([run(4)], late, new Set([4]))).toEqual({ dispatch: true });
    expect(pickScan([run(4, { event: 'pull_request' })], late)).toEqual({ dispatch: true });
    expect(pickScan([], late)).toEqual({ dispatch: true });
  });
});

describe("a batch's line in batch.env", () => {
  const names = [
    'a package in `deploy/overlays/local/factory-image/kustomization.yaml` and `pnpm-lock.yaml`',
    'kyverno: ghcr.io/kyverno/readiness-checker',
    "an odd 'one'",
  ];
  const sourced = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'batch-env-'));
    try {
      writeFileSync(join(dir, 'batch.env'), text);
      // As copies.sh reads it: sourced by bash, then handed on as one value.
      const show = ['source "$1"', 'printf %s "$' + '{PIN_WATCH_ONLY-unset}|$' + '{STAGED_EXTRA-unset}"'].join('; ');
      return execFileSync('bash', ['-c', show, '-', join(dir, 'batch.env')], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads back whole through a shell, spaces, backticks, colons and quotes too', () => {
    expect(sourced(withSetting('', 'PIN_WATCH_ONLY', pinWatchLine(names)))).toBe(`${names.join(',')}|unset`);
  });

  it('is written to an empty file, and replaces the line a file has, keeping the rest', () => {
    const first = withSetting('', 'PIN_WATCH_ONLY', pinWatchLine(['postgres']));
    expect(first).toBe("PIN_WATCH_ONLY='postgres'\n");
    const extra = withSetting(first, 'STAGED_EXTRA', 'STAGED_EXTRA=x2');
    const second = withSetting(extra, 'PIN_WATCH_ONLY', pinWatchLine(['loki', 'grafana']));
    expect(second).toBe("STAGED_EXTRA=x2\nPIN_WATCH_ONLY='loki,grafana'\n");
    expect(sourced(second)).toBe('loki,grafana|x2');
    expect(withSetting(second, 'STAGED_EXTRA', undefined)).toBe("PIN_WATCH_ONLY='loki,grafana'\n");
  });
});

describe("the worker's word that it cannot read the scan", () => {
  const now = Date.parse('2026-11-25T01:00:00Z');
  const line = (secondsAgo: number, why = "run 7's state cannot be read: no key") =>
    JSON.stringify({
      level: 40,
      time: now - secondsAgo * 1000,
      err: { message: `The scan's moves in example/factory-copy cannot be read: ${why}.` },
      msg: 'watch failed',
    });

  it('is quoted once said on three passes, the last of them just now', () => {
    const log = [line(150), '{"msg":"another line"}', line(90), line(20)].join('\n');
    expect(unreadMoves(log, now)).toBe(
      "The scan's moves in example/factory-copy cannot be read: run 7's state cannot be read: no key.",
    );
  });

  it('is not taken from one or two passes, or from passes long over', () => {
    expect(unreadMoves([line(90), line(20)].join('\n'), now)).toBeUndefined();
    expect(unreadMoves([line(900), line(840), line(780)].join('\n'), now)).toBeUndefined();
    expect(unreadMoves('', now)).toBeUndefined();
  });

  it('ends a move with no pull request, and no other', () => {
    const unread = "The scan's moves in example/factory-copy cannot be read: no key.";
    expect(certainFail({ mustHold: false, pulls: [], unread })).toMatch(/no pull request, and the worker cannot read/);
    expect(certainFail({ mustHold: true, pulls: [], unread })).toBeUndefined();
    const open = { number: 5, state: 'open', title: 't', head: 'h', red: [], pending: ['title'], touched: [] };
    expect(certainFail({ mustHold: false, pulls: [open], unread })).toBeUndefined();
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
