/**
 * The feed: every public event, in seq order, held in memory and passed to listeners as it arrives. The server
 * sends events and artifacts and nothing derived from them, but one thing it alone can say: whether each relayed
 * refusal is what the GitHub worker signed (`refusals.ts`). The browser does the projecting.
 *
 * Three sources: the event store (live, through LISTEN and NOTIFY), an event-log folder (fixed, as the replay site
 * will be), or nothing at all (an empty store).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, RawEvent } from '@software-factory/events';
import { EVENTS_FILE, parseLog, upcast } from '@software-factory/events';
import { signedPayloadOf } from '@software-factory/events/signed-check';
import { listen, readPublic, storeKind } from '@software-factory/store';
import type { Sql } from 'postgres';
import { log } from './log.ts';
import type { SignedRefusal } from './refusals.ts';

export interface FeedEvent {
  seq: number;
  /** The public event as JSON, encoded once for every client. */
  json: string;
  /** When the store took it, in milliseconds since the epoch. */
  appendedAt: number;
}

export type Listener = (event: FeedEvent) => void;

/** What a store holds: samples or real events, or neither yet. Not an event: the store records it once (0002). */
export type StoreKind = 'sample' | 'real' | null;

export class Feed {
  /** What the store holds, as it last said. The stream tells each browser first thing, so an empty store is described rightly. */
  #kind: StoreKind = null;
  readonly #kindListeners = new Set<(kind: StoreKind) => void>();

  get kind(): StoreKind {
    return this.#kind;
  }

  /** Records what the store holds, and tells every stream when it changes. */
  set kind(kind: StoreKind) {
    if (kind === this.#kind) return;
    this.#kind = kind;
    for (const listener of this.#kindListeners) listener(kind);
  }

  /** Calls back whenever the store's kind changes, until unsubscribed. */
  onKind(listener: (kind: StoreKind) => void): () => void {
    this.#kindListeners.add(listener);
    return () => this.#kindListeners.delete(listener);
  }

  readonly #events: FeedEvent[] = [];
  readonly #listeners = new Set<Listener>();
  /** Every public artifact's recorded type, by hash. The console serves only these. */
  readonly #artifactTypes = new Map<string, string>();
  /** Every public refusal that carries a record and a signature, in seq order: what `/api/refusals` checks. */
  readonly #signed: SignedRefusal[] = [];

  get lastSeq(): number {
    return this.#events.at(-1)?.seq ?? 0;
  }

  get size(): number {
    return this.#events.length;
  }

  /** The events after a seq, in order. */
  after(seq: number): FeedEvent[] {
    // Seqs only grow, so a binary search finds the first one after.
    let [low, high] = [0, this.#events.length];
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.#events[mid]?.seq ?? 0) <= seq) low = mid + 1;
      else high = mid;
    }
    return this.#events.slice(low);
  }

  artifactType(hash: string): string | undefined {
    return this.#artifactTypes.get(hash);
  }

  /** Every public refusal relayed with a record and a signature, in seq order. */
  get signedRefusals(): readonly SignedRefusal[] {
    return this.#signed;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get subscribers(): number {
    return this.#listeners.size;
  }

  /** Adds events in seq order, skipping any it already has, and tells every listener. */
  add(events: readonly { event: RawEvent & { seq: number }; appendedAt: number }[]): void {
    for (const { event, appendedAt } of events) {
      if (event.seq <= this.lastSeq) continue;
      for (const artifact of (event as { artifacts?: ArtifactRef[] }).artifacts ?? []) {
        this.#artifactTypes.set(artifact.hash, artifact.type);
      }
      const signed = signedPayloadOf(event);
      if (signed) this.#signed.push({ seq: event.seq, payload: signed });
      const added = { seq: event.seq, json: JSON.stringify(event), appendedAt };
      this.#events.push(added);
      for (const listener of this.#listeners) listener(added);
    }
  }
}

/** A feed from the event store, kept current by LISTEN and NOTIFY. Resolves once it has read what is there. */
export async function storeFeed(sql: Sql): Promise<Feed> {
  const feed = new Feed();
  let reading: Promise<void> | undefined;
  let again = false;
  // Notifications can arrive faster than reads finish; one read at a time, and one more if any came meanwhile.
  const catchUp = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        // The kind is decided once, by `make real-store` or the first event, and never changes after. Until then it
        // is asked again on every read: `make real-store` notifies, so the console hears of it with no event.
        if (feed.kind === null) feed.kind = await storeKind(sql);
        for (;;) {
          const page = await readPublic(sql, feed.lastSeq);
          feed.add(page.map(({ event, appendedAt }) => ({ event, appendedAt: appendedAt.getTime() })));
          if (page.length < 1000) break;
        }
      } while (again);
    })()
      .catch((error: unknown) => log.error({ err: error }, 'could not read the event store'))
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  const ready = Promise.withResolvers<void>();
  // onReady runs on the first LISTEN and again after every reconnection: read whatever arrived meanwhile.
  await listen(
    sql,
    () => void catchUp(),
    () => void catchUp().then(ready.resolve),
  );
  await ready.promise;
  log.info({ events: feed.size, last: feed.lastSeq }, 'reading the event store');
  return feed;
}

/**
 * A feed from an event-log folder: what it holds when the server starts, and nothing more. Its times are moved
 * so the last event happened as the server started, as `factory events load` moves them into a store, so the
 * console shows a recording as live work rather than as something hours old.
 */
export function logFeed(dir: string, now = Date.now()): Feed {
  const feed = new Feed();
  const raws = parseLog(readFileSync(join(dir, EVENTS_FILE), 'utf-8')) as (RawEvent & { ts: string })[];
  const shift = now - Math.max(...raws.map((raw) => Date.parse(raw.ts)));
  feed.add(
    raws.map((raw) => {
      const moved = { ...raw, ts: new Date(Date.parse(raw.ts) + shift).toISOString() };
      const result = upcast(moved);
      const event = (result.ok ? result.event : moved) as RawEvent & { seq: number };
      return { event, appendedAt: Date.parse(moved.ts) };
    }),
  );
  // A log has no store table: its first work item says whether it holds samples.
  const opened = raws.find((raw) => raw.type === 'work-item.opened') as { payload?: { sample?: boolean } } | undefined;
  feed.kind = opened ? (opened.payload?.sample ? 'sample' : 'real') : null;
  log.info({ events: feed.size, dir }, 'serving an event log, its last event now');
  return feed;
}
