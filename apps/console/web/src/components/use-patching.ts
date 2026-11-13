/**
 * Patching's view, for its summary and its sheet alike: worked out from the fold the console's view was drawn from (the
 * events by its time and the work items), and kept while what it reads is the same, so an event that changes nothing
 * here renders nothing here.
 */
import { useMemo } from 'react';
import { foldOf, type View } from '../projection/index.ts';
import type { ItemState } from '../projection/items.ts';
import { dayView, lastRead, type PatchingView } from '../projection/patching.ts';

/**
 * What the view reads of the work items: those that carry a dependency, by where each stands. Two folds that agree on
 * this give the same view, so a new event elsewhere keeps it.
 */
const carriedKey = (items: readonly ItemState[]) =>
  items
    .filter((item) => item.dependency)
    .map((item) => `${item.number}:${item.stage}:${item.closedAt ?? ''}:${item.dependency?.name}`)
    .join(' ');

/** A minute's resolution is all a deadline's words need. */
const MINUTE = 60_000;

/** The day's view, and the page's time to the minute, which its deadlines are said at. */
export function usePatching(drawn: View): { view: PatchingView; t: number } {
  const { seen: events, items } = foldOf(drawn);
  // The fold holds the events by t already, so the newest day from the sense's role in it is the one to show.
  const read = lastRead(events, drawn.t);
  const carried = carriedKey(items);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view reads only the day and the carried work items, and is kept while they are the same
  const view: PatchingView = useMemo(
    () => (read ? dayView(read.payload, Date.parse(read.ts), items) : { state: 'unread' }),
    [read, carried],
  );
  return { view, t: Math.floor(drawn.t / MINUTE) * MINUTE };
}
