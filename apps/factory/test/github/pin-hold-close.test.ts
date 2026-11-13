/**
 * Martin's hold of a pin move by its label, carried by branch across a close and reopen (`heldBefore`). The watch and
 * the queue are the real ones; GitHub's `closed_at` and `merged_at` are set by each test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readPinScope } from '../../src/github/pins.ts';
import type { ReadMove } from '../../src/github/scanning.ts';
import { heldByMartin, labelledByApp, worker } from './pin-worker-harness.ts';
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
  return { repo, w, at, first };
}

/** The first pull request closed by the watch (a day without the move), and the move back as a second one. */
async function closedAndBack(held: boolean) {
  const s = await start();
  s.w.events.set(s.first.number, held ? heldByMartin() : labelledByApp());
  s.at.moves = movesTo(null);
  await s.w.watchOnly();
  expect(s.first.state).toBe('closed');
  s.w.times.set(s.first.number, { closed_at: '2026-11-12T09:00:00Z' });
  s.at.moves = movesTo('13.8.0');
  await s.w.watchOnly();
  const [second] = open(s.repo);
  if (!second) throw new Error('the pin watch did not open the move again');
  return { ...s, second };
}

describe('the hold by branch, held', () => {
  it('held across a close and reopen at another target, pass after pass', async () => {
    const { w } = await closedAndBack(true);
    await w.queueOnly();
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
  });

  it('a merge before the held one closed, or at the same second, does not end the hold; one after does', async () => {
    const { repo, w, first } = await closedAndBack(true);
    const merged = repo.addPull({ head: BRANCH, state: 'closed', title: 'earlier' });
    merged.number = first.number - 1;
    w.times.set(merged.number, { closed_at: '2026-11-12T08:00:00Z', merged_at: '2026-11-12T08:00:00Z' });
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
    w.times.set(merged.number, { closed_at: '2026-11-12T09:00:00Z', merged_at: '2026-11-12T09:00:00Z' });
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
    w.times.set(merged.number, { closed_at: '2026-11-12T09:00:01Z', merged_at: '2026-11-12T09:00:01Z' });
    await w.queueOnly();
    expect(w.enqueued.length).toBe(1);
  });

  it('a read of the closed pull request’s events that fails holds that pass', async () => {
    const { w } = await closedAndBack(true);
    w.failing.events = true;
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
    w.failing.events = false;
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
  });

  it('more closed pull requests on the branch than five pages holds', async () => {
    const { repo, w } = await closedAndBack(false);
    for (let i = 0; i < 500; i++) repo.addPull({ head: BRANCH, state: 'closed', title: `old ${i}` });
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
  });

  it('the label put back by Martin on the closed pull request does not lift the hold', async () => {
    const { w, first } = await closedAndBack(true);
    w.events.set(first.number, [
      ...heldByMartin(),
      { event: 'labeled', actor: { id: 6206459 }, label: { name: 'pin' } },
    ]);
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
  });
});

describe('the hold’s answer kept per close', () => {
  it('sees Martin take the label off a pull request that had closed, after the queue read it once', async () => {
    const { w, first, second } = await closedAndBack(false);
    // The queue reads the closed pull request (not held then) and tries the enqueue, which GitHub fails for now.
    w.failEnqueue.times = 1;
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
    expect(w.eventReads.get(first.number)).toBe(1);
    // Martin holds the move on the closed pull request, the way the description says a hold is carried.
    w.events.set(first.number, heldByMartin());
    await w.queueOnly();
    expect(w.eventReads.get(first.number)).toBe(2);
    expect(w.enqueued).toEqual([]);
    expect(second.number).toBeGreaterThan(first.number);
  });

  it('control: the same hold, placed before the queue first read the closed pull request, is kept', async () => {
    const { w, first } = await closedAndBack(false);
    w.events.set(first.number, heldByMartin());
    w.failEnqueue.times = 1;
    await w.queueOnly();
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
  });
});
