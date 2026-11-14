/**
 * Moving events between event-log folders and the event store: `factory events load`, `play` and `export`.
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { type NewEvent, type PublicEvent, type RawEvent, upcast } from '@software-factory/events';
import { logArtifactPath, readLogEvents, readLogPrivate, writeLogEvents } from '@software-factory/events/log';
import { type ArtifactStore, EventWriter, readPublic, storeKind } from '@software-factory/store';
import type { Sql } from 'postgres';

export interface Selection {
  /** Only these work items. */
  only?: string[] | undefined;
  /** Every work item but these. */
  except?: string[] | undefined;
}

/**
 * A log's events, upcast, in order, without the seqs and roles the store will give them afresh. A sample log's events
 * are given back their private summaries and payloads (`private.ndjson`), so the store checks each as it would a real
 * one and makes its public view itself.
 */
export function readLog(dir: string, { only, except }: Selection = {}): NewEvent[] {
  const halves = readLogPrivate(dir);
  return readLogEvents(dir)
    .map((logged: RawEvent) => {
      const half = halves.get((logged as RawEvent & { id?: string }).id ?? '');
      const raw = half
        ? { ...logged, ...(half.summary !== undefined && { summary: half.summary }), payload: half.payload }
        : logged;
      const result = upcast(raw);
      if (!result.ok)
        throw new Error(`${dir} holds an event this factory does not understand: ${raw.type} v${raw.version}`);
      // The store gives each a seq afresh, and records the role that appends it, whoever appended it before.
      const { seq: _seq, appended_by: _appendedBy, ...event } = result.event;
      return event as NewEvent;
    })
    .filter(({ work_item: item }) => {
      if (item === null) return !only;
      return (!only || only.includes(item)) && !except?.includes(item);
    });
}

const isSample = (events: readonly NewEvent[]) =>
  events.some((event) => event.type === 'work-item.opened' && event.payload.sample);

/** Refuses a store that holds the other kind of event, or any of these already. */
async function checkStore(sql: Sql, events: readonly NewEvent[]): Promise<'sample' | 'real'> {
  const kind = isSample(events) ? 'sample' : 'real';
  const held = await storeKind(sql);
  if (kind === 'sample' && held === 'real') throw new Error('This store holds real events, so it takes no samples.');
  if (kind === 'real' && held === 'sample') throw new Error('This store holds samples, so it takes no real events.');
  const ids = events.map((event) => event.id);
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`
    select count(*)::int as count from events where id in ${sql(ids)}`;
  if (count) throw new Error(`The store already holds ${count} of these events.`);
  return kind;
}

/** Copies the artifacts the events refer to from the log folder into the artifact store. */
async function copyArtifacts(dir: string, events: readonly NewEvent[], store: ArtifactStore): Promise<number> {
  const hashes = new Set(events.flatMap((event) => event.artifacts.map((artifact) => artifact.hash)));
  for (const hash of hashes) {
    const stored = await store.put(readFileSync(logArtifactPath(dir, hash)));
    if (stored !== hash) throw new Error(`${logArtifactPath(dir, hash)} does not hash to its name`);
  }
  return hashes.size;
}

/** Moves every event by the same amount, so that the last one happened at `end`. */
export function endingAt<T extends { ts: string }>(events: readonly T[], end: number): T[] {
  const last = Math.max(...events.map((event) => Date.parse(event.ts)));
  return events.map((event) => ({ ...event, ts: new Date(Date.parse(event.ts) + end - last).toISOString() }));
}

/** `factory events load`: appends a log's events in one go, their times moved so the last one is now. */
export async function load(sql: Sql, store: ArtifactStore, dir: string, selection: Selection = {}, now = Date.now()) {
  const events = readLog(dir, selection);
  const kind = await checkStore(sql, events);
  const artifacts = await copyArtifacts(dir, events, store);
  await new EventWriter(sql, { kind, artifacts: store }).append(endingAt(events, now));
  return { events: events.length, artifacts };
}

export interface PlayOptions extends Selection {
  /** How many times faster than recorded. */
  speed: number;
  /** The longest pause between two events, in milliseconds, so quiet hours pass quickly. */
  maxPause: number;
  /** Told of each event as it is appended. */
  onEvent?: (event: NewEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** `factory events play`: appends a log's events one at a time, at their recorded pace, sped up. */
export async function play(sql: Sql, store: ArtifactStore, dir: string, options: PlayOptions) {
  const { speed, maxPause, onEvent, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  const events = readLog(dir, options);
  const kind = await checkStore(sql, events);
  await copyArtifacts(dir, events, store);
  const writer = new EventWriter(sql, { kind, artifacts: store });
  let previous: number | undefined;
  for (const event of events) {
    const recorded = Date.parse(event.ts);
    if (previous !== undefined) await sleep(Math.min(maxPause, Math.max(0, recorded - previous) / speed));
    previous = recorded;
    // Each event happens now, as far as the console can tell.
    const now = { ...event, ts: new Date().toISOString() } as NewEvent;
    await writer.append(now);
    onEvent?.(now);
  }
  return { events: events.length };
}

/**
 * `factory events export`: writes a work item's public events, or with no work item every public event in the
 * store, and their artifacts, to a log folder.
 */
export async function exportItem(sql: Sql, store: ArtifactStore, item: string | null, dir: string) {
  const events: PublicEvent[] = [];
  for (let after = 0; ; ) {
    const page = await readPublic(sql, after);
    if (!page.length) break;
    after = page.at(-1)?.event.seq ?? after;
    const publicEvents = page.map(({ event }) => event as unknown as PublicEvent);
    events.push(...publicEvents.filter((event) => item === null || event.work_item === item));
  }
  if (!events.length)
    throw new Error(item ? `The store holds no events for work item ${item}.` : 'The store is empty.');
  writeLogEvents(dir, events);
  const hashes = new Set(events.flatMap((event) => event.artifacts.map((artifact) => artifact.hash)));
  await mkdir(join(dir, 'artifacts'), { recursive: true });
  for (const hash of hashes) {
    const opened = await store.open(hash);
    if (!opened) throw new Error(`The artifact store has no ${hash}`);
    await writeFile(logArtifactPath(dir, hash), await buffer(opened.body));
  }
  return { events: events.length, artifacts: hashes.size };
}
