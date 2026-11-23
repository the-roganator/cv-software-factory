import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withChecksRun } from '../apps/factory/src/github/actions.ts';
import { type Made, sealMade } from '../apps/factory/src/github/made.ts';
import { APP_REPOSITORY, FACTORY_REPOSITORY } from '../apps/factory/src/repositories.ts';
import { newKey, readKey, type StateApi } from '../apps/factory/src/vulnerabilities/state.ts';
import { zipOf } from '../apps/factory/test/vulnerabilities/zip-of.ts';
import type { Get, Move as PinStepMove } from '../apps/runner/src/pins.ts';
import { askedKey, type Derivation, deriveOn } from './derive.ts';
import { type MoveIO, proveMove, type ScanMove } from './move.ts';
import { askedOf, derivationOf, mergeOf, type ScanDay, sides } from './moves.ts';
import type { GitHub, PullRequest, Run } from './review-gate.ts';

// The gate's two sides of a merge, read from a repository of git's own as from GitHub's copy, and the move proved on
// them: what a pull request's head makes on main's tip, and what the merge queue's commit makes on the one it was made
// on.

const APP = 'the-roganator/cv-worlds-worst-website';
const LOCK = 'pnpm-lock.yaml';
const CHART = 'deploy/base/telemetry/prometheus.yaml';
const ICON = 'apps/console/public/icon.png';

const root = mkdtempSync(join(tmpdir(), 'moves-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const origin = join(root, 'origin');
mkdirSync(origin);
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', '-C', origin, ...args],
    { encoding: 'utf-8' },
  ).trim();
git('init', '--quiet', '--initial-branch=main');

/** A commit on `parent` with these files, on a branch of its own so a fetch by its id finds it. */
function commit(branch: string, parent: string | undefined, files: Record<string, string | Uint8Array>): string {
  if (parent) git('checkout', '--quiet', '-B', branch, parent);
  else git('checkout', '--quiet', '-B', branch);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(origin, dirname(path)), { recursive: true });
    writeFileSync(join(origin, path), body);
  }
  git('add', '--all');
  git('commit', '--quiet', '--message', branch);
  return git('rev-parse', 'HEAD');
}

/** The queue's commit for a head, as GitHub makes one: the head's change merged onto `onto`, its one parent. */
function queued(branch: string, onto: string, head: string, mergeBase: string): string {
  const tree = git('merge-tree', '--write-tree', `--merge-base=${mergeBase}`, onto, head).split('\n')[0] as string;
  const made = git('commit-tree', tree, '-p', onto, '-m', branch);
  git('branch', '--force', branch, made);
  return made;
}

/** A lockfile: each package at its version, apart enough that git merges changes to each. */
const lockfile = (a: string, b: string, shared: string) =>
  [
    "lockfileVersion: '9.0'",
    'packages:',
    `  a@${a}:`,
    ...Array.from({ length: 5 }, (_, i) => `    a${i}: x`),
    `  b@${b}:`,
    ...Array.from({ length: 5 }, (_, i) => `    b${i}: x`),
    `  shared@${shared}:`,
    '',
  ].join('\n');

