import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branchFits,
  certainFail,
  type DuplicateFacts,
  dependabotMissing,
  duplicateVerdict,
  factoryBusy,
  type HoldFacts,
  holdBroken,
  holdDecided,
  isRoutine,
  issueFault,
  issueOfMove,
  leftAloneFault,
  lockfileKey,
  moveFits,
  newerFault,
  type PullFacts,
  pickScan,
  pinsFault,
  pinWatchLine,
  printOf,
  probeQuery,
  queuedFault,
  restartVerdict,
  routineBranch,
  routineMajorBranch,
  type ScanRun,
  saysNotPulled,
  settleMs,
  staleTarget,
  stillListed,
  type TicketFacts,
  targetOf,
  ticketFault,
  unreadMoves,
  withoutDependabot,
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

describe('a move the next scan still lists', () => {
  const lockfile = 'a package in `pnpm-lock.yaml`';

  it('is one of the first scan, by its name and the version its pins held', () => {
    const before = [{ name: 'prometheus', from: '29.35.0' }];
    expect(stillListed(before, [{ name: 'prometheus', from: '29.35.0' }])).toHaveLength(1);
  });

  it('is not the next move of the same pin, from the version the first moved to', () => {
    const before = [{ name: 'prometheus', from: '29.35.0' }];
    expect(stillListed(before, [{ name: 'prometheus', from: '29.49.0' }])).toEqual([]);
  });

  it('is not a move of another name from the same version', () => {
    expect(stillListed([{ name: 'loki', from: '1.0.0' }], [{ name: 'grafana', from: '1.0.0' }])).toEqual([]);
  });

  it('keeps every lockfile move of the name, as none says its version, so they are counted as before', () => {
    const before = [1, 2, 3].map(() => ({ name: lockfile, from: '' }));
    const after = [1, 2].map(() => ({ name: lockfile, from: '' }));
    expect(stillListed(before, after)).toHaveLength(2);
    expect(stillListed([], after)).toEqual([]);
  });
});

describe('the factory copy at rest, for an app run', () => {
  const app = 'scratch[bot]';
  const pin = { number: 885, title: 'chore(pin): move prometheus to 29.49.0', author: app };
  const deploy = { number: 884, title: 'chore(deploy): run console 108575d and the factory 108575d', author: app };
  const at = { app, main: 'aaa', baseline: 'aaa' };

  it("rests with nothing open, or only others' pull requests", () => {
    expect(factoryBusy({ ...at, pulls: [] })).toBeUndefined();
    const others = [
      { number: 3, title: 'chore(deps): Bump the "playwright" group', author: 'dependabot[bot]' },
      { number: 9, title: 'chore(pin): move postgres to 18.7', author: 'mrogan' },
      { number: 10, title: 'chore(main): release 1.2.0', author: app },
    ];
    expect(factoryBusy({ ...at, pulls: others })).toBeUndefined();
  });

  it("does not rest while a pin move of the App's is open, at the baseline or past it", () => {
    expect(factoryBusy({ ...at, pulls: [pin] })).toContain('#885');
    expect(factoryBusy({ ...at, main: 'bbb', pulls: [pin] })).toContain('#885');
  });

  it('passes over the deploy pin a reset leaves on the baseline, red by design', () => {
    expect(factoryBusy({ ...at, pulls: [deploy] })).toBeUndefined();
  });

  it('does not rest while a deploy pin is open on a main past the baseline', () => {
    const why = factoryBusy({ ...at, main: 'bbb', pulls: [deploy, pin] });
    expect(why).toContain('#885, #884');
    expect(why).toContain('deploy pin');
  });
});

