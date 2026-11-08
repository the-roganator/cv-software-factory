/**
 * Answering a hold from Needs you: Martin approves it, rejects it, answers it in words, or sends it back to the planner
 * with his words, and the admin service appends his `hold.answered`, which the line or triage acts on as `ANSWERS` says
 * for the hold's cause. One route each, `POST /admin/holds/:workItem/approve`, `/reject`, `/answer` and `/replan`, each
 * naming the hold the card showed (its `hold.started` event's id).
 *
 * - **Only the hold the card showed.** The answer is refused, having changed nothing, unless that hold is the work
 *   item's open one as the answer is taken, as the line reads it: its latest hold, with nothing since that answered
 *   or ended it (an answer, a merge, a close, a reopening, for a deploy a release, for a merge gates that failed, for a
 *   spec a spec written again, which the line holds afresh and an answer to the old card is told of). Words on one of
 *   triage's holds leave it open (`WORDS_LEAVE_HELD`), so it can still be approved or rejected. Answers are taken one
 *   at a time, under the lock every append takes, so two cannot both answer one hold, and a hold the line or triage
 *   appends meanwhile is the one answered next.
 * - **Only an answer that does something.** One the line would only wait after is refused (`answersTo`): approving a
 *   merge, which Martin does on GitHub, a deploy, which a release ends by itself, or a suggestion, which never starts
 *   work: Martin asks for an improvement himself with the console's "+". Sending the work back to the planner is
 *   taken only on the holds before a merge where the spec may be what is wrong (a gate, a review, a merge, tests
 *   first), with his words, which are his reason for it. An answer that takes words (`takesWords`) is refused without
 *   them, and one that takes none with them. On a work item a visitor's report opened, but on triage's holds, words
 *   are taken only shared (`sharesWords`), as no agent reads them otherwise, and would only hand back the same again:
 *   the service takes there exactly what the console offers. Two answers that take no words and do the same are one (`sameAs`): approving the planner's
 *   rejection, or the coder's finding nothing to fix, is refused, as Close (his rejection) does the same, and its
 *   summary says he closed it, agreeing.
 * - **The cause is the store's.** Approving a hold whose cause is a guardrail is `hold.approve-guardrail` in the access
 *   table, which needs the passkey again; the cause is read from the stored hold, never taken from the request.
 *   Approving the spec of an improvement is `hold.approve-improvement-spec`, which needs it too, as asking for one does:
 *   it sets the line building something new. That is a `spec` hold on a work item whose opening says it is an
 *   improvement, both read from the store, whoever opened it. Sharing his words on a work item a visitor's report
 *   opened is `hold.share-words`, which needs it too: it loosens what such a work item carries. Rejecting, unshared
 *   words, and approving any other hold never ask.
 * - **Words about a visitor's report stay Martin's, unless he shares them.** On a work item a visitor's report opened
 *   (its first signal is a report), the answer is marked `report`, and its public view leaves his words out, at any
 *   stage: a paraphrase of a report would pass any redactor. Martin, their author, shares them (`share`), judging they
 *   do not repeat the visitor: the answer is marked `shared` too, and his words are then read and shown as on any other
 *   work item. Triage's holds there keep his words his, unshared. Sharing words anywhere else is refused.
 */
import { randomUUID } from 'node:crypto';
import {
  answersTo,
  CLOSE_AGREES,
  HOLD_ANSWERS,
  type HoldAnswer,
  type HoldCause,
  MARTIN_ANSWER_CHARS,
  type NewEvent,
  type RawEvent,
  sharesWords,
  takesWords,
  upcast,
  VERSIONS,
  WORDED_ANSWERS,
  WORDS_LEAVE_HELD,
} from '@software-factory/events';
import { fromMartin, LINE_ROLE, lockAppends, openedAsImprovement } from '@software-factory/store';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { ACCESS, GUARDRAIL_HOLDS } from '../../../../policy/access.ts';
import { type AdminStore, Refused, type Session, steppedUpNow } from './store.ts';

/** A work item's number, as the store keeps it. */
export const WORK_ITEM = /^[1-9][0-9]{0,8}$/;

const hold = z.strictObject({ hold: z.uuid() });
const withWords = hold.extend({
  words: z.string().trim().min(1).max(MARTIN_ANSWER_CHARS).optional(),
  share: z.literal(true).optional(),
});

/**
 * What an answer sends: the hold the card showed, and for those that go with words (`WORDED_ANSWERS`), the words,
 * which the hold's cause and work item say whether it takes (`takesWords`), as the answer is taken.
 */
export const ANSWER = Object.fromEntries(
  HOLD_ANSWERS.map((answer) => [answer, WORDED_ANSWERS.includes(answer) ? withWords : hold]),
) as Record<HoldAnswer, typeof hold | typeof withWords>;

/** What an answer did: the work item, the hold, the answer, whether Martin's words stay his, and whether he shared them. */
export interface Answered {
  workItem: string;
  hold: string;
  decision: HoldAnswer;
  report: boolean;
  shared: boolean;
}

