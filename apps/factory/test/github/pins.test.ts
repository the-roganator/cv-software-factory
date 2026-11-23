/**
 * The pin watch (`pins.ts`) against the fake GitHub, through the live actions and the pin guard as the worker runs
 * them: one pull request for the moves at one file and never two, a moved target, a move gone, each refusal of the
 * guard, Dependabot's pull request for the same pin left alone, and one issue for each move the App cannot write.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { type Logger, pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { type Changed, proveMove } from '../../../../scripts/move.ts';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { IssueGuard, openedBy } from '../../src/github/issues.ts';
import { treeSource } from '../../src/github/pin-guard.ts';
import {
  branchOf,
  carriedBy,
  PASS_MS,
  PIN_LABEL,
  type PinScope,
  pinWatch,
  readPinScope,
} from '../../src/github/pins.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { client, quiet, type Sent } from './fake.ts';
import {
  day,
  dependabotGroup,
  digest,
  FACTORY,
  FakeRepo,
  FILES,
  factoryMoves,
  move,
  pinBranchOf,
  trivyCritical,
  writes,
} from './pins-harness.ts';

/** A watch over the fake repository, whose day is what `today` gives, and a clock a test moves on. */
function harness(
  repo: FakeRepo,
  today: () => Moves,
  options: { dryRun?: boolean; only?: PinScope; log?: Logger } = {},
) {
  const sent: Sent[] = [];
  const { github } = client(repo.routes(), sent);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'pins-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  const actions = options.dryRun
    ? new DryRunActions(artifacts, quiet, undefined, undefined, guard, undefined, treeSource(github))
    : new LiveActions(github, { guard });
  let clock = Date.parse('2026-11-11T07:00:00Z');
  const reads = { moves: async () => today() };
  const watch = pinWatch(
    { github, reads, actions, recorder, log: options.log ?? quiet, now: () => clock, only: options.only ?? '*' },
    FACTORY,
  );
  const records = () =>
    readdirSync(artifacts.dir, { recursive: true })
      .map(String)
      .filter((f) => !f.endsWith('/') && /[0-9a-f]{16}/.test(f))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(artifacts.dir, f), 'utf8'));
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  return {
    sent,
    actions,
    records,
    /** One pass, an hour after the last. */
    pass: async () => {
      clock += PASS_MS;
      await watch();
    },
  };
}

const appPulls = (repo: FakeRepo) => repo.pulls.filter((p) => p.head.startsWith('factory/pin/'));
const openPins = (repo: FakeRepo) => appPulls(repo).filter((p) => p.state === 'open');

/** The lines a branch's head changes from main's, each before and after. */
function changed(repo: FakeRepo, branch: string, base = repo.main) {
  const out: { file: string; line: number; before: string; after: string }[] = [];
  const head = repo.commits.get(repo.refs.get(branch) as string) as Map<string, { text: string }>;
  const was = repo.commits.get(base) as Map<string, { text: string }>;
  for (const [file, { text }] of head) {
    const before = was.get(file)?.text.split('\n') ?? [];
    for (const [i, line] of text.split('\n').entries())
      if (line !== before[i]) out.push({ file, line: i + 1, before: before[i] ?? '', after: line });
    expect(text.split('\n')).toHaveLength(before.length);
  }
  expect([...was.keys()].sort()).toEqual([...head.keys()].sort());
  return out;
}

