/**
 * Martin's hold of a pin move (its `pin` label taken off), carried across the pin watch closing and reopening the move
 * by `heldBefore`, by the move's branch: whatever target the move comes back at, and however its title changes in
 * place, the hold stands until a pull request from the branch is merged.
 *
 * The watch and the queue are the real ones, over one fake repository (the harness of pin-hold.test.ts); the
 * gate's verdict and the checks are stubbed as passing.
 */
import { describe, expect, it } from 'vitest';
import { APP_USER, MARTIN } from '../../src/github/issues.ts';
import { readPinScope } from '../../src/github/pins.ts';
import type { ReadMove } from '../../src/github/scanning.ts';
import { worker } from './pin-queue-harness.ts';
import { day, FakeRepo, FILES, factoryMoves } from './pins-harness.ts';

const BRANCH = 'factory/pin/example-dashboards';

/** The day's moves, with example-dashboards moved to a version, or left out. */
const movesTo = (version: string | null): ReadMove[] =>
  factoryMoves()
    .filter((m) => version !== null || m.name !== 'example-dashboards')
    .map((m) => (m.name === 'example-dashboards' ? { ...m, to: `chart example-dashboards ${version}` } : m));

const open = (repo: FakeRepo) => repo.pulls.filter((p) => p.head === BRANCH && p.state === 'open');

/** The watch opens the move at 13.7.2, Martin takes its label off, and the queue holds it pass after pass. */
async function held() {
  const repo = new FakeRepo(FILES);
  const scanned = repo.main;
  const at = { moves: movesTo('13.7.2') };
  const only = readPinScope('example-dashboards');
  const w = worker(repo, only, () => day(scanned, at.moves));
  // Martin takes the label off the watch's pull request before the queue's first pass.
  await w.watchOnly();
  const [first] = open(repo);
  if (!first) throw new Error('the pin watch opened nothing');
  first.labels = [];
  w.events.set(first.number, [
    { event: 'labeled', actor: { id: APP_USER }, label: { name: 'pin' } },
    { event: 'unlabeled', actor: { id: MARTIN }, label: { name: 'pin' } },
  ]);
  await w.pass();
  await w.pass();
  expect(first.labels).toEqual(['pin']);
  expect(first.title).toBe('chore(pin): move example-dashboards to 13.7.2');
  expect(w.enqueued).toEqual([]);
  return { repo, w, at, first };
}

describe('Martin’s hold of a pin move, across a close and reopen, at any target', () => {
  it('control: the same pull request, moved in place to a later target, stays held', async () => {
    const { w, at, first } = await held();
    at.moves = movesTo('13.8.0');
    await w.pass();
    await w.pass();
    expect(first.title).toBe('chore(pin): move example-dashboards to 13.8.0');
    expect(first.state).toBe('open');
    expect(w.enqueued).toEqual([]);
  });

  it('holds when the target moves in place, the move goes for a day, and comes back at the target Martin held', async () => {
    const { repo, w, at, first } = await held();
    // The target moves on: the watch retitles the held pull request in place. Still held, by its own events.
    at.moves = movesTo('13.8.0');
    await w.pass();
    expect(first.title).toBe('chore(pin): move example-dashboards to 13.8.0');
    expect(w.enqueued).toEqual([]);
    // A day without the move: the watch closes it, under the title it has now.
    at.moves = movesTo(null);
    await w.pass();
    expect(first.state).toBe('closed');
    // The move is back at the target Martin held (the later release withdrawn): a new pull request, same title as held.
    at.moves = movesTo('13.7.2');
    await w.pass();
    await w.pass();
    const [second] = open(repo);
    expect(second?.number).not.toBe(first.number);
    expect(second?.title).toBe('chore(pin): move example-dashboards to 13.7.2');
    expect(w.enqueued).toEqual([]);
  });

  it('holds when the move goes for a day and comes back at a later target', async () => {
    const { repo, w, at, first } = await held();
    at.moves = movesTo(null);
    await w.pass();
    expect(first.state).toBe('closed');
    at.moves = movesTo('13.8.0');
    await w.pass();
    await w.pass();
    const [second] = open(repo);
    expect(second?.number).not.toBe(first.number);
    expect(w.enqueued).toEqual([]);
  });

  it('holds when the move is closed and opened again, and then its target moves in place', async () => {
    const { repo, w, at, first } = await held();
    at.moves = movesTo(null);
    await w.pass();
    at.moves = movesTo('13.7.2');
    await w.pass();
    await w.pass();
    const [second] = open(repo);
    expect(second?.number).not.toBe(first.number);
    // The hold is carried to the new pull request.
    expect(w.enqueued).toEqual([]);
    // The target moves on, in place, on the reopened pull request: still held, as #first would have been.
    at.moves = movesTo('13.8.0');
    await w.pass();
    await w.pass();
    expect(second?.title).toBe('chore(pin): move example-dashboards to 13.8.0');
    expect(w.enqueued).toEqual([]);
  });
});