/** A work item's open hold: its event's id, and its cause. */
interface OpenHold {
  id: string;
  cause: HoldCause;
}

/** The open hold, if any, and the `spec` holds a later spec ended, which Martin may still be looking at. */
interface Holds {
  open: OpenHold | undefined;
  respecified: Set<string>;
}

/**
 * The work item's open hold, if it has one: its latest `hold.started`, and nothing since that answers or ends it, as the
 * line's `fold` (`line/machine.ts`) reads them. The admin service keeps its own reading, of these few events, rather
 * than take in the line's code, its GitHub and Kubernetes clients with it; `admin.test.ts` holds the two to each other
 * case by case. Only Martin's roles' answers count, as the line and triage count them, and only the line's specs, as
 * the line reads them: a spec written while a `spec` hold is open ends that hold, since what Martin read is not what
 * the line would build, and the new spec is held afresh.
 */
async function openHold(tx: TransactionSql, workItem: string): Promise<Holds> {
  const rows = await tx<(RawEvent & { id: string })[]>`
    select e.id, e.seq, e.type, e.version, e.payload from events e
    where e.work_item = ${workItem} and ${fromMartin(tx, 'e')}
      and (e.type <> 'spec.written' or e.appended_by is null or e.appended_by = ${LINE_ROLE})
      and e.type in ('hold.started', 'hold.answered', 'gates.started', 'gates.finished', 'pull-request.merged', 'work.returned',
                     'release.started', 'release.promoted', 'release.rolled-back', 'release.aborted', 'release.errored',
                     'work-item.closed', 'work-item.reopened', 'spec.written')
    order by e.seq`;
  let open: OpenHold | undefined;
  const respecified = new Set<string>();
  // The latest release carrying the merged change, whether it was promoted, and whether it has ended otherwise, and
  // the commit the latest gates ran on.
  let release: { name: string; promoted: boolean; ended: boolean } | undefined;
  let gates: string | undefined;
  // Whether the change has merged since the work item last went back to Plan or reopened: a release before it carries
  // nothing.
  let merged = false;
  // The end of a release other than the latest to carry the change says nothing about it. Its end, however it came,
  // ends a hold of its canary paused for Martin, as the line's fold does.
  const ends = (name: string, promoted: boolean) => {
    if (release?.name !== name) return;
    release = promoted ? { ...release, promoted: true } : { ...release, ended: true };
    if (open?.cause === 'canary') open = undefined;
  };
  for (const row of rows) {
    const read = upcast({ ...row, seq: Number(row.seq) });
    if (!read.ok) continue;
    const { event } = read;
    switch (event.type) {
      case 'hold.started':
        // A hold for a deploy decided as a release started is already answered by it.
        if (event.payload.cause === 'deploy' && release && !release.ended) break;
        // A canary's hold is of the release in flight that carries the change: one of any other, or one that has
        // ended, holds nothing.
        if (
          event.payload.cause === 'canary' &&
          !(release && release.name === event.payload.release && !release.promoted && !release.ended)
        ) {
          break;
        }
        open = { id: row.id, cause: event.payload.cause };
        break;
      case 'spec.written':
        if (open?.cause === 'spec') {
          respecified.add(open.id);
          open = undefined;
        }
        break;
      case 'hold.answered':
        // Words leave one of triage's holds standing, for his approval or rejection.
        if (event.payload.decision === 'answered' && open && WORDS_LEAVE_HELD.includes(open.cause)) break;
        open = undefined;
        break;
      case 'gates.started':
        gates = event.payload.commit;
        break;
      // Gates that fail end a wait for his merge, which GitHub would refuse.
      case 'gates.finished':
        if (event.payload.commit === gates && event.payload.conclusion === 'failed' && open?.cause === 'merge') {
          open = undefined;
        }
        break;
      case 'pull-request.merged':
        open = undefined;
        release = undefined;
        merged = true;
        break;
      // A fresh pass, as the line starts one: a new pull request, with its own gates, merge and release.
      case 'work.returned':
        if (event.payload.to !== 'plan') break;
        merged = false;
        release = undefined;
        gates = undefined;
        break;
      // A release that carries the merged change ends a wait for its deploy, and a hold of an earlier release's canary.
      case 'release.started':
        if (!merged) break;
        release = { name: event.payload.release, promoted: false, ended: false };
        if (open?.cause === 'deploy' || open?.cause === 'canary') open = undefined;
        break;
      case 'release.promoted':
        ends(event.payload.release, true);
        break;
      case 'release.rolled-back':
      case 'release.aborted':
      case 'release.errored':
        ends(event.payload.release, false);
        break;
      case 'work-item.closed':
        open = undefined;
        break;
      case 'work-item.reopened':
        open = undefined;
        merged = false;
        release = undefined;
        gates = undefined;
        break;
    }
  }
  return { open, respecified };
}