describe('the pin watch', () => {
  it('opens one pull request for each move it can write, labelled pin, changing only the version or digest at each pin', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, factoryMoves()));
    await w.pass();

    const pulls = openPins(repo);
    expect(pulls.map((p) => p.head).sort()).toEqual(
      [
        pinBranchOf('example-dashboards'),
        pinBranchOf('example-logs'),
        pinBranchOf('example/sidecar'),
        pinBranchOf('ghcr.io/example/scanner-proxy'),
        pinBranchOf('k3s'),
      ].sort(),
    );
    // Each on the branch of the files its move pins: the first by its path, and a digest of them all.
    expect(pinBranchOf('example/sidecar')).toMatch(
      /^factory\/pin\/deploy-base-telemetry-values-dashboards\.yaml-[0-9a-f]{8}$/,
    );
    for (const pull of pulls) expect(pull.labels).toEqual([PIN_LABEL]);

    expect(changed(repo, pinBranchOf('example/sidecar'))).toEqual([
      {
        file: 'deploy/base/telemetry/values/dashboards.yaml',
        line: 4,
        before: `    tag: 2.11.2@${digest('sidecar/old')}`,
        after: `    tag: 2.14.3@${digest('sidecar/new')}`,
      },
      {
        file: 'deploy/base/telemetry/values/logs.yaml',
        line: 4,
        before: `    tag: 2.11.2@${digest('sidecar/old')}`,
        after: `    tag: 2.14.3@${digest('sidecar/new')}`,
      },
    ]);
    expect(changed(repo, pinBranchOf('ghcr.io/example/scanner-proxy'))).toEqual([
      expect.objectContaining({
        after: `export const IMAGE = 'ghcr.io/example/scanner-proxy:2.17.0@${digest('scanner-proxy/new')}';`,
      }),
    ]);
    expect(changed(repo, pinBranchOf('example-logs'))).toEqual([
      expect.objectContaining({ after: '    targetRevision: 21.1.1 # example-logs 3.4.0' }),
    ]);
    expect(changed(repo, pinBranchOf('k3s'))).toEqual([
      expect.objectContaining({ after: 'image: example/k3s:v1.34.5-k3s1' }),
    ]);
    // Each made on main's head, through a branch of its own that is gone again.
    expect([...repo.refs.keys()].filter((b) => b.startsWith('factory/pin-next/'))).toEqual([]);
  });

  it('describes each pin before and after, what each move clears, its deadline, and how it merges', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves())).pass();
    const byHead = (head: string) => openPins(repo).find((p) => p.head === head);

    const sidecar = byHead(pinBranchOf('example/sidecar'));
    expect(sidecar?.title).toBe('chore(pin): move example/sidecar to 2.14.3');
    expect(sidecar?.body).toContain(
      `| \`example/sidecar\` | \`deploy/base/telemetry/values/logs.yaml:4\` | \`2.11.2@${digest('sidecar/old')}\` | \`2.14.3@${digest('sidecar/new')}\` |`,
    );
    expect(sidecar?.body).toContain(
      '| `example/sidecar` | 2 critical, 30 high, 22 medium, 6 low | nothing | 2026-11-18T06:00:00Z |',
    );
    expect(sidecar?.body).toContain('The review gate passes it as `move` when it is exactly the scan’s move');
    // A major that clears a Critical is a move like any other.
    expect(byHead(pinBranchOf('example-logs'))?.body).toContain('The review gate passes it as `move`');
    // k3s merges as any move, and says what is Martin's after: no pull request waits for him by its lane.
    const k3s = byHead(pinBranchOf('k3s'))?.body;
    expect(k3s).toContain('The review gate passes it as `move`');
    expect(k3s).toContain('once this merges, run `make upgrade-cluster`');
    for (const pull of openPins(repo)) expect(pull.body).not.toContain('It waits for you');
    // Its counts and its pins, never a package or an advisory.
    for (const pull of openPins(repo)) expect(pull.body).not.toMatch(/GHSA-|CVE-|@example\/tokens/);
  });

  it('never opens two: a later pass, and a worker started again, find its pull request and leave it', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const today = () => day(scanned, factoryMoves());
    const w = harness(repo, today);
    await w.pass();
    const before = appPulls(repo).length;
    await w.pass();
    await harness(repo, today).pass();
    expect(appPulls(repo)).toHaveLength(before);
    // Nothing written again: the same branches, at the same commits.
    const again = harness(repo, today);
    await again.pass();
    expect(writes(again.sent)).toEqual([]);
  });

  it('moves its branch, title and description when the target moves on, and opens no other', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    const [sidecar] = openPins(repo).filter((p) => p.head === pinBranchOf('example/sidecar'));
    moves = moves.map((m) =>
      m.name === 'example/sidecar' ? { ...m, to: `image 2.14.4@${digest('sidecar/newer')}` } : m,
    );
    await w.pass();

    expect(openPins(repo).filter((p) => p.head === pinBranchOf('example/sidecar'))).toEqual([sidecar]);
    expect(sidecar?.title).toBe('chore(pin): move example/sidecar to 2.14.4');
    expect(sidecar?.body).toContain(`2.14.4@${digest('sidecar/newer')}`);
    expect(changed(repo, pinBranchOf('example/sidecar')).map((c) => c.after)).toEqual([
      `    tag: 2.14.4@${digest('sidecar/newer')}`,
      `    tag: 2.14.4@${digest('sidecar/newer')}`,
    ]);
  });

  it('makes its commit again on main when its pull request conflicts, and leaves it when main moved cleanly', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, factoryMoves()));
    await w.pass();
    const pull = openPins(repo).find((p) => p.head === pinBranchOf('example-dashboards'));
    const first = repo.refs.get(pinBranchOf('example-dashboards'));
    repo.push({ 'README.md': 'moved on\n' });
    await w.pass();
    expect(repo.refs.get(pinBranchOf('example-dashboards'))).toBe(first);

    if (pull) pull.mergeable = false;
    await w.pass();
    const again = repo.refs.get(pinBranchOf('example-dashboards')) as string;
    expect(again).not.toBe(first);
    expect(repo.file(again, 'README.md')).toBe('moved on\n');
    expect(openPins(repo).filter((p) => p.head === pinBranchOf('example-dashboards'))).toHaveLength(1);
  });

  it('closes the pull request of a move that is gone, with a sentence', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    moves = moves.filter((m) => m.name !== 'example-dashboards');
    await w.pass();
    const gone = appPulls(repo).find((p) => p.head === pinBranchOf('example-dashboards'));
    expect(gone?.state).toBe('closed');
    expect(repo.issues.find((i) => i.number === gone?.number)).toBeUndefined();
    expect(w.sent.some((s) => s.method === 'POST' && s.path.endsWith(`/issues/${gone?.number}/comments`))).toBe(true);
    expect(openPins(repo)).toHaveLength(4);
  });

  it('closes every pull request it has open on a day whose moves.json lists no move', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    expect(openPins(repo).length).toBeGreaterThan(0);
    moves = [];
    await w.pass();
    expect(openPins(repo)).toEqual([]);
  });

  it('does not open again a target whose pull request Martin closed without merging it', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    const pull = openPins(repo).find((p) => p.head === pinBranchOf('example-dashboards'));
    if (pull) pull.state = 'closed';
    await w.pass();
    expect(appPulls(repo).filter((p) => p.head === pinBranchOf('example-dashboards'))).toHaveLength(1);
    moves = moves.map((m) => (m.name === 'example-dashboards' ? { ...m, to: 'chart example-dashboards 13.8.0' } : m));
    await w.pass();
    expect(openPins(repo).filter((p) => p.head === pinBranchOf('example-dashboards'))).toHaveLength(1);
  });

  it('acts on nothing when the scan wrote no moves, or the day could not be read', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const none = harness(repo, () => ({ ...day(scanned, []), file: null }));
    await none.pass();
    expect(writes(none.sent)).toEqual([]);
    const failing = harness(repo, () => {
      throw new Error('the moves read failed');
    });
    await expect(failing.pass()).rejects.toThrow('the moves read failed');
    expect(writes(failing.sent)).toEqual([]);
  });

  it('leaves a move whose pin’s line has changed since the scan to the next scan, keeping its pull request', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, factoryMoves()));
    await w.pass();
    repo.push({
      'deploy/base/telemetry/dashboards.yaml': FILES['deploy/base/telemetry/dashboards.yaml']?.replace(
        '13.2.7',
        '13.3.0',
      ) as string,
    });
    const pull = openPins(repo).find((p) => p.head === pinBranchOf('example-dashboards'));
    if (pull) pull.mergeable = false;
    const before = repo.refs.get(pinBranchOf('example-dashboards'));
    await w.pass();
    expect(repo.refs.get(pinBranchOf('example-dashboards'))).toBe(before);
    expect(pull?.state).toBe('open');
  });

  it('records a dry run’s pull requests and commits, and writes nothing in GitHub', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, factoryMoves()), { dryRun: true });
    await w.pass();
    expect(writes(w.sent)).toEqual([]);
    const actions = w.records().map((r) => r.action);
    expect(actions.filter((a) => a === 'commitPins')).toHaveLength(5);
    expect(actions.filter((a) => a === 'openPullRequest')).toHaveLength(5);
    expect(actions.filter((a) => a === 'openIssue')).toHaveLength(3);
  });
});

