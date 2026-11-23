import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Get, Move, Pnpm } from '../apps/runner/src/pins.ts';
import { askedKey, deriveOn, githubGet, PNPM_RELEASE_AGE, pnpmAge, pnpmAsOf } from './derive.ts';

/** A checkout git tracks, with these files committed. */
function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'derive-'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '--message', 'main');
  return dir;
}

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const STATIC = 'gcr.io/distroless/static';

/** A registry whose tag `nonroot` of distroless's static image is at a digest now. */
const registry =
  (now: string, asked: string[] = []): Get =>
  async (url) => {
    asked.push(url);
    if (url === 'https://gcr.io/v2/distroless/static/manifests/nonroot')
      return new Response(null, { headers: { 'docker-content-digest': now } });
    return new Response(null, { status: 404 });
  };

const MINUTE = 60_000;

describe('pnpm, as of the scan', () => {
  it('reads the checkout’s release age, or pnpm’s day, and refuses one it cannot read', () => {
    expect(pnpmAge('packages:\n  - apps/*\n')).toBe(PNPM_RELEASE_AGE);
    expect(pnpmAge('minimumReleaseAge: 4320 # three days\n')).toBe(4320);
    expect(() => pnpmAge('minimumReleaseAge: a day\n')).toThrow(/is not a number of minutes/);
  });

  it('takes no release younger than the age at the scan’s time, however long after it runs (C-1)', async () => {
    const runs: string[][] = [];
    const pnpm: Pnpm = async (_dir, args) => {
      runs.push(args);
    };
    const judged = Date.parse('2026-11-20T05:00:00Z');
    const dir = checkout({ 'package.json': '{}\n' });
    // The scan's own step, a few minutes after it judged; the gate, hours later; and a clock behind the scan's.
    for (const later of [4 * MINUTE + 1, 9 * 60 * MINUTE, -5 * MINUTE])
      await pnpmAsOf(pnpm, judged, () => judged + later)(dir, ['update', 'example']);
    expect(runs).toEqual([
      ['--config.minimum-release-age=1445', 'update', 'example'],
      ['--config.minimum-release-age=1980', 'update', 'example'],
      ['--config.minimum-release-age=1440', 'update', 'example'],
    ]);
    const longer = checkout({ 'pnpm-workspace.yaml': 'minimumReleaseAge: 4320\n' });
    await pnpmAsOf(pnpm, judged, () => judged + 60 * MINUTE)(longer, ['install']);
    expect(runs.at(-1)).toEqual(['--config.minimum-release-age=4380', 'install']);
  });
});

describe('the derivation, made again with the answers the scan had (C-1)', () => {
  const DOCKERFILE = `FROM ${STATIC}:nonroot@${digest('2')}\n`;
  const move: Move = { ecosystem: 'docker', name: STATIC, from: 'nonroot', to: `nonroot@${digest('5')}` };
  const derivation = () => ({ work: mkdtempSync(join(tmpdir(), 'derive-work-')), workspace: true, pnpm: '/bin/pnpm' });

  it('writes the scan’s digest for a tag the registry has pushed again since, where a fresh ask refuses it', async () => {
    const asked: string[] = [];
    const answers = new Map([[askedKey(STATIC, 'nonroot'), digest('5')]]);
    const made = await deriveOn(checkout({ Dockerfile: DOCKERFILE }), [move], {
      ...derivation(),
      get: registry(digest('6'), asked),
      asked: answers,
    });
    expect(made.get('Dockerfile')).toBe(`FROM ${STATIC}:nonroot@${digest('5')}\n`);
    expect(asked).toEqual([]);
    // Asked again, the registry's new answer is not the scan's, and the step refuses the move.
    await expect(
      deriveOn(checkout({ Dockerfile: DOCKERFILE }), [move], { ...derivation(), get: registry(digest('6')) }),
    ).rejects.toThrow(/is sha256:6{64} in its registry, not sha256:5{64}/);
  });

  it('keeps each answer it was given by the registry, for the gate to make the move with', async () => {
    const answers = new Map<string, string>();
    await deriveOn(checkout({ Dockerfile: DOCKERFILE }), [move], {
      ...derivation(),
      get: registry(digest('5')),
      asked: answers,
    });
    expect([...answers]).toEqual([[askedKey(STATIC, 'nonroot'), digest('5')]]);
  });

  it('runs pnpm as of the scan’s time', async () => {
    // pnpm, as a script that keeps its arguments and moves the package as `pnpm update` would.
    const bin = mkdtempSync(join(tmpdir(), 'derive-pnpm-'));
    const pnpm = join(bin, 'pnpm');
    const log = join(bin, 'args.json');
    writeFileSync(
      pnpm,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync('pnpm-lock.yaml', fs.readFileSync('pnpm-lock.yaml', 'utf8').replace(/(example@|version: )1\\.0\\.0/g, (_, at) => at + '1.0.1'));\n`,
    );
    chmodSync(pnpm, 0o755);
    const lock = (v: string) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      example:\n        specifier: ^1.0.0\n        version: ${v}\n\npackages:\n\n  example@${v}:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  example@${v}: {}\n`;
    const dir = checkout({
      'package.json': `${JSON.stringify({ name: 'x', dependencies: { example: '^1.0.0' } })}\n`,
      'pnpm-lock.yaml': lock('1.0.0'),
    });
    const work = mkdtempSync(join(tmpdir(), 'derive-work-'));
    mkdirSync(join(work, 'home'), { recursive: true });
    const asOf = Date.now() - 3 * 60 * MINUTE;
    const made = await deriveOn(dir, [{ ecosystem: 'npm', name: 'example', from: '1.0.0', to: '1.0.1' }], {
      work,
      workspace: true,
      pnpm,
      asOf,
    });
    expect(made.get('pnpm-lock.yaml')).toBe(lock('1.0.1'));
    const args = JSON.parse(readFileSync(log, 'utf8')) as string[];
    const age = Number(args.find((a) => a.startsWith('--config.minimum-release-age='))?.split('=')[1]);
    // A day, and the three hours since the scan, to pnpm's minute: never a release the scan's pnpm would not take.
    expect(age - PNPM_RELEASE_AGE).toBeGreaterThanOrEqual(180);
    expect(age - PNPM_RELEASE_AGE).toBeLessThanOrEqual(181);
    expect(args.slice(args.indexOf('update'))).toEqual(['update', 'example', '--depth', 'Infinity']);
  });
});

/** The pin step's requests (scripts/derive.ts): the job's token on GitHub's API alone, and on nothing without one. */
describe('the derivation’s requests', () => {
  const seen = () => {
    const asked: { url: string; authorization: string | null }[] = [];
    const get: Get = async (url, init) => {
      asked.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return new Response('[]');
    };
    return { asked, get };
  };
  const RELEASES = 'https://api.github.com/repos/pnpm/pnpm/releases?per_page=100';

  it('gives GitHub’s API the token when one is given, and no other host', async () => {
    const { asked, get } = seen();
    const given = githubGet('ghs_read', get);
    await given(RELEASES);
    await given('https://nodejs.org/dist/index.json');
    await given('https://api.github.com.example.test/repos/pnpm/pnpm/releases');
    await given('https://registry-1.docker.io/v2/library/node/manifests/24', { headers: { accept: 'x' } });
    expect(asked.map((each) => each.authorization)).toEqual(['Bearer ghs_read', null, null, null]);
  });

  it('sends none when no token is given', async () => {
    const { asked, get } = seen();
    await githubGet(undefined, get)(RELEASES);
    await githubGet('', get)(RELEASES);
    expect(asked.map((each) => each.authorization)).toEqual([null, null]);
  });
});
