/**
 * The inbox: where the senses leave what they found, for triage to take (0002_store-kind-work-items-and-inbox.sql).
 * A signal here is what `signal.received` will say if triage makes an event of it, with its artifacts beside it.
 */
import { type InboxSignal, moveFingerprint } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import type { Sql } from 'postgres';
import type { JSONValue } from './client.ts';

/**
 * What a sense found, as triage matches it: the route and the symptom class; or, for a dependency, its move's name and
 * ecosystem (`moveFingerprint`), with neither its version nor its findings, so every target of one move is one. A
 * report or a finding has none.
 */
export function fingerprintOf(found: Pick<InboxSignal, 'sense' | 'route' | 'move' | 'symptom'>): string | null {
  if (found.sense === 'report' || found.sense === 'planner') return null;
  if (!found.symptom) throw new Error(`A signal from the ${found.sense} needs the symptom class it saw`);
  if (found.move) {
    const { name, ecosystem } = moveFingerprint(found.move);
    return `move ${ecosystem} ${name}`;
  }
  return `${found.route} ${found.symptom}`;
}

/**
 * Leaves a signal in the inbox, and returns its id. Triage hears of it at once, through NOTIFY. A signal sent again
 * with the same id is left as it was the first time, so a sender that cannot tell whether it sent one sends it again.
 */
export async function sendSignal(sql: Sql, found: InboxSignal, id: string = crypto.randomUUID()): Promise<string> {
  const checked = validateSignal(found);
  if (!checked.ok) throw new Error(`The inbox refuses this signal:\n  ${checked.problems.join('\n  ')}`);
  // The id is the inbox's only unique key, so any conflict is this signal's. Naming it (`on conflict (id)`) would need
  // the right to read the inbox, which a sense does not have (0022_worker-roles.sql).
  await sql`insert into inbox (id, sense, fingerprint, signal)
            values (${id}, ${found.sense}, ${fingerprintOf(found)}, ${sql.json(found as unknown as JSONValue)})
            on conflict do nothing`;
  return id;
}

/**
 * Deletes the repeats triage counted before `before`, and returns how many went. A counted signal is one on a ticket
 * that already had it: nothing reads it again, as triage's burst and hold reads look only at signals that opened, are
 * held or still wait, and the store refuses triage the delete of any of those (0020_prune-inbox.sql). Two kinds
 * stay however old:
 *
 * - each sense's newest signal, as a sense that takes up from where it left off reads it (`lastObserved` in
 *   apps/factory/src/logs; today only the reports do, and triage never counts a report);
 * - the canary's, whose ids the line derives from the analysis run: one still in the cluster when the line restarts
 *   is sent again, and its row is what makes the inbox drop it. There are a few a release.
 */
export async function pruneInbox(sql: Sql, before: Date): Promise<number> {
  const deleted = await sql`
    delete from inbox
    where outcome = 'counted' and sense <> 'canary' and received_at < ${before}
      and exists (select 1 from inbox newer where newer.sense = inbox.sense and newer.received_at > inbox.received_at)`;
  return deleted.count;
}
