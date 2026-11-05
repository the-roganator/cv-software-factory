/**
 * The holds that wait for Martin now, one each, as the line folds each work item's events (`machine.ts`): what the
 * alert for each new hold is made from (`line.hold.age`, `metrics.ts`). Read from the store, never from what a worker
 * remembers, so a line that restarts, or a second replica, reports the same holds, each from the same moment.
 *
 * Each names its work item, its cause and, where Martin answers it on GitHub, the pull request: a merge hold's latest
 * pushed pull request, a deploy hold's deploy pull request. A merge held again as the review gate's word on it changes
 * has waited since the first of those holds (`mergeHeldSince`). A deploy hold waits for Martin only once that pull
 * request's checks have passed and the line has not added it to the merge queue, or the queue took it out
 * (`deploy.ts`), and from then; until then it waits for the build, the checks, the review gate, the queue or Argo CD,
 * and is not his yet. One whose release was aborted or erred waits for his retry, from the hold's start.
 */
import { type HoldCause, type RawEvent, upcast } from '@software-factory/events';
import { fromMartin, lastEnd } from '@software-factory/store';
import type { Sql } from 'postgres';
import { type DeployChange, waitsForMartin as deployWaitsForMartin, latestDeploy } from './deploy.ts';
import { fold, type LineEvent } from './machine.ts';

/** A hold that waits for Martin. */
export interface OpenHold {
  workItem: string;
  cause: HoldCause;
  /** The pull request he answers it on, on GitHub, if there is one. */
  pullRequest: number | undefined;
  /** Since when it has waited for him. */
  since: Date;
}

/** One stored event, upcast, with when it was appended. */
export interface Dated {
  type: string;
  payload: unknown;
  ts: Date;
}

/** The hold of a work item that waits for Martin, from its events in order, if one does. */
export function waitingHold(workItem: string, events: readonly Dated[]): OpenHold | undefined {
  const s = fold(events as unknown as LineEvent[]);
  const { hold } = s;
  if (!hold || s.closed) return undefined;
  // The hold in force is the payload of the `hold.started` the fold took.
  const started = events.findLast((event) => event.payload === hold);
  if (!started) return undefined;
  if (hold.cause === 'merge') {
    return { workItem, cause: hold.cause, pullRequest: s.pullRequest?.number, since: mergeHeldSince(events, started) };
  }
  if (hold.cause === 'deploy') {
    const how = s.release?.ended?.how;
    if (how === 'aborted' || how === 'errored') {
      return { workItem, cause: hold.cause, pullRequest: undefined, since: started.ts };
    }
    const deploy = latestDeploy(events, hold);
    if (!deploy || !deployWaitsForMartin(deploy)) return undefined;
    return { workItem, cause: hold.cause, pullRequest: deploy.pullRequest, since: deployWaitSince(events, started) };
  }
  return { workItem, cause: hold.cause, pullRequest: undefined, since: started.ts };
}

/**
 * Since when a work item's deploy pull request has waited for Martin under the hold that started at `started`: the
 * first of the records in a row, since then, of that pull request at that head that wait for him. Why it waits may
 * change meanwhile (the gate judging again, auto-merge switched), and it has waited for him all along.
 */
function deployWaitSince(events: readonly Dated[], started: Dated): Date {
  let since: Date | undefined;
  let at: string | undefined;
  for (const event of events.slice(events.indexOf(started) + 1)) {
    if (event.type !== 'deploy.changed') continue;
    const change = event.payload as DeployChange;
    const head = `${change.pullRequest} ${change.commit}`;
    if (!deployWaitsForMartin(change)) since = undefined;
    else if (since === undefined || head !== at) since = event.ts;
    at = head;
  }
  return since ?? started.ts;
}

/**
 * The events that end a wait for Martin's merge: a push, work sent back, his answer, the line adding the change to the
 * merge queue, or the queue taking it out, which is new for him.
 */
const MERGE_WAIT_ENDS = new Set([
  'pull-request.pushed',
  'work.returned',
  'hold.answered',
  'pull-request.enqueued',
  'pull-request.dequeued',
]);

/**
 * Since when a change has waited for Martin's merge: the first of the merge's holds since nothing ended the wait. The
 * line holds it again as what the review gate says changes (`merging.ts`), and each says why, but the wait is one.
 */
function mergeHeldSince(events: readonly Dated[], latest: Dated): Date {
  let since = latest.ts;
  for (let i = events.indexOf(latest) - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || MERGE_WAIT_ENDS.has(event.type)) break;
    if (event.type === 'hold.started') {
      if ((event.payload as { cause?: string }).cause !== 'merge') break;
      since = event.ts;
    }
  }
  return since;
}

/**
 * Every hold that waits for Martin now, oldest first: each work item's that has a hold, has not closed since, and is
 * not a sample's, folded from its events, Martin's commands only from his roles, as the line reads them.
 */
export async function openHolds(sql: Sql): Promise<OpenHold[]> {
  const rows = await sql<(RawEvent & { ts: Date; work_item: string })[]>`
    with ever as (
      select distinct h.work_item from events h where h.type = 'hold.started' and not h.sample
    ),
    held as (
      select ever.work_item from ever where ${lastEnd(sql, 'ever.work_item')} is distinct from 'work-item.closed'
    )
    select e.seq, e.work_item, e.ts, e.type, e.version, e.payload from events e
    join held on held.work_item = e.work_item
    where ${fromMartin(sql, 'e')}
    order by e.work_item, e.seq`;
  const by = new Map<string, Dated[]>();
  for (const row of rows) {
    const read = upcast({ ...row, seq: Number(row.seq) });
    if (!read.ok) continue;
    const list = by.get(row.work_item) ?? [];
    list.push({ type: read.event.type, payload: read.event.payload, ts: new Date(row.ts) });
    by.set(row.work_item, list);
  }
  return [...by]
    .flatMap(([workItem, events]) => waitingHold(workItem, events) ?? [])
    .sort((a, b) => a.since.getTime() - b.since.getTime());
}