/**
 * Whether the work item is an improvement, by its opening, whoever appended it: only Martin's roles may open one now
 * (0035_improvement-requests.sql), and one a worker opened before then asks for the passkey all the same.
 */
async function isImprovement(tx: TransactionSql, workItem: string): Promise<boolean> {
  const [row] = await tx<{ improvement: boolean }[]>`
    select ${openedAsImprovement(tx, 'w.work_item')} as improvement from (select ${workItem}::text as work_item) w`;
  return row?.improvement === true;
}

/** Whether a visitor's report opened the work item: its first signal is a report. */
async function openedByReport(tx: TransactionSql, workItem: string): Promise<boolean> {
  const [first] = await tx<{ sense: string }[]>`
    select payload->>'sense' as sense from events
    where work_item = ${workItem} and type = 'signal.received' order by seq limit 1`;
  return first?.sense === 'report';
}

const DID: Record<HoldAnswer, (workItem: string) => string> = {
  approved: (workItem) => `approved the hold on #${workItem}`,
  rejected: (workItem) => `rejected the hold on #${workItem}`,
  answered: (workItem) => `answered the hold on #${workItem} in words`,
  replanned: (workItem) => `sent the hold on #${workItem} back to the planner`,
};

/** Martin's answer, as he gave it. */
function answerEvent(
  workItem: string,
  cause: HoldCause,
  decision: HoldAnswer,
  hold: string,
  report: boolean,
  words?: string,
  shared = false,
): NewEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type: 'hold.answered',
    version: VERSIONS['hold.answered'],
    actor: 'martin',
    summary:
      decision === 'rejected' && CLOSE_AGREES.includes(cause)
        ? `Martin closed #${workItem}, agreeing with the ${cause === 'nothing-to-fix' ? 'coder' : 'planner'}`
        : `Martin ${DID[decision](workItem)}`,
    payload: {
      decision,
      ...(words !== undefined && { answer: words }),
      hold,
      ...(report && { report: true }),
      ...(shared && { shared: true }),
    },
    artifacts: [],
  } as NewEvent;
}

/** Answers a work item's open hold as Martin gave it, or refuses having changed nothing. */
export async function answerHold(
  store: AdminStore,
  session: Session,
  workItem: string,
  decision: HoldAnswer,
  given: { hold: string; words?: string; share?: true },
): Promise<Answered> {
  const shared = given.share === true;
  const { report } = await store.record(
    async (tx) => {
      // One answer at a time, and none between a hold the line or triage appends and the next.
      await lockAppends(tx);
      const { open, respecified } = await openHold(tx, workItem);
      if (respecified.has(given.hold)) {
        // The card showed a spec the planner has since written again: an answer to it would answer nothing.
        throw new Refused(
          'hold',
          409,
          `The spec of #${workItem} was written again since that card, so this answer would answer nothing: the line holds the new one for you when it needs you.`,
        );
      }
      if (!open || open.id !== given.hold) {
        throw new Refused(
          'hold',
          409,
          open
            ? `#${workItem} is held for something else now: look at its card again.`
            : `#${workItem} has no hold waiting now: it was answered, or moved on.`,
        );
      }
      const report = await openedByReport(tx, workItem);
      // Where words reach an agent only shared, they are taken only shared; anywhere else, never.
      const shares = sharesWords(open.cause, report);
      if (shared && !shares) {
        throw new Refused(
          'share',
          422,
          report
            ? 'Your words on this hold stay yours: send them without sharing.'
            : 'Your words here are public anyway: send them without sharing.',
        );
      }
      if (!answersTo(open.cause).includes(decision)) {
        throw new Refused('answer', 422, 'That answer does nothing for this hold, so it takes another.');
      }
      const takes = takesWords(open.cause, decision);
      if (takes && given.words === undefined) throw new Refused('words', 422, 'That answer takes your words.');
      if (!takes && given.words !== undefined) throw new Refused('words', 422, 'That answer takes no words.');
      if (takes && shares && !shared) {
        throw new Refused(
          'share',
          422,
          'A visitor’s report opened this, so your words reach an agent only shared: share them, or answer another way.',
        );
      }
      const guardrail = (GUARDRAIL_HOLDS as readonly HoldCause[]).includes(open.cause);
      const asks =
        (shared && ACCESS['hold.share-words'].stepUp) ||
        (decision === 'approved' &&
          ((guardrail && ACCESS['hold.approve-guardrail'].stepUp) ||
            (open.cause === 'spec' &&
              ACCESS['hold.approve-improvement-spec'].stepUp &&
              (await isImprovement(tx, workItem)))));
      if (asks) {
        // Asked again as the answer is taken, after the lock: the passkey given may have gone stale while it waited.
        if (!(await steppedUpNow(tx, session))) throw new Refused('step-up', 403, 'This needs your passkey again.');
      }
      return { report, cause: open.cause };
    },
    ({ report, cause }) => [answerEvent(workItem, cause, decision, given.hold, report, given.words, shared)],
  );
  return { workItem, hold: given.hold, decision, report, shared };
}