describe('a hold, decided at one head and kept', () => {
  const held: HoldFacts = { number: 18, state: 'open', head: 'a'.repeat(40), red: [], pending: [], touched: [] };
  const major = { ...held, rule: 'major' };

  it('is decided for a head the gate passed once the worker says it waits for the level', () => {
    expect(holdDecided(major, 'level', false)).toBe(true);
    expect(holdDecided(major, 'verdict', false)).toBe(false);
    expect(holdDecided(major, undefined, false)).toBe(false);
  });

  it('is decided for a head the gate held once the worker says it waits for the verdict', () => {
    expect(holdDecided({ ...held, rule: 'held' }, 'verdict', false)).toBe(true);
    expect(holdDecided({ ...held, rule: 'held' }, 'level', false)).toBe(false);
  });

  it('is not decided while anything is pending, red, queued, merged or unjudged', () => {
    expect(holdDecided({ ...major, pending: ['platform'] }, 'level', false)).toBe(false);
    expect(holdDecided({ ...major, gatePending: 'checks' }, 'level', false)).toBe(false);
    expect(holdDecided({ ...major, red: ['title'] }, 'level', false)).toBe(false);
    expect(holdDecided({ ...major, queuedBy: 'scratch[bot]' }, 'level', false)).toBe(false);
    expect(holdDecided({ ...major, state: 'merged' }, 'level', false)).toBe(false);
    expect(holdDecided(held, 'level', false)).toBe(false);
  });

  it("is decided for a forgery by its checks and the gate's verdict alone", () => {
    expect(holdDecided({ ...held, rule: 'held', red: ['title'] }, undefined, true)).toBe(true);
    expect(holdDecided({ ...held, pending: ['review'] }, undefined, true)).toBe(false);
  });

  it('stands at a later head whose checks are pending or red, or which the gate has not judged', () => {
    const later = { ...held, head: 'b'.repeat(40), pending: ['platform', 'review'] };
    expect(holdBroken([later], 'major')).toBeUndefined();
    expect(holdBroken([{ ...later, pending: [], red: ['platform'], rule: 'major' }], 'major')).toBeUndefined();
    expect(holdBroken([{ ...later, rule: 'held', gatePending: 'checks' }], 'major')).toBeUndefined();
    expect(holdBroken([{ ...later, state: 'closed' }], 'major')).toBeUndefined();
  });

  it('is broken by a merge, a queue entry, or anyone touching it', () => {
    expect(holdBroken([{ ...major, state: 'merged' }], 'major')).toBe('#18 merged, and must not');
    expect(holdBroken([{ ...major, queuedBy: 'scratch[bot]' }], 'major')).toContain('queued by scratch[bot]');
    expect(holdBroken([{ ...major, touched: ['labeled by mrogan'] }], 'major')).toContain('labeled by mrogan');
  });

  it('is broken by a later verdict of the gate by another rule, where a rule is asked', () => {
    expect(holdBroken([{ ...major, rule: 'move' }], 'major')).toContain('is move, not major');
    expect(holdBroken([{ ...major, rule: 'held' }], 'major')).toContain('is held, not major');
    expect(holdBroken([{ ...major, rule: 'move' }])).toBeUndefined();
  });
});

describe('a move that must not merge, and the merge queue', () => {
  it('fails once it was queued, merged yet or not', () => {
    expect(queuedFault([{ number: 18, queuedBy: 'scratch[bot]' }])).toBe(
      '#18 was added to the merge queue by scratch[bot], and must never be',
    );
    expect(queuedFault([{ number: 17 }, { number: 18, queuedBy: 'mrogan' }])).toContain('#18');
  });

  it('has no fault while none was ever queued', () => {
    expect(queuedFault([{ number: 18 }, { number: 19, queuedBy: undefined }])).toBeUndefined();
    expect(queuedFault([])).toBeUndefined();
  });
});

