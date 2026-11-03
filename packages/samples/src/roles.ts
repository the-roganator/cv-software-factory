/**
 * The store's role that would append each sample, as the cluster's would: the samples' event log carries it, so the
 * console counts a refusal by who appended it from the samples as it does from the store. A sample loaded into a store
 * (`make samples`) is appended by Martin's command line, and says so there.
 */
import { ADMIN_TYPES, type NewEvent } from '@software-factory/events';
import { REFUSALS } from '../../../policy/refusals.ts';

/** The types each worker appends that no other does; the line appends the rest of the work's. */
const APPENDERS: Partial<Record<NewEvent['type'], string>> = {
  'signal.received': 'factory_triage',
  'judgement.made': 'factory_triage',
  'ticket.opened': 'factory_triage',
  'spend.capped': 'factory_gateway',
  'spend.cleared': 'factory_gateway',
  'score.updated': 'scoreboard_writer',
  // `make guardrails`'s, as only its role may append one.
  'guardrail.proved': 'factory_proofs',
  // Martin's to launch from the console, as his commands are; the harness's alone to end.
  'attack.launched': 'factory_admin',
  'attack.finished': 'factory_redteam',
};

/**
 * What the red-team harness appends on an attack's work item: its end and its close, and the refusals it relays or
 * records itself (the GitHub worker's guard, GitHub and the review check's, relayed; the egress attack's own). Triage
 * and the line record the others an attack meets, each from a role of its own.
 */
const HARNESS_APPENDS = (event: NewEvent): boolean =>
  event.type === 'work-item.closed' ||
  (event.type === 'action.refused' &&
    (REFUSALS[event.payload.mechanism].appendedBy as readonly string[]).includes('factory_redteam'));

/**
 * The role that would append a sample, or none for one nothing in the factory appends (a defect's injection). `attacks`
 * are the work items Martin launched an attack on, whose refusals and close the harness appends.
 */
export function appenderOf(event: NewEvent, attacks: ReadonlySet<string> = new Set()): string | undefined {
  if (event.type === 'defect.injected') return undefined;
  if (event.work_item && attacks.has(event.work_item) && HARNESS_APPENDS(event)) return 'factory_redteam';
  if (ADMIN_TYPES.includes(event.type)) return 'factory_admin';
  if (event.type === 'action.refused') return REFUSALS[event.payload.mechanism].appendedBy[0];
  // Only Martin's roles open an improvement or an attack's work item, which the admin service opens with his request.
  if (event.type === 'work-item.opened')
    return event.payload.kind === 'improvement' || event.payload.kind === 'red-team'
      ? 'factory_admin'
      : 'factory_triage';
  if (event.actor === 'triage') return 'factory_triage';
  return APPENDERS[event.type] ?? 'factory_line';
}
