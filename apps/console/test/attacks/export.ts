/**
 * Writes the console's test data for red-team attacks (`events.ts`) to its event log, log/events.ndjson, which a
 * browser test's server reads. Nothing the console ships reads it.
 *
 *     node apps/console/test/attacks/export.ts            # write it
 *     node apps/console/test/attacks/export.ts --check    # fail if it is out of date (make check, CI)
 *
 * Every event is validated as the store would validate it, and written as its public view, with the role that would
 * append it, as the samples' are.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PublicEvent } from '@software-factory/events';
import { EVENTS_FILE, formatLog, writeLogEvents } from '@software-factory/events/log';
import { publicView } from '@software-factory/events/public';
import { validate } from '@software-factory/events/schemas';
import { appenderOf, attackItems } from '../../../../packages/samples/src/roles.ts';
import { attackEvents } from './events.ts';

export const LOG = fileURLToPath(new URL('./log/', import.meta.url));

export function publicAttacks(): PublicEvent[] {
  const events = attackEvents();
  const problems = events.flatMap((event) => {
    const result = validate(event);
    return (result.ok ? [] : result.problems).map((p) => `#${event.work_item} ${event.type}: ${p}`);
  });
  if (problems.length) throw new Error(`The attacks' test data is not valid:\n  ${problems.join('\n  ')}`);
  const attacks = attackItems(events);
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
  const events = publicAttacks();
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