describe("the pull requests of Dependabot's a run needs open as it starts", () => {
  const needs = [
    { test: 'N1', title: /bump node from/i },
    { test: '12', title: /anchore\/syft/i },
  ];

  const BASELINE = '2026-11-25T10:00:00Z';
  const pull = (number: number, title: string, headAt = '2026-11-25T10:04:00Z', conflicting?: boolean) => ({
    number,
    title,
    headAt,
    conflicting: conflicting ?? false,
  });
  const node = 'chore(deps): bump node from 24.22.0 to 24.22.3';
  const syft = 'chore(deps): Bump anchore/syft from v1.54.0';

  it('lacks none when each has an open one of its title, made since the baseline and without a conflict', () => {
    expect(dependabotMissing(needs, [pull(4, node), pull(7, syft)], BASELINE)).toEqual([]);
    expect(dependabotMissing([], [], BASELINE)).toEqual([]);
    // One needed as it is counts on any base, conflicting or not, so long as it is open.
    const asIs = [{ test: '22', title: /anchore\/syft/i, asIs: true }];
    expect(dependabotMissing(asIs, [pull(7, syft, '2026-11-15T08:00:00Z', true)], BASELINE)).toEqual([]);
    expect(dependabotMissing(asIs, [], BASELINE)[0]).toContain('none is');
    // One Dependabot opened itself counts at any age, unless it conflicts or GitHub has not said.
    const anyAge = [{ test: '22', title: /anchore\/syft/i, anyAge: true }];
    expect(dependabotMissing(anyAge, [pull(7, syft, '2026-11-15T08:00:00Z', false)], BASELINE)).toEqual([]);
    expect(dependabotMissing(anyAge, [pull(7, syft, '2026-11-15T08:00:00Z', true)], BASELINE)[0]).toContain(
      'conflicts with main',
    );
    expect(dependabotMissing(anyAge, [], BASELINE)[0]).toContain('none is');
  });

  it('drops a test that lacks one while others are left to judge, and stops the run when none is', () => {
    const missing = [{ test: '22', why: 'test 22 needs one' }];
    expect(withoutDependabot(missing, ['1', '2', '22'])).toEqual({ dropped: { '22': 'test 22 needs one' }, stop: [] });
    expect(withoutDependabot(missing, ['22'])).toEqual({ dropped: {}, stop: ['test 22 needs one'] });
    expect(withoutDependabot([], ['1', '22'])).toEqual({ dropped: {}, stop: [] });
    const two = [...missing, { test: '22', why: 'and another' }];
    expect(withoutDependabot(two, ['1', '22']).dropped['22']).toBe('test 22 needs one; and another');
  });

  it('names each test whose pull request is not open', () => {
    const missing = dependabotMissing(needs, [pull(4, node)], BASELINE);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('test 12');
    expect(missing[0]).toContain('open, and none is');
    expect(dependabotMissing(needs, [], BASELINE)).toHaveLength(2);
  });

  it('lacks one opened again whose branch Dependabot has not made again on the baseline, or that conflicts', () => {
    // Reopened: its head is the one it was closed with, from before the baseline.
    const stale = dependabotMissing(needs, [pull(4, node), pull(7, syft, '2026-11-24T08:00:00Z')], BASELINE);
    expect(stale).toEqual([expect.stringContaining("test 12 needs Dependabot's pull request")]);
    expect(stale[0]).toContain("#7's head is from before it");
    const conflicting = dependabotMissing(needs, [pull(4, node), pull(7, syft, undefined, true)], BASELINE);
    expect(conflicting[0]).toContain('#7 conflicts with main');
    // GitHub works a conflict out after a push: until it has, the pull request is not yet the one the test needs.
    const unknown = [pull(4, node), { ...pull(7, syft), conflicting: undefined }];
    expect(dependabotMissing(needs, unknown, BASELINE)[0]).toContain('has not said whether #7 has one');
    // One of the title that is ready is enough, whatever another of it is.
    const two = [pull(4, node), pull(7, syft, '2026-11-24T08:00:00Z'), pull(9, syft)];
    expect(dependabotMissing(needs, two, BASELINE)).toEqual([]);
  });
});

