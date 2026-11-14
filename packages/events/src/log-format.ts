/**
 * The event-log file: newline-delimited JSON of public events in `seq` order, beside a folder of artifacts named by
 * hash. Samples, recordings for the replay site, `make demo` and the console's tests all use it.
 *
 *     <log>/events.ndjson
 *     <log>/artifacts/<sha256>
 *     <log>/private.ndjson       the samples' alone: each event's own summary and payload where its view changes them
 *
 * Parsing and formatting only, with no file system, so the browser reads a log with the same code as Node.
 */
import type { PublicEvent } from './types.ts';
import type { RawEvent } from './upcast.ts';

export const EVENTS_FILE = 'events.ndjson';
export const ARTIFACTS_DIR = 'artifacts';

/**
 * The envelope's fields in the order a log writes them, so a log is stable from one export to the next. The role that
 * appended an event is left out where none is known.
 */
const ORDER = [
  'id',
  'seq',
  'ts',
  'work_item',
  'type',
  'version',
  'actor',
  'summary',
  'payload',
  'artifacts',
  'appended_by',
] as const;

export function formatLog(events: readonly PublicEvent[]): string {
  const lines = events.map((event) => JSON.stringify(Object.fromEntries(ORDER.map((key) => [key, event[key]]))));
  return `${lines.join('\n')}\n`;
}

/** The events in a log, not yet upcast. A line that is not JSON stops the read with its number. */
export function parseLog(text: string): RawEvent[] {
  return text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as RawEvent];
    } catch {
      throw new Error(`Line ${index + 1} of the event log is not JSON`);
    }
  });
}
