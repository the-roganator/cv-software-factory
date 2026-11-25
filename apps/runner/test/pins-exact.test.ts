/**
 * A routine update's move of a package, made by the pin step with pnpm itself against a registry of the test's own:
 * what `pnpm update <name>@<target>` resolves and writes is pnpm's to say, and no fake of it could. The registry has a
 * release younger than the target inside the range, old enough for pnpm's own release age (a day) and not for the
 * scan's wait: a fix's move takes it, as a floor allows, and a routine update's does not.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { listenLocal } from '@software-factory/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isReason, type Made, openMade, reasonOf, sealMade } from '../../factory/src/github/made.ts';
import { madeRefusal } from '../../factory/src/github/pin-guard.ts';
import { newKey, readKey } from '../../factory/src/vulnerabilities/state.ts';
import {
  importedVersions,
  lockedVersions,
  type Move,
  movePackage,
  OWN_PNPM,
  OWN_PNPM_FLAG,
  PinsHeld,
  PinsRefused,
  type Pnpm,
  pnpmAsOf,
} from '../src/pins.ts';

const exec = promisify(execFile);
const DAY = 24 * 3_600_000;
const WORK = mkdtempSync(join(tmpdir(), 'pins-exact-'));

/** Each release the registry has: what it depends on, and how many days ago it was published. */
const RELEASES: Record<string, Record<string, { needs?: Record<string, string>; days: number }>> = {
  'demo-pkg': {
    '1.0.0': { days: 40 },
    // The scan's target: past its wait.
    '1.0.1': { days: 5 },
    // Younger, inside `^1.0.0`: past pnpm's day, and not past the scan's wait.
    '1.0.2': { days: 2 },
    // Out this morning: younger than pnpm's own release age, which refuses it.
    '1.0.3': { days: 0.2 },
    '2.0.0': { days: 10 },
    '2.0.1': { days: 2 },
  },
  'demo-parent': { '1.0.0': { needs: { 'demo-pkg': '^1.0.0' }, days: 40 } },
  // A parent that pins the package exactly, where it was: no release of the package moves its copy.
  'demo-holder': { '1.0.0': { needs: { 'demo-pkg': '1.0.0' }, days: 40 } },
};

/** A package's tarball: its manifest alone, as `npm pack` lays one out. */
function tarball(name: string, version: string, needs: Record<string, string> = {}): Buffer {
  const dir = mkdtempSync(join(WORK, 'pack-'));
  mkdirSync(join(dir, 'package'));
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name, version, dependencies: needs }));
  execFileSync('tar', ['czf', 'package.tgz', 'package'], { cwd: dir });
  return readFileSync(join(dir, 'package.tgz'));
}

let server: Server;
let registry = '';
/** The oldest a release must be to be served: the registry as it was that many days ago. */
let since = 0;

beforeAll(async () => {
  const tarballs = new Map<string, Buffer>();
  for (const [name, versions] of Object.entries(RELEASES))
    for (const [version, { needs }] of Object.entries(versions))
      tarballs.set(`/${name}/-/${name}-${version}.tgz`, tarball(name, version, needs));
  server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? '');
    const bytes = tarballs.get(path);
    if (bytes) {
      response.end(bytes);
      return;
    }
    const versions = RELEASES[path.slice(1)];
    if (!versions) {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    const name = path.slice(1);
    const served = Object.entries(versions).filter(([, { days }]) => days >= since);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        name,
        'dist-tags': { latest: served.at(-1)?.[0] },
        time: Object.fromEntries(served.map(([v, { days }]) => [v, new Date(Date.now() - days * DAY).toISOString()])),
        versions: Object.fromEntries(
          served.map(([version, { needs }]) => {
            const tarball = tarballs.get(`/${name}/-/${name}-${version}.tgz`) as Buffer;
            const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
            const dist = { tarball: `${registry}${name}/-/${name}-${version}.tgz`, integrity };
            return [version, { name, version, dependencies: needs ?? {}, dist }];
          }),
        ),
      }),
    );
  });
  registry = `${(await listenLocal(server)).url.replace(/\/$/, '')}/`;
});
afterAll(() => server?.close());