describe('the pin watch beside Dependabot', () => {
  const sbom = (
    tag: string,
    seed = 'sbom-tool/new',
    clears = { CRITICAL: 0, HIGH: 7, MEDIUM: 12, LOW: 3, UNKNOWN: 0 },
  ) => [
    move({
      name: 'ghcr.io/example/sbom-tool',
      pins: [{ file: 'deploy/images/sbom-tool/Dockerfile', line: 2 }],
      from: 'v1.54.0',
      to: `image ${tag}@${digest(seed)}`,
      clears,
      lane: 'worker',
    }),
  ];

  const sbomBranch = () => branchOf(sbom('v1.55.1')[0] as ReadMove);

  it('makes the move whatever Dependabot has open for the pin, at the same target or another, and never touches Dependabot’s', async () => {
    for (const [tag, seed] of [
      ['v1.55.1', 'sbom-tool/new'],
      ['v1.54.1', 'sbom-tool/older'],
    ] as const) {
      const repo = new FakeRepo(FILES);
      const scanned = repo.main;
      const theirs = dependabotGroup(repo, tag, seed);
      // A routine move, with no High or Critical on a deadline, as much as one that has.
      const w = harness(repo, () =>
        day(scanned, sbom('v1.55.1', 'sbom-tool/new', { CRITICAL: 0, HIGH: 0, MEDIUM: 2, LOW: 1, UNKNOWN: 0 })),
      );
      await w.pass();
      expect(openPins(repo).map((p) => p.head)).toEqual([sbomBranch()]);
      expect(theirs.state).toBe('open');
      expect(repo.refs.get(theirs.head)).toBeUndefined();
      for (const s of writes(w.sent)) {
        expect(s.path).not.toContain(`/${theirs.number}`);
        expect(s.path).not.toContain('dependabot');
      }
    }
  });

  it('keeps its own open when Dependabot’s opens later at the same target', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, sbom('v1.55.1')));
    await w.pass();
    const [ours] = openPins(repo);
    const theirs = dependabotGroup(repo, 'v1.55.1');
    await w.pass();
    expect(ours?.state).toBe('open');
    expect(theirs.state).toBe('open');
  });
});

