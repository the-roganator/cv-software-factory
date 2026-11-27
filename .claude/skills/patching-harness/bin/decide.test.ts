import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  besideWords,
  branchFits,
  certainFail,
  changesVerdict,
  type DuplicateFacts,
  dependabotMissing,
  duplicateVerdict,
  extraSpoils,
  factoryBusy,
  forgeFault,
  type HoldFacts,
  holdBroken,
  holdDecided,
  isRoutine,
  issueFault,
  issueOfMove,
  leftAloneFault,
  lineTooEarly,
  lockfileKey,
  majorNext,
  majorNextFault,
  majorNotFirst,
  movedUnder,
  moveFits,
  NO_VERDICT,
  newerFault,
  notListed,
  PIN_PASS_LIMIT_MS,
  PIN_PASS_MS,
  type PodFacts,
  type PullFacts,
  pickScan,
  pinsFault,
  pinWatchLacks,
  pinWatchLine,
  printOf,
  probeQuery,
  queuedFault,
  queueWords,
  REFUSAL_KINDS,
  restartVerdict,
  revertedVerdict,
  rolloutProgressing,
  routineBranch,
  routineMajorBranch,
  type ScanRun,
  saysNotPulled,
  seenToTheGates,
  settleMs,
  shownAs,
  staleTarget,
  startingPods,
  stillListed,
  type TicketFacts,
  targetOf,
  ticketFault,
  unreadMoves,
  waitedVerdict,
  waitsFault,
  waitsReading,
  watcherRode,
  watchRead,
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

describe('a staged extra no test of the run asks for', () => {
  it("leaves a factory run alone when it serves the app's tests only", () => {
    expect(extraSpoils('factory', ['app'])).toBe(false);
  });

  it('spoils a factory run when a factory test asks for it, or none does', () => {
    expect(extraSpoils('factory', ['factory'])).toBe(true);
    expect(extraSpoils('factory', ['app', 'factory'])).toBe(true);
    expect(extraSpoils('factory', [])).toBe(true);
  });

  it('spoils an app run, whoever it serves', () => {
    expect(extraSpoils('app', ['app'])).toBe(true);
    expect(extraSpoils('app', ['factory'])).toBe(true);
  });
});

describe('the moves the pin watch was not told to take', () => {
  const base = 'mcr.microsoft.com/devcontainers/base';

  it('lacks none when it takes every move, or each by name', () => {
    expect(pinWatchLacks('*', [base, 'postgres'])).toEqual([]);
    expect(pinWatchLacks(`postgres, ${base}`, [base, 'postgres'])).toEqual([]);
    expect(pinWatchLacks('', [])).toEqual([]);
  });

  it('lacks every one when told nothing, and each one not named', () => {
    expect(pinWatchLacks('', [base])).toEqual([base]);
    expect(pinWatchLacks('postgres', [base, 'postgres'])).toEqual([base]);
    expect(pinWatchLacks('postgres-exporter', ['postgres'])).toEqual(['postgres']);
  });
});

