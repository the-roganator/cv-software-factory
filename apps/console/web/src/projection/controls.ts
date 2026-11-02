/**
 * The line's controls as everyone sees them: the latest `controls.changed` Martin appended, turned into the controls in
 * force by policy's own check (`policy/line.ts`'s `controlsInForce`, which the line and the admin service use too, so
 * all three agree), and, while the line takes the next few, how many it has taken since he chose them.
 *
 * The line counts the next few by when it took each work item onto its own table, which no event records. The console
 * counts the first thing the line's agents record on each after its ticket: a work item counts once its
 * planner's first step has ended, and one taken just before the take was chosen counts if that step ended after.
 */
import { AUTONOMY, type Autonomy, type PublicEvent } from '@software-factory/events';
import {
  type ControlAction,
  type ControlsInForce,
  controlAction,
  controlsInForce,
  takeOf,
} from '@software-factory/policy/line';

export interface ControlsView extends ControlsInForce {
  /**
   * While the line takes the next few: when Martin chose them, and how many work items it has taken since. When is the
   * time of the change that chose them, which a replay of the events moves with every other, and the take's own
   * `since` is the store's clock at that change.
   */
  nextFew: { since: number; taken: number } | undefined;
  /** When Martin last changed one of them, if he has. */
  at: number | undefined;
  /**
   * Martin's latest switch of alerts to his phone (`alerts.switched`), unchecked, or none: `policy/phone.ts`'s
   * `phoneInForce` says what is in force on the page's profile.
   */
  phone: unknown;
}

/**
 * The agents the line runs on a work item only once it has taken it. The line itself (`factory`) is left out: it
 * records holds, closes and releases on work items it never took.
 */
const LINE_ACTORS: ReadonlySet<string> = new Set(['planner', 'coder', 'reviewer', 'describer']);

/** Martin's changes of the line's controls: admin events only his roles can append, as the store has them. */
const changes = (events: readonly PublicEvent[]) =>
  events.filter((event) => event.type === 'controls.changed' && event.actor === 'martin');

/** The controls in force at t, and what the next few have taken so far. */
export const controlsView = (events: readonly PublicEvent[], t: number): ControlsView =>
  controlsOf(events.filter((event) => Date.parse(event.ts) <= t));

/** The same, after the events that had happened by t, in seq order, as `project` holds them. */
export function controlsOf(seen: readonly PublicEvent[]): ControlsView {
  const made = changes(seen);
  const last = made.at(-1);
  const controls = controlsInForce(last?.payload);
  const { take } = controls;
  let nextFew: ControlsView['nextFew'];
  if (take?.kind === 'next-few') {
    // The change that chose them: the earliest of those since that have kept the same start.
    let since = Date.parse(take.since);
    for (const event of [...made].reverse()) {
      const was = controlsInForce(event.payload).take;
      if (was?.kind !== 'next-few' || was.since !== take.since) break;
      since = Date.parse(event.ts);
    }
    // Each work item with a ticket or Martin's request for an improvement, as the line's queue takes either, and when
    // an agent of the line first did anything with it after that.
    const ticketed = new Set<string>();
    const first = new Map<string, number>();
    for (const event of seen) {
      const item = event.work_item;
      if (!item) continue;
      if (event.type === 'ticket.opened' || event.type === 'improvement.requested') ticketed.add(item);
      else if (ticketed.has(item) && LINE_ACTORS.has(event.actor) && !first.has(item)) {
        first.set(item, Date.parse(event.ts));
      }
    }
    nextFew = { since, taken: [...first.values()].filter((at) => at >= since).length };
  }
  const phone = seen.findLast((event) => event.type === 'alerts.switched' && event.actor === 'martin')?.payload;
  return { ...controls, nextFew, at: last && Date.parse(last.ts), phone };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isAutonomy = (value: unknown): value is Autonomy => (AUTONOMY as readonly unknown[]).includes(value);

/**
 * Which of the access table's actions a recorded change is, by `controlAction`, as the line counts it; or none, for a
 * change that is not one.
 */
export function changeAction(change: unknown): ControlAction | undefined {
  if (!isRecord(change)) return undefined;
  const { control, before, after } = change;
  switch (control) {
    case 'autonomy':
      return isAutonomy(before) && isAutonomy(after) ? controlAction({ control, before, after }) : undefined;
    case 'new-work':
    case 'auto-merge':
    case 'auto-rollback':
      return typeof before === 'boolean' && typeof after === 'boolean'
        ? controlAction({ control, before, after })
        : undefined;
    case 'take': {
      const was = before === null ? null : takeOf(before);
      const is = takeOf(after);
      return was !== undefined && is !== undefined ? controlAction({ control, before: was, after: is }) : undefined;
    }
    default:
      return undefined;
  }
}