describe('the pin watch’s issues', () => {
  it('opens one issue for each move it cannot write, labelled pin, naming no package', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves())).pass();
    expect(repo.issues.map((i) => i.title).sort()).toEqual([
      'Move a package in pnpm-lock.yaml (3f9a1c0b7e2d) to the version its alerts name',
      'Move example-cd to chart example-cd 10.15.0',
      'Move example/old-line off a line no longer built',
    ]);
    for (const issue of repo.issues) {
      expect(issue.labels).toEqual([PIN_LABEL]);
      expect(issue.body).not.toMatch(/@example\/tokens|3\.0\.[12]|GHSA-/);
    }
    const cd = repo.issues.find((i) => i.title.startsWith('Move example-cd'));
    expect(cd?.body).toContain('no pull request of the App’s writes the Makefile');
    expect(cd?.body).toContain('- `mise.toml:2`, pinning `10.9.5`');
    expect(cd?.body).toContain('**Deadline** 2026-11-18T06:00:00Z.');
  });

  it('updates an issue rather than opening another, and closes it when its move is gone', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    await harness(repo, () => day(scanned, moves)).pass();
    expect(repo.issues).toHaveLength(3);
    moves = moves.map((m) => (m.name === 'example-cd' ? { ...m, clears: { ...m.clears, HIGH: 50 } } : m));
    await w.pass();
    expect(repo.issues).toHaveLength(3);
    expect(repo.issues.find((i) => i.title.startsWith('Move example-cd'))?.body).toContain('50 high');
    moves = moves.filter((m) => m.name !== 'example-cd');
    await w.pass();
    expect(repo.issues.find((i) => i.title.startsWith('Move example-cd'))?.state).toBe('closed');
  });

  it('leaves an issue Martin closed, until its move has a later target', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    const cd = repo.issues.find((i) => i.title.startsWith('Move example-cd'));
    if (cd) cd.state = 'closed';
    await w.pass();
    expect(cd?.state).toBe('closed');
    moves = moves.map((m) => (m.name === 'example-cd' ? { ...m, to: 'chart example-cd 10.16.0' } : m));
    await w.pass();
    expect(cd?.state).toBe('open');
    expect(cd?.title).toBe('Move example-cd to chart example-cd 10.16.0');
    expect(repo.issues).toHaveLength(3);
  });

  it('opens an issue for a move whose pin’s line it cannot write', async () => {
    const repo = new FakeRepo({
      ...FILES,
      'deploy/base/telemetry/dashboards.yaml': 'targetRevision: 13.2.7 # was 13.2.7\n',
    });
    const scanned = repo.main;
    const moves = factoryMoves()
      .filter((m) => m.name === 'example-dashboards')
      .map((m) => ({ ...m, pins: [{ file: 'deploy/base/telemetry/dashboards.yaml', line: 1 }] }));
    await harness(repo, () => day(scanned, moves)).pass();
    expect(appPulls(repo)).toEqual([]);
    expect(repo.issues.map((i) => i.title)).toEqual(['Move example-dashboards to chart example-dashboards 13.7.2']);
    expect(repo.issues[0]?.body).toContain('does not write 13.2.7 once as a word of its own');
  });
});

describe('the pin watch’s refusals', () => {
  it('refuses two moves that name one line, opening neither, and records the refusal once, signed as the worker’s others', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const [dashboards] = factoryMoves().filter((m) => m.name === 'example-dashboards') as [ReadMove];
    const moves = [
      dashboards,
      { ...dashboards, name: 'example-dashboards-twin', to: 'chart example-dashboards 13.7.3' },
    ];
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    await w.pass();
    expect(appPulls(repo)).toEqual([]);
    const refusals = w.records().filter((r) => r.payload?.mechanism === 'github-guard');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].payload.output).toBe(
      'Moves example-dashboards and example-dashboards-twin name one line: neither is the one move of that pin.',
    );
  });

  it('names no branch by a move’s name: one that would escape factory/pin/ is on its file’s branch', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const moves = factoryMoves()
      .filter((m) => m.name === 'example-dashboards')
      .map((m) => ({ ...m, name: '../../main' }));
    await harness(repo, () => day(scanned, moves)).pass();
    expect(openPins(repo).map((p) => p.head)).toEqual([pinBranchOf('example-dashboards')]);
    expect(openPins(repo)[0]?.title).toBe('chore(pin): move ../../main to 13.7.2');
    expect(repo.refs.get('main')).toBe(scanned);
  });
});

