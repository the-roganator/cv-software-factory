/**
 * the hold carried by branch (`heldBefore`), and its cache.
 *
 * Only "held" is kept now, and whether a merge ended a hold is worked out before the cache is read, so a kept "held" is
 * lifted by a later merge. What is still missed: a hold is dated by when its pull request CLOSED, not by when Martin
 * took the label off, so a label he takes off a closed pull request after a later merge from the branch holds nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readPinScope } from '../../src/github/pins.ts';
import type { ReadMove } from '../../src/github/scanning.ts';
import { heldByMartin, labelledByApp, worker } from './pin-worker-harness6.ts';
import { day, FakeRepo, FILES, factoryMoves } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const BRANCH = 'factory/pin/example-dashboards';
const movesTo = (version: string | null): ReadMove[] =>
  factoryMoves()
    .filter((m) => version !== null || m.name !== 'example-dashboards')
    .map((m) => (m.name === 'example-dashboards' ? { ...m, to: `chart example-dashboards ${version}` } : m));
const open = (repo: FakeRepo) => repo.pulls.filter((p) => p.head === BRANCH && p.state === 'open');

async function start() {
  const repo = new FakeRepo(FILES);
  const scanned = repo.main;
  const at = { moves: movesTo('13.7.2') };
  const w = await worker(repo, readPinScope('example-dashboards'), () => day(scanned, at.moves), closing);
  await w.watchOnly();
  const [first] = open(repo);
  if (!first) throw new Error('the pin watch opened nothing');
  /** The watch closes the open pull request (a day without the move), at a time; then opens the move again. */
  const closeAndOpen = async (closedAt: string, next: string) => {
    const [was] = open(repo);
    at.moves = movesTo(null);
    await w.watchOnly();
    if (was?.state !== 'closed') throw new Error('the watch did not close it');
    w.times.set(was.number, { closed_at: closedAt });
    at.moves = movesTo(next);
    await w.watchOnly();
    const [now] = open(repo);
    if (!now) throw new Error('the watch did not open the move again');
    return { was, now };
  };
  return { repo, w, at, first, closeAndOpen };
}

describe('the hold by branch', () => {
  it('holds when Martin takes the label off a closed pull request after a later merge from the branch', async () => {
    const s = await start();
    // #1: never held while open; the watch closes it at 09:00.
    s.w.events.set(s.first.number, labelledByApp());
    const { was: one, now: two } = await s.closeAndOpen('2026-11-12T09:00:00Z', '13.8.0');
    // #2: the worker's own queue adds it, and it merges at 10:00 (nobody's hand on it).
    await s.w.queueOnly();
    expect(s.w.enqueued.map((e) => e.number)).toEqual([two.number]);
    two.state = 'closed';
    two.merged_at = '2026-11-12T10:00:00Z';
    s.w.times.set(two.number, { closed_at: '2026-11-12T10:00:00Z', merged_at: '2026-11-12T10:00:00Z' });
    // 11:00: Martin holds the move, on the pull request of it that is his to label: he takes `pin` off #1.
    s.w.events.set(one.number, heldByMartin('2026-11-12T11:00:00Z'));
    // The scan lists the move again, at a later target: #3.
    s.at.moves = movesTo('13.9.0');
    s.repo.push({ 'deploy/base/telemetry/dashboards.yaml': FILES['deploy/base/telemetry/dashboards.yaml'] as string });
    await s.w.watchOnly();
    const [three] = open(s.repo);
    if (!three) throw new Error('the watch did not open #3');
    await s.w.queueOnly();
    // He has merged nothing since he took the label off: the move is held.
    expect(s.w.enqueued.map((e) => e.number)).toEqual([two.number]);
  });

  it('a hold kept as held is lifted by a merge after it, and only then', async () => {
    const s = await start();
    s.w.events.set(s.first.number, heldByMartin());
    const { was: one, now: two } = await s.closeAndOpen('2026-11-12T09:00:00Z', '13.8.0');
    await s.w.queueOnly();
    await s.w.queueOnly();
    expect(s.w.enqueued).toEqual([]);
    // Read each pass, as Martin may take the label off, or put it back and take it off again, at any time.
    expect(s.w.eventReads.get(one.number)).toBe(2);
    // Martin merges #2 himself; the branch is used again for #3.
    two.state = 'closed';
    two.merged_at = '2026-11-12T12:00:00Z';
    s.w.times.set(two.number, { closed_at: '2026-11-12T12:00:00Z', merged_at: '2026-11-12T12:00:00Z' });
    s.at.moves = movesTo('13.9.0');
    await s.w.watchOnly();
    const [three] = open(s.repo);
    if (!three) throw new Error('the watch did not open #3');
    await s.w.queueOnly();
    expect(s.w.enqueued.map((e) => e.number)).toEqual([three.number]);
  });

  it('a label taken off a closed pull request after the queue read it not held is seen on the next pass', async () => {
    const s = await start();
    s.w.events.set(s.first.number, labelledByApp());
    const { was: one, now: two } = await s.closeAndOpen('2026-11-12T09:00:00Z', '13.8.0');
    // The gate has not passed it yet when the queue first reads the hold... here it reads it and would add: hold first.
    s.w.failEnqueue.times = 1;
    await s.w.queueOnly();
    expect(s.w.enqueued).toEqual([]);
    s.w.events.set(one.number, heldByMartin());
    await s.w.queueOnly();
    await s.w.queueOnly();
    expect(s.w.enqueued).toEqual([]);
    expect(two.state).toBe('open');
  });

  it('a held pull request closed, opened again by Martin and closed again is read again, and still holds', async () => {
    const s = await start();
    s.w.events.set(s.first.number, heldByMartin());
    const { was: one } = await s.closeAndOpen('2026-11-12T09:00:00Z', '13.8.0');
    await s.w.queueOnly();
    s.w.times.set(one.number, { closed_at: '2026-11-12T09:30:00Z' });
    await s.w.queueOnly();
    expect(s.w.eventReads.get(one.number)).toBe(2);
    expect(s.w.enqueued).toEqual([]);
  });
});
