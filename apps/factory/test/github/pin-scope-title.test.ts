/**
 * PIN_WATCH_ONLY as the queue reads it (`toldWait`): the branch `pinBranchFor(name)` and the title `pinTitle(name, <one
 * word>)`. `pinTitle` drops backticks and line breaks from a name and cuts at 256 characters, and `pinBranchFor` folds
 * them away, so two names could have one branch and one title. The watch opens no pull request for a name its title
 * would alter or cut (an issue instead), and the queue takes no such name as told, so the title names one move.
 */
import { describe, expect, it } from 'vitest';
import { toldWait } from '../../src/github/deploy-queue.ts';
import { pinBranchFor } from '../../src/github/pin-guard.ts';
import { pinTitle, readPinScope } from '../../src/github/pins.ts';
import { worker } from './pin-queue-harness.ts';
import { day, FakeRepo, FILES, factoryMoves } from './pins-harness.ts';

describe('a move the setting does not name, under a name it does', () => {
  it('opens no pull request for "example-dashboards`", whose title would read as "example-dashboards", and so queues none', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const other = 'example-dashboards`';
    const moves = factoryMoves().map((m) => (m.name === 'example-dashboards' ? { ...m, name: other } : m));
    // An earlier setting, every move: the watch takes the other move, and opens an issue for it.
    const earlier = worker(repo, '*', () => day(scanned, moves));
    await earlier.watchOnly();
    expect(repo.pulls.find((p) => p.head === 'factory/pin/example-dashboards')).toBeUndefined();
    // An issue instead, as for any move the watch cannot make safely.
    expect(repo.issues.some((i) => /example-dashboards/.test(i.title))).toBe(true);

    // The setting now names one move, exactly, and the day does not list it: the watch takes no move of the day's.
    const only = readPinScope('example-dashboards');
    expect(moves.some((m) => only !== '*' && only.includes(m.name))).toBe(false);
    const now = worker(repo, only, () => day(scanned, moves));
    await now.pass();
    await now.pass();
    expect(now.enqueued).toEqual([]);
  });

  it('by the functions alone: a told name the title would cut is told nothing; one only the watch keeps apart', () => {
    const told = (name: string, other: string, to = '1.2.3') =>
      toldWait([name], { title: pinTitle(other, to), head: { ref: pinBranchFor(other), sha: '', repo: null } });
    // Told one name; the pull request's title is another move's whose name the title alters. The queue cannot tell
    // them apart, which is why the watch opens no pull request for such a name.
    expect(told('example/sidecar', 'example/sidecar`')).toBeUndefined();
    expect(told('example/sidecar', '`example/sidecar`')).toBeUndefined();
    expect(told('example/sidecar', 'example/sidecar\n')).toBeUndefined();
    // A told name the title would cut, or alter, is told nothing.
    const long = `registry.example/${'a'.repeat(260)}`;
    expect(told(`${long}/one`, `${long}/two`)?.waits).toBe('not-a-pin');
    expect(told(`${long}/one`, `${long}/one`)?.waits).toBe('not-a-pin');
    expect(told('example/sidecar`', 'example/sidecar`')?.waits).toBe('not-a-pin');
    // A name that fits, with a version that takes the title to GitHub's 256: cut there, and read as cut.
    const fits = `registry.example/${'b'.repeat(210)}`;
    const version = 'v1.10.2-rc.1+build.12345678901234567890';
    expect(`chore(pin): move ${fits} to ${version}`.length).toBeGreaterThan(256);
    expect(told(fits, fits, version)?.waits).toBe('not-a-pin');
    expect(told(fits, fits, 'v1')).toBeUndefined();
    // Controls: every other difference is two names to the queue.
    expect(told('example/sidecar', 'example-sidecar')?.waits).toBe('not-a-pin');
    expect(told('example/sidecar', 'Example/Sidecar')?.waits).toBe('not-a-pin');
    expect(told('example/sidecar', 'example/sidecar to 9')?.waits).toBe('not-a-pin');
    expect(told('example/sidecar to 9', 'example/sidecar', '9 to 1.2.3')?.waits).toBe('not-a-pin');
    expect(told('example/sidecar', 'example/sidecar', '1.2.3 and more')?.waits).toBe('not-a-pin');
    expect(told('example/sidecar', 'example/sidecar')).toBeUndefined();
    // A name as the scan writes one today (#1056's), with a colon and a space: told, by itself alone.
    const real = 'argo-rollouts: quay.io/argoproj/argo-rollouts';
    expect(told(real, real, 'v1.10.2')).toBeUndefined();
    expect(told('argo-rollouts', real, 'v1.10.2')?.waits).toBe('not-a-pin');
    expect(told(real, 'argo-rollouts', 'v1.10.2')?.waits).toBe('not-a-pin');
  });
});