describe('the pin watch, as review found it', () => {
  it('opens nothing for a lockfile’s move in a lane it writes until the scan has made it, a major’s among them', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const lockfile = factoryMoves().find((m) => m.lockfile) as ReadMove;
    const w = harness(repo, () => day(scanned, [{ ...lockfile, lane: 'worker', major: true }]));
    await w.pass();
    expect(writes(w.sent)).toEqual([]);
  });

  it('opens again an issue it closed itself when the same move comes back to it', async () => {
    const repo = new FakeRepo({
      ...FILES,
      'deploy/base/telemetry/dashboards.yaml': 'targetRevision: 13.2.7 # was 13.2.7\n',
    });
    const scanned = repo.main;
    const unwritable = factoryMoves()
      .filter((m) => m.name === 'example-dashboards')
      .map((m) => ({ ...m, pins: [{ file: 'deploy/base/telemetry/dashboards.yaml', line: 1 }] }));
    let moves = unwritable;
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    moves = [];
    await w.pass();
    expect(repo.issues[0]?.state).toBe('closed');
    moves = unwritable;
    await w.pass();
    expect(repo.issues).toHaveLength(1);
    expect(repo.issues[0]?.state).toBe('open');
  });

  it('moves a move that gains a pin in another file to the pull request of both files, and closes the first', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const one = factoryMoves().map((m) =>
      m.name === 'example/sidecar' ? { ...m, pins: [{ file: 'deploy/base/telemetry/values/logs.yaml', line: 4 }] } : m,
    );
    let moves = one;
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    const first = branchOf(one.find((m) => m.name === 'example/sidecar') as ReadMove);
    expect(changed(repo, first)).toHaveLength(1);
    moves = factoryMoves();
    await w.pass();
    expect(changed(repo, pinBranchOf('example/sidecar'))).toHaveLength(2);
    expect(
      appPulls(repo)
        .filter((p) => p.head === first)
        .map((p) => p.state),
    ).toEqual(['closed']);
    expect(openPins(repo).filter((p) => p.title === 'chore(pin): move example/sidecar to 2.14.3')).toHaveLength(1);
  });

  it('records a dry run’s pull requests and issues once, however many passes it makes', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, factoryMoves()), { dryRun: true });
    await w.pass();
    await w.pass();
    await w.pass();
    const actions = w.records().map((r) => r.action);
    expect(actions.filter((a) => a === 'openPullRequest')).toHaveLength(5);
    expect(actions.filter((a) => a === 'openIssue')).toHaveLength(3);
  });

  it('opens an issue, not a refusal, for a move whose pin’s file is a symbolic link', async () => {
    const repo = new FakeRepo({
      ...FILES,
      'deploy/base/telemetry/dashboards.yaml': { mode: '120000', text: 'deploy/base/telemetry/logs.yaml' },
    });
    const scanned = repo.main;
    const w = harness(repo, () =>
      day(
        scanned,
        factoryMoves().filter((m) => m.name === 'example-dashboards'),
      ),
    );
    await w.pass();
    expect(appPulls(repo)).toEqual([]);
    expect(repo.issues[0]?.body).toContain('is not a file the watch can read');
    expect(w.records().filter((r) => r.payload?.mechanism === 'github-guard')).toEqual([]);
  });
});