/** pnpm itself, as the pin step runs it, at the test's registry; each registry of a test has a cache of its own. */
const realPnpm =
  (cache: string): Pnpm =>
  async (dir, args) => {
    const flags = [OWN_PNPM_FLAG, `--config.registry=${registry}`, `--config.store-dir=${join(WORK, 'store')}`];
    await exec('pnpm', [...flags, `--config.cache-dir=${join(WORK, cache)}`, '--ignore-scripts', ...args], {
      cwd: dir,
      env: { ...process.env, ...OWN_PNPM, CI: 'true' },
    });
  };
/** As the scan, the line and the gate each run it: as of a time, under the checkout's release age. */
const pnpm = () => pnpmAsOf(realPnpm(`cache-${++caches}`), Date.now());
let caches = 0;

const manifest = (name: string, dependencies: Record<string, string>) =>
  `${JSON.stringify({ name, version: '1.0.0', private: true, dependencies }, null, 2)}\n`;

/** A checkout, installed and committed while the registry had only its releases of a month ago and more. */
async function checkout(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(WORK, 'checkout-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  since = 30;
  await realPnpm(`cache-${++caches}`)(dir, ['install', '--lockfile-only']);
  since = 0;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir });
  git('init', '--quiet');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'base');
  return dir;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const rangeIn = (dir: string, path = 'package.json') => JSON.parse(read(dir, path)).dependencies['demo-pkg'];
const lockedIn = (dir: string) => lockedVersions(read(dir, 'pnpm-lock.yaml'), 'demo-pkg');

const SHOP = { 'package.json': manifest('shop', { 'demo-parent': '^1.0.0', 'demo-pkg': '^1.0.0' }) };
const update = (to: string, routine = true): Move => ({
  ecosystem: 'npm',
  name: 'demo-pkg',
  from: '1.0.0',
  to,
  ...(routine ? { routine } : {}),
});

