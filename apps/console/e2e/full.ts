/**
 * The full events, as the admin service streams them to Martin's session, made from the samples for the browser tests:
 * the samples' log is public views, so each visitor's report is given back the text the tests look for, the dependency
 * sense's day the lockfile's package the public view withholds until its pull request is open. A sample's other
 * events are given back their own payloads by `own`, from the samples' private half (`private.ndjson`).
 */

import { fileURLToPath } from 'node:url';
import { type HoldAnswer, type RawEvent, WORDED_ANSWERS } from '@software-factory/events';
import { readLogPrivate } from '@software-factory/events/log';
import { WITHHELD } from '../../../packages/samples/src/patching-withheld.ts';

/** The samples' own summaries and payloads where their public views change them. */
const PRIVATE = readLogPrivate(fileURLToPath(new URL('../../../packages/samples/log', import.meta.url)));

/** What the samples' visitor wrote, with a link, an address and markup, which the console leaves out. */
export const REPORT_TEXT =
  'The contact form ate my message twice, so I gave up. <b>Mail me</b> at someone@example.com or see https://example.com/help';

/** The same, as Martin reads it on the sheet. */
export const REPORT_SHOWN = 'The contact form ate my message twice, so I gave up. bMail me/b at or see';

/** What Martin answered on a hold about a visitor's report, which only his full events carry. */
export const MARTINS_WORDS = 'Worth having: I’ll ask for colour in search from Plan once improvements ship.';

/**
 * An event as its full version carries it: a report with its text, Martin's words on a hold about one, and the sense's
 * day whole.
 */
export function full<T extends RawEvent>(event: T): T {
  if (event.type === 'patching.read') {
    type Day = { repositories: { repository: string; moves: { lockfile: boolean; package?: unknown }[] }[] };
    const day = event.payload as Day;
    const repositories = day.repositories.map((r) =>
      r.repository === 'the-roganator/cv-worlds-worst-website'
        ? { ...r, moves: r.moves.map((m) => (m.lockfile && !m.package ? { ...m, package: WITHHELD } : m)) }
        : r,
    );
    return { ...event, payload: { ...day, repositories } };
  }
  const payload = event.payload as { report?: { page: string }; state?: { report?: { page: string } } };
  if (event.type === 'signal.received' && payload.report) {
    return { ...event, payload: { ...payload, report: { ...payload.report, text: REPORT_TEXT } } };
  }
  if (event.type === 'judgement.made' && payload.state?.report) {
    const state = { ...payload.state, report: { ...payload.state.report, text: REPORT_TEXT } };
    return { ...event, payload: { ...payload, state } };
  }
  const answer = event.payload as { decision?: HoldAnswer; report?: boolean; answer?: string };
  // Only an answer that goes with words had words to leave out.
  if (
    event.type === 'hold.answered' &&
    answer.report &&
    answer.decision !== undefined &&
    WORDED_ANSWERS.includes(answer.decision) &&
    answer.answer === undefined
  ) {
    return { ...event, payload: { ...answer, answer: MARTINS_WORDS } };
  }
  return event;
}

/** A sample as it was appended: its own summary and payload where its public view changes them (`private.ndjson`). */
export function own<T extends RawEvent>(event: T): T {
  const half = PRIVATE.get((event as RawEvent & { id?: string }).id ?? '');
  return half
    ? { ...event, ...(half.summary !== undefined && { summary: half.summary }), payload: half.payload }
    : event;
}
