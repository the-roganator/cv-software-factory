/**
 * The console's test data for red-team attacks: none can be launched yet (`policy/attacks.ts`), so the samples hold
 * none, and the browser tests of an attack's card, sheet and Launch read this instead. It is the samples' line and
 * their run of `make guardrails`, the visitor's report triage quarantined (#1291, without its screenshot), and four
 * attacks Martin launched from Guardrails: the report attack, refused by that quarantine; the image attack, refused by
 * admission control; the egress attack, which nothing refused; and the image attack again, in flight at the end. Each
 * event carries the role that would append it, as the samples' do.
 */
import type { NewEvent } from '@software-factory/events';
import { cited, inOrder, LINE_STARTED } from '../../../../packages/samples/src/index.ts';
import instructionReport from '../../../../packages/samples/src/items/1291-instruction-report.ts';
import { PROOFS } from '../../../../packages/samples/src/proofs.ts';
import reportAttack from './items/1289-report-attack.ts';
import unsignedImage from './items/1293-unsigned-image.ts';
import outsideUrl from './items/1333-outside-url.ts';
import unsignedImageAgain from './items/1335-unsigned-image-again.ts';

export const ATTACK_ITEMS = [reportAttack, unsignedImage, outsideUrl, unsignedImageAgain];

/** Every event of the attacks' test data, in the order it happened, each attack's end citing its refusals by seq. */
export function attackEvents(): NewEvent[] {
  // The report's screenshot stays the samples': nothing here shows #1291 but its refusal.
  const report = instructionReport.events.map((event) => ({ ...event, artifacts: [] }));
  return cited(inOrder([LINE_STARTED, ...PROOFS, ...report, ...ATTACK_ITEMS.flatMap((item) => item.events)]));
}
