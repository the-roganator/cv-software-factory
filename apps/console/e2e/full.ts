/**
 * The full events, as the admin service streams them to Martin's session, made from the samples for the browser tests:
 * the samples are public views, so each visitor's report is given back the text a visitor wrote, and the dependency
 * sense's day the lockfile's package the public view withholds until its pull request is open. Everything else in them
 * is the same in both.
 */
import { type HoldAnswer, type RawEvent, WORDED_ANSWERS } from '@software-factory/events';
import { PATCHING } from '../../../packages/samples/src/patching.ts';

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
  if (event.type === 'patching.read' && (event as { id?: string }).id === PATCHING.id)
    return { ...event, payload: PATCHING.payload };
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
