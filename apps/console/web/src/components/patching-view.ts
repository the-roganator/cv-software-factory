/**
 * Patching's view, for its summary and its sheet alike, worked out once for each view the console draws, whichever of
 * them asks first, from the fold it was drawn from (the events by its time and the work items). It is kept while what
 * it reads is the same, the same object, so an event that changes nothing here renders nothing in either. Plain
 * TypeScript, which Node tests directly.
 */
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

/** The last view worked out, and what it was read from. */
let kept: { read: object | undefined; carried: string; view: PatchingView } | undefined;
/** Each drawn view's answer, so the summary and the sheet share one. */
const answered = new WeakMap<View, PatchingView>();

/** The day's view in a drawn view: the same object while the day and the carried work items are the same. */
export function patchingOf(drawn: View): PatchingView {
  const known = answered.get(drawn);
  if (known) return known;
  const { seen: events, items } = foldOf(drawn);
  // The fold holds the events by t already, so the newest day from the sense's role in it is the one to show.
  const read = lastRead(events, drawn.t);
  const carried = carriedKey(items);
  if (!kept || kept.read !== read || kept.carried !== carried) {
    kept = {
      read,
      carried,
      view: read ? dayView(read.payload, Date.parse(read.ts), items) : { state: 'unread' },
    };
  }
  answered.set(drawn, kept.view);
  return kept.view;
}

/** The day's view, and the page's time to the minute, which its deadlines are said at. */
export function patchingNow(drawn: View): { view: PatchingView; t: number } {
  return { view: patchingOf(drawn), t: Math.floor(drawn.t / MINUTE) * MINUTE };
}
