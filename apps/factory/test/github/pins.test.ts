/**
 * The pin watch (`pins.ts`) against the fake GitHub, through the live actions and the pin guard as the worker runs
 * them: one pull request for each move and never two, a moved target, a move gone, each refusal of the guard, each case
 * of Dependabot's, and one issue for each move the App cannot write.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import { IssueGuard, openedBy } from '../../src/github/issues.ts';
import { treeSource } from '../../src/github/pin-guard.ts';
import { PASS_MS, PIN_LABEL, pinWatch } from '../../src/github/pins.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { client, quiet, type Sent } from './fake.ts';
import { day, dependabotGroup, digest, FACTORY, FakeRepo, FILES, factoryMoves, move, writes } from './pins-harness.ts';

const DEPENDABOT_YML = `version: 2
updates:
  - package-ecosystem: docker
    directories:
      - /deploy/images/sbom-tool
    schedule: { interval: weekly }
`;

/** A watch over the fake repository, whose day is what `today` gives, and a clock a test moves on. */
function harness(repo: FakeRepo, today: () => Moves, options: { dryRun?: boolean } = {}) {
  const sent: Sent[] = [];
  const { github } = client(repo.routes(), sent);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'pins-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  const actions = options.dryRun
    ? new DryRunActions(artifacts, quiet, undefined, undefined, guard, undefined, treeSource(github))
    : new LiveActions(github, { guard });
  let clock = Date.parse('2026-11-11T07:00:00Z');
  const reads = {
    moves: async () => today(),
    dependencyPulls: (r: string) => dependencyPulls(github, r, async () => DEPENDABOT_YML),
  };
  const watch = pinWatch({ github, reads, actions, recorder, log: quiet, now: () => clock }, FACTORY);
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
    expect(pulls.map((p) => p.head).sort()).toEqual([
      'factory/pin/example-dashboards',
      'factory/pin/example-logs',
      'factory/pin/example-sidecar',
      'factory/pin/ghcr.io-example-scanner-proxy',
      'factory/pin/k3s',
    ]);
    for (const pull of pulls) expect(pull.labels).toEqual([PIN_LABEL]);

    expect(changed(repo, 'factory/pin/example-sidecar')).toEqual([
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
    expect(changed(repo, 'factory/pin/ghcr.io-example-scanner-proxy')).toEqual([
      expect.objectContaining({
        after: `export const IMAGE = 'ghcr.io/example/scanner-proxy:2.17.0@${digest('scanner-proxy/new')}';`,
      }),
    ]);
    expect(changed(repo, 'factory/pin/example-logs')).toEqual([
      expect.objectContaining({ after: '    targetRevision: 21.1.1 # example-logs 3.4.0' }),
    ]);
    expect(changed(repo, 'factory/pin/k3s')).toEqual([
      expect.objectContaining({ after: 'image: example/k3s:v1.34.5-k3s1' }),
    ]);
    // Each made on main's head, through a branch of its own that is gone again.
    expect([...repo.refs.keys()].filter((b) => b.startsWith('factory/pin-next/'))).toEqual([]);
  });

  it('describes each pin before and after, what it clears, its deadline, and why it waits for Martin when it does', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves())).pass();
    const byHead = (head: string) => openPins(repo).find((p) => p.head === head);

    const sidecar = byHead('factory/pin/example-sidecar');
    expect(sidecar?.title).toBe('chore(pin): move example/sidecar to 2.14.3');
    expect(sidecar?.body).toContain(
      `| \`deploy/base/telemetry/values/logs.yaml:4\` | \`2.11.2@${digest('sidecar/old')}\` | \`2.14.3@${digest('sidecar/new')}\` |`,
    );
    expect(sidecar?.body).toContain(
      'It clears 2 critical, 30 high, 22 medium, 6 low, and leaves nothing on the same pins.',
    );
    expect(sidecar?.body).toContain('Deadline: 2026-11-18T06:00:00Z.');
    expect(sidecar?.body).toContain('The review gate passes it as `pin-move` when it proves the move');
    expect(byHead('factory/pin/example-logs')?.body).toContain('**It waits for you.** It crosses a major');
    expect(byHead('factory/pin/k3s')?.body).toContain('`make upgrade-cluster`');
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
    const [sidecar] = openPins(repo).filter((p) => p.head === 'factory/pin/example-sidecar');
    moves = moves.map((m) =>
      m.name === 'example/sidecar' ? { ...m, to: `image 2.14.4@${digest('sidecar/newer')}` } : m,
    );
    await w.pass();

    expect(openPins(repo).filter((p) => p.head === 'factory/pin/example-sidecar')).toEqual([sidecar]);
    expect(sidecar?.title).toBe('chore(pin): move example/sidecar to 2.14.4');
    expect(sidecar?.body).toContain(`2.14.4@${digest('sidecar/newer')}`);
    expect(changed(repo, 'factory/pin/example-sidecar').map((c) => c.after)).toEqual([
      `    tag: 2.14.4@${digest('sidecar/newer')}`,
      `    tag: 2.14.4@${digest('sidecar/newer')}`,
    ]);
  });

  it('makes its commit again on main when its pull request conflicts, and leaves it when main moved cleanly', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, factoryMoves()));
    await w.pass();
    const pull = openPins(repo).find((p) => p.head === 'factory/pin/example-dashboards');
    const first = repo.refs.get('factory/pin/example-dashboards');
    repo.push({ 'README.md': 'moved on\n' });
    await w.pass();
    expect(repo.refs.get('factory/pin/example-dashboards')).toBe(first);

    if (pull) pull.mergeable = false;
    await w.pass();
    const again = repo.refs.get('factory/pin/example-dashboards') as string;
    expect(again).not.toBe(first);
    expect(repo.file(again, 'README.md')).toBe('moved on\n');
    expect(openPins(repo).filter((p) => p.head === 'factory/pin/example-dashboards')).toHaveLength(1);
  });

  it('closes the pull request of a move that is gone, with a sentence', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    moves = moves.filter((m) => m.name !== 'example-dashboards');
    await w.pass();
    const gone = appPulls(repo).find((p) => p.head === 'factory/pin/example-dashboards');
    expect(gone?.state).toBe('closed');
    expect(repo.issues.find((i) => i.number === gone?.number)).toBeUndefined();
    expect(w.sent.some((s) => s.method === 'POST' && s.path.endsWith(`/issues/${gone?.number}/comments`))).toBe(true);
    expect(openPins(repo)).toHaveLength(4);
  });

  it('does not open again a target whose pull request Martin closed without merging it', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    const pull = openPins(repo).find((p) => p.head === 'factory/pin/example-dashboards');
    if (pull) pull.state = 'closed';
    await w.pass();
    expect(appPulls(repo).filter((p) => p.head === 'factory/pin/example-dashboards')).toHaveLength(1);
    moves = moves.map((m) => (m.name === 'example-dashboards' ? { ...m, to: 'chart example-dashboards 13.8.0' } : m));
    await w.pass();
    expect(openPins(repo).filter((p) => p.head === 'factory/pin/example-dashboards')).toHaveLength(1);
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
    const pull = openPins(repo).find((p) => p.head === 'factory/pin/example-dashboards');
    if (pull) pull.mergeable = false;
    const before = repo.refs.get('factory/pin/example-dashboards');
    await w.pass();
    expect(repo.refs.get('factory/pin/example-dashboards')).toBe(before);
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
  const urgent = (tag: string, seed = 'sbom-tool/new'): ReadMove[] => [
    move({
      name: 'ghcr.io/example/sbom-tool',
      pins: [{ file: 'deploy/images/sbom-tool/Dockerfile', line: 2 }],
      from: 'v1.54.0',
      to: `image ${tag}@${digest(seed)}`,
      clears: { CRITICAL: 0, HIGH: 7, MEDIUM: 12, LOW: 3, UNKNOWN: 0 },
      lane: 'worker',
    }),
  ];

  it('opens nothing when a group’s pull request of Dependabot’s, as #984’s, moves the pin to the same target', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const theirs = dependabotGroup(repo, 'v1.55.1');
    const w = harness(repo, () => day(scanned, urgent('v1.55.1')));
    await w.pass();
    expect(appPulls(repo)).toEqual([]);
    expect(theirs.state).toBe('open');
    expect(writes(w.sent)).toEqual([]);
  });

  it('opens nothing when Dependabot’s moves it further, by a branch that names its pin', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    repo.addPull({
      head: 'dependabot/docker/deploy/images/sbom-tool/ghcr.io/example/sbom-tool-v1.56.0',
      user: 'dependabot[bot]',
    });
    const w = harness(repo, () => day(scanned, urgent('v1.55.1')));
    await w.pass();
    expect(appPulls(repo)).toEqual([]);
  });

  it('opens its own beside Dependabot’s at an older target when the move has a High on a deadline, and never touches Dependabot’s', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const theirs = dependabotGroup(repo, 'v1.54.1', 'sbom-tool/older');
    const w = harness(repo, () => day(scanned, urgent('v1.55.1')));
    await w.pass();
    expect(openPins(repo).map((p) => p.head)).toEqual(['factory/pin/ghcr.io-example-sbom-tool']);
    expect(theirs.state).toBe('open');
    expect(repo.refs.get(theirs.head)).toBeUndefined();
    for (const s of writes(w.sent)) {
      expect(s.path).not.toContain(`/${theirs.number}`);
      expect(s.path).not.toContain('dependabot');
    }
  });

  it('closes its own once Dependabot’s moves the pin as far, and leaves Dependabot’s open', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () => day(scanned, urgent('v1.55.1')));
    await w.pass();
    const [ours] = openPins(repo);
    const theirs = dependabotGroup(repo, 'v1.55.1');
    await w.pass();
    expect(ours?.state).toBe('closed');
    expect(theirs.state).toBe('open');
  });

  it('opens nothing for a move in Dependabot’s lane', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = harness(repo, () =>
      day(
        scanned,
        factoryMoves().filter((m) => m.lane === 'dependabot'),
      ),
    );
    await w.pass();
    expect(writes(w.sent)).toEqual([]);
  });

  it('holds when a group’s patch of the pin’s file is one GitHub did not send', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const theirs = dependabotGroup(repo, 'v1.55.1');
    theirs.files = [{ filename: 'deploy/images/sbom-tool/Dockerfile' }];
    const w = harness(repo, () => day(scanned, urgent('v1.55.1')));
    await w.pass();
    expect(appPulls(repo)).toEqual([]);
  });
});

