/**
 * Writes the samples to their event log: log/events.ndjson, beside the screenshots in log/artifacts, with each relayed
 * refusal's signed record there too, the key they are signed with beside the events (log/refusal-key.pem), and how each
 * checks against it (log/refusals.json), for a page that reads the folder with no server to ask.
 *
 *     node packages/samples/src/export.ts            # write it
 *     node packages/samples/src/export.ts --check    # fail if it is out of date (make check, CI)
 *
 * Every event is validated as the store would validate it, and written as its public view, so events.ndjson holds
 * nothing a visitor may not see: no report text, no visitor's key, no withheld package. Each carries the role that
 * would append it. Beside it, log/private.ndjson holds each event's own summary and payload where its public view
 * changes them, so `make samples` appends a sample as a real event is appended: its payload checked against its
 * schema, and its public view made at the append, never read from the log. The samples are invented, so the private
 * half holds nothing private to anyone; the export refuses one that holds anything shaped like a secret or an address.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PublicEvent } from '@software-factory/events';
import {
  EVENTS_FILE,
  formatLog,
  formatPrivate,
  PRIVATE_FILE,
  type PrivateHalf,
  writeLogEvents,
} from '@software-factory/events/log';
import { publicView, redactDeep } from '@software-factory/events/public';
import { validate } from '@software-factory/events/schemas';
import { checkRecord, publicKeyOf, REFUSAL_CHECKS_FILE, signedPayloadOf } from '@software-factory/events/signed-check';
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

/** The secrets the samples make up for the redactor to take out, which a sample's private half may hold. */
const INVENTED_SECRETS = ['password=hunter2'];

/** An address, a URL with credentials, or anything else that would be real in a sample: none may be in its private half. */
const REAL = /[\w.+-]+@[\w-]+\.[\w.]+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i;

/**
 * Each sample's own summary and payload where its public view changes them, in the log's order. Refused when one holds
 * anything the redactor would take out, or an address: invented data has neither.
 */
export function privateHalves(): PrivateHalf[] {
  return sampleEvents().flatMap((event) => {
    const shown = publicView(event.type, event);
    const summary = shown.summary === event.summary ? undefined : event.summary;
    const changed = summary !== undefined || JSON.stringify(shown.payload) !== JSON.stringify(event.payload);
    if (!changed) return [];
    const half = { id: event.id, ...(summary !== undefined && { summary }), payload: event.payload };
    const text = INVENTED_SECRETS.reduce((out, secret) => out.replaceAll(secret, ''), JSON.stringify(half));
    if (JSON.stringify(redactDeep(JSON.parse(text))) !== text || REAL.test(text)) {
      throw new Error(`#${event.work_item} ${event.type} holds something a sample may not: ${text.slice(0, 200)}`);
    }
    return [half];
  });
}

if (import.meta.main) {
  const events = publicSamples();
  const file = join(LOG, EVENTS_FILE);
  const name = relative(process.cwd(), file);
  // Each relayed refusal's check, made here from its record and the samples' key and kept beside the events: the folder
  // is what the replay site publishes whole, so it holds the verdicts and never a record, whose words are those before
  // redaction.
  const key = publicKeyOf(SAMPLE_REFUSAL_KEY);
  const checks = Object.fromEntries(
    events.flatMap((event) => {
      const signed = signedPayloadOf(event);
      return signed ? [[event.seq, checkRecord(RECORDS.get(signed.record), key, signed)]] : [];
    }),
  );
  const written = new Map<string, Uint8Array | string>([
    [join(LOG, REFUSAL_CHECKS_FILE), `${JSON.stringify(checks, null, 2)}\n`],
    // Invented, so public as it is: the private half `make samples` loads (above).
    [join(LOG, PRIVATE_FILE), formatPrivate(privateHalves())],
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
