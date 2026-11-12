/**
 * The scoreboard over the samples, worked out by the scoreboard's own figures (`factory`'s `scoreboard/figures.ts`)
 * against an invented answer key, at the moments its worker would publish them: off until it has a key, then a `score.updated`
 * each time a figure changes, verified and the median as soon as they do, found only on the slow cadence.
 */
import type { NewEvent, PayloadOf } from '@software-factory/events';
import { VERSIONS } from '@software-factory/events';
import { figures, lastBoundary, SCORE_TYPES, type ScoreEvent, tickets } from '@software-factory/factory/scoreboard';
import { type KeyEntry, SCOREBOARD } from '../../../policy/scoreboard.ts';
import { uuidFor } from './build.ts';

/** How many entries the invented key has in all. */
const ENTRIES = 30;

/**
 * The samples' answer key, invented: the defect of every sample ticket but the canary's, whose release carried
 * none of the factory's work, so it finds nothing; and as many entries as it takes to make thirty, which no sample
 * ticket finds and which say nothing of what they are.
 */
function key(events: readonly NewEvent[]): KeyEntry[] {
  const found = new Map<string, KeyEntry>();
  for (const event of events) {
    if (event.type !== 'ticket.opened') continue;
    const { fingerprint } = event.payload;
    // No entry is on every route, or a move's.
    if (('route' in fingerprint && fingerprint.route === '*') || 'ecosystem' in fingerprint) continue;
    found.set(JSON.stringify(fingerprint), { id: `found-by-${event.work_item}`, fingerprint });
  }
  const unfound = Array.from({ length: ENTRIES - found.size }, (_, i) => ({
    id: `unfound-${i + 1}`,
    fingerprint: { page: '/', text: `an entry no sample ticket finds, ${i + 1}` },
  }));
  return [...found.values(), ...unfound];
}

/** When the scoreboard was given its key: before it, the scoreboard says once that it is off. */
const KEYED_AT = Date.parse('2026-09-29T09:00:00+01:00');
/** How long after an event is appended the scoreboard's pass publishes what it changed. */
const PASS_MS = 1_000;

type Score = PayloadOf<'score.updated'>;

const same = (a: Score, b: Score) =>
  a.keyed && b.keyed
    ? a.entries === b.entries && a.found === b.found && a.verified === b.verified && a.medianMs === b.medianMs
    : a.keyed === b.keyed;

/**
 * Every `score.updated` the scoreboard would have published over the samples, from the line's start to its last
 * event: once off, then the figures at each moment one could change, a ticket's event or a cadence boundary,
 * whenever they did.
 */
export function scoreEvents(events: readonly NewEvent[]): NewEvent<'score.updated'>[] {
  const scored = events.filter(
    (event): event is NewEvent & { work_item: string } =>
      (SCORE_TYPES as readonly string[]).includes(event.type) && event.work_item !== null,
  ) as unknown as ScoreEvent[];
  const entries = key(events);
  const start = Date.parse(events[0]?.ts ?? '');
  const end = Date.parse(events.at(-1)?.ts ?? '');
  const every = SCOREBOARD.foundEveryHours * 3_600_000;
  // The scoreboard passes as each event is appended (`factory scoreboard` listens for them), a moment later, and once
  // a minute besides, which is how a boundary of the slow cadence reaches it with no event.
  const first = lastBoundary(KEYED_AT);
  const passes = [
    KEYED_AT,
    ...scored.map((event) => Date.parse(event.ts) + PASS_MS),
    ...Array.from({ length: Math.floor((end - first) / every) + 1 }, (_, i) => first + i * every),
  ].filter((at) => at >= KEYED_AT && at <= end);
  const published: [at: number, score: Score][] = [[start + PASS_MS, { keyed: false }]];
  for (const at of [...new Set(passes)].sort((a, b) => a - b)) {
    const { falsePositives: _, ...figured } = figures(
      tickets(scored.filter((event) => Date.parse(event.ts) <= at)),
      entries,
      lastBoundary(at),
    );
    const score: Score = { keyed: true, ...figured };
    const last = published.at(-1)?.[1];
    if (!last || !same(score, last)) published.push([at, score]);
  }
  return published.map(([at, score], i) => ({
    id: uuidFor(`line/score/${i}`),
    ts: new Date(at).toISOString(),
    work_item: null,
    type: 'score.updated',
    version: VERSIONS['score.updated'],
    actor: 'scoreboard',
    summary: score.keyed
      ? `The scoreboard: ${score.found} of ${score.entries} found, ${score.verified} verified fixed`
      : 'The scoreboard is off: it has no answer key',
    payload: score,
    artifacts: [],
  }));
}
