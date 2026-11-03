/**
 * Writes the samples to their event log: log/events.ndjson, beside the screenshots in log/artifacts.
 *
 *     node packages/samples/src/export.ts            # write it
 *     node packages/samples/src/export.ts --check    # fail if it is out of date (make check, CI)
 *
 * Every event is validated as the store would validate it, and written as its public view, so the log holds
 * nothing a visitor may not see: no report text, no visitor's key. Each carries the role that would append it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PublicEvent } from '@software-factory/events';
import { EVENTS_FILE, formatLog, writeLogEvents } from '@software-factory/events/log';
import { publicView } from '@software-factory/events/public';
import { validate } from '@software-factory/events/schemas';
import { ARTIFACTS, LOG } from './captures.ts';
import { sampleEvents } from './index.ts';
import { appenderOf } from './roles.ts';

export function publicSamples(): PublicEvent[] {
  const events = sampleEvents();
  const problems = events.flatMap((event) => {
    const result = validate(event);
    const missing = event.artifacts.filter((a) => !existsSync(join(ARTIFACTS, a.hash))).map((a) => `missing ${a.hash}`);
    return [...(result.ok ? [] : result.problems), ...missing].map((p) => `#${event.work_item} ${event.type}: ${p}`);
  });
  if (problems.length) throw new Error(`The samples are not valid:\n  ${problems.join('\n  ')}`);
  const attacks = new Set(
    events.flatMap((event) => (event.type === 'attack.launched' && event.work_item ? [event.work_item] : [])),
  );
  return events.map((event, i) => {
    const appendedBy = appenderOf(event, attacks);
    return {
      ...event,
      ...publicView(event.type, event),
      seq: i + 1,
      ...(appendedBy && { appended_by: appendedBy }),
    } as PublicEvent;
  });
}

if (import.meta.main) {
  const events = publicSamples();
  const file = join(LOG, EVENTS_FILE);
  const name = relative(process.cwd(), file);
  if (process.argv.includes('--check')) {
    if (!existsSync(file) || readFileSync(file, 'utf-8') !== formatLog(events)) {
      console.error(`${name} is out of date: run node ${relative(process.cwd(), import.meta.filename)}`);
      process.exit(1);
    }
    console.log(name, 'is up to date');
  } else {
    writeLogEvents(LOG, events);
    console.log(`wrote ${events.length} events to ${name}`);
  }
}
