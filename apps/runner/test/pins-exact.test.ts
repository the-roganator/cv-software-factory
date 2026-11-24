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
import { madeRefusal } from '../../factory/src/github/pin-guard.ts';
import {
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
    '2.0.0': { days: 10 },
    '2.0.1': { days: 2 },
  },
  'demo-parent': { '1.0.0': { needs: { 'demo-pkg': '^1.0.0' }, days: 40 } },
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

  it('holds a routine major for an override, as a fix’s, where a parent’s range keeps a copy at the old version', async () => {
    const dir = await checkout(SHOP);
    await expect(movePackage(dir, update('2.0.0'), pnpm())).rejects.toThrow(PinsHeld);
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