describe('the pin watch, told which moves to take (PIN_WATCH_ONLY)', () => {
  /** A logger that keeps what it says. */
  const heard = () => {
    const lines: { msg: string; [key: string]: unknown }[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) });
    return { log, lines };
  };

  it('told nothing, opens nothing and closes nothing, and says so once', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves())).pass();
    const before = openPins(repo).length;
    expect(before).toBeGreaterThan(0);
    const { log, lines } = heard();
    const told = harness(repo, () => day(scanned, []), { only: [], log });
    await told.pass();
    await told.pass();
    expect(writes(told.sent)).toEqual([]);
    expect(openPins(repo)).toHaveLength(before);
    expect(lines.filter((l) => /told no move/.test(l.msg))).toHaveLength(1);
  });

  it('told one name, takes that move alone and leaves another’s open pull request as it is', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves())).pass();
    const other = openPins(repo).find((p) => p.head === pinBranchOf('example-dashboards'));
    expect(other).toBeDefined();
    // The day moves on: the dashboards' move is gone, and sidecar's is its own again.
    const sidecar = repo.pulls.find((p) => p.head === pinBranchOf('example/sidecar'));
    if (sidecar) sidecar.state = 'closed';
    const { log, lines } = heard();
    const one = harness(
      repo,
      () =>
        day(
          scanned,
          factoryMoves().filter((m) => m.name !== 'example-dashboards'),
        ),
      { only: ['example-logs'], log },
    );
    await one.pass();
    expect(other?.state).toBe('open');
    const touched = one.sent.filter((s) => s.method !== 'GET').map((s) => s.path);
    expect(touched.some((path) => path.endsWith(`/${other?.number}`) || path.includes(`/${other?.number}/`))).toBe(
      false,
    );
    expect(lines.find((l) => /pin watch takes/.test(l.msg))).toMatchObject({ only: ['example-logs'], taken: 1 });
  });

  it('told one name, opens that move’s pull request and no other', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves()), { only: ['example-dashboards'] }).pass();
    expect(openPins(repo).map((p) => p.head)).toEqual([pinBranchOf('example-dashboards')]);
    expect(repo.issues).toEqual([]);
  });

  it('told every move (*), does what it does with no setting at all', async () => {
    const [all, every] = [new FakeRepo(FILES), new FakeRepo(FILES)];
    await harness(all, () => day(all.main, factoryMoves()), { only: '*' }).pass();
    await harness(every, () => day(every.main, factoryMoves())).pass();
    expect(
      openPins(all)
        .map((p) => p.head)
        .sort(),
    ).toEqual(
      openPins(every)
        .map((p) => p.head)
        .sort(),
    );
    expect(openPins(all).length).toBeGreaterThan(1);
  });

  it('told one of two moves that name one line, refuses it as it would with both told', async () => {
    const repo = new FakeRepo(FILES);
    const sidecar = factoryMoves().find((m) => m.name === 'example/sidecar') as ReadMove;
    const rival = { ...sidecar, name: 'example/sidecar-rival' };
    await harness(repo, () => day(repo.main, [sidecar, rival]), { only: ['example/sidecar'] }).pass();
    expect(appPulls(repo)).toEqual([]);
  });

  it('told a name that only folds to another move’s branch, closes nothing of that move’s', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves())).pass();
    const dashboards = openPins(repo).find((p) => p.head === pinBranchOf('example-dashboards'));
    await harness(repo, () => day(scanned, factoryMoves()), { only: ['Example-Dashboards'] }).pass();
    expect(dashboards?.state).toBe('open');
  });

  it('says a name no move of the day has', async () => {
    const repo = new FakeRepo(FILES);
    const { log, lines } = heard();
    const w = harness(repo, () => day(repo.main, factoryMoves()), {
      only: ['example-dashboards', 'no-such-move'],
      log,
    });
    await w.pass();
    expect(lines.find((l) => /pin watch takes/.test(l.msg))).toMatchObject({ unknown: ['no-such-move'], taken: 1 });
    expect(openPins(repo)).toHaveLength(1);
  });
});

describe('PIN_WATCH_ONLY, read', () => {
  it('names none unset or blank, every move as * alone, and the names otherwise', () => {
    expect(readPinScope(undefined)).toEqual([]);
    expect(readPinScope(' , ')).toEqual([]);
    expect(readPinScope('*')).toBe('*');
    expect(readPinScope(' argo-rollouts: quay.io/argoproj/argo-rollouts , loki,loki')).toEqual([
      'argo-rollouts: quay.io/argoproj/argo-rollouts',
      'loki',
    ]);
    expect(() => readPinScope('*,loki')).toThrow(/stands alone/);
  });
});