const counts = { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
const packageMove = (index: number, name: string, line: number): ScanMove => ({
  repository: APP,
  name: `a package in \`${LOCK}\``,
  pins: [{ file: LOCK, line: 0 }],
  from: '',
  to: '',
  major: false,
  clears: counts,
  leaves: counts,
  newToday: 0,
  lane: 'line',
  lockfile: true,
  index,
  findings: [],
  withheld: { package: name, from: '1.0.0', to: 'version 2.0.0', pins: [{ file: LOCK, line }] },
});
const SCAN = [packageMove(1, 'a', 3), packageMove(2, 'b', 9)];

/**
 * pnpm, as the derivation runs it on a checkout: each package to its version, and `shared` to what they need together.
 * Either at 2.0.0 needs `shared` at 2.0.0; both need 3.0.0, which neither pull request wrote alone.
 */
const pnpm =
  (base: (path: string) => Promise<string | undefined>): MoveIO['derive'] =>
  async (moves: readonly PinStepMove[]) => {
    let text = (await base(LOCK)) as string;
    for (const each of moves) text = text.replace(`  ${each.name}@${each.from}:`, `  ${each.name}@${each.to}:`);
    const moved = ['a', 'b'].filter((name) => text.includes(`  ${name}@2.0.0:`)).length;
    text = text.replace(/ {2}shared@[\d.]+:/, `  shared@${moved === 2 ? '3.0.0' : '2.0.0'}:`);
    return new Map([[LOCK, text]]);
  };

const MAIN = commit('main', undefined, { [LOCK]: lockfile('1.0.0', '1.0.0', '1.0.0') });
const A = commit('a', MAIN, { [LOCK]: lockfile('2.0.0', '1.0.0', '2.0.0') });
const B = commit('b', MAIN, { [LOCK]: lockfile('1.0.0', '2.0.0', '2.0.0') });
const SOURCE = `file://${origin}`;
/** The scan's day the sides' own derivation would be made as of: these tests prove the moves with their own. */
const DAY: ScanDay = { moves: [], judged: Date.parse('2026-11-20T05:00:00Z'), asked: new Map() };

let made = 0;
/** The answer the gate's move job gives on these two sides. */
async function proved(merge: Parameters<typeof sides>[1], scan: ScanMove[] = SCAN) {
  const work = join(root, `work-${++made}`);
  mkdirSync(work);
  const two = await sides(APP, merge, work, DAY, SOURCE);
  return proveMove(two.changed, scan, { base: () => undefined, derive: pnpm(two.base) }, true);
}

describe('what the move job proves a move on (S-L5)', () => {
  it('proves each pull request alone on main’s tip, as the gate judges its head', async () => {
    expect(await proved({ base: MAIN, mergeBase: MAIN, head: A })).toMatchObject({ rule: 'move' });
    expect(await proved({ base: MAIN, mergeBase: MAIN, head: B })).toMatchObject({ rule: 'move' });
  });

  it('proves a head the watch wrote again for its checks as it proved the head before (`commitAgain`)', async () => {
    // The same tree on the same parent, its message with a `Checks-run:` line: what the queue writes for a failed check.
    const message = withChecksRun(git('log', '-1', '--format=%B', A), 2);
    const again = git('commit-tree', `${A}^{tree}`, '-p', MAIN, '-m', message);
    git('branch', '--force', 'a-again', again);
    expect(again).not.toBe(A);
    expect(git('log', '-1', '--format=%B', again)).toContain('Checks-run: 2');
    expect(await proved({ base: MAIN, mergeBase: MAIN, head: again })).toEqual(
      await proved({ base: MAIN, mergeBase: MAIN, head: A }),
    );
  });

  it('proves the queue’s commit on the entries ahead of it, and refuses a combination no derivation writes', async () => {
    // A first in the queue: its commit is main's tip and its move, which the derivation writes.
    const first = queued('gh-readonly-queue/main/pr-1-x', MAIN, A, MAIN);
    expect(await proved({ queue: first })).toMatchObject({ rule: 'move' });
    // B behind it: git merges the two cleanly, `shared` at 2.0.0, where the derivation of both writes 3.0.0.
    const second = queued('gh-readonly-queue/main/pr-2-x', first, B, MAIN);
    expect(await proved({ queue: second })).toEqual({
      reason: `${LOCK}:15 is not what the pin step writes for the moves it carries`,
    });
  });
});

describe('what the move job reads of a file (S-M2)', () => {
  it('refuses bytes that are not UTF-8 changed beside a real move, which a lenient reading takes for the same', async () => {
    const chart = (version: string) => `spec:\n  source:\n      chart: prometheus\n      targetRevision: ${version}\n`;
    const icon = (byte: number) => Uint8Array.of(0x89, 0x50, 0x4e, 0x47, byte, 0x0a);
    const base = commit('icon', undefined, { [CHART]: chart('29.35.0'), [ICON]: icon(0x80) });
    const head = commit('icon-head', base, { [CHART]: chart('29.47.2'), [ICON]: icon(0xff) });
    const scan: ScanMove[] = [
      {
        ...packageMove(1, '', 0),
        repository: 'the-roganator/cv-software-factory',
        name: 'prometheus',
        lockfile: false,
        lane: 'worker',
        withheld: undefined,
        pins: [{ file: CHART, line: 4 }],
        from: '29.35.0',
        to: 'chart prometheus 29.47.2',
      },
    ];
    const work = join(root, 'work-icon');
    mkdirSync(work);
    const two = await sides(APP, { base, mergeBase: base, head }, work, DAY, SOURCE);
    const io: MoveIO = {
      base: (path) => (path === CHART ? chart('29.35.0') : undefined),
      derive: async () => new Map(),
    };
    expect(await proveMove(two.changed, scan, io, false)).toEqual({
      reason: `${ICON} is not UTF-8 text, and a move writes text alone`,
    });
    // The chart alone is the move.
    const alone = commit('icon-chart', base, { [CHART]: chart('29.47.2') });
    const one = join(root, 'work-icon-chart');
    mkdirSync(one);
    const chartOnly = await sides(APP, { base, mergeBase: base, head: alone }, one, DAY, SOURCE);
    expect(await proveMove(chartOnly.changed, scan, io, false)).toMatchObject({ rule: 'move' });
  });
});

describe('which merge the move job judges', () => {
  const pr = (number: number): PullRequest => ({
    number,
    state: 'open',
    user: { id: 1 },
    head: { sha: 'a'.repeat(40), ref: 'factory/pin/x', repo: { full_name: APP } },
    base: { ref: 'main', repo: { full_name: APP } },
  });
  const compare = { merge_base_commit: { sha: 'b'.repeat(40) }, base_commit: { sha: 'c'.repeat(40) } };
  const github = { api: async () => compare } as unknown as GitHub;
  const run: Run = { repo: APP, read: '', token: '', autonomy: '', print: true };

  it('judges the queue’s own commit for the pull request it was made for, and every other on main’s tip', async () => {
    const queue = { number: 7, commit: 'd'.repeat(40) };
    expect(await mergeOf({ ...run, queue }, pr(7), github)).toEqual({ queue: queue.commit });
    expect(await mergeOf({ ...run, queue }, pr(6), github)).toEqual({
      base: 'c'.repeat(40),
      mergeBase: 'b'.repeat(40),
      head: 'a'.repeat(40),
    });
    expect(await mergeOf(run, pr(7), github)).toMatchObject({ base: 'c'.repeat(40) });
  });
});

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const KEY = readKey(newKey());
const JUDGED = Date.parse('2026-11-20T05:00:00Z');

const group = (asked?: Made['groups'][number]['asked']): Made['groups'][number] => ({
  files: ['apps/factory/Dockerfile'],
  major: false,
  moves: [1],
  refused: [],
  changed: [],
  steps: [],
  ...(asked && { asked }),
});

/** GitHub, as far as the gate reads a run's `pins`: the run's artifacts, and the archive. */
function artifacts(run: string, made: Made | undefined): { api: StateApi; asked: string[] } {
  const asked: string[] = [];
  const archive = made && zipOf({ 'pins.sealed': sealMade(made, KEY) });
  return {
    asked,
    api: {
      json: async (path) => {
        asked.push(path);
        return {
          artifacts: archive && path.includes(`/runs/${run}/`) ? [{ id: 3, name: 'pins', expired: false }] : [],
        };
      },
      bytes: async (path) => {
        asked.push(path);
        return archive;
      },
    },
  };
}

describe('the answers the gate makes the scan’s moves with (C-1)', () => {
  it('reads the digests the scan’s step was given from the same run’s pins, the first group’s where two asked', async () => {
    const made: Made = {
      version: 1,
      repository: FACTORY_REPOSITORY,
      run: '42',
      commit: 'a'.repeat(40),
      groups: [
        group([{ image: 'node', tag: '24-slim', digest: digest('1') }]),
        // A group made before the answers were kept, and one that asked the same tag a moment later.
        group(),
        group([
          { image: 'node', tag: '24-slim', digest: digest('2') },
          { image: 'gcr.io/distroless/nodejs24-debian13', tag: 'nonroot', digest: digest('3') },
        ]),
      ],
    };
    const { api, asked } = artifacts('42', made);
    expect([...(await askedOf(api, FACTORY_REPOSITORY, '42', KEY))]).toEqual([
      [askedKey('node', '24-slim'), digest('1')],
      [askedKey('gcr.io/distroless/nodejs24-debian13', 'nonroot'), digest('3')],
    ]);
    expect(asked[0]).toBe(`/repos/${FACTORY_REPOSITORY}/actions/runs/42/artifacts?name=pins&per_page=10`);
  });

  it('reads the app’s from its run’s pins too, and has none where the run kept no pins', async () => {
    expect((await askedOf(artifacts('42', undefined).api, FACTORY_REPOSITORY, '42', KEY)).size).toBe(0);
    const made: Made = {
      version: 1,
      repository: APP_REPOSITORY,
      run: '42',
      commit: 'a'.repeat(40),
      groups: [group([{ image: 'gcr.io/distroless/nodejs24-debian13', tag: 'nonroot', digest: digest('4') }])],
    };
    const { api, asked } = artifacts('42', made);
    expect([...(await askedOf(api, APP_REPOSITORY, '42', KEY))]).toEqual([
      [askedKey('gcr.io/distroless/nodejs24-debian13', 'nonroot'), digest('4')],
    ]);
    expect(asked[0]).toBe(`/repos/${APP_REPOSITORY}/actions/runs/42/artifacts?name=pins&per_page=10`);
  });

  it('makes either repository’s moves as of the scan with its answers, each image at the scan’s target', () => {
    const day: ScanDay = { moves: [], judged: JUDGED, asked: new Map([[askedKey('node', '24-slim'), digest('1')]]) };
    const moves = [
      { ecosystem: 'docker' as const, name: 'gcr.io/distroless/static', from: 'nonroot', to: `nonroot@${digest('5')}` },
      { ecosystem: 'npm' as const, name: 'example', from: '1.0.0', to: '1.0.1' },
    ];
    const asked = new Map([
      [askedKey('node', '24-slim'), digest('1')],
      [askedKey('gcr.io/distroless/static', 'nonroot'), digest('5')],
    ]);
    expect(derivationOf(FACTORY_REPOSITORY, day, moves)).toEqual({ workspace: true, asOf: JUDGED, asked });
    // The app's checkout is held to the registry; its moves are made from what its own scan sealed, as the factory's.
    expect(derivationOf(APP_REPOSITORY, day, moves)).toEqual({ workspace: false, asOf: JUDGED, asked });
  });
});

describe('the app’s moves, made from what its scan sealed (S2-M1)', () => {
  const NONROOT = 'gcr.io/distroless/nodejs24-debian13';
  const BUILD = 'node:24.22.2-alpine3.24';
  /** What the app's scan sealed: the digest its pins job was given for each tag the move asks. */
  const sealed: ScanDay = {
    moves: [],
    judged: JUDGED,
    asked: new Map([
      [askedKey('node', '24.22.2-alpine3.24'), digest('3')],
      [askedKey(NONROOT, 'nonroot'), digest('4')],
    ]),
  };
  const MISE_TOML = '[settings]\nminimum_release_age = "3d"\n\n[tools]\nnode = "24.22.1"\n';
  const MISE_LOCK = `[[tools.node]]\nversion = "24.22.1"\nbackend = "core:node"\nspecifiers = ["24.22.1"]\n\n[tools.node."platforms.linux-x64"]\nchecksum = "sha256:${'f'.repeat(64)}"\nurl = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz"\n`;
  const DOCKERFILE = `FROM node:24.22.1-alpine3.24@${digest('1')} AS build\nFROM ${NONROOT}:nonroot@${digest('2')}\n`;
  const MAIN: Record<string, string> = { 'mise.toml': MISE_TOML, 'mise.lock': MISE_LOCK, Dockerfile: DOCKERFILE };
  /** nodejs.org, Docker Hub and gcr.io, with the build stage's tag and distroless's `nonroot` at these digests now. */
  const registries =
    (build: string, nonroot: string): Get =>
    async (url) => {
      if (url === 'https://nodejs.org/dist/index.json')
        return Response.json([{ version: 'v24.22.2', date: '2026-11-01' }]);
      if (url === 'https://nodejs.org/dist/v24.22.2/SHASUMS256.txt')
        return new Response(`${'a'.repeat(64)}  node-v24.22.2-linux-x64.tar.gz\n`);
      if (url.startsWith('https://auth.docker.io/token')) return Response.json({ token: 'anonymous' });
      if (url === 'https://registry-1.docker.io/v2/library/node/manifests/24.22.2-alpine3.24')
        return new Response(null, { headers: { 'docker-content-digest': build } });
      if (url === 'https://gcr.io/v2/distroless/nodejs24-debian13/manifests/nonroot')
        return new Response(null, { headers: { 'docker-content-digest': nonroot } });
      return new Response(null, { status: 404 });
    };
  const checkout = () => {
    const dir = mkdtempSync(join(root, 'app-'));
    for (const [path, text] of Object.entries(MAIN)) writeFileSync(join(dir, path), text);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
        {
          cwd: dir,
        },
      );
    git('init', '--quiet');
    git('add', '.');
    git('commit', '--quiet', '--message', 'main');
    return dir;
  };
  /** The pin step on main, made as `derivation` says, with the registries as `get` answers. */
  const step = (moves: readonly PinStepMove[], get: Get, derivation: Pick<Derivation, 'asOf' | 'asked'>) =>
    deriveOn(checkout(), moves, {
      work: mkdtempSync(join(root, 'derive-')),
      pnpm: '/bin/pnpm',
      workspace: false,
      get,
      ...derivation,
    });
  /** The app's scan's move of Node, as the GitHub worker reads it. */
  const node: ScanMove = {
    repository: APP_REPOSITORY,
    name: 'node',
    pins: [{ file: 'mise.toml', line: 5 }],
    from: '24.22.1',
    to: 'version 24.22.2',
    major: false,
    clears: counts,
    leaves: counts,
    newToday: 0,
    lane: 'line',
    lockfile: false,
    index: 1,
    findings: [],
  };
  /** The gate's proof of a pull request whose files are `head`, after both registries pushed their tags again. */
  const gate = (head: Map<string, string>) =>
    proveMove(
      [...head].map(([path, text]) => ({
        path,
        status: 'M',
        modes: ['100644', '100644'] as [string, string],
        base: MAIN[path],
        head: text,
      })),
      [node],
      {
        base: (path) => MAIN[path],
        derive: (moves) =>
          step(moves, registries(digest('7'), digest('6')), derivationOf(APP_REPOSITORY, sealed, moves)),
      },
      true,
    );
  // The line's pin step, given what the scan sealed (`Step['made']`), while the registries still answered so.
  const made = () =>
    step([{ ecosystem: 'node', name: 'node', from: '24.22.1', to: '24.22.2' }], registries(digest('3'), digest('4')), {
      asOf: JUDGED,
      asked: new Map(sealed.asked),
    });

  it('passes the line’s move as the scan sealed it, though both tags were pushed again since', async () => {
    const line = await made();
    expect(line.get('Dockerfile')).toBe(
      `FROM ${BUILD}@${digest('3')} AS build\nFROM ${NONROOT}:nonroot@${digest('4')}\n`,
    );
    expect(await gate(line)).toMatchObject({ rule: 'move' });
  });

  it('holds a pull request that pins another digest of a tag the move brings, whatever its commits say of it', async () => {
    // The App's key writes the build stage at an older build of the same tag, and its commit says it asked that:
    // nothing of a pull request's commits reaches the gate's derivation, which takes the scan's day alone.
    const forged = new Map(await made());
    forged.set(
      'Dockerfile',
      (forged.get('Dockerfile') as string).replace(`${BUILD}@${digest('3')}`, `${BUILD}@${digest('9')}`),
    );
    expect(await gate(forged)).toEqual({
      reason: `Dockerfile:1 is \`FROM ${BUILD}@${digest('9')} AS build\` where the scan's moves make \`FROM ${BUILD}@${digest('3')} AS build\``,
    });
  });
});
