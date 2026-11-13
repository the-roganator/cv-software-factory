/**
 * The words Patching's and Guardrails' summaries share with their sheets: how many hold, how a guardrail and an attack
 * read, and how many moves wait on Martin. Kept apart from both, so a summary carries none of its sheet's code.
 */
import { plural } from '../format.ts';
import type { GuardrailRow, GuardrailsView, Verdict } from '../projection/index.ts';
import type { GlyphName } from './Glyph.tsx';

/** How a guardrail reads, by its state: its word, tone and glyph. */
export const READS: Record<GuardrailRow['state'], [word: string, tone: string, glyph: GlyphName]> = {
  held: ['Held', 'ok', 'check'],
  'not-held': ['Did not hold', 'attn', 'cross'],
  unproved: ['Not proved', 'faint', 'dash'],
};

/** An attack's last run, in the words its card shows: refused, the failures that page Martin, or running. */
export const LAST_RUN: Record<Verdict, [word: string, tone: string, glyph: GlyphName]> = {
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

/** Martin, signed in, reads "you"; everyone else reads "Martin". */
export const you = (martin: boolean) => (martin ? 'you' : 'Martin');

/** "4 wait on you", "1 waits on Martin". */
export const waitWords = (n: number, martin: boolean) => `${n} wait${n === 1 ? 's' : ''} on ${you(martin)}`;

/** "9 moves". */
export const movesWords = (n: number) => plural(n, 'move');
