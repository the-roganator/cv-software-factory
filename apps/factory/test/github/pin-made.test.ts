/**
 * The pin watch and the moves the scan made with the pin step (github/made.ts): a lockfile's packages, what mise
 * pins, and Playwright's image with its library in the lockfile, committed whole as the scan made them, one pull request for each group, and the review gate's rule passing it
 * by asking the same step for the same moves on main.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { type Changed, proveMove } from '../../../../scripts/move.ts';
import type { Move as PinStepMove } from '../../../runner/src/pins.ts';
import { LiveActions } from '../../src/github/actions.ts';
import { WatchedHeads } from '../../src/github/branches.ts';
import { IssueGuard, openedBy } from '../../src/github/issues.ts';
import { groupOf, type MadeGroup, madeByStep, stepOf, toolAt, writtenBy } from '../../src/github/made.ts';
import { pinBranchFor } from '../../src/github/pin-guard.ts';
import { carriedBy, PASS_MS, PIN_LABEL, type PinScope, pinWatch } from '../../src/github/pins.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { client, quiet, type Sent } from './fake.ts';
import { day, digest, FakeRepo, FILES, move, writes } from './pins-harness.ts';

const LOCK = [
  "lockfileVersion: '9.0'",
  '',
  'packages:',
  '',
  '  example-a@1.0.0:',
  '    resolution: {integrity: sha512-a}',
  '',
  '  example-b@2.0.0:',
  '    resolution: {integrity: sha512-b}',
  '',
].join('\n');
const MOVED = LOCK.replace('example-a@1.0.0', 'example-a@1.0.1').replace('example-b@2.0.0', 'example-b@2.0.3');
const MISE_LOCK = ['[[tools.k3d]]', 'version = "5.8.3"', 'backend = "aqua:k3d-io/k3d"', ''].join('\n');
const MISE_MOVED = MISE_LOCK.replace('5.8.3', '5.9.0');
const files = () => ({ ...FILES, 'pnpm-lock.yaml': LOCK, 'mise.lock': MISE_LOCK, 'mise.toml': '[tools]\nk3d = "5"\n' });

/** A lockfile's move, as the worker reads it: the public name, and what the state withholds. */
const npm = (index: number, name: string, from: string, to: string, line: number): ReadMove =>
  move({
    index,
    name: 'a package in `deploy/images/example/kustomization.yaml` and `pnpm-lock.yaml`',
    pins: [
      { file: 'deploy/images/example/kustomization.yaml', line: 0 },
      { file: 'pnpm-lock.yaml', line: 0 },
    ],
    from: '',
    to: '',
    lockfile: true,
    lane: 'worker',
    mark: `mark${index}`.padEnd(12, '0'),
    withheld: {
      package: name,
      from,
      // The scan's grammar for a target: `versions 5.7.2 and 7.5.2` for a package at two.
      to: to.includes(', ') ? `versions ${to.split(', ').join(' and ')}` : `version ${to}`,
      pins: [{ file: 'pnpm-lock.yaml', line }],
    },
    clears: { CRITICAL: 0, HIGH: 0, MEDIUM: 4 + index, LOW: 0, UNKNOWN: 0 },
  });
/** One of k3d's images, which mise.lock's k3d pins: two of the scan's moves at one line. */
const k3d = (index: number, image: string): ReadMove =>
  move({
    index,
    name: `ghcr.io/k3d-io/${image}`,
    pins: [{ file: 'mise.lock', line: 2 }],
    from: '5.8.3',
    to: `image 5.9.0@${digest(image)}`,
    lane: 'worker',
  });
const scan = () => [
  npm(1, 'example-a', '1.0.0', '1.0.1', 5),
  npm(2, 'example-b', '2.0.0', '2.0.3', 8),
  k3d(3, 'k3d-tools'),
  k3d(4, 'k3d-proxy'),
];

const lockGroup = (over: Partial<MadeGroup> = {}): MadeGroup => ({
  files: ['pnpm-lock.yaml'],
  major: false,
  moves: [1, 2],
  refused: [],
  changed: [{ path: 'pnpm-lock.yaml', text: MOVED }],
  steps: [
    { move: 1, ecosystem: 'npm', name: 'example-a', before: ['1.0.0'], after: ['1.0.1'] },
    { move: 2, ecosystem: 'npm', name: 'example-b', before: ['2.0.0'], after: ['2.0.3'] },
  ],
  ...over,
});
const miseGroup = (): MadeGroup => ({
  files: ['mise.lock'],
  major: false,
  moves: [3, 4],
  refused: [],
  changed: [{ path: 'mise.lock', text: MISE_MOVED }],
  steps: [
    { move: 3, ecosystem: 'tool', name: 'k3d', before: ['5.8.3'], after: ['5.9.0'] },
    { move: 4, ecosystem: 'tool', name: 'k3d', before: ['5.8.3'], after: ['5.9.0'] },
  ],
});