describe('the pin watch’s issues', () => {
  it('opens one issue for each move it cannot write, labelled pin, naming no package', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await harness(repo, () => day(scanned, factoryMoves())).pass();
    expect(repo.issues.map((i) => i.title).sort()).toEqual([
      'Move a package in pnpm-lock.yaml (code scanning alert #5120) to the version its alerts name',
      'Move example-cd to chart example-cd 10.15.0',
      'Move example/old-line off a line no longer built',
    ]);
    for (const issue of repo.issues) {
      expect(issue.labels).toEqual([PIN_LABEL]);
      expect(issue.body).not.toMatch(/@example\/tokens|3\.0\.[12]|GHSA-/);
    }
    const cd = repo.issues.find((i) => i.title.startsWith('Move example-cd'));
    expect(cd?.body).toContain('`mise upgrade`');
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
  it('refuses two moves that name one line, opening neither, and records the refusal signed as the worker’s others', async () => {
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
    expect(refusals).toHaveLength(2);
    expect(refusals[0].payload.output).toBe(
      'Moves example-dashboards and example-dashboards-twin name one line: neither is the one move of that pin.',
    );
  });

  it('keeps a move whose name would escape factory/pin/ under it', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const moves = factoryMoves()
      .filter((m) => m.name === 'example-dashboards')
      .map((m) => ({ ...m, name: '../../main' }));
    await harness(repo, () => day(scanned, moves)).pass();
    expect(openPins(repo).map((p) => p.head)).toEqual(['factory/pin/main']);
    expect(repo.refs.get('main')).toBe(scanned);
  });
});

