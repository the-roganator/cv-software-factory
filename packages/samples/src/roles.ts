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
  // Martin's to launch from the console, as his commands are.
  'attack.launched': 'factory_admin',
};

/** The role that would append a sample, or none for one nothing in the factory appends (a defect's injection). */
export function appenderOf(event: NewEvent): string | undefined {
  if (event.type === 'defect.injected') return undefined;
  if (ADMIN_TYPES.includes(event.type)) return 'factory_admin';
  if (event.type === 'action.refused') return REFUSALS[event.payload.mechanism].appendedBy[0];
  if (event.type === 'work-item.opened')
    return event.payload.kind === 'improvement' ? 'factory_admin' : 'factory_triage';
  if (event.actor === 'triage') return 'factory_triage';
  return APPENDERS[event.type] ?? 'factory_line';
}
