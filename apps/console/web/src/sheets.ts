/**
 * What the sheet holds: a work item, or a panel opened whole from its summary in the bottom row (the design system's
 * README, "A panel's sheet"), Patching's or Guardrails', at one of its rows or at the top. And which of them the address
 * asks for:
 *
 * - `?move=<key>` opens Patching's at that row, and `?open=<1..11>` Guardrails' at that one, unless `?sheet=` names the
 *   other panel;
 * - `?sheet=patching` and `?sheet=guardrails` open them at the top;
 * - `?item=<n>&sheet`, with no value, opens the work item's.
 */

export type SheetAsk =
  | { kind: 'item'; item: string }
  | { kind: 'patching'; row?: string | undefined }
  | { kind: 'guardrails'; row?: number | undefined };

/** A guardrail's number, from 1 to 11; anything else opens the sheet at its top. */
function guardrail(value: string | null): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 11 ? n : undefined;
}

/** The sheet the address asks for, if any. */
export function askedSheet(params: URLSearchParams): SheetAsk | undefined {
  const sheet = params.get('sheet');
  const move = params.get('move');
  if (move !== null && sheet !== 'guardrails') return { kind: 'patching', row: move || undefined };
  if (params.has('open') && sheet !== 'patching') return { kind: 'guardrails', row: guardrail(params.get('open')) };
  if (sheet === 'patching' || sheet === 'guardrails') return { kind: sheet };
  const item = params.get('item');
  if (sheet !== null && item) return { kind: 'item', item };
  return undefined;
}