describe('one pull request for the day’s moves at one file', () => {
  const KYVERNO = 'deploy/base/admission/values/kyverno.yaml';
  const IMAGES = ['kyverno', 'kyvernopre', 'reports-controller', 'readiness-checker'];
  /** A values file that pins four images of one chart, a line each, and the chart's own version under them. */
  const files = () => ({
    ...FILES,
    [KYVERNO]: [
      ...IMAGES.flatMap((image) => [`${image}:`, `  tag: v1.19.1@${digest(`${image}/old`)}`]),
      'chart: 3.5.0',
      '',
    ].join('\n'),
  });
  /** The four images' moves, as the scan names a chart's: Kyverno's own, in the worker's lane as any other. */
  const four = (to = 'v1.20.0'): ReadMove[] =>
    IMAGES.map((image, i) =>
      move({
        name: `kyverno: reg.example/kyverno/${image}`,
        pins: [{ file: KYVERNO, line: 2 * i + 2 }],
        from: 'v1.19.1',
        to: `image ${to}@${digest(`${image}/${to}`)}`,
        clears: { CRITICAL: 0, HIGH: i + 1, MEDIUM: 2, LOW: 0, UNKNOWN: 0 },
        lane: 'worker',
      }),
    );
  /** The chart's own move across a major, on the file's last pin: the gate names it `major` unless it clears a Critical. */
  const major = (critical = 0): ReadMove =>
    move({
      name: 'kyverno',
      pins: [{ file: KYVERNO, line: 9 }],
      from: '3.5.0',
      to: 'chart kyverno 4.0.0 (a major)',
      major: true,
      clears: { CRITICAL: critical, HIGH: 4, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
      lane: 'worker',
      findings: critical ? [trivyCritical({ file: KYVERNO, line: 9 })] : [],
    });
  const BRANCH = branchOf(four()[0] as ReadMove);

  /** What the review gate makes of a branch (scripts/move.ts): the day's moves made on main, compared with its head. */
  const gate = (repo: FakeRepo, branch: string, scan: ReadMove[]) => {
    const head = repo.refs.get(branch) as string;
    const paths = [...new Set(changed(repo, branch).map((line) => line.file))];
    const change = paths.map(
      (path): Changed => ({
        path,
        status: 'M',
        modes: ['100644', '100644'],
        base: repo.file(repo.main, path),
        head: repo.file(head, path),
      }),
    );
    const derive = async () => {
      throw new Error('no lockfile moves here');
    };
    return proveMove(change, scan, { base: (path) => repo.file(repo.main, path), derive }, false);
  };

  it('carries Kyverno’s four images in one, which the gate passes as the scan’s four moves', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const moves = four();
    await harness(repo, () => day(scanned, moves)).pass();

    const [pull, ...others] = openPins(repo);
    expect(others).toEqual([]);
    expect(pull).toMatchObject({ head: BRANCH, title: `chore(pin): move 4 pins in ${KYVERNO}`, labels: [PIN_LABEL] });
    expect(changed(repo, BRANCH).map((line) => [line.line, line.after])).toEqual(
      IMAGES.map((image, i) => [2 * i + 2, `  tag: v1.20.0@${digest(`${image}/v1.20.0`)}`]),
    );
    expect(pull?.body).toContain('makes 4 of the day’s moves');
    for (const [i, image] of IMAGES.entries()) {
      expect(pull?.body).toContain(
        `| \`kyverno: reg.example/kyverno/${image}\` | \`${KYVERNO}:${2 * i + 2}\` | \`v1.19.1@${digest(`${image}/old`)}\` | \`v1.20.0@${digest(`${image}/v1.20.0`)}\` |`,
      );
      expect(pull?.body).toContain(`| \`kyverno: reg.example/kyverno/${image}\` | ${i + 1} high, 2 medium | nothing |`);
    }
    expect(carriedBy(pull?.body).sort()).toEqual(moves.map((m) => m.name).sort());
    expect(await gate(repo, BRANCH, moves)).toMatchObject({ rule: 'move', title: expect.stringContaining('4 moves') });
  });

  it('is updated as the day’s moves there change, and closed when none is left', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    let moves = four();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    const [pull] = openPins(repo);
    const first = repo.refs.get(BRANCH);
    // The same day again, its moves in another order: nothing is written.
    moves = [...moves].reverse();
    await w.pass();
    expect(repo.refs.get(BRANCH)).toBe(first);

    // A target moves on: the branch moves, and its description with it.
    moves = [...four().slice(0, 3), ...four('v1.20.1').slice(3)];
    await w.pass();
    expect(repo.refs.get(BRANCH)).not.toBe(first);
    expect(pull?.body).toContain(`v1.20.1@${digest('readiness-checker/v1.20.1')}`);
    expect(await gate(repo, BRANCH, moves)).toMatchObject({ rule: 'move' });

    // Two go (main has them, or nothing they cleared is left): the pull request carries the two that stay.
    moves = four().slice(0, 2);
    await w.pass();
    expect(pull?.title).toBe(`chore(pin): move 2 pins in ${KYVERNO}`);
    expect(changed(repo, BRANCH)).toHaveLength(2);
    // One left: it reads as one move's.
    moves = four().slice(0, 1);
    await w.pass();
    expect(pull?.title).toBe('chore(pin): move kyverno: reg.example/kyverno/kyverno to v1.20.0');
    expect(openPins(repo)).toEqual([pull]);

    moves = [];
    await w.pass();
    expect(pull?.state).toBe('closed');
    expect(appPulls(repo)).toHaveLength(1);
  });

  it('opens a major the level may hold apart from the rest of its file, which do not wait for it', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const moves = [...four(), major()];
    await harness(repo, () => day(scanned, moves)).pass();

    const apart = branchOf(major());
    expect(apart).toMatch(/-major-[0-9a-f]{8}$/);
    expect(
      openPins(repo)
        .map((p) => p.head)
        .sort(),
    ).toEqual([BRANCH, apart].sort());
    const held = openPins(repo).find((p) => p.head === apart);
    expect(held?.title).toBe('chore(pin): move kyverno to 4.0.0');
    expect(held?.body).toContain('the review gate passes it as `major`');
    expect(held?.body).toContain('at Lights-out; at any other level it waits for you');
    expect(changed(repo, apart).map((line) => line.after)).toEqual(['chart: 4.0.0']);
    expect(changed(repo, BRANCH)).toHaveLength(4);
    // The gate names each as the level reads it: the major alone is `major`, and the rest are a `move`.
    expect(await gate(repo, apart, moves)).toMatchObject({ rule: 'major' });
    expect(await gate(repo, BRANCH, moves)).toMatchObject({ rule: 'move', title: expect.stringContaining('4 moves') });
  });

  it('holds apart a major whose only Critical is its publisher’s: Trivy’s rating alone releases one', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const published = {
      ...major(1),
      findings: [{ ...trivyCritical({ file: KYVERNO, line: 9 }), severity: 'HIGH' as const }],
    };
    const moves = [...four(), published];
    await harness(repo, () => day(scanned, moves)).pass();
    const apart = branchOf(published);
    expect(apart).toMatch(/-major-[0-9a-f]{8}$/);
    expect(
      openPins(repo)
        .map((p) => p.head)
        .sort(),
    ).toEqual([BRANCH, apart].sort());
    expect(await gate(repo, apart, moves)).toMatchObject({ rule: 'major' });
  });

  it('carries a major that clears a Critical with the rest: the gate names it a move, which no level holds apart', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const moves = [...four(), major(1)];
    await harness(repo, () => day(scanned, moves)).pass();
    expect(openPins(repo).map((p) => p.head)).toEqual([BRANCH]);
    expect(changed(repo, BRANCH)).toHaveLength(5);
    expect(await gate(repo, BRANCH, moves)).toMatchObject({ rule: 'move', title: expect.stringContaining('5 moves') });
  });

  it('leaves out a move whose line has changed since the scan, and one that is an issue, and carries the rest', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    // main moved one pin by hand since the scan read it, and another's target is nothing a pin's line writes.
    repo.push({ [KYVERNO]: (files()[KYVERNO] as string).replace(`v1.19.1@${digest('kyverno/old')}`, 'v1.19.9') });
    const moves = four().map((m, i) => (i === 1 ? { ...m, to: 'tool kyvernopre 1.20.0' } : m));
    await harness(repo, () => day(scanned, moves)).pass();
    const [pull] = openPins(repo);
    expect(pull?.title).toBe(`chore(pin): move 2 pins in ${KYVERNO}`);
    expect(changed(repo, BRANCH).map((line) => line.line)).toEqual([6, 8]);
    expect(repo.issues.map((i) => i.title)).toEqual([
      'Move kyverno: reg.example/kyverno/kyvernopre to tool kyvernopre 1.20.0',
    ]);
    expect(await gate(repo, BRANCH, moves)).toMatchObject({ rule: 'move', title: expect.stringContaining('2 moves') });
  });

  it('carries only the moves it is told to take, and told some, closes only a pull request whose moves are all among them', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const names = four().map((m) => m.name);
    let moves = four();
    await harness(repo, () => day(scanned, moves), { only: names.slice(0, 2) }).pass();
    const [pull] = openPins(repo);
    expect(pull?.title).toBe(`chore(pin): move 2 pins in ${KYVERNO}`);
    expect(carriedBy(pull?.body)).toEqual(names.slice(0, 2));

    // The day lists none of them now. A watch told one of its two moves leaves it; one told both closes it.
    moves = [];
    await harness(repo, () => day(scanned, moves), { only: names.slice(0, 1) }).pass();
    expect(pull?.state).toBe('open');
    await harness(repo, () => day(scanned, moves), { only: names.slice(0, 3) }).pass();
    expect(pull?.state).toBe('closed');
  });

  it('does not open again what Martin closed, until the day’s moves there change', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    let moves = four();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    const [pull] = openPins(repo);
    if (pull) pull.state = 'closed';
    await w.pass();
    expect(appPulls(repo)).toHaveLength(1);
    moves = four('v1.20.1');
    await w.pass();
    expect(openPins(repo).map((p) => p.head)).toEqual([BRANCH]);
    expect(appPulls(repo)).toHaveLength(2);
  });

  it('reads no mark it did not write as a move it carries', () => {
    expect(carriedBy(undefined)).toEqual([]);
    expect(carriedBy('<!-- factory: pin-moves %5B%22a%22%2C7%5D -->')).toEqual(['a']);
    expect(carriedBy('<!-- factory: pin-moves %7B%7D -->')).toEqual([]);
    expect(carriedBy('<!-- factory: pin-moves %E0%A4%A -->')).toEqual([]);
  });
});