describe('an issue that must say why', () => {
  const app = 'scratch[bot]';
  const wants = { names: ['lefthook', '2.2.2'], says: [/weaker provenance/], never: [/log says which/] };
  const issue = (body: string, author = app) => ({ number: 891, author, title: 'Move a package', body });

  it("passes when the App's issue names the package and release in code and says why", () => {
    const body = 'pnpm refused `lefthook` at `2.2.2`: it has a weaker provenance than the release before.';
    expect(issueFault([issue(body)], app, wants)).toEqual({ number: 891 });
  });

  it("finds no issue when none names both in code, or the one that does is not the App's", () => {
    expect(issueFault([issue('lefthook 2.2.2, a weaker provenance')], app, wants).fault).toContain('no issue');
    const body = '`lefthook` `2.2.2` weaker provenance';
    expect(issueFault([issue(body, 'mrogan')], app, wants).fault).toContain('no issue');
    expect(issueFault([], app, wants).number).toBeUndefined();
  });

  it('fails one that does not say why, or that sends the reader to a log', () => {
    expect(issueFault([issue('`lefthook` `2.2.2` was refused')], app, wants).fault).toContain('does not say');
    const body = '`lefthook` `2.2.2`: a weaker provenance, or an install script. The worker’s log says which.';
    expect(issueFault([issue(body)], app, wants)).toEqual({ number: 891, fault: 'issue #891 says log says which' });
  });

  it("knows the pin watch's title for a move, to a target or off a line no longer built", () => {
    const base = 'mcr.microsoft.com/devcontainers/base';
    expect(issueOfMove(`Move ${base} off a line no longer built`, base)).toBe(true);
    expect(issueOfMove('Move postgres to image 18.7', 'postgres')).toBe(true);
    expect(issueOfMove('Move postgres-exporter to image 1', 'postgres')).toBe(false);
  });
});

describe("Dependabot's pull request for a pin the App moved", () => {
  const app = 'scratch[bot]';
  const merge = { number: 900, commit: 'c0ffee1234', at: '2026-11-25T10:20:00Z' };
  const said = {
    author: app,
    body: '`main` already has every version this moves, since #900.',
    at: '2026-11-25T10:21:00Z',
  };
  const pull: DuplicateFacts = {
    number: 3,
    state: 'closed',
    openedAt: '2026-11-25T10:00:00Z',
    closedAt: '2026-11-25T10:21:00Z',
    closedBy: app,
    comments: [said],
  };

  it('passes when the App closed it after the merge, its comment naming the merge', () => {
    expect(duplicateVerdict({ pull, app, merge }).pass).toBe(true);
    const byCommit = { ...said, body: '`main` already has every version this moves, at c0ffee1.' };
    expect(duplicateVerdict({ pull: { ...pull, comments: [byCommit] }, app, merge }).pass).toBe(true);
  });

  it('fails while it is open after the merge, or when it merged', () => {
    const open = { ...pull, state: 'open', closedAt: undefined, closedBy: undefined, comments: [] };
    expect(duplicateVerdict({ pull: open, app, merge }).why).toContain('still open');
    expect(duplicateVerdict({ pull: open, app, merge: undefined }).why).toContain('has not merged');
    expect(duplicateVerdict({ pull: { ...pull, state: 'merged' }, app, merge }).pass).toBe(false);
  });

  it('fails a close with no such comment, or one that names no merge', () => {
    expect(duplicateVerdict({ pull: { ...pull, comments: [] }, app, merge }).why).toContain('no comment');
    const elsewhere = { ...said, body: 'Closing: `main` already has every version this moves, since #900.' };
    expect(duplicateVerdict({ pull: { ...pull, comments: [elsewhere] }, app, merge }).why).toContain('no comment');
    const unnamed = { ...said, body: '`main` already has every version this moves.' };
    expect(duplicateVerdict({ pull: { ...pull, comments: [unnamed] }, app, merge }).why).toContain('names neither');
  });

  it('gives no verdict when Dependabot closed its own first, and says so', () => {
    const own = { ...pull, closedBy: 'dependabot[bot]', comments: [] };
    const verdict = duplicateVerdict({ pull: own, app, merge });
    expect(verdict.pass).toBe(false);
    expect(verdict.why).toContain('no verdict');
    expect(verdict.why).toContain('dependabot[bot]');
  });

  it("is the set-up's fault when there was none, or it was not open at the merge", () => {
    expect(duplicateVerdict({ pull: undefined, app, merge }).why).toContain("set-up's");
    const early = { ...pull, closedAt: '2026-11-25T10:10:00Z' };
    expect(duplicateVerdict({ pull: early, app, merge }).why).toContain('was not open');
    const late = { ...pull, openedAt: '2026-11-25T10:30:00Z', closedAt: '2026-11-25T10:31:00Z' };
    expect(duplicateVerdict({ pull: late, app, merge }).why).toContain('was not open');
  });

  it("passes when both diffs add the same line, and gives no verdict when Dependabot's adds another", () => {
    const ours = ['image: postgres:18.7-alpine3.24@sha256:0115'];
    expect(duplicateVerdict({ pull, app, merge, lines: { theirs: ours, ours } }).pass).toBe(true);
    const theirs = ['image: postgres:18.8-alpine3.24@sha256:9999'];
    const open = { ...pull, state: 'open', closedAt: undefined, closedBy: undefined, comments: [] };
    const left = duplicateVerdict({ pull: open, app, merge, lines: { theirs, ours } });
    expect(left.pass).toBe(false);
    expect(left.why).toContain('no verdict');
    expect(left.why).toContain('`image: postgres:18.8-alpine3.24@sha256:9999`');
    expect(left.why).toContain('`image: postgres:18.7-alpine3.24@sha256:0115`');
  });

  it('fails when the App closed one whose line main lacks', () => {
    const lines = { theirs: ['image: postgres:18.8'], ours: ['image: postgres:18.7'] };
    const closed = duplicateVerdict({ pull, app, merge, lines });
    expect(closed.pass).toBe(false);
    expect(closed.why).toContain('though main lacks its line');
  });

  it('leaves alone one whose lines main lacks: it is still open', () => {
    const other = { ...pull, number: 3, state: 'open', closedAt: undefined, closedBy: undefined, comments: [] };
    expect(leftAloneFault([other], app)).toBeUndefined();
    expect(leftAloneFault([{ ...other, state: 'closed', closedBy: 'dependabot[bot]' }], app)).toContain('no verdict');
    expect(leftAloneFault([{ ...other, state: 'closed', closedBy: app }], app)).toBe(
      "Dependabot's #3, whose lines main lacks, was closed by the App",
    );
    expect(leftAloneFault([], app)).toContain("set-up's");
  });
});

