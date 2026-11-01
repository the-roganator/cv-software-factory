/**
 * What the canary bird does on each release event that arrives while the console is open. The bird is drawn by
 * `components/Bird.tsx`; this says only which reaction an event calls for, so the tests reach it without a browser.
 *
 * The line records a release's events on each work item it carries, not always in the same pass, so one start, look,
 * step or end can arrive as several events: the bird reacts to the first and lets the copies go. A look may also arrive
 * split across two events, when the line read the analysis between two of its writes: each part is a look of its own,
 * and the bird hops for each, but a measure is never sour twice for the same measurement.
 */
import { measurementOf, type PublicEvent } from '@software-factory/events';
import { endsRelease } from './items.ts';

export type Reaction =
  /** A release started: the bird leaves its cage for the Canary panel, as a paper bird for a dry run. */
  | { kind: 'leave'; paper: boolean }
  /** A look landed and every measure it took passed, or is still counting. */
  | { kind: 'hop' }
  /** A look, or a step, failed a measure: a sour note and a flinch, and it carries on. */
  | { kind: 'sour' }
  /** A step passed: it sings, one note more for each step passed so far (`step` 0 for the first). */
  | { kind: 'sing'; step: number }
  /** Promoted: a trill, then home. */
  | { kind: 'trill' }
  /** Rolled back: a sour note, it keels over, shakes it off and flies home ruffled. */
  | { kind: 'keel' }
  /** Stopped with the line, aborted by Martin, or stopped by an analysis error: it goes home, saying nothing. */
  | { kind: 'home' };

/** What the bird has reacted to: the release it is out for, and what of it it has heard already. */
export interface Watch {
  /** The release it is out for, while that is in flight; undefined while it is in its cage. */
  release: string | undefined;
  /** Each measurement it has heard, by its measure and its end, as the Canary panel keeps them (`measurementOf`). */
  measured: Set<string>;
  /** The weight of each step it has heard passed or failed. */
  stepped: Set<number>;
  /** How many of those steps passed: its next song has one note more. */
  sung: number;
}

export const caged = (): Watch => ({ release: undefined, measured: new Set(), stepped: new Set(), sung: 0 });

/** Takes in one event, and says what the bird does about it, if anything. */
export function hear(watch: Watch, event: PublicEvent): Reaction | undefined {
  if (event.type === 'release.started') {
    const { release, dryRun } = event.payload;
    // The same start on another work item the release carries.
    if (watch.release === release) return undefined;
    Object.assign(watch, caged(), { release });
    return { kind: 'leave', paper: dryRun };
  }
  if (event.type !== 'canary.measuring' && event.type !== 'canary.stepped' && !endsRelease(event)) return undefined;
  if (event.payload.release !== watch.release) return undefined;
  if (event.type === 'canary.measuring') {
    const heard = event.payload.measures.filter((m) => !watch.measured.has(measurementOf(m)));
    if (!heard.length) return undefined;
    for (const m of heard) watch.measured.add(measurementOf(m));
    // A look over its limit is sour, whether it failed or, with auto-rollback off, was inconclusive.
    return heard.some((m) => m.phase === 'failed' || m.phase === 'inconclusive') ? { kind: 'sour' } : { kind: 'hop' };
  }
  if (event.type === 'canary.stepped') {
    const { weight, analysis } = event.payload;
    // A step that could not be judged, or that waits for someone, is no song, and may yet be judged.
    if (analysis.phase !== 'successful' && analysis.phase !== 'failed') return undefined;
    if (watch.stepped.has(weight)) return undefined;
    watch.stepped.add(weight);
    if (analysis.phase === 'failed') return { kind: 'sour' };
    watch.sung += 1;
    return { kind: 'sing', step: watch.sung - 1 };
  }
  watch.release = undefined;
  if (event.type === 'release.promoted') return { kind: 'trill' };
  if (event.type === 'release.rolled-back') return { kind: 'keel' };
  return { kind: 'home' };
}

/** What the bird has heard by the end of the events, reacting to none of them: the console has just opened. */
export function heard(events: readonly PublicEvent[]): Watch {
  const watch = caged();
  for (const event of events) hear(watch, event);
  return watch;
}