describe('a pod still starting, before the cluster is judged clean', () => {
  const probes: PodFacts = {
    name: 'factory/probes-5f4cfb7d7d-mqvr5',
    phase: 'Running',
    ready: false,
    restarts: 0,
    waiting: [],
    deployment: 'factory/probes',
  };
  const rolling = ['factory/probes'];

  it("is waited for while its Deployment's rollout is in flight and it has shown no fault", () => {
    expect(startingPods([probes], rolling)).toEqual([probes.name]);
    expect(startingPods([{ ...probes, phase: 'Pending', waiting: ['ContainerCreating'] }], rolling)).toHaveLength(1);
  });

  it('is not waited for once ready, or when no rollout of its Deployment is in flight', () => {
    expect(startingPods([{ ...probes, ready: true }], rolling)).toEqual([]);
    expect(startingPods([probes], [])).toEqual([]);
    expect(startingPods([probes], ['factory/line'])).toEqual([]);
    expect(startingPods([{ ...probes, deployment: undefined }], rolling)).toEqual([]);
  });

  it('is judged at once after a restart, in a back-off, or failed', () => {
    expect(startingPods([{ ...probes, restarts: 1 }], rolling)).toEqual([]);
    expect(startingPods([{ ...probes, waiting: ['CrashLoopBackOff'] }], rolling)).toEqual([]);
    expect(startingPods([{ ...probes, phase: 'Pending', waiting: ['ImagePullBackOff'] }], rolling)).toEqual([]);
    expect(startingPods([{ ...probes, phase: 'Failed' }], rolling)).toEqual([]);
  });

  it("reads a rollout in flight from the Deployment's Progressing condition", () => {
    const progressing = (reason: string, status = 'True') => [
      { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
      { type: 'Progressing', status, reason },
    ];
    expect(rolloutProgressing(progressing('ReplicaSetUpdated'))).toBe(true);
    expect(rolloutProgressing(progressing('NewReplicaSetAvailable'))).toBe(false);
    expect(rolloutProgressing(progressing('ProgressDeadlineExceeded', 'False'))).toBe(false);
    expect(rolloutProgressing([])).toBe(false);
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

  it("gives the kind of the worker's reason, whichever of them the issue has", () => {
    const refused = { names: ['lefthook'], says: [/`\d+\.\d+\.\d+`/], never: [/log says which/], kinds: REFUSAL_KINDS };
    const young =
      'The pin step could not make `lefthook` `2.2.2`: the release is younger than the minimum age this repository gives a release.';
    expect(issueFault([issue(young)], app, refused)).toEqual({ number: 891, kind: 'young' });
    const provenance = '`lefthook` `2.2.2`: published with weaker provenance than the release before it.';
    expect(issueFault([issue(provenance)], app, refused)).toEqual({ number: 891, kind: 'provenance' });
    for (const [kind, words] of [
      ['script', 'the release has an install script this repository does not allow'],
      ['override', 'it goes with an override for that copy'],
      ['resolved', 'it asked pnpm for the release the scan listed, and pnpm resolved a newer one, `2.2.4`'],
      ['lock', 'mise could not lock the release'],
    ])
      expect(issueFault([issue(`\`lefthook\` \`2.2.3\`: ${words}.`)], app, refused).kind).toBe(kind);
  });

  it('fails the catch-all, which gives no reason, and an issue that names no release in code', () => {
    const refused = { names: ['lefthook'], says: [/`\d+\.\d+\.\d+`/], never: [/log says which/], kinds: REFUSAL_KINDS };
    const other =
      'The pin step could not make `lefthook` `2.2.2` on the commit it read. The watch makes it once a scan can.';
    expect(issueFault([issue(other)], app, refused).fault).toContain('gives none of the reasons');
    const unnamed = '`lefthook`: the release is younger than the minimum age.';
    expect(issueFault([issue(unnamed)], app, refused).fault).toContain('does not say');
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

  it('says what became of one beside a move, and never judges the move by it', () => {
    expect(besideWords(undefined, app, merge.at)).toBe("no pull request of Dependabot's beside it");
    expect(besideWords(pull, app, merge.at)).toBe(
      "Dependabot's #3 beside it closed by the App as a duplicate after the merge",
    );
    expect(besideWords({ ...pull, comments: [] }, app, merge.at)).toContain('with no comment that says why');
    expect(besideWords({ ...pull, closedBy: 'dependabot[bot]' }, app, merge.at)).toContain('closed by dependabot[bot]');
    const open = { ...pull, state: 'open', closedAt: undefined, closedBy: undefined };
    expect(besideWords(open, app, merge.at)).toBe("Dependabot's #3 beside it is still open");
    expect(besideWords({ ...pull, state: 'merged' }, app, merge.at)).toContain('merged');
    expect(besideWords({ ...pull, closedAt: '2026-11-25T10:10:00Z' }, app, merge.at)).not.toContain('after the merge');
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

  it('is seen as far as the gates when all but the merge holds and only the scan gates are red', () => {
    const gates = ['gates / dependency review', 'gates / lockfile scan'];
    const open = { ...facts, mergedAt: undefined, state: 'open', red: gates, pending: [], touched: [], gates };
    expect(seenToTheGates(open)).toBe(
      "the same pull request and issue took the new target; not merged: the scan gates refuse 1.16.0 for advisories of its own, the staging's",
    );
    expect(seenToTheGates({ ...open, red: ['gates / lockfile scan'] })).toBeDefined();
    // Anything else is a failure's to say: another check red, none red, something pending, a touch, a merge.
    expect(seenToTheGates({ ...open, red: [...gates, 'lint, types, tests'] })).toBeUndefined();
    expect(seenToTheGates({ ...open, red: [] })).toBeUndefined();
    expect(seenToTheGates({ ...open, pending: ['image builds'] })).toBeUndefined();
    expect(seenToTheGates({ ...open, touched: ['labeled by mrogan'] })).toBeUndefined();
    expect(seenToTheGates({ ...open, state: 'closed' })).toBeUndefined();
    expect(seenToTheGates({ ...open, mergedAt: '2026-11-25T10:30:00Z' })).toBeUndefined();
    // Nor when the pull request or the issue did not take the new target.
    expect(seenToTheGates({ ...open, headNow: open.headAtOpen })).toBeUndefined();
    expect(seenToTheGates({ ...open, adds: [lockfileKey(name, '1.15.6')] })).toBeUndefined();
    expect(seenToTheGates({ ...open, issueNow: open.issueAtOpen })).toBeUndefined();
    expect(seenToTheGates({ ...open, toldAt: undefined })).toBeUndefined();
  });

  it('fails an issue that does not name the later target, or still names the first', () => {
    expect(newerFault({ ...facts, issueNow: facts.issueAtOpen })).toContain('does not name 1.16.0');
    const both = 'Move `follow-redirects` to `1.16.0` or later (it was to `1.15.6` or later).';
    expect(newerFault({ ...facts, issueNow: both })).toContain('still names 1.15.6');
    expect(newerFault({ ...facts, issueNow: 'Move follow-redirects to 1.16.0 or later.' })).toBeUndefined();
    expect(newerFault({ ...facts, issueNow: 'Move it to 11.16.0 or later.' })).toContain('does not name 1.16.0');
    // The advisories it lists, each with the release that fixes it, name no target.
    const listed = 'Move `follow-redirects` from `1.14.8` to `1.16.0` or later.\n- `CVE-2024-28849`: fixed in `1.15.6`';
    expect(newerFault({ ...facts, issueNow: listed })).toBeUndefined();
  });
});

describe('the store restarting under a report', () => {
  const ok = { posted: 202, restarted: true, errors: [], inbox: 1, arrivedS: 95, watcher: { away: true, back: true } };
  const away =
    '{"level":40,"check":"reports","msg":"a check could not reach the store, as for a restart: its next turn tries again"}';
  const back = '{"level":30,"check":"reports","msg":"the check reached the store again, after 31 s"}';

  it('passes when the watcher met the outage, the report is in the inbox once and no worker logged an error', () => {
    expect(restartVerdict(ok)).toEqual({
      pass: true,
      why: 'the store was away under the report; the log watcher warned, and reached it again; in the inbox once, after 95 s; no worker logged an error',
    });
  });

  it("gives no verdict when the watcher's log has no warning, and fails when it never reached the store again", () => {
    for (const watcher of [undefined, { away: false, back: false }]) {
      const verdict = restartVerdict({ ...ok, watcher });
      expect(verdict.pass).toBe(false);
      expect(verdict.why).toContain("no verdict: the restart fell between the watcher's turns");
    }
    expect(restartVerdict({ ...ok, watcher: { away: true, back: false } }).why).toContain(
      'never said it reached it again',
    );
  });

  it("reads the watcher's warning and its return from its log, in that order", () => {
    expect(watcherRode([away, away, back].join('\n'))).toEqual({ away: true, back: true });
    expect(watcherRode(away)).toEqual({ away: true, back: false });
    expect(watcherRode([back, away].join('\n'))).toEqual({ away: true, back: false });
    expect(watcherRode('{"level":30,"msg":"reports checked"}\nnot json')).toEqual({ away: false, back: false });
    // The same words at another level are not the warning.
    expect(watcherRode(away.replace('"level":40', '"level":30'))).toEqual({ away: false, back: false });
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

describe('a pin move Martin asked for changes on', () => {
  const says = /Martin asked for changes/;
  const held: HoldFacts & { gateWords?: string } = {
    number: 7,
    state: 'open',
    head: 'a'.repeat(40),
    red: [],
    pending: [],
    rule: 'held',
    touched: ['reviewed by the-roganator-martin'],
    gateWords: 'Martin asked for changes',
  };
  const review = { number: 7, head: held.head, pending: ['lint, types, tests'] };
  const judge = (over: Partial<Parameters<typeof changesVerdict>[0]> = {}) =>
    changesVerdict({ pulls: [held], review, says, decided: true, ...over });

  it('passes once the gate holds it for his review, its checks are in, and the worker has said it waits', () => {
    expect(judge()).toEqual({
      pass: true,
      why: expect.stringMatching(/#7 held by the gate .*never queued; asked while/),
    });
  });
  it('waits for the worker’s word, and for the checks', () => {
    expect(judge({ decided: false }).why).toMatch(/waiting for its checks and the worker/);
    expect(judge({ pulls: [{ ...held, pending: ['platform'] }] }).why).toMatch(/not settled: waiting on platform/);
  });
  it('fails when it merged or was queued', () => {
    expect(judge({ pulls: [{ ...held, state: 'merged' }] }).why).toMatch(/merged, though Martin asked/);
    expect(judge({ pulls: [{ ...held, queuedBy: 'the-app[bot]' }] }).why).toMatch(
      /added to the merge queue by the-app/,
    );
  });
  it('fails when the gate passed it, or held it for another reason', () => {
    expect(judge({ pulls: [{ ...held, rule: 'move' }] }).why).toMatch(/passed it as move, though Martin asked/);
    expect(judge({ pulls: [{ ...held, gateWords: 'Held for its risk tags' }] }).why).toMatch(/not because he asked/);
  });
  it('gives no verdict when every check was in before the review, as the worker could have queued it first', () => {
    const late = judge({ review: { ...review, pending: [] } });
    expect(late.pass).toBe(false);
    expect(late.why).toMatch(/^no verdict: every required check of #7 was in/);
  });
  it('fails without the review, with no pull request, with two, or touched by another hand', () => {
    expect(judge({ review: undefined }).why).toMatch(/was not posted/);
    expect(judge({ pulls: [] }).why).toMatch(/no pull request opened/);
    expect(judge({ pulls: [held, { ...held, number: 8 }] }).why).toMatch(/2 pull requests/);
    expect(judge({ pulls: [{ ...held, touched: [...held.touched, 'labeled by someone'] }] }).why).toBe(
      '#7 touched: labeled by someone',
    );
  });
  it('keeps a hold decided at an earlier head, unless the gate passes a later one', () => {
    const later = { ...held, head: 'b'.repeat(40), pending: ['platform', 'review'], rule: undefined };
    expect(judge({ pulls: [later], decided: false, heldAt: { head: held.head } }).pass).toBe(true);
    const passed = { ...later, pending: [], rule: 'move' };
    expect(judge({ pulls: [passed], decided: false, heldAt: { head: held.head } }).why).toMatch(/passed it as move/);
  });
});

describe('what the worker says a move waits for', () => {
  const line = (number: number, head: string, waits: string, why: string) =>
    JSON.stringify({ level: 30, number, head, waits, why, msg: 'the pin pull request waits to be queued' });
  const stopped = 'the line is stopped, so a move waits for Martin';
  const major = 'the line is stopped, so a major waits for Martin';
  const supervised = 'at Supervised a move waits for Martin';
  const pulls = [
    { number: 1, head: 'aaa', queued: false, pending: 0 },
    { number: 2, head: 'bbb', queued: false, pending: 0 },
  ];

  it('reads the last word at each head from the log', () => {
    const words = queueWords(
      [line(1, 'aaa', 'checks', 'tests is running'), 'not json', line(1, 'aaa', 'stopped', stopped)].join('\n'),
    );
    expect(words.get('1 aaa')).toEqual({ waits: 'stopped', why: stopped });
    expect(words.get('2 bbb')).toBeUndefined();
  });
  it('wants the stop said of every move, and of one that Guarded would queue', () => {
    const words = queueWords([line(1, 'aaa', 'stopped', stopped), line(2, 'bbb', 'stopped', major)].join('\n'));
    expect(waitsFault(pulls, words, 'stopped')).toBeUndefined();
    const majors = queueWords([line(1, 'aaa', 'stopped', major), line(2, 'bbb', 'stopped', major)].join('\n'));
    expect(waitsFault(pulls, majors, 'stopped')).toMatch(/none of them is a move Guarded would queue/);
  });
  it('tells the level’s wait from the stop’s, and takes either where both are in force', () => {
    const words = queueWords([line(1, 'aaa', 'stopped', stopped), line(2, 'bbb', 'level', supervised)].join('\n'));
    expect(waitsFault(pulls, words, 'either')).toBeUndefined();
    expect(waitsFault(pulls, words, 'stopped')).toMatch(/#2 at bbb: the worker says it waits for level/);
    expect(waitsFault(pulls, words, 'supervised')).toMatch(/#1 at aaa: the worker says it waits for stopped/);
    const guarded = queueWords(line(1, 'aaa', 'level', 'at Guarded a major waits for Martin'));
    expect(waitsFault([pulls[0] as (typeof pulls)[number]], guarded, 'supervised')).toMatch(
      /not that it waits at Supervised/,
    );
  });
  it('fails on a queued pull request, checks still running, no word, or no pull request', () => {
    const words = queueWords(line(1, 'aaa', 'stopped', stopped));
    expect(waitsFault([{ ...pulls[0], queued: true } as (typeof pulls)[number]], words, 'stopped')).toBe(
      '#1 is in the merge queue',
    );
    expect(waitsFault([{ ...pulls[0], pending: 2 } as (typeof pulls)[number]], words, 'stopped')).toMatch(/2 checks/);
    expect(waitsFault(pulls, words, 'stopped')).toMatch(/#2 at bbb: the worker has said nothing of it/);
    expect(waitsFault([], words, 'either')).toBe('no move has a pull request open');
  });
});

describe('a target that moves under a pull request during the run', () => {
  const line = (number: number, head: string, waits: string, why: string) =>
    JSON.stringify({ msg: 'A pull request waits to be queued', number, head, waits, why });
  const stopped = 'the line is stopped, so a move waits for Martin';
  const held = "the gate's rule is held, not move or major";
  const prometheus = {
    number: 983,
    head: '394d035aaa',
    title: 'chore(pin): move prometheus to 29.49.0',
    queued: false,
    pending: 0,
  };
  const loki = { number: 982, head: 'aff8911bbb', title: 'chore(pin): move loki to 21.6.0', queued: false, pending: 0 };
  const scan = [
    { name: 'prometheus', to: 'chart prometheus 29.49.0' },
    { name: 'loki', to: 'chart loki 21.6.2 (a major)' },
  ];
  const said = (...lines: string[]) => queueWords(lines.join('\n'));

  it('reads every move waiting, as waitsFault does', () => {
    const words = said(line(983, prometheus.head, 'stopped', stopped), line(982, loki.head, 'stopped', stopped));
    expect(waitsReading([prometheus, loki], words, 'either', undefined)).toEqual({ reads: 'waits' });
  });
  it('gives no verdict when the gate holds a head whose target the newest scan moved on from', () => {
    const words = said(line(983, prometheus.head, 'stopped', stopped), line(982, loki.head, 'verdict', held));
    expect(movedUnder(loki, words, scan)).toMatchObject({ pin: 'loki' });
    expect(waitsReading([prometheus, loki], words, 'either', scan)).toEqual({
      reads: 'moved',
      why: "no verdict: loki's target moved during the run: #982 at aff8911 moves it to 21.6.0, the newest scan's move is to 21.6.2, and the gate holds the head until the pin watch writes it again",
    });
  });
  it('gives no verdict while the worker has said nothing of the head that replaced a held one', () => {
    const newer = { ...loki, head: 'b5970f4ccc', title: 'chore(pin): move loki to 21.6.2', pending: 3 };
    const words = said(line(983, prometheus.head, 'stopped', stopped), line(982, loki.head, 'verdict', held));
    const reading = waitsReading([prometheus, newer], words, 'either', scan);
    expect(reading).toMatchObject({ reads: 'moved' });
    expect(reading).toHaveProperty(
      'why',
      "no verdict: loki's target moved during the run: #982 at b5970f4 replaced aff8911, which the gate held, and the worker has said nothing of it yet",
    );
  });
  it('reads the pull request at its newest head once the worker has spoken of it', () => {
    const newer = { ...loki, head: 'b5970f4ccc', title: 'chore(pin): move loki to 21.6.2' };
    const before = [line(983, prometheus.head, 'stopped', stopped), line(982, loki.head, 'verdict', held)];
    const waits = said(...before, line(982, newer.head, 'stopped', stopped));
    expect(waitsReading([prometheus, newer], waits, 'either', scan)).toEqual({ reads: 'waits' });
    // The newest head held too, at the scan's own target: the gate holds it for another reason.
    const again = said(...before, line(982, newer.head, 'verdict', held));
    expect(waitsReading([prometheus, newer], again, 'either', scan)).toMatchObject({
      reads: 'fault',
      why: expect.stringMatching(/^#982 at b5970f4: the worker says it waits for verdict/),
    });
  });
  it('fails on a verdict at the newest head whose title names the scan’s own target, or with no scan to say', () => {
    const current = { ...loki, title: 'chore(pin): move loki to 21.6.2' };
    const words = said(line(983, prometheus.head, 'stopped', stopped), line(982, loki.head, 'verdict', held));
    expect(movedUnder(current, words, scan)).toBeUndefined();
    expect(waitsReading([prometheus, current], words, 'either', scan)).toMatchObject({ reads: 'fault' });
    expect(waitsReading([prometheus, loki], words, 'either', undefined)).toMatchObject({ reads: 'fault' });
    // A scan that no longer lists the pin names no other target for it.
    expect(waitsReading([prometheus, loki], words, 'either', [scan[0] as (typeof scan)[number]])).toMatchObject({
      reads: 'fault',
    });
  });
  it('fails on another pull request’s fault, and on one in the queue, whatever moved', () => {
    const words = said(
      line(983, prometheus.head, 'level', 'at Supervised a move waits for Martin'),
      line(982, loki.head, 'verdict', held),
    );
    expect(waitsReading([prometheus, loki], words, 'stopped', scan)).toMatchObject({
      reads: 'fault',
      why: expect.stringMatching(/^#983 at 394d035: the worker says it waits for level/),
    });
    const fits = said(line(983, prometheus.head, 'stopped', stopped), line(982, loki.head, 'verdict', held));
    expect(waitsReading([prometheus, { ...loki, queued: true }], fits, 'either', scan)).toEqual({
      reads: 'fault',
      why: '#982 is in the merge queue',
    });
  });
  it('has no verdict on the stop when the one move Guarded would queue is the one that moved', () => {
    const major = 'the line is stopped, so a major waits for Martin';
    const words = said(line(983, prometheus.head, 'verdict', held), line(982, loki.head, 'stopped', major));
    const moved = [{ name: 'prometheus', to: 'chart prometheus 29.50.0' }];
    expect(waitsReading([prometheus, loki], words, 'stopped', moved)).toMatchObject({
      reads: 'moved',
      why: expect.stringMatching(
        /^no verdict: prometheus's target moved during the run: #983 at 394d035 moves it to 29.49.0/,
      ),
    });
    // With no target moved, the same words fail the phase: the gate holds the one move for another reason.
    expect(waitsReading([prometheus, loki], words, 'stopped', scan)).toMatchObject({ reads: 'fault' });
  });
  it('says nothing moved of a pull request the worker has never spoken of', () => {
    expect(movedUnder(loki, said(line(983, prometheus.head, 'verdict', held)), scan)).toBeUndefined();
  });
});

describe('a move put back on main', () => {
  const app = 'the-app[bot]';
  const repo = 'owner/copy';
  const read = { at: '2026-11-26T22:35:23.000Z', run: 9 };
  const issue = {
    number: 20,
    author: app,
    body: 'The factory made this move, and its merge was then undone on `main`: the pin is back.',
    at: '2026-11-26T22:35:38Z',
  };
  const facts = {
    of: '14a',
    move: { name: 'k3s', from: 'v1.37.1+k3s1' },
    merged: 12,
    revert: 'c'.repeat(40),
    scan: { id: 9, moves: [{ name: 'k3s', from: 'v1.37.1+k3s1' }] },
    pulls: [] as number[],
    issues: [issue],
    app,
    read,
    watchedUntil: '2026-11-26T22:40:23.000Z',
    settleMs: 5 * 60_000,
  };
  it('passes once the watch read the scan, opened no pull request after, and its issue says so', () => {
    expect(revertedVerdict(facts)).toEqual({
      pass: true,
      why: expect.stringMatching(/scan 9 lists it again, the pin watch read scan 9 at .*5 minutes after.*issue #20/),
    });
    // Its issue alone is a sign of its pass, where the log gave none: the watch is counted from the issue.
    expect(revertedVerdict({ ...facts, read: undefined, watchedUntil: '2026-11-26T22:40:38Z' })).toEqual({
      pass: true,
      why: expect.stringMatching(/the pin watch made a pass, .*issue #20 says its merge was undone on main/),
    });
  });
  it('fails at once on a pull request for it again, whatever else is known', () => {
    for (const each of [facts, { ...facts, read: undefined, issues: [], watchedUntil: undefined }]) {
      const verdict = revertedVerdict({ ...each, pulls: [31] });
      expect(verdict).toMatchObject({ pass: false, why: expect.stringMatching(/the App opened #31 for it again/) });
      expect(verdict.mark).toBeUndefined();
    }
  });
  it('gives no verdict, neither a pass nor a failure, while the watch is not known to have read the scan', () => {
    const early = { ...facts, read: undefined, issues: [], watchedUntil: '2026-11-26T22:34:46.777Z' };
    expect(revertedVerdict(early)).toEqual({
      pass: false,
      mark: NO_VERDICT,
      why: expect.stringMatching(
        /^no verdict: #12 merged and was put back .*; the pin watch had not read scan 9 by 2026-11-26T22:34:46.777Z$/,
      ),
    });
    // An issue of someone else's is no sign of the watch's pass.
    const another = [{ ...issue, author: 'someone' }];
    expect(revertedVerdict({ ...early, issues: another }).mark).toBe(NO_VERDICT);
  });
  it('fails when the watch read the scan and wrote no issue that says so', () => {
    expect(revertedVerdict({ ...facts, issues: [] })).toEqual({
      pass: false,
      why: expect.stringMatching(
        /the pin watch read scan 9 at .* and opened no pull request, but no issue of the App's/,
      ),
    });
    const silent = [{ ...issue, body: 'Move k3s.' }];
    expect(revertedVerdict({ ...facts, issues: silent }).why).toMatch(/issue #20 does not say it was undone on main/);
    expect(revertedVerdict({ ...facts, issues: silent }).mark).toBeUndefined();
  });
  it('is not yet a pass, or a failure for want of an issue, before the watch after the sign is over', () => {
    const soon = '2026-11-26T22:36:23.000Z';
    expect(revertedVerdict({ ...facts, watchedUntil: soon })).toEqual({
      pass: false,
      why: expect.stringMatching(/issue #20 says so; watching for a pull request \(1 min\)/),
    });
    expect(revertedVerdict({ ...facts, issues: [], watchedUntil: soon }).why).toMatch(/watching for its issue/);
  });
  it('gives no verdict when the move never merged, or the scan does not list it again', () => {
    expect(revertedVerdict({ ...facts, merged: undefined }).why).toMatch(/^no verdict: test 14a's move did not merge/);
    expect(revertedVerdict({ ...facts, scan: { id: 9, moves: [] } }).why).toMatch(/^no verdict: .*does not list k3s/);
  });
  it('fails when the pins were not put back, or the scan left no moves', () => {
    expect(revertedVerdict({ ...facts, revert: undefined }).why).toMatch(/were not put back on main/);
    expect(revertedVerdict({ ...facts, scan: { id: 9, moves: undefined } }).why).toMatch(/left no moves/);
  });

  it('reads the pin watch’s pass on a scan from the worker’s log, by the run it names', () => {
    const line = (run: number | undefined, time: number, of = repo) =>
      JSON.stringify({
        level: 30,
        time,
        repo: of,
        run,
        taken: 1,
        msg: 'the pin watch takes the moves it was told to (PIN_WATCH_ONLY), and leaves the rest alone',
      });
    const at = Date.parse('2026-11-26T22:35:23Z');
    // An earlier scan's pass, another repository's, and a line that names no run are no pass on this scan.
    const before = [line(8, at - 60_000), line(9, at, 'owner/other'), line(undefined, at), 'not json'].join('\n');
    expect(watchRead(before, repo, 9)).toBeUndefined();
    expect(watchRead(`${before}\n${line(9, at)}`, repo, 9)).toEqual({ at: '2026-11-26T22:35:23.000Z', run: 9 });
    // A later scan of the same main is read after this one was listed: the first such pass is the sign.
    expect(watchRead([line(11, at + 60_000), line(10, at)].join('\n'), repo, 9)).toMatchObject({ run: 10 });
  });
  it('waits for the watch one of its periods and a restart', () => {
    expect(PIN_PASS_LIMIT_MS).toBeGreaterThan(PIN_PASS_MS);
    expect(PIN_PASS_LIMIT_MS).toBe(70 * 60_000);
  });
});

describe('content that waits a day', () => {
  it('reads a move as listed, said to wait for its content, absent, or not said', () => {
    expect(shownAs({ moves: [{ name: 'postgres' }] }, 'postgres')).toBe('listed');
    expect(shownAs({ moves: [], waiting: [{ name: 'postgres', why: 'content' }] }, 'postgres')).toBe('waiting');
    // Refused as no better than the pin, or another pin's wait, is no wait of this one's content.
    expect(shownAs({ moves: [], waiting: [{ name: 'postgres', why: 'no-better' }] }, 'postgres')).toBe('absent');
    expect(shownAs({ moves: [], waiting: [{ name: 'loki', why: 'content' }] }, 'postgres')).toBe('absent');
    expect(shownAs({ moves: [{ name: 'loki' }], waiting: [] }, 'postgres')).toBe('absent');
    // A scan that does not say what waits says nothing of a move it does not list.
    expect(shownAs({ moves: [{ name: 'loki' }] }, 'postgres')).toBe('unsaid');
    expect(shownAs(undefined, 'postgres')).toBe('unsaid');
  });
  it('names the moves a scan does not list', () => {
    expect(notListed(['postgres', 'k3s'], { moves: [{ name: 'k3s' }] })).toEqual(['postgres']);
    expect(notListed(['postgres'], undefined)).toEqual(['postgres']);
    expect(notListed(['postgres'], {})).toEqual(['postgres']);
    expect(notListed([], { moves: [] })).toEqual([]);
  });
  it("names a move a scan lists while it says its content waits: the listed one is not the content's", () => {
    // The app's first scan after a reset: the runtime image listed for Node's bare version, its digest waiting.
    const first = {
      moves: [{ name: 'gcr.io/distroless/nodejs24-debian13', to: 'version 24.22.1' }, { name: 'node' }],
      waiting: [
        { name: 'gcr.io/distroless/nodejs24-debian13', why: 'content' },
        { name: 'ghcr.io/anchore/syft', why: 'content' },
        { name: 'node', why: 'no-better' },
      ],
    };
    expect(notListed(['gcr.io/distroless/nodejs24-debian13', 'node', 'ghcr.io/anchore/syft'], first)).toEqual([
      'gcr.io/distroless/nodejs24-debian13',
      'ghcr.io/anchore/syft',
    ]);
    // The scan after it, on the state put back: listed, and nothing of it waits.
    const second = {
      moves: [{ name: 'gcr.io/distroless/nodejs24-debian13', to: 'image nonroot@sha256:675c' }],
      waiting: [],
    };
    expect(notListed(['gcr.io/distroless/nodejs24-debian13'], second)).toEqual([]);
  });
  it("gives a forgery's failure in the error's own words, never the stack", () => {
    const died = [
      'file:///work/bin/forge.ts:663',
      "  if (typeof move === 'string') throw new Error('not one the pin step makes');",
      '                                      ^',
      '',
      "Error: the scan's gcr.io/distroless/nodejs24-debian13 move is not one the pin step makes: a bare version",
      '    at forgeRuntime (file:///work/bin/forge.ts:663:39)',
      '    at async main (file:///work/bin/forge.ts:877:7)',
      '',
      'Node.js v24.22.3',
    ].join('\n');
    expect(forgeFault(died)).toBe(
      "the forgery could not be made: the scan's gcr.io/distroless/nodejs24-debian13 move is not one the pin step makes: a bare version",
    );
    expect(forgeFault('Error: spawnSync node ETIMEDOUT')).toBe(
      'the forgery could not be made: spawnSync node ETIMEDOUT',
    );
    expect(forgeFault('\nkilled\n')).toBe('the forgery could not be made: killed');
    expect(forgeFault('')).toBe('the forgery could not be made: forge.ts said nothing');
  });
  it('passes when the first scan after the reset says it waits and the one on its state lists it', () => {
    const verdict = waitedVerdict({
      move: 'postgres',
      first: { id: 1, shown: 'waiting' },
      second: { id: 2, listed: true },
      early: [],
    });
    expect(verdict).toEqual({
      pass: true,
      why: expect.stringMatching(/scan 1, with no state, lists no move of postgres and says it waits .* scan 2/),
    });
  });
  it('gives no verdict when the first scan does not say it waits', () => {
    const second = { id: 2, listed: true };
    expect(waitedVerdict({ move: 'postgres', first: { id: 1, shown: 'unsaid' }, second }).why).toMatch(
      /^no verdict: scan 1 does not list postgres and does not say what waits/,
    );
    expect(waitedVerdict({ move: 'postgres', first: { id: 1, shown: 'absent' }, second }).why).toMatch(
      /^no verdict: scan 1 neither lists postgres nor says it waits/,
    );
  });
  it('fails when a pull request was opened for it before the second scan', () => {
    const verdict = waitedVerdict({
      move: 'postgres',
      first: { id: 1, shown: 'waiting' },
      second: { id: 2, listed: true },
      early: [41],
    });
    expect(verdict).toEqual({ pass: false, why: expect.stringMatching(/^#41 was opened for postgres before scan 2/) });
  });
  it('fails when the first scan lists it', () => {
    const verdict = waitedVerdict({
      move: 'postgres',
      first: { id: 1, shown: 'listed' },
      second: { id: 2, listed: true },
    });
    expect(verdict).toEqual({ pass: false, why: expect.stringMatching(/its content did not wait/) });
  });
  it('fails when the run read one scan that lists it, and gives no verdict when neither lists it', () => {
    expect(waitedVerdict({ move: 'postgres', first: undefined, second: { id: 2, listed: true } }).why).toMatch(
      /the first this run read, lists postgres/,
    );
    expect(waitedVerdict({ move: 'postgres', first: undefined, second: { id: 2, listed: false } }).why).toMatch(
      /^no verdict/,
    );
    expect(
      waitedVerdict({ move: 'postgres', first: { id: 1, shown: 'waiting' }, second: { id: 2, listed: false } }).why,
    ).toMatch(/^no verdict: scan 1 says postgres waits, and scan 2 on its state does not list it/);
    expect(waitedVerdict({ move: 'postgres', first: undefined, second: undefined }).why).toBe(
      'the scan has not finished',
    );
  });
});

describe('a move within the major, and then the major', () => {
  const first = { name: 'prometheus', to: 'chart prometheus 29.49.0', major: false };
  const major = { name: 'prometheus', from: '29.49.0', to: 'chart prometheus 30.0.1 (a major)', major: true };
  it('fails when the first scan names the major', () => {
    expect(majorNextFault({ ...first, to: major.to, major: true }, [])).toMatch(/names a major for prometheus/);
  });
  it('says nothing while no later scan is read', () => {
    expect(majorNextFault(first, [])).toBeUndefined();
  });
  it('is content with a later scan that lists the major from the release it moved to, or says it waits', () => {
    expect(
      majorNextFault(first, [
        { id: 2, moves: [] },
        { id: 3, moves: [major] },
      ]),
    ).toBeUndefined();
    expect(
      majorNextFault(first, [{ id: 2, moves: [], waiting: [{ name: 'prometheus', why: 'content' }] }]),
    ).toBeUndefined();
  });
  it('says which word of a later scan it stands on: the major listed, before one said to wait', () => {
    const waits = { id: 2, moves: [], waiting: [{ name: 'prometheus', why: 'content' }] };
    expect(majorNext(first, [waits])).toEqual({ scan: 2, listed: false });
    expect(majorNext(first, [waits, { id: 3, moves: [major] }])).toEqual({ scan: 3, listed: true });
    expect(majorNext(first, [{ id: 2, moves: [] }])).toBeUndefined();
    expect(majorNext(first, [{ id: 2, moves: [{ ...major, from: '29.35.0' }] }])).toBeUndefined();
  });
  it('fails when no later scan lists it, or lists a move from there that is no major', () => {
    expect(majorNextFault(first, [{ id: 2, moves: [] }])).toMatch(/scan 2 lists no major of prometheus from 29.49.0/);
    expect(majorNextFault(first, [{ id: 2, moves: [{ ...major, from: '29.35.0' }] }])).toMatch(/lists no major/);
    expect(
      majorNextFault(first, [{ id: 2, moves: [{ ...major, major: false, to: 'chart prometheus 29.50.0' }] }]),
    ).toMatch(/which is no major/);
  });
});

describe('a test of a pin’s major, on a scan that lists a move within the major first', () => {
  it('has a verdict where the scan lists the major: every fix of the pin is one, or the rest would leave worse', () => {
    expect(majorNotFirst({ name: 'loki', from: '18.13.7', to: 'chart loki 21.6.0 (a major)', major: true })).toBe(
      undefined,
    );
    expect(
      majorNotFirst({ name: 'grafana', from: '13.2.7', to: 'chart grafana 14.6.0 (a major)', major: true }),
    ).toBeUndefined();
    // No move of the pin at all is another fault, and the verdict's to say.
    expect(majorNotFirst(undefined)).toBeUndefined();
  });

  it('has none where a release within the major clears some of its findings and leaves none worse: that move comes first, and merges', () => {
    const why = majorNotFirst({ name: 'loki', from: '18.13.7', to: 'chart loki 18.17.1', major: false });
    expect(why).toContain('the scan lists loki from 18.13.7 to chart loki 18.17.1, a move within its major');
    expect(why).toContain('leaves none worse for the major');
    expect(why).toContain('no major of loki to judge until that has merged');
  });
});

describe('the line under an app’s test, before the scan the run stands on', () => {
  it('must be stopped where the store was saved with it running, and is left where it is stopped or never started', () => {
    expect(lineTooEarly('line.started')).toMatch(/running before the scan the run stands on is in/);
    expect(lineTooEarly('line.stopped')).toBeUndefined();
    expect(lineTooEarly(undefined)).toBeUndefined();
  });
});
