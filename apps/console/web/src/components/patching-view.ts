/**
 * Patching's view, for its summary and its sheet alike, worked out once for each view the console draws, whichever of
 * them asks first, from the fold it was drawn from (the events by its time and the work items). It is kept while what
 * it reads is the same, the same object, so an event that changes nothing here renders nothing in either. Nothing is
 * held but by the views and events it was worked out from. Plain TypeScript, which Node tests directly.
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

/** Before the sense's first day: one view for every caller, so it is always the same. */
const UNREAD: PatchingView = { state: 'unread' };
/**
 * Each day's view, by the event it was read from, with the carried work items it was worked out with: a view drawn
 * later from the same day and the same work items gets the same object. Held by the event alone, so a fold that holds
 * another day never evicts it, and it goes with the events.
 */
const byDay = new WeakMap<object, { carried: string; view: PatchingView }>();
/** Each drawn view's answer, so the summary and the sheet share one. */
const answered = new WeakMap<View, PatchingView>();

/** The day's view in a drawn view: the same object while the day and the carried work items are the same. */
export function patchingOf(drawn: View): PatchingView {
  const known = answered.get(drawn);
  if (known) return known;
  const { seen: events, items } = foldOf(drawn);
  // The fold holds the events by t already, so the newest day from the sense's role in it is the one to show.
  const read = lastRead(events, drawn.t);
  let view = UNREAD;
  if (read) {
    const carried = carriedKey(items);
    const kept = byDay.get(read);
    view = kept?.carried === carried ? kept.view : dayView(read.payload, Date.parse(read.ts), items);
    if (kept?.view !== view) byDay.set(read, { carried, view });
  }
  answered.set(drawn, view);
  return view;
}

/** The day's view, and the page's time to the minute, which its deadlines are said at. */
export function patchingNow(drawn: View): { view: PatchingView; t: number } {
  return { view: patchingOf(drawn), t: Math.floor(drawn.t / MINUTE) * MINUTE };
}