describe('the pin watch, as review found it', () => {
  it('opens an issue for a lockfile’s move in any lane it would otherwise write, a major’s among them', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const lockfile = factoryMoves().find((m) => m.lockfile) as ReadMove;
    await harness(repo, () => day(scanned, [{ ...lockfile, lane: 'approval', major: true }])).pass();
    expect(appPulls(repo)).toEqual([]);
    expect(repo.issues.map((i) => i.title)).toEqual([
      'Move a package in pnpm-lock.yaml (code scanning alert #5120) to the version its alerts name',
    ]);
  });

  it('opens again a target whose pull request it closed itself, once Dependabot’s that it gave way to is gone', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const urgent = [
      move({
        name: 'ghcr.io/example/sbom-tool',
        pins: [{ file: 'deploy/images/sbom-tool/Dockerfile', line: 2 }],
        from: 'v1.54.0',
        to: `image v1.55.1@${digest('sbom-tool/new')}`,
        lane: 'worker',
      }),
    ];
    const w = harness(repo, () => day(scanned, urgent));
    await w.pass();
    const theirs = dependabotGroup(repo, 'v1.55.1');
    await w.pass();
    expect(openPins(repo)).toEqual([]);
    theirs.state = 'closed';
    await w.pass();
    expect(openPins(repo).map((p) => p.head)).toEqual(['factory/pin/ghcr.io-example-sbom-tool']);
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

  it('commits again when the same target gains a pin, so the branch holds what its description says', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves().map((m) =>
      m.name === 'example/sidecar' ? { ...m, pins: [{ file: 'deploy/base/telemetry/values/logs.yaml', line: 4 }] } : m,
    );
    const w = harness(repo, () => day(scanned, moves));
    await w.pass();
    expect(changed(repo, 'factory/pin/example-sidecar')).toHaveLength(1);
    moves = factoryMoves();
    await w.pass();
    expect(changed(repo, 'factory/pin/example-sidecar')).toHaveLength(2);
    expect(openPins(repo).filter((p) => p.head === 'factory/pin/example-sidecar')).toHaveLength(1);
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
