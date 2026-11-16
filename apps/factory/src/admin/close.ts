/**
 * Martin's close of a work item nothing holds for him, from the console (`POST /admin/work-items/:workItem/close`) or
 * his command line (`make close-work-item`): a discard, `work-item.closed` with outcome `discarded`, appended as his,
 * whether the line has taken the work item or not. The line acts on it whatever it takes: it closes the work item's
 * pull request, unmerged, and its issue, stops a step in hand, and ends its row (`line/worker.ts`). The store lets his
 * roles append a close only as a discard (`0053_martin-closes.sql`).
 *
 * - **Not where a hold is open.** A held work item closes from its card, by Close (his rejection), whose answer the
 *   line or triage acts on as the hold's cause says; this is refused there, as the card says what closing does.
 * - **Not once its change has merged, or while it waits in the merge queue.** The release carries a merged change, and
 *   Release and Verify end it; one in the queue may merge before the line could close its pull request, which his
 *   close, recorded first, could then not stop.
 * - **Not an attack's.** A red-team attack's work item ends as its attack does, which the harness records.
 * - **His words, but not about a visitor's report.** The reason is public, in the close's public view and the comment
 *   on its pull request. On a work item a visitor's report opened, words about it would pass any redactor, so a reason
 *   is refused there and the close says only that he closed it, as his answers keep his words his there.
 * - **One at a time**, under the lock every append takes, read from the events alone: a close, a hold or a merge
 *   appended meanwhile is seen.
 */
import { MARTIN_CLOSE_CHARS } from '@software-factory/events';
import { lastEnd, lockAppends } from '@software-factory/store';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { openedByReport, openHold } from './holds.ts';
import { type AdminStore, adminEvent, Refused } from './store.ts';

/** The longest reason a close takes. */
export const CLOSE_REASON_CHARS = MARTIN_CLOSE_CHARS;

/** What the console sends: the reason, if he gives one. */
export const CLOSE = z.strictObject({ words: z.string().trim().min(1).max(CLOSE_REASON_CHARS).optional() });

/** Where the close was asked from, which a close with no reason says. */
export type ClosedFrom = 'console' | 'command line';

/**
 * Martin's close of the work item, as an event to append in the caller's transaction, after its lock, or a refusal,
 * having changed nothing.
 */
export async function decideClose(
  tx: TransactionSql,
  workItem: string,
  words: string | undefined,
  from: ClosedFrom,
): Promise<ReturnType<typeof adminEvent>> {
  const [state] = await tx<{ opened: boolean; kind: string | null; ended: string | null; queue: string | null }[]>`
    select exists(select 1 from events e where e.work_item = w.work_item and e.type = 'work-item.opened') as opened,
           (select e.payload->>'kind' from events e where e.work_item = w.work_item and e.type = 'work-item.opened'
            order by e.seq limit 1) as kind,
           ${lastEnd(tx, 'w.work_item')} as ended,
           (select e.type from events e where e.work_item = w.work_item
              and e.type in ('pull-request.enqueued', 'pull-request.dequeued', 'pull-request.merged', 'work.returned',
                             'work-item.reopened')
            order by e.seq desc limit 1) as queue
    from (select ${workItem}::text as work_item) w`;
  if (!state?.opened) throw new Refused('work-item', 404, `#${workItem} is not a work item in this store.`);
  if (state.ended === 'work-item.closed') throw new Refused('work-item', 409, `#${workItem} is closed already.`);
  if (state.kind === 'red-team') {
    throw new Refused('attack', 409, `#${workItem} is an attack’s: it ends as its attack does.`);
  }
  if (state.queue === 'pull-request.enqueued') {
    throw new Refused(
      'queued',
      409,
      `#${workItem}’s pull request is in the merge queue: take it out on GitHub first, or let it merge.`,
    );
  }
  const { open, merged } = await openHold(tx, workItem);
  if (open) {
    throw new Refused(
      'hold',
      409,
      `#${workItem} is held for you: close it from its card, which says what closing does there.`,
    );
  }
  if (merged) {
    throw new Refused(
      'merged',
      409,
      `#${workItem}’s change has merged: its release carries it, and Release and Verify end it.`,
    );
  }
  if (words !== undefined && (await openedByReport(tx, workItem))) {
    throw new Refused(
      'words',
      422,
      'A visitor’s report opened this, and a reason would be public: close it without one.',
    );
  }
  const reason = words ?? `Martin closed it from ${from === 'console' ? 'the console' : 'his command line'}`;
  return adminEvent(
    'work-item.closed',
    words ? `Closed by Martin: ${words}` : 'Closed by Martin',
    { outcome: 'discarded', reason },
    workItem,
  );
}

/** Closes the work item as Martin's, from the console, or refuses having changed nothing. */
export async function closeWorkItem(
  store: AdminStore,
  workItem: string,
  words: string | undefined,
): Promise<{ workItem: string; closed: true }> {
  await store.record(
    async (tx) => {
      await lockAppends(tx);
      return decideClose(tx, workItem, words, 'console');
    },
    (event) => [event],
  );
  return { workItem, closed: true };
}