describe('a routine update of a package, made by pnpm itself', { timeout: 120_000 }, () => {
  it('moves to exactly its target, every copy with it, and takes no younger release inside the range', async () => {
    const dir = await checkout(SHOP);
    expect(lockedIn(dir)).toEqual(['1.0.0']);
    const before = { manifest: read(dir, 'package.json'), lock: read(dir, 'pnpm-lock.yaml') };
    await movePackage(dir, update('1.0.1'), pnpm());
    // The one copy, which the manifest and `demo-parent` both resolve: at the target, not at 1.0.2.
    expect(lockedIn(dir)).toEqual(['1.0.1']);
    expect(read(dir, 'pnpm-lock.yaml')).not.toContain('1.0.2');
    // The manifest's range is the target, its operator kept, and nothing else of the manifest changes.
    expect(read(dir, 'package.json')).toBe(before.manifest.replace('"demo-pkg": "^1.0.0"', '"demo-pkg": "^1.0.1"'));
    // What the worker's guard takes of a file the pin step wrote: a manifest's range, and a lockfile's packages.
    expect(madeRefusal('package.json', before.manifest, read(dir, 'package.json'))).toBeUndefined();
    expect(
      madeRefusal('pnpm-lock.yaml', before.lock, read(dir, 'pnpm-lock.yaml').replaceAll(registry, 'https://r.test/')),
    ).toBeUndefined();
  });

  it('is the same bytes made again, as the review gate makes it', async () => {
    const [first, again] = [await checkout(SHOP), await checkout(SHOP)];
    await movePackage(first, update('1.0.1'), pnpm());
    await movePackage(again, update('1.0.1'), pnpm());
    for (const path of ['package.json', 'pnpm-lock.yaml']) expect(read(again, path)).toBe(read(first, path));
    // Made on a checkout that has it, it writes nothing.
    const made = read(first, 'pnpm-lock.yaml');
    await movePackage(first, update('1.0.1'), pnpm());
    expect(read(first, 'pnpm-lock.yaml')).toBe(made);
  });

  it('leaves a fix’s move as it is: its target a floor, the newest release pnpm’s own age admits taken', async () => {
    const dir = await checkout(SHOP);
    await movePackage(dir, update('1.0.1', false), pnpm());
    expect(lockedIn(dir)).toEqual(['1.0.2']);
  });

  it('moves the package in each importer of a workspace that names it, each range’s operator kept', async () => {
    const dir = await checkout({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'package.json': manifest('root', {}),
      'apps/a/package.json': manifest('a', { 'demo-pkg': '^1.0.0' }),
      'apps/b/package.json': manifest('b', { 'demo-parent': '^1.0.0', 'demo-pkg': '~1.0.0' }),
    });
    await movePackage(dir, update('1.0.1'), pnpm());
    expect(lockedIn(dir)).toEqual(['1.0.1']);
    expect(rangeIn(dir, 'apps/a/package.json')).toBe('^1.0.1');
    expect(rangeIn(dir, 'apps/b/package.json')).toBe('~1.0.1');
    expect(read(dir, 'pnpm-workspace.yaml')).toBe('packages:\n  - apps/*\n');
  });

  it('makes a routine update across a major by the same command: the range to the target, and no younger release of that major', async () => {
    const dir = await checkout({ 'package.json': manifest('shop', { 'demo-pkg': '^1.0.0' }) });
    await movePackage(dir, update('2.0.0'), pnpm());
    expect(lockedIn(dir)).toEqual(['2.0.0']);
    expect(rangeIn(dir)).toBe('^2.0.0');
  });

  const HELD = { 'package.json': manifest('shop', { 'demo-holder': '^1.0.0', 'demo-pkg': '^1.0.0' }) };

  it('leaves the copy a parent pins exactly where that parent wants it: the manifest’s copy at the target is the move made', async () => {
    const dir = await checkout(HELD);
    const before = read(dir, 'pnpm-lock.yaml');
    await movePackage(dir, update('1.0.1'), pnpm());
    expect(importedVersions(read(dir, 'pnpm-lock.yaml'), 'demo-pkg').map((each) => each.version)).toEqual(['1.0.1']);
    expect(rangeIn(dir)).toBe('^1.0.1');
    // The parent's copy is as it was, beside the manifest's: the package at two versions, and no younger one.
    expect(lockedIn(dir)).toEqual(['1.0.0', '1.0.1']);
    expect(read(dir, 'pnpm-lock.yaml')).toMatch(
      /^ {2}demo-holder@1\.0\.0:\n {4}dependencies:\n {6}demo-pkg: 1\.0\.0$/m,
    );
    // The entry the scan found the package at is a line the lockfile still has, for the parent.
    expect(read(dir, 'pnpm-lock.yaml')).toContain('\n  demo-pkg@1.0.0:\n');
    // The worker's guard takes a lockfile that holds the package twice, each a registry's package.
    const after = read(dir, 'pnpm-lock.yaml').replaceAll(registry, 'https://r.test/');
    expect(madeRefusal('pnpm-lock.yaml', before, after)).toBeUndefined();
    // Made, it is made: again writes nothing, though a copy is still at the version it moved from.
    const made = read(dir, 'pnpm-lock.yaml');
    await movePackage(dir, update('1.0.1'), pnpm());
    expect(read(dir, 'pnpm-lock.yaml')).toBe(made);
    // The same bytes on another checkout, as the review gate makes it.
    const again = await checkout(HELD);
    await movePackage(again, update('1.0.1'), pnpm());
    for (const path of ['package.json', 'pnpm-lock.yaml']) expect(read(again, path)).toBe(read(dir, path));
  });

  it('makes a routine major where a parent stays on the old major: no override is asked of Martin', async () => {
    const dir = await checkout(SHOP);
    await movePackage(dir, update('2.0.0'), pnpm());
    expect(importedVersions(read(dir, 'pnpm-lock.yaml'), 'demo-pkg').map((each) => each.version)).toEqual(['2.0.0']);
    expect(rangeIn(dir)).toBe('^2.0.0');
    // `demo-parent` asks for `^1.0.0`, which admits no 2.0.0: its copy is on the old major still.
    const kept = lockedIn(dir).filter((version) => version !== '2.0.0');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^1\.0\./);
    expect(lockedIn(dir)).not.toContain('2.0.1');
  });

  it('still holds a fix for an override where a parent keeps a copy at the version its advisory names', async () => {
    const dir = await checkout(HELD);
    const error = await movePackage(dir, update('1.0.1', false), pnpm()).catch((e) => e);
    expect(error).toBeInstanceOf(PinsHeld);
    expect(error.message).toBe(
      'demo-pkg stays at 1.0.0: demo-holder@1.0.0 admit no 1.0.1, so it needs an override in pnpm-workspace.yaml',
    );
  });

  it('says each refusal in one line of plain words, pnpm’s own reason in it, which the scan seals and the worker opens', async () => {
    const refusal = async (files: Record<string, string>, move: Move, tool: Pnpm = pnpm()) => {
      const dir = await checkout(files);
      // What a refused move wrote, if anything, is undone by whoever ran the step (scripts/derive.ts).
      const error = await movePackage(dir, move, tool).catch((e) => e);
      expect(error, JSON.stringify(move)).toBeInstanceOf(PinsRefused);
      return (error as Error).message;
    };
    const reasons = [
      // pnpm's own guard: a release younger than its release age, asked for by its version.
      await refusal(SHOP, update('1.0.3')),
      // The step's own: a package no manifest names, and a copy past the target.
      await refusal({ 'package.json': manifest('shop', { 'demo-parent': '^1.0.0' }) }, update('1.0.1')),
      await refusal(SHOP, update('1.0.1'), async (dir, args) => {
        await pnpm()(
          dir,
          args.map((arg) => (arg === 'demo-pkg@1.0.1' ? 'demo-pkg@1.0.2' : arg)),
        );
      }),
      // pnpm's answer to a version for a package no manifest names, had the step asked it.
      await refusal(SHOP, update('1.0.1'), async (dir) => {
        await realPnpm(`cache-${++caches}`)(dir, ['update', 'demo-parent@1.0.0', 'demo-absent@1.0.0']);
      }),
    ];
    expect(reasons[0]).toMatch(/^pnpm refused demo-pkg@1\.0\.3: /);
    expect(reasons[1]).toMatch(/^No manifest names demo-pkg/);
    expect(reasons[2]).toBe(
      'demo-pkg resolves to 1.0.2, past 1.0.1: a routine update moves to the release the scan listed, and no further.',
    );
    expect(reasons[3]).toMatch(/^pnpm refused demo-pkg@1\.0\.1: /);
    for (const reason of reasons) {
      // One line, no command line, none of the marks pnpm draws its report with.
      expect(reason, reason).not.toMatch(/[\n\r│├╰─▶×]|Command failed|--config|--depth/);
      expect(reason.length, reason).toBeLessThanOrEqual(400);
      expect(isReason(reason), reason).toBe(true);
      expect(reasonOf(reason)).toBe(reason);
    }
    // Sealed as the scan's pins job seals them, and opened as the worker and the review gate open them.
    const key = readKey(newKey());
    const made: Made = {
      version: 1,
      repository: 'the-roganator/cv-software-factory',
      run: '7',
      commit: 'a'.repeat(40),
      groups: [
        {
          files: ['pnpm-lock.yaml'],
          major: false,
          routine: true,
          moves: [],
          refused: reasons.map((reason, i) => ({ move: i + 1, reason: reasonOf(reason) })),
          changed: [],
          steps: [],
        },
      ],
    };
    expect(openMade(sealMade(made, key), key, made.repository, '7')).toEqual(made);
  });

  it('refuses a routine update of a package no manifest names, before pnpm runs: pnpm holds only a direct one to a version', async () => {
    const dir = await checkout({ 'package.json': manifest('shop', { 'demo-parent': '^1.0.0' }) });
    const lock = read(dir, 'pnpm-lock.yaml');
    const ran: string[][] = [];
    const error = await movePackage(dir, update('1.0.1'), async (_, args) => void ran.push(args)).catch((e) => e);
    expect(error).toBeInstanceOf(PinsRefused);
    expect(error.message).toBe(
      'No manifest names demo-pkg, and pnpm moves a package to an exact version only where one does: a routine update of it cannot be held to 1.0.1.',
    );
    expect(ran).toEqual([]);
    // pnpm's own answer to the same request, which is why the step refuses it first.
    await expect(
      realPnpm(`cache-${++caches}`)(dir, ['update', 'demo-pkg@1.0.1', '--depth', 'Infinity']),
    ).rejects.toThrow(/ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP/);
    expect(read(dir, 'pnpm-lock.yaml')).toBe(lock);
  });
});