describe('a ticket that must close with no change of its own', () => {
  const app = 'scratch[bot]';
  const wants = { closes: 'no-change', reason: /^Main already has its move/ };
  const ticket: TicketFacts = {
    workItem: '1201',
    takenAt: '2026-11-25T10:00:00Z',
    closed: { outcome: 'no-change', reason: 'Main already has its move, at 1a2b3c4: ghcr.io/anchore/syft at v1.57.2' },
    failures: 0,
    events: ['issue.opened', 'work-item.closed'],
    issue: { number: 44, state: 'closed', reason: 'completed', by: app },
  };

  it('passes when it closed so, no step failed, and the App closed its issue as completed', () => {
    expect(ticketFault(ticket, wants, app)).toBeUndefined();
  });

  it('fails when never taken, held, or not closed', () => {
    expect(ticketFault({ ...ticket, takenAt: undefined }, wants, app)).toBe('#1201 never taken');
    expect(ticketFault({ ...ticket, held: 'the gates failed' }, wants, app)).toContain('held for Martin');
    expect(ticketFault({ ...ticket, closed: undefined }, wants, app)).toContain('not closed');
  });

  it('fails another outcome or reason, and a close after failed steps', () => {
    const verified = { outcome: 'verified', reason: 'The scan no longer lists it' };
    expect(ticketFault({ ...ticket, closed: verified }, wants, app)).toContain('closed verified');
    const other = { outcome: 'no-change', reason: 'Nothing to do' };
    expect(ticketFault({ ...ticket, closed: other }, wants, app)).toContain('Nothing to do');
    expect(ticketFault({ ...ticket, failures: 2 }, wants, app)).toContain('2 failed steps');
  });

  it('fails with no issue, or one not closed as completed by the App', () => {
    expect(ticketFault({ ...ticket, issue: undefined }, wants, app)).toContain('no issue');
    const open = { number: 44, state: 'open' };
    expect(ticketFault({ ...ticket, issue: open }, wants, app)).toContain('is open');
    const byMartin = { number: 44, state: 'closed', reason: 'completed', by: 'mrogan' };
    expect(ticketFault({ ...ticket, issue: byMartin }, wants, app)).toContain('by mrogan');
  });
});