/** The day, with what the scan made of it. */
const made = (scanned: string, moves: ReadMove[], groups: MadeGroup[]): Moves => ({
  ...day(scanned, moves),
  made: { version: 1, repository: day(scanned, moves).repository, run: '42000000101', commit: scanned, groups },
});

function harness(repo: FakeRepo, today: () => Moves, only: PinScope = '*', heads?: WatchedHeads) {
  const sent: Sent[] = [];
  const { github } = client(repo.routes(), sent);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'pin-made-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const actions = new LiveActions(github, { guard: new IssueGuard({ openedBy: openedBy(github), recorder }) });
  const lines: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) });
  let clock = Date.parse('2026-11-11T07:00:00Z');
  const reads = { moves: async () => today() };
  const watch = pinWatch(
    { github, reads, actions, recorder, log, now: () => clock, only, ...(heads ? { heads } : {}) },
    day(repo.main, []).repository,
  );
  return {
    sent,
    lines,
    pass: async () => {
      clock += PASS_MS;
      await watch();
    },
  };
}

const openPins = (repo: FakeRepo) => repo.pulls.filter((p) => p.head.startsWith('factory/pin/') && p.state === 'open');
const LOCK_BRANCH = pinBranchFor(['pnpm-lock.yaml']);
const MISE_BRANCH = pinBranchFor(['mise.lock']);

/** What the review gate makes of a branch: the scan's moves made on main by the step, compared with its head. */
async function gate(
  repo: FakeRepo,
  branch: string,
  moves: ReadMove[],
  wrote: (steps: PinStepMove[]) => Map<string, string>,
) {
  const head = repo.refs.get(branch) as string;
  const asked: PinStepMove[][] = [];
  const change = ['pnpm-lock.yaml', 'mise.lock']
    .filter((path) => repo.file(head, path) !== repo.file(repo.main, path))
    .map(
      (path): Changed => ({
        path,
        status: 'M',
        modes: ['100644', '100644'],
        base: repo.file(repo.main, path),
        head: repo.file(head, path),
      }),
    );
  const result = await proveMove(
    change,
    moves,
    {
      base: (path) => repo.file(repo.main, path),
      derive: async (steps) => {
        asked.push([...steps]);
        return wrote([...steps]);
      },
    },
    false,
  );
  return { result, asked };
}

