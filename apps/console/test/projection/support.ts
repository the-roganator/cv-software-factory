/**
 * Events for the projection's tests: the samples' event log, the attacks' test data, and a small builder for hand-made
 * cases.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Actor,
  type EventType,
  type PayloadOf,
  type PublicEvent,
  parseLog,
  upcast,
  VERSIONS,
} from '@software-factory/events';

export const SAMPLES: PublicEvent[] = parseLog(
  readFileSync(fileURLToPath(new URL('../../../../packages/samples/log/events.ndjson', import.meta.url)), 'utf-8'),
).map((raw) => {
  const result = upcast(raw);
  if (!result.ok) throw new Error(`The samples hold an event the console does not understand: ${raw.type}`);
  return result.event;
});

export const END = Date.parse(SAMPLES.at(-1)?.ts ?? '');

/**
 * The red-team attacks' test data (`test/attacks`): no attack can be launched yet, so the samples hold none, and the
 * tests of an attack as it will be read these.
 */
export const ATTACKS: PublicEvent[] = parseLog(
  readFileSync(fileURLToPath(new URL('../attacks/log/events.ndjson', import.meta.url)), 'utf-8'),
).map((raw) => {
  const result = upcast(raw);
  if (!result.ok) throw new Error(`The attacks' test data holds an event the console does not understand: ${raw.type}`);
  return result.event;
});

export const ATTACKS_END = Date.parse(ATTACKS.at(-1)?.ts ?? '');

/**
 * A moment the samples show a merge waiting at Release, unheld: #1310's, in a dry run, which no deploy can carry, half
 * a minute after it merged and before the dry run released it.
 */
export const MERGE_WAITING =
  Date.parse(SAMPLES.find((e) => e.work_item === '1310' && e.type === 'pull-request.merged')?.ts ?? '') + 30_000;
if (!Number.isFinite(MERGE_WAITING)) throw new Error('The samples have no merge of #1310 to wait for a release');

/**
 * The console's milestone 4 test data (test/fixture): a day of invented work in a real store, from the senses'
 * first tickets to a spend cap reached and cleared.
 */
export const FIXTURE: PublicEvent[] = parseLog(
  readFileSync(fileURLToPath(new URL('../fixture/log/events.ndjson', import.meta.url)), 'utf-8'),
).map((raw) => {
  const result = upcast(raw);
  if (!result.ok) throw new Error(`The test data holds an event the console does not understand: ${raw.type}`);
  return result.event;
});

/** Times in the test data's day, in London: the afternoon's work done, the cap reached, and the cap cleared. */
export const AFTERNOON = Date.parse('2026-10-03T16:10:00+01:00');
export const CAPPED = Date.parse('2026-10-03T21:20:00+01:00');
export const CLEARED = Date.parse('2026-10-04T01:05:00+01:00');

let seq = 0;

/** Events for one work item, minutes from a start. */
interface Builder {
  events: PublicEvent[];
  at(minute: number): number;
  add<K extends EventType>(minute: number, type: K, actor: Actor, payload: PayloadOf<K>, summary?: string): Builder;
  open(kind?: PayloadOf<'work-item.opened'>['kind']): Builder;
}

export function work(number: string, start = Date.parse('2026-10-03T09:00:00Z')): Builder {
  const events: PublicEvent[] = [];
  const builder: Builder = {
    events,
    at: (minute: number) => start + minute * 60_000,
    add(minute, type, actor, payload, summary = type) {
      events.push({
        id: `${number}-${events.length}`,
        seq: ++seq,
        ts: new Date(start + minute * 60_000).toISOString(),
        work_item: number,
        type,
        version: VERSIONS[type],
        actor,
        summary,
        payload,
        artifacts: [],
      } as PublicEvent);
      return builder;
    },
    open(kind = 'defect-fix') {
      return builder.add(0, 'work-item.opened', 'factory', { kind, title: `Item ${number}`, sample: true });
    },
  };
  return builder;
}

const COMMIT = 'a'.repeat(40);

export const payloads = {
  signal: {
    sense: 'probe',
    check: 'products journey',
    route: '/products',
    version: 'v0.9.4',
  } satisfies PayloadOf<'signal.received'>,
  gatesStarted: { pullRequest: 7, commit: COMMIT, checks: ['Unit tests'] } satisfies PayloadOf<'gates.started'>,
  gatesFailed: {
    pullRequest: 7,
    commit: COMMIT,
    conclusion: 'failed',
    passed: 0,
    failed: ['Unit tests'],
  } satisfies PayloadOf<'gates.finished'>,
  gatesPassed: {
    pullRequest: 7,
    commit: COMMIT,
    conclusion: 'passed',
    passed: 1,
    failed: [],
  } satisfies PayloadOf<'gates.finished'>,
};