describe('a target that moves on after the pull request opened', () => {
  const name = 'follow-redirects';
  const facts = {
    number: 430,
    name,
    first: '1.15.6',
    later: '1.16.0',
    issueAtOpen: 'Move `follow-redirects` to `1.15.6` or later.',
    issueNow: 'Move `follow-redirects` to `1.16.0` or later.',
    headAtOpen: 'a'.repeat(40),
    headNow: 'b'.repeat(40),
    toldAt: '2026-11-25T10:10:00Z',
    mergedAt: '2026-11-25T10:30:00Z',
    adds: [lockfileKey(name, '1.16.0')],
  };

  it('passes when the same pull request and its issue took the later target', () => {
    expect(newerFault(facts)).toBeUndefined();
  });

  it('gives no verdict when the first scan did not name the first target', () => {
    expect(newerFault({ ...facts, issueAtOpen: 'Move `follow-redirects` to `1.16.0` or later.' })).toContain(
      'no verdict',
    );
    expect(newerFault({ ...facts, issueAtOpen: undefined })).toContain('not read');
  });

  it('gives no verdict when it merged before the later scan reached the line, and fails when none did', () => {
    expect(newerFault({ ...facts, mergedAt: '2026-11-25T10:05:00Z' })).toContain('no verdict');
    expect(newerFault({ ...facts, toldAt: undefined })).toContain('never reached the line');
  });

  it('fails a head that never moved, or a diff at the first target', () => {
    expect(newerFault({ ...facts, headNow: facts.headAtOpen })).toContain('its head before the target moved');
    expect(newerFault({ ...facts, adds: [lockfileKey(name, '1.15.6')] })).toContain('does not move');
    const both = [lockfileKey(name, '1.15.6'), lockfileKey(name, '1.16.0')];
    expect(newerFault({ ...facts, adds: both })).toContain('still moves a copy');
    expect(newerFault({ ...facts, adds: [] })).toContain('no copy of it');
  });

  it('fails an issue that does not name the later target, or still names the first', () => {
    expect(newerFault({ ...facts, issueNow: facts.issueAtOpen })).toContain('does not name 1.16.0');
    const both = 'Move `follow-redirects` to `1.16.0` or later (it was `1.15.6`).';
    expect(newerFault({ ...facts, issueNow: both })).toContain('still names 1.15.6');
    expect(newerFault({ ...facts, issueNow: 'Move follow-redirects to 1.16.0 or later.' })).toBeUndefined();
    expect(newerFault({ ...facts, issueNow: 'Move it to 1.16.0, from 11.15.60.' })).toBeUndefined();
  });
});

describe('the store restarting under a report', () => {
  const ok = { posted: 202, restarted: true, errors: [], inbox: 1, arrivedS: 95 };

  it('passes when the report is in the inbox once and no worker logged an error', () => {
    expect(restartVerdict(ok)).toEqual({
      pass: true,
      why: 'the store restarted under the report; in the inbox once, after 95 s; no worker logged an error',
    });
  });

  it('fails a report the app did not take, and a store that did not restart', () => {
    expect(restartVerdict({ ...ok, posted: 429 }).why).toContain('429');
    expect(restartVerdict({ ...ok, restarted: false }).pass).toBe(false);
  });

  it('fails a report lost, or left twice', () => {
    expect(restartVerdict({ ...ok, inbox: 0 }).why).toContain('never reached');
    expect(restartVerdict({ ...ok, inbox: 2 }).why).toContain('2 times');
  });

  it("fails on a worker's error", () => {
    const verdict = restartVerdict({ ...ok, errors: ['logs-7c9: 1 (check failed)'] });
    expect(verdict.pass).toBe(false);
    expect(verdict.why).toContain('logs-7c9');
  });
});