describe('the moves the scan made with the pin step', () => {
  it('groups a lockfile’s moves by the lockfile, and mise’s by mise’s files, and names their tool from its entry', () => {
    const [a, , tools] = scan() as [ReadMove, ReadMove, ReadMove];
    expect(writtenBy(a)).toEqual(['pnpm-lock.yaml']);
    expect(groupOf(tools)).toEqual({ files: ['mise.lock'], major: false });
    expect(toolAt(MISE_LOCK, 2)).toBe('k3d');
    expect(toolAt('[settings]\nx = 1\n', 2)).toBeUndefined();
    expect(stepOf(a, undefined)).toEqual({ ecosystem: 'npm', name: 'example-a', from: '1.0.0', to: '1.0.1' });
    expect(stepOf(tools, MISE_LOCK)).toEqual({ ecosystem: 'tool', name: 'k3d', from: '5.8.3', to: '5.9.0' });
    // A package at two versions is one move to two.
    const twice = npm(5, 'semver', '5.7.1, 7.5.1', '5.7.2, 7.5.2', 9);
    expect(stepOf(twice, undefined)).toEqual({
      ecosystem: 'npm',
      name: 'semver',
      from: '5.7.1,7.5.1',
      to: '5.7.2,7.5.2',
    });
  });

  it('opens one pull request for the day’s lockfile moves and one for k3d’s two, each as the scan made it', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const w = harness(repo, () => made(scanned, scan(), [lockGroup(), miseGroup()]));
    await w.pass();
    const pulls = openPins(repo);
    expect(pulls.map((p) => p.head).sort()).toEqual([LOCK_BRANCH, MISE_BRANCH].sort());
    const lock = pulls.find((p) => p.head === LOCK_BRANCH);
    const tools = pulls.find((p) => p.head === MISE_BRANCH);
    expect(repo.file(repo.refs.get(LOCK_BRANCH) as string, 'pnpm-lock.yaml')).toBe(MOVED);
    expect(repo.file(repo.refs.get(MISE_BRANCH) as string, 'mise.lock')).toBe(MISE_MOVED);
    for (const [path, text] of Object.entries(files()))
      if (path !== 'pnpm-lock.yaml') expect(repo.file(repo.refs.get(LOCK_BRANCH) as string, path)).toBe(text);
    expect(lock).toMatchObject({ title: 'chore(pin): move 2 packages in pnpm-lock.yaml', labels: [PIN_LABEL] });
    expect(tools).toMatchObject({ title: 'chore(pin): move k3d to 5.9.0', labels: [PIN_LABEL] });
    // What its diff shows, and nothing the scan found there.
    expect(lock?.body).toContain('| `example-a` | `1.0.0` | `1.0.1` |');
    expect(lock?.body).not.toMatch(/medium|Clears|Deadline|GHSA-|CVE-/);
    expect(carriedBy(lock?.body)).toHaveLength(2);
    // k3d's two images are the scan's two moves of one pin, and neither is refused as one of two at its line.
    expect(carriedBy(tools?.body)).toEqual(['ghcr.io/k3d-io/k3d-tools', 'ghcr.io/k3d-io/k3d-proxy']);
    expect(tools?.body).toContain('| `ghcr.io/k3d-io/k3d-tools` | 3 high, 5 medium | nothing |');
    expect(repo.issues).toEqual([]);
  });

  it('is passed by the review gate, which asks the step for the same moves, in the same order', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    await harness(repo, () => made(scanned, scan(), [lockGroup(), miseGroup()])).pass();
    const lock = await gate(repo, LOCK_BRANCH, scan(), () => new Map([['pnpm-lock.yaml', MOVED]]));
    expect(lock.asked).toEqual([
      [
        { ecosystem: 'npm', name: 'example-a', from: '1.0.0', to: '1.0.1' },
        { ecosystem: 'npm', name: 'example-b', from: '2.0.0', to: '2.0.3' },
      ],
    ]);
    expect(lock.result).toMatchObject({ rule: 'move' });
    // Its words name the public list's move alone, never the package.
    expect(JSON.stringify(lock.result)).not.toMatch(/example-a|example-b/);
    const tools = await gate(repo, MISE_BRANCH, scan(), () => new Map([['mise.lock', MISE_MOVED]]));
    expect(tools.asked).toEqual([
      [
        { ecosystem: 'tool', name: 'k3d', from: '5.8.3', to: '5.9.0' },
        { ecosystem: 'tool', name: 'k3d', from: '5.8.3', to: '5.9.0' },
      ],
    ]);
    expect(tools.result).toMatchObject({ rule: 'move' });
    // What the step writes on main differing from the pull request is refused, by its line alone.
    const other = await gate(
      repo,
      LOCK_BRANCH,
      scan(),
      () => new Map([['pnpm-lock.yaml', LOCK.replace('1.0.0', '1.0.2')]]),
    );
    expect(other.result).toEqual({
      reason: 'pnpm-lock.yaml:5 is not what the pin step writes for the moves it carries',
    });
  });

  it('opens an issue for a move the step refused, naming no package, logs the step’s words, and makes the rest', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const group = lockGroup({
      moves: [1],
      refused: [{ move: 2, reason: 'ERR_PNPM_TRUST_DOWNGRADE example-b@2.0.3 has weaker provenance' }],
      changed: [{ path: 'pnpm-lock.yaml', text: LOCK.replace('example-a@1.0.0', 'example-a@1.0.1') }],
      steps: [{ move: 1, ecosystem: 'npm', name: 'example-a', before: ['1.0.0'], after: ['1.0.1'] }],
    });
    const w = harness(repo, () => made(scanned, scan().slice(0, 2), [group]));
    await w.pass();
    expect(openPins(repo).map((p) => p.title)).toEqual(['chore(pin): move example-a in pnpm-lock.yaml']);
    expect(repo.issues.map((i) => i.title)).toEqual([expect.stringMatching(/^Move a package in `?deploy.*\(mark2/)]);
    expect(repo.issues[0]?.body).toContain('could not make it on the commit it read');
    expect(repo.issues[0]?.body).not.toMatch(/example-b|TRUST_DOWNGRADE/);
    expect(w.lines.find((line) => line.reason)).toMatchObject({
      level: 40,
      move: 2,
      reason: expect.stringContaining('TRUST_DOWNGRADE'),
    });
  });

  it('waits when a file the step wrote has changed on main, or when the scan made none', async () => {
    const changed = new FakeRepo(files());
    const scanned = changed.main;
    changed.push({ 'pnpm-lock.yaml': `${LOCK}\n` });
    const a = harness(changed, () => made(scanned, scan().slice(0, 2), [lockGroup()]));
    await a.pass();
    expect(writes(a.sent)).toEqual([]);

    const none = new FakeRepo(files());
    const b = harness(none, () => day(none.main, scan().slice(0, 2)));
    await b.pass();
    expect(writes(b.sent)).toEqual([]);
  });

  it('told one move of a group the step made, commits the group whole, as the scan made it and the gate makes it', async () => {
    const repo = new FakeRepo(files());
    const moves = [scan()[0] as ReadMove, { ...(scan()[1] as ReadMove), name: 'a package in `pnpm-lock.yaml`' }];
    const told = moves[0]?.name as string;
    const w = harness(repo, () => made(repo.main, moves, [lockGroup()]), [told]);
    await w.pass();
    const [pull] = openPins(repo);
    expect(pull?.head).toBe(LOCK_BRANCH);
    expect(repo.file(repo.refs.get(LOCK_BRANCH) as string, 'pnpm-lock.yaml')).toBe(MOVED);
    expect(carriedBy(pull?.body)).toEqual(moves.map((move) => move.name));
    expect((await gate(repo, LOCK_BRANCH, moves, () => new Map([['pnpm-lock.yaml', MOVED]]))).result).toMatchObject({
      rule: 'move',
    });
    // A move of the group it was not told, refused by the step, has no issue of the watch's: one told has.
    const refused = (index: number) =>
      lockGroup({
        moves: [3 - index],
        refused: [{ move: index, reason: 'ERR_PNPM_TRUST_DOWNGRADE' }],
        changed: [{ path: 'pnpm-lock.yaml', text: MOVED }],
      });
    const other = new FakeRepo(files());
    await harness(other, () => made(other.main, moves, [refused(2)]), [told]).pass();
    expect(other.issues).toEqual([]);
    expect(openPins(other)).toHaveLength(1);
    const own = new FakeRepo(files());
    await harness(own, () => made(own.main, moves, [refused(1)]), [told]).pass();
    expect(own.issues).toHaveLength(1);
  });

  it('writes nothing again while the scan makes the same bytes, and moves its branch when they change', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    let group = lockGroup();
    const w = harness(repo, () => made(scanned, scan().slice(0, 2), [group]));
    await w.pass();
    const first = repo.refs.get(LOCK_BRANCH);
    await w.pass();
    expect(repo.refs.get(LOCK_BRANCH)).toBe(first);
    group = lockGroup({ changed: [{ path: 'pnpm-lock.yaml', text: MOVED.replace('1.0.1', '1.0.2') }] });
    await w.pass();
    expect(repo.refs.get(LOCK_BRANCH)).not.toBe(first);
    expect(openPins(repo)).toHaveLength(1);
  });

  it('a restart keeps the head of a pull request whose files the scan wrote, while main has not changed them', async () => {
    const repo = new FakeRepo(files());
    const scanned = repo.main;
    const today = () => made(scanned, scan().slice(0, 2), [lockGroup()]);
    await harness(repo, today, '*', new WatchedHeads()).pass();
    const first = repo.refs.get(LOCK_BRANCH) as string;
    // main moves elsewhere, then the worker starts again: a new record, and the same head taken as its own.
    repo.push({ 'deploy/k3d/cluster.yaml': 'kind: Simple\n' });
    const heads = new WatchedHeads();
    const again = harness(repo, today, '*', heads);
    await again.pass();
    expect(repo.refs.get(LOCK_BRANCH)).toBe(first);
    expect(heads.get(day(scanned, []).repository, LOCK_BRANCH)).toBe(first);
    expect(writes(again.sent)).toEqual([]);
    // The scan's bytes for the lockfile change: the branch no longer holds them, and is written again.
    const moved = harness(
      repo,
      () =>
        made(scanned, scan().slice(0, 2), [
          lockGroup({ changed: [{ path: 'pnpm-lock.yaml', text: MOVED.replace('1.0.1', '1.0.2') }] }),
        ]),
      '*',
      new WatchedHeads(),
    );
    await moved.pass();
    expect(repo.refs.get(LOCK_BRANCH)).not.toBe(first);
  });

  describe('Playwright’s image, which brings its library (test 6)', () => {
    const BROWSER = 'apps/factory/Dockerfile.browser';
    const MANIFEST = 'apps/factory/package.json';
    const PLAYWRIGHT = 'mcr.microsoft.com/playwright';
    const browser = (tag: string, at: string) =>
      `FROM node:24.22.2-trixie-slim AS node\nFROM ${PLAYWRIGHT}:${tag}@${at} AS browsers\n`;
    const manifest = (range: string) => `{\n  "dependencies": {\n    "playwright": "${range}"\n  }\n}\n`;
    const LIBRARY = `${LOCK}  playwright@1.65.0:\n    resolution: {integrity: sha512-p}\n`;
    const withBrowser = () => ({
      ...files(),
      'pnpm-lock.yaml': LIBRARY,
      [BROWSER]: browser('v1.65.0-noble', digest('playwright/old')),
      [MANIFEST]: manifest('^1.65.0'),
    });
    const image = (index: number): ReadMove =>
      move({
        index,
        name: PLAYWRIGHT,
        pins: [{ file: BROWSER, line: 2 }],
        from: 'v1.65.0-noble',
        to: `image v1.65.1-noble@${digest('playwright/new')}`,
        lane: 'worker',
      });
    const changed = (lock: string) => [
      { path: BROWSER, text: browser('v1.65.1-noble', digest('playwright/new')) },
      { path: MANIFEST, text: manifest('^1.65.1') },
      { path: 'pnpm-lock.yaml', text: lock.replace('playwright@1.65.0', 'playwright@1.65.1') },
    ];
    const step = { move: 3, ecosystem: 'docker' as const, name: PLAYWRIGHT, before: ['v1.65.0-noble'] };

    it('is made by the step, in the lockfile’s group, as the day’s lockfile moves are', () => {
      expect(madeByStep(image(3))).toBe(true);
      expect(writtenBy(image(3))).toEqual(['pnpm-lock.yaml']);
      expect(groupOf(image(3))).toEqual(groupOf(scan()[0] as ReadMove));
      expect(stepOf(image(3), undefined)).toEqual({
        ecosystem: 'docker',
        name: PLAYWRIGHT,
        from: 'v1.65.0-noble',
        to: `v1.65.1-noble@${digest('playwright/new')}`,
      });
      // An image that brings nothing is a pin's edit, as it was.
      expect(madeByStep({ ...image(3), name: 'postgres' })).toBe(false);
    });

    it('opens one pull request with the day’s lockfile moves: the image, its library and their ranges together', async () => {
      const repo = new FakeRepo(withBrowser());
      const scanned = repo.main;
      const moves = [...scan().slice(0, 2), image(3)];
      const group = lockGroup({
        moves: [1, 2, 3],
        changed: changed(
          MOVED.replace(
            'example-b@2.0.3:\n    resolution: {integrity: sha512-b}\n',
            'example-b@2.0.3:\n    resolution: {integrity: sha512-b}\n  playwright@1.65.0:\n    resolution: {integrity: sha512-p}\n',
          ),
        ),
        steps: [...lockGroup().steps, { ...step, after: [`v1.65.1-noble@${digest('playwright/new')}`] }],
      });
      await harness(repo, () => made(scanned, moves, [group])).pass();
      const pulls = openPins(repo);
      expect(pulls.map((p) => p.head)).toEqual([LOCK_BRANCH]);
      const head = repo.refs.get(LOCK_BRANCH) as string;
      for (const { path, text } of group.changed) expect(repo.file(head, path)).toBe(text);
      expect(pulls[0]?.title).toBe('chore(pin): move 3 pins in pnpm-lock.yaml');
      expect(carriedBy(pulls[0]?.body)).toEqual([
        ...scan()
          .slice(0, 2)
          .map((m) => m.name),
        PLAYWRIGHT,
      ]);
      expect(pulls[0]?.body).toContain(
        '`mcr.microsoft.com/playwright` is one release with its library, `playwright`, `playwright-core`, `@playwright/test`',
      );
      expect(repo.issues).toEqual([]);
    });

    it('titles the image’s pull request alone by its tag, without its digest', async () => {
      const repo = new FakeRepo(withBrowser());
      const scanned = repo.main;
      const group = lockGroup({
        moves: [1],
        changed: changed(LIBRARY),
        steps: [{ ...step, move: 1, after: [`v1.65.1-noble@${digest('playwright/new')}`] }],
      });
      await harness(repo, () => made(scanned, [image(1)], [group])).pass();
      expect(openPins(repo).map((p) => p.title)).toEqual([
        'chore(pin): move mcr.microsoft.com/playwright to v1.65.1-noble',
      ]);
    });
  });
});
