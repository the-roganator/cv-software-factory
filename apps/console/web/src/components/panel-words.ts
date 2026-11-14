/**
 * The words Patching's and Guardrails' summaries share with their sheets: how many hold, how a guardrail and an attack
 * read, how many moves wait on Martin and what the sense found running, and what a summary's lines say. Kept apart from
 * both, so a summary carries none of its sheet's code; plain TypeScript, which Node tests directly.
 */
import { count, dayLabel, plural, startOfDay } from '../format.ts';
import type { AttackRow, GuardrailRow, GuardrailsView, Verdict } from '../projection/index.ts';
import type { Counts, PatchingView } from '../projection/patching.ts';

/** The glyphs these words come with, each one of `Glyph.tsx`'s. */
type Mark = 'check' | 'cross' | 'dash' | 'ring';

/** How a guardrail reads, by its state: its word, tone and glyph. */
export const READS: Record<GuardrailRow['state'], [word: string, tone: string, glyph: Mark]> = {
  held: ['Held', 'ok', 'check'],
  'not-held': ['Did not hold', 'attn', 'cross'],
  unproved: ['Not proved', 'faint', 'dash'],
};

/** An attack's last run, in the words its card shows: refused, the failures that page Martin, or running. */
export const LAST_RUN: Record<Verdict, [word: string, tone: string, glyph: Mark]> = {
  refused: ['Refused', 'ok', 'check'],
  'not-refused': ['Not refused · Martin paged', 'attn', 'cross'],
  unconfirmed: ['Not confirmed · Martin paged', 'attn', 'cross'],
  unfinished: ['Unfinished · Martin paged', 'attn', 'ring'],
  running: ['Running', 'signal', 'ring'],
};

/** How many hold, as the summary and the sheet say it: "11 held", or "10 held · 1 did not", and any not proved yet. */
export function heldWords({ held, notHeld, unproved }: GuardrailsView): string {
  return [`${held} held`, notHeld > 0 && `${notHeld} did not`, unproved > 0 && `${unproved} not proved yet`]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The newest proof of any guardrail, whatever it showed: "Last proved" is its age, and a guardrail that did not hold
 * has its own line beside it.
 */
export function lastProof({ rows }: GuardrailsView): { at: number; held: boolean } | undefined {
  let newest: { at: number; held: boolean } | undefined;
  for (const { proof } of rows) {
    if (proof && (!newest || proof.at > newest.at)) newest = { at: proof.at, held: proof.held };
  }
  return newest;
}

/** The attack launched last, of those that can be, if any has been. */
export function lastAttack({
  rows,
}: GuardrailsView): (AttackRow & { last: NonNullable<AttackRow['last']> }) | undefined {
  let latest: (AttackRow & { last: NonNullable<AttackRow['last']> }) | undefined;
  for (const { attack } of rows) {
    const last = attack?.available ? attack.last : undefined;
    if (attack && last && (!latest || last.at > latest.last.at)) latest = { ...attack, last };
  }
  return latest;
}

/** Martin, signed in, reads "you"; everyone else reads "Martin". */
export const you = (martin: boolean) => (martin ? 'you' : 'Martin');

/** "4 wait on you", "1 waits on Martin", "1,200 wait on you". */
export const waitWords = (n: number, martin: boolean) => `${count(n)} wait${n === 1 ? 's' : ''} on ${you(martin)}`;

/** "9 moves". */
export const movesWords = (n: number) => plural(n, 'move');

/** "today", or the day it was, as a line says when the scan ran. */
export const onDay = (at: number, t: number) => (startOfDay(at) === startOfDay(t) ? 'today' : `on ${dayLabel(at)}`);

/**
 * What the sense found running that waits on Martin, a phrase for each kind there is: "1 unscanned image running",
 * "2 digests no scan read", "1 pin not running yet". The sheet's kicker and the summary's lines say the same.
 */
export function runningWords(view: Extract<PatchingView, { state: 'read' }>): string[] {
  const { running } = view;
  const each = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
  return [
    running['unlisted-image'] > 0 &&
      `${each(running['unlisted-image'], 'unscanned image', 'unscanned images')} running`,
    running['unscanned-digest'] > 0 && `${each(running['unscanned-digest'], 'digest', 'digests')} no scan read`,
    running['not-running'] > 0 && `${each(running['not-running'], 'pin', 'pins')} not running yet`,
  ].filter((words): words is string => Boolean(words));
}

/**
 * A row of counts' label, and whether it counts nothing at all. The findings of no rating it holds, which no column
 * draws, are said beside the label ("· 3 unrated"), so a row is never read as less than it is. What the moves clear is
 * "Nothing to clear" only when it clears nothing at all.
 */
export function countsLabel(
  label: 'All open' | 'The moves clear',
  counts: Counts | undefined,
): { label: string; nothing: boolean } {
  if (!counts) return { label, nothing: false };
  const nothing = counts.critical + counts.high + counts.medium + counts.low + counts.unknown === 0;
  const named = label === 'The moves clear' && nothing ? 'Nothing to clear' : label;
  return { label: counts.unknown > 0 ? `${named} · ${count(counts.unknown)} unrated` : named, nothing };
}
