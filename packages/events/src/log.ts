/**
 * Reading and writing event-log folders on disk (log-format.ts describes the format). Node only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR, EVENTS_FILE, formatLog, parseLog } from './log-format.ts';
import type { PublicEvent } from './types.ts';
import type { RawEvent } from './upcast.ts';

export * from './log-format.ts';

export const readLogEvents = (dir: string): RawEvent[] => parseLog(readFileSync(join(dir, EVENTS_FILE), 'utf-8'));

export const logArtifactPath = (dir: string, hash: string): string => join(dir, ARTIFACTS_DIR, hash);

/** Writes a log's events. Its artifacts are written separately, by hash, into `<dir>/artifacts`. */
export function writeLogEvents(dir: string, events: readonly PublicEvent[]): void {
  mkdirSync(join(dir, ARTIFACTS_DIR), { recursive: true });
  writeFileSync(join(dir, EVENTS_FILE), formatLog(events));
}

/**
 * A sample log's private half: each event's own summary and payload where its public view changes them, by the event's
 * id, one JSON object a line in the log's order. Only the samples write one (`packages/samples/src/export.ts`), and
 * they are invented, so nothing in it is private to anyone: it is there so a store loads a sample as a real event is
 * appended, its payload checked against its schema and its public view made from it, never taken from the log.
 */
export const PRIVATE_FILE = 'private.ndjson';

export interface PrivateHalf {
  id: string;
  summary?: string;
  payload: unknown;
}

/** A log's private half, by event id: empty for a log with none, as every export of a store is. */
export function readLogPrivate(dir: string): Map<string, PrivateHalf> {
  const path = join(dir, PRIVATE_FILE);
  if (!existsSync(path)) return new Map();
  const halves = parseLog(readFileSync(path, 'utf-8')) as unknown as PrivateHalf[];
  return new Map(halves.map((half) => [half.id, half]));
}

export const formatPrivate = (halves: readonly PrivateHalf[]): string =>
  `${halves.map(({ id, summary, payload }) => JSON.stringify({ id, ...(summary !== undefined && { summary }), payload })).join('\n')}\n`;
