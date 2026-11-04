/**
 * Writes the samples to their event log: log/events.ndjson, beside the screenshots in log/artifacts, with each relayed
 * refusal's signed record there too, and the key they are signed with beside the events (log/refusal-key.pem).
 *
 *     node packages/samples/src/export.ts            # write it
 *     node packages/samples/src/export.ts --check    # fail if it is out of date (make check, CI)
 *
 * Every event is validated as the store would validate it, and written as its public view, so the log holds
 * nothing a visitor may not see: no report text, no visitor's key. Each carries the role that would append it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PublicEvent } from '@software-factory/events';
import { EVENTS_FILE, formatLog, writeLogEvents } from '@software-factory/events/log';
import { publicView } from '@software-factory/events/public';
import { validate } from '@software-factory/events/schemas';
import { REFUSAL_KEY_FILE } from '@software-factory/events/signed';
import { ARTIFACTS, LOG } from './captures.ts';
import { sampleEvents } from './index.ts';
import { RECORDS, SAMPLE_REFUSAL_KEY } from './refusals.ts';
import { appenderOf, attackItems } from './roles.ts';

export function publicSamples(): PublicEvent[] {
  const events = sampleEvents();
  const problems = events.flatMap((event) => {
    const result = validate(event);
    const missing = event.artifacts.filter((a) => !existsSync(join(ARTIFACTS, a.hash))).map((a) => `missing ${a.hash}`);
    return [...(result.ok ? [] : result.problems), ...missing].map((p) => `#${event.work_item} ${event.type}: ${p}`);
  });
  if (problems.length) throw new Error(`The samples are not valid:\n  ${problems.join('\n  ')}`);
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
  const events = publicSamples();
  const file = join(LOG, EVENTS_FILE);
  const name = relative(process.cwd(), file);
  // The relayed refusals' records and the key that signs them, which the console's server checks them with.
  const written = new Map<string, Uint8Array | string>([
    ...[...RECORDS].map(([hash, bytes]): [string, Uint8Array] => [join(ARTIFACTS, hash), bytes]),
    [join(LOG, REFUSAL_KEY_FILE), SAMPLE_REFUSAL_KEY],
  ]);
  const same = (path: string, body: Uint8Array | string) =>
    existsSync(path) && Buffer.from(readFileSync(path)).equals(Buffer.from(body));
  if (process.argv.includes('--check')) {
    const stale = [...written].find(([path, body]) => !same(path, body));
    if (stale) {
      console.error(
        `${relative(process.cwd(), stale[0])} is out of date: run node ${relative(process.cwd(), import.meta.filename)}`,
      );
      process.exit(1);
    }
    if (!existsSync(file) || readFileSync(file, 'utf-8') !== formatLog(events)) {
      console.error(`${name} is out of date: run node ${relative(process.cwd(), import.meta.filename)}`);
      process.exit(1);
    }
    console.log(name, 'is up to date');
  } else {
    writeLogEvents(LOG, events);
    for (const [path, body] of written) writeFileSync(path, body);
    console.log(`wrote ${events.length} events to ${name}`);
  }
}
