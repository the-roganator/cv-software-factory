/**
 * What the line does next with a work item, decided from its events alone. A pure function, so a test drives it with
 * a list of events, and a line that stopped or crashed carries on from the last event it appended: nothing about a
 * work item's progress lives anywhere else.
 *
 *     ticket → [issue] → planner → spec → coder → pull request → gates → reviewer → describer → Martin's merge
 *                                            ▲                      │          │
 *                                            └──── work returned ───┴──────────┘
 *
 * The coder's patch passes the scope fence before it reaches GitHub. One the fence refuses goes back to the coder
 * once, with the fence's output, and stays in Build; a second refusal holds the work item for Martin. A scope the
 * coder keeps straying from is the planner's to fix, so his answer sends the work item back to Plan, and the planner
 * is told what the fence printed and what he said. A coder that cannot meet the criteria without a file outside the
 * scope (an existing test the change rightly makes wrong) says so instead, naming each file and why, and the work
 * item holds the same way at once, with nothing of its round pushed (`needsHold`): the planner is told the files.
 *
 * A review that blocks sends the work back to the coder, whose next round resumes its session with the blocking
 * findings and the suggestions, and the gates and a fresh reviewer run again on what it pushes. A review that still
 * blocks after the second holds the work item for Martin, as does one the reviewer escalates. His approval of a held
 * review stands in for the reviewer's: before the change goes on, the line answers the thread of each finding it
 * blocked on, and of each suggestion it sends on with no round, saying he accepted it, and resolves it
 * (`review.accepted`), so he resolves none by hand. His words leave the threads open for the coder he sends the work
 * back to.
 *
 * A review that approves and leaves suggestions sends the work back to the coder once in a pass
 * (`LIMITS.suggestions`), before the describer writes the change up, to take each or decline it with a reason, as the
 * factory asks of agents answering a review; the app's `main` merges nothing with a review thread open. A coder that
 * takes any pushes, and the gates and a fresh reviewer run again; the review after that goes on whatever it suggests,
 * so suggestions never send the work round again on their own. That review counts toward `LIMITS.reviews` like any
 * other, and is at least the second: one that blocks after the coder's change for a suggestion holds for Martin, since
 * the change the reviewer approved is what the suggestion broke. One that declines them all changes nothing, and the
 * approval stands (`suggestions.answered`). Martin's approval sends the change on as it is, with no such round.
 *
 * A coder the work came back to may change nothing, and say why: a gate failed on a defect its change uncovered and
 * did not cause, or its change already does what was asked. That is an outcome, not a failed step: the work item
 * holds for Martin with the coder's reason, under the cause of what sent the work back (`gates` or `review`), so his
 * answer means what it would have meant there (`unchangedHold`). A first round that changes nothing questions the
 * spec instead, and holds as `nothing-to-fix`.
 *
 * A spec tagged with a risk that always needs a person (`ALWAYS_HELD`: a fix that changes behaviour beyond its
 * ticket) holds for Martin's approval before the coder starts, whatever the autonomy and whatever the round: every
 * spec so tagged, a rewritten one too. Approving carries on to Build; answering sends it back to the planner with what
 * he said.
 *
 * A review whose findings cite the ticket (the spec or the change goes beyond what it asks) holds as `beyond-ticket`:
 * the coder cannot put a spec right, so his answer sends it back to the planner, and his approval stands in for the
 * reviewer's. A spec written again once there is a pull request sends the work back to the coder, held to the new one.
 *
 * A work item that has spent as much on models as one may holds before its next step, since the gateway would refuse
 * every call that step made.
 *
 * Martin's merge answers whatever held the change before it, and the work item goes on to Release and Verify:
 *
 *     merged → [waits for a deploy] → release started → promoted → verify → cleared → closed, verified
 *                       ▲                    │                       │
 *                       └─ rolled back, ─────┘                       └─ persists → back to Plan, once; then held
 *                          erred or aborted
 *
 * A merged change waits at Release, held for Martin (`deploy`), until a release that carries it starts: the deploy
 * pull request that carries it is his to merge, and the release's start ends the hold by itself. A release that rolls
 * back holds it again, for the next; so does one whose analysis erred, or that Martin aborted, until he retries it,
 * which starts it again, or a later release carries the change. With auto-rollback off, a canary the analysis judges
 * bad pauses for Martin, and the release watch holds the work item (`canary`) until the release ends: promoted fully,
 * it goes on to Verify; aborted by him, it rolled back, and is held for the next, or for his retry, as any rollback. A dry run's merge, which no deploy can carry, is not
 * held: it waits at Release for the dry run's release. One that promotes moves it to Verify, where the sense that saw
 * the defect looks again (`verify.ts`). A signal that has cleared closes the work item as verified. One that persists
 * sends the work back to Plan, with the verification for the planner: a fresh pass, with a new spec, a new pull
 * request, its own gates, review, merge and release. A second that persists holds for Martin, as does a ticket only a visitor's report saw,
 * which no sense can look at again: approving closes it as verified, answering sends it back to Plan with his words.
 *
 * A verified ticket whose signal comes back reopens (triage decides it): the same defect regressed. The work item
 * starts a fresh pass at Plan, as after a return to Plan, and the planner is told what came back. A ticket a dry run
 * verified reopens the same way when the line runs live (`dryRunLeft`), with nothing come back to tell.
 *
 * The events are folded into where the work item is (`fold`), and `decide` turns that into one next action. Each
 * action either appends events, which moves the work item on, or waits for something outside the line: the gates
 * (GitHub's checks, which the line reads and appends as events) or Martin. The bounds a step has (its turns and
 * deadline) are each agent's (`agents/`); the bounds on the loop are `LIMITS`.
 *
 * A hold waits for Martin's answer, and what the answer does depends on why the work item is held: `ANSWERS` has a
 * rule for each cause and each answer. An answer in words to one of triage's holds leaves it standing
 * (`WORDS_LEAVE_HELD`): only his approval or his rejection settles those.
 *
 * An improvement Martin asked for (`improvement.requested`, the console's "+") comes onto the line as a ticket does,
 * and goes the same way to his merge, with three differences. Its spec is held for his approval before any code, every
 * spec of it, rewritten or not, whatever its risks: an improvement widens what the app does. It has no signal, so no
 * sense looks at it again, and a wait on overlapping work ends when that work closes. And once a release that carries
 * it is promoted, the line hands it over (`hand-over`): its change is in the app behind its flag, off, and the flag
 * pass (`flags.ts`) judges it from there, at each stage Martin widens the flag to. A rollback, or a release that erred
 * or was aborted, holds it for the next deploy as a fix is held.
 *
 * A held work item's defect may go some other way: another work item's fix, Martin's own commit, a dependency update.
 * So after each real release is promoted, and once as a hold starts, the sense that saw it looks again at the version
 * the stable Service runs (`lookDue`), unless a signal on that version already says the defect is there. A hold the
 * line made because its steps, gates or cap stopped the work (`closesWhenCleared`) closes as verified when the signal
 * has cleared; one that waits on Martin's judgement stays, and says the signal cleared, and his closing its pull request
 * then closes it as verified. A signal since, or a later look that finds it, ends the clearance.
 *
 * So may an open ticket's, before the line takes it. As it takes one whose signal was last seen on a version before
 * the one the stable Service runs, before its issue opens and the planner starts (`atTake`), the sense looks again the
 * same way: cleared, it closes as verified, with no issue opened and nothing spent; otherwise it goes on to Plan.
 *
 * Two tickets can be one defect, which shows only once the planner names the files. After Plan, a work item whose
 * spec's scope shares a file with the spec of work in flight waits (`wait.started`), before the coder starts and before
 * a spec that always needs Martin is held for him, until each of those work items is verified or closed. Then its
 * sense looks again: cleared, it closes as verified; otherwise it goes on to Build with its spec as written. While it
 * waits, each release is looked at as for a hold. A work item never waits on one that waits on it.
 */
import {
  ALWAYS_HELD,
  ANSWERS,
  cutTo,
  type HoldAnswer,
  type HoldCause,
  LIMITS,
  type PayloadOf,
  type Resolution,
  type SignalSource,
  STAGES,
  type Stage,
  sameVersion,
  touches,
  WORDS_LEAVE_HELD,
} from '@software-factory/events';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import { whoAborted } from '../release/watch.ts';
import { type Finding, suggestionsLeft } from './review.ts';

/** The agents the line runs, each in a runner. */
export type LineAgent = 'planner' | 'coder' | 'reviewer' | 'describer';

/** The bounds on the loop, shared with the console, which draws how near a work item is to them. */
export { LIMITS };

/** An event as the line reads it: its type and payload, upcast to the current version. */
export type LineEvent = { [K in keyof Payloads]: { type: K; payload: Payloads[K] } }[keyof Payloads];

type Payloads = {
  [K in
    | 'ticket.opened'
    | 'improvement.requested'
    | 'spec.written'
    | 'pull-request.pushed'
    | 'suggestions.answered'
    | 'wait.started'
    | 'signal.received'
    | 'signal.rechecked'
    | 'gates.started'
    | 'gates.finished'
    | 'review.submitted'
    | 'review.accepted'
    | 'work-item.summarised'
    | 'work.returned'
    | 'hold.started'
    | 'hold.answered'
    | 'action.refused'
    | 'pull-request.merged'
    | 'release.started'
    | 'release.promoted'
    | 'release.rolled-back'
    | 'release.aborted'
    | 'release.errored'
    | 'verification.finished'
    | 'work-item.closed'
    | 'work-item.reopened']: PayloadOf<K>;
};

/** Where a work item is, from its events. */
export interface WorkItemState {
  ticket: PayloadOf<'ticket.opened'> | undefined;
  /**
   * Martin's request, when the work item is an improvement he asked for: the line reads it only from his roles, and
   * takes the work item only when he opened it too (`queue.ts`). A request makes it an improvement, whatever else it
   * has.
   */
  request: PayloadOf<'improvement.requested'> | undefined;
  spec: PayloadOf<'spec.written'> | undefined;
  /** The latest pull request pushed, and whether the coder must build again since. */
  pullRequest: PayloadOf<'pull-request.pushed'> | undefined;
  rebuild: { from: Stage; reason: string } | undefined;
  /** The coder's round: 1, and one more each time work returns to Build. */
  round: number;
  /** The scope fence's output on the coder's last patch, when it refused that patch and nothing was pushed since. */
  fenced: string | undefined;
  /** The coder's patches the scope fence has refused, since Martin last answered a hold. */
  fenceRefusals: number;
  /** The gates on the latest push: the commit they started on, and how they ended, once they have. */
  gates: { commit: string; conclusion: 'passed' | 'failed' | undefined; failed: string[] } | undefined;
  /**
   * Whether the gates passed on the latest push, in its latest run that has ended: a run on a newer commit of the
   * push (main merged in) leaves them passed while it runs, and replaces them when it ends.
   */
  gatesPassed: boolean;
  gateReturns: number;
  /** The review of the latest push, if it has one. */
  review: PayloadOf<'review.submitted'> | undefined;
  /** The times an approving review's suggestions sent the work back in this pass, which `LIMITS.suggestions` bounds. */
  suggestionReturns: number;
  /**
   * The coder's answer to the latest review's suggestions, once it has given one: those it declined, each with its
   * reason, which the next reviewer is told. A suggestion answered is not sent to the coder again.
   */
  suggestionsAnswered: PayloadOf<'suggestions.answered'> | undefined;
  /**
   * Whether Martin approved the spec in force, when it carries a risk that always holds it (`ALWAYS_HELD`), or is an
   * improvement's.
   */
  specApproved: boolean;
  /** Whether the spec was written again after the latest push, which the coder has not yet been sent back to meet. */
  respecified: boolean;
  /**
   * Every review of any push, in order: the thread the describer reads. Its length is what `LIMITS.reviews` bounds,
   * and its last is the review a later reviewer checks first.
   */
  reviews: PayloadOf<'review.submitted'>[];
  /** Each time the work went back to Build, in order, and why. */
  returns: { from: Stage; reason: string }[];
  /**
   * Martin's approval of a held review with threads open (`acceptedFindings`), until the line has answered them on the
   * pull request (`review.accepted`), saying he accepted it: his words, unless they stay his, and which of his answers
   * it was, counting from 0 among the work item's `hold.answered` events, so the line says when he gave it.
   */
  accepted: { words: string | undefined; answer: number } | undefined;
  /** Whether the describer has written up the approved change. */
  described: boolean;
  /** The hold in force, if any. */
  hold: PayloadOf<'hold.started'> | undefined;
  /** Martin's answer to the last hold, until the work item moves on from it: what it does, and what he said. */
  answer:
    | {
        cause: HoldCause;
        stage: Stage;
        decision: HoldAnswer;
        resolution: Resolution;
        /** His words, unless they stay his, on a work item a visitor's report opened. */
        text: string | undefined;
      }
    | undefined;
  /**
   * Martin's answers to the holds at Plan, and to those that send the work item back to it, each with what he was
   * asked (the planner's question, why it was held, or what the scope fence printed), for every later step of the
   * planner's: a second question should not forget the first answer.
   */
  answers: Answer[];
  /**
   * Why the work item is back at Plan for another spec, from the hold Martin answered or the return that sent it,
   * until the planner writes one: what the planner is told of why its last spec came back.
   */
  replan: Replan | undefined;
  merged: boolean;
  /**
   * The latest release that carried the change since its merge: how it started, its promotion once it has one, and
   * whether it rolled back, erred or was aborted.
   */
  release:
    | {
        started: PayloadOf<'release.started'>;
        promoted: PayloadOf<'release.promoted'> | undefined;
        ended:
          | { how: 'rolled-back'; by: PayloadOf<'release.rolled-back'>['by'] }
          | { how: 'errored' }
          | { how: 'aborted'; by: PayloadOf<'release.aborted'>['by'] }
          | undefined;
      }
    | undefined;
  /** The latest verification of that release, once it is promoted. */
  verification: PayloadOf<'verification.finished'> | undefined;
  /**
   * Every verification that found the ticket's signal persisting after a release, in every pass: how many since the
   * ticket last reopened is what `LIMITS.persists` bounds, and the planner is told of each.
   */
  persisted: PayloadOf<'verification.finished'>[];
  /** Each time the ticket reopened after it was verified, in order: what came back, which the planner is told. */
  reopened: PayloadOf<'work-item.reopened'>[];
  /** How many of `persisted` came before the last reopening: `LIMITS.persists` bounds those since, a fix's own. */
  persistedBefore: number;
  closed: boolean;
  /** The sense of the ticket's first signal, which looks again at a held or waiting work item. */
  firstSense: SignalSource | undefined;
  /** The versions of the app the ticket's signals were seen on: triage records each sense's first in each version. */
  seenOn: string[];
  /**
   * The latest spec, in any pass: what the work item is about, even back at Plan for another, and what the planner
   * is told it wrote last when the work comes back to it.
   */
  lastSpec: PayloadOf<'spec.written'> | undefined;
  /** The work items it waits on after Plan, the files their specs share with its own, and whether the wait is over. */
  waiting: { on: string[]; files: string[]; ended: boolean } | undefined;
  /** The latest look again under the hold or wait in force, and the release it looked at. */
  rechecked: PayloadOf<'signal.rechecked'> | undefined;
  /** That look, while it cleared and nothing since says the defect is there. */
  cleared: PayloadOf<'signal.rechecked'> | undefined;
}

/** A work item with no events yet. */
const initial = (): WorkItemState => ({
  ticket: undefined,
  request: undefined,
  spec: undefined,
  pullRequest: undefined,
  rebuild: undefined,
  round: 1,
  fenced: undefined,
  fenceRefusals: 0,
  gates: undefined,
  gatesPassed: false,
  gateReturns: 0,
  review: undefined,
  suggestionReturns: 0,
  suggestionsAnswered: undefined,
  specApproved: false,
  respecified: false,
  reviews: [],
  returns: [],
  accepted: undefined,
  described: false,
  hold: undefined,
  answer: undefined,
  answers: [],
  replan: undefined,
  merged: false,
  release: undefined,
  verification: undefined,
  persisted: [],
  reopened: [],
  persistedBefore: 0,
  closed: false,
  firstSense: undefined,
  seenOn: [],
  lastSpec: undefined,
  waiting: undefined,
  rechecked: undefined,
  cleared: undefined,
});

/** A look again stands only under the hold or wait it was made under. */
const forgetLook = (state: WorkItemState) => Object.assign(state, { rechecked: undefined, cleared: undefined });

export function fold(events: readonly LineEvent[]): WorkItemState {
  const state = initial();
  // Martin's answers so far, which `accepted` names its own among.
  let answers = 0;
  for (const event of events) {
    // Anything that moves the work item on is past the answer that moved it.
    if (MOVES_ON.has(event.type)) state.answer = undefined;
    // An improvement's wait on overlapping work has no look to end it: whatever the line does next ends it, as the
    // work it waited on has closed (`decide`).
    if (state.request && state.waiting && !state.waiting.ended && MOVES_ON.has(event.type)) {
      state.waiting = { ...state.waiting, ended: true };
    }
    switch (event.type) {
      case 'ticket.opened':
        state.ticket = event.payload;
        break;
      case 'improvement.requested':
        state.request = event.payload;
        break;
      case 'spec.written':
        state.spec = event.payload;
        state.lastSpec = event.payload;
        state.replan = undefined;
        state.specApproved = false;
        // A hold on the spec before is a hold on what Martin read: his answer to it says nothing of this one, which
        // is held afresh if it needs him. His approval of the old card, appended after, finds no hold, and approves
        // nothing.
        if (state.hold?.cause === 'spec') state.hold = undefined;
        // A new spec is checked against the work in flight again.
        state.waiting = undefined;
        state.respecified = state.pullRequest !== undefined;
        // A new spec is a new scope: what the fence refused under the last one is no part of it, and a review held
        // the change to the old one, so the change is reviewed again against this.
        state.fenced = undefined;
        state.review = undefined;
        break;
      case 'pull-request.pushed':
        state.pullRequest = event.payload;
        state.respecified = false;
        state.rebuild = undefined;
        state.fenced = undefined;
        state.gates = undefined;
        state.gatesPassed = false;
        state.review = undefined;
        state.accepted = undefined;
        break;
      // A run on a newer commit of the same push (main merged into the branch, as to resolve a conflict) replaces the
      // run before once it ends: until then, gates that passed still stand, and the work item waits where it is.
      case 'gates.started':
        state.gates = { commit: event.payload.commit, conclusion: undefined, failed: [] };
        break;
      case 'gates.finished':
        if (state.gates?.commit === event.payload.commit) {
          state.gates = { ...state.gates, conclusion: event.payload.conclusion, failed: event.payload.failed };
          state.gatesPassed = event.payload.conclusion === 'passed';
          // Gates that pass answer the failure that sent the work back, whoever moved the branch: main merged into
          // it, or a check run again. The coder has nothing left to put right.
          if (state.gatesPassed && state.rebuild?.from === 'gates') state.rebuild = undefined;
          // Gates that fail after they passed end the wait for Martin's merge, which GitHub would refuse, whether the
          // hold still stands or he answered it to wait: the failure sends the work back to Build, as on the push's
          // first run. A round recorded with the merge comes before it, and the merge carries the work item on to
          // Release whatever the round said.
          if (!state.gatesPassed && (state.hold?.cause === 'merge' || state.answer?.cause === 'merge')) {
            Object.assign(state, { hold: undefined, answer: undefined });
            forgetLook(state);
          }
        }
        break;
      case 'review.submitted':
        state.review = event.payload;
        state.reviews.push(event.payload);
        state.suggestionsAnswered = undefined;
        state.accepted = undefined;
        break;
      case 'review.accepted':
        state.accepted = undefined;
        break;
      case 'suggestions.answered':
        state.suggestionsAnswered = event.payload;
        // After a push this changes nothing. Alone, the coder declined every suggestion it was sent back for, and
        // changed nothing: the approval it was sent back from stands.
        state.rebuild = undefined;
        break;
      case 'work-item.summarised':
        // Triage writes the first summary; the describer's follows an approving review.
        if (state.review?.verdict === 'approved') state.described = true;
        break;
      case 'work.returned':
        // Work sent back leaves the threads open for the round it goes to.
        state.accepted = undefined;
        if (event.payload.to === 'build') {
          state.rebuild = { from: event.payload.from, reason: event.payload.reason };
          state.respecified = false;
          // A change written up is written up again: the next round is a different change, and its pull request
          // went back to draft with the return, until the describer readies it again.
          state.described = false;
          state.returns.push(state.rebuild);
          state.round += 1;
          if (event.payload.from === 'gates') state.gateReturns += 1;
          if (event.payload.suggestions !== undefined) state.suggestionReturns += 1;
        }
        if (event.payload.to === 'plan') {
          // Martin's answer that sent it back says more of why than the return does.
          state.replan ??= { cause: 'returned', from: event.payload.from, reason: event.payload.reason };
          startAgain(state);
        }
        break;
      case 'hold.started':
        // A hold for a deploy decided as a release started is already answered by it.
        if (event.payload.cause === 'deploy' && state.release && !state.release.ended) break;
        // A canary's hold is of the release in flight that carries the change: one of any other, or one that has
        // ended, holds nothing.
        if (event.payload.cause === 'canary' && !inFlight(state, event.payload.release)) break;
        state.hold = event.payload;
        forgetLook(state);
        break;
      case 'wait.started':
        state.waiting = { on: event.payload.on, files: event.payload.files, ended: false };
        forgetLook(state);
        break;
      case 'signal.received':
        state.firstSense ??= event.payload.sense;
        state.seenOn.push(event.payload.version);
        // Seen since on the version it cleared on, or a later one: the defect is there after all. Triage records a
        // signal late only on the version before the look, which says nothing of it.
        if (state.cleared?.against && !sameVersion(state.cleared.against, event.payload.version)) {
          state.cleared = undefined;
        }
        break;
      case 'signal.rechecked':
        state.rechecked = event.payload;
        if (event.payload.outcome === 'cleared') state.cleared = event.payload;
        else if (event.payload.outcome === 'persists') state.cleared = undefined;
        if (event.payload.for === 'wait' && state.waiting) state.waiting = { ...state.waiting, ended: true };
        break;
      case 'hold.answered': {
        answers += 1;
        if (!state.hold) break;
        const { cause, stage } = state.hold;
        // A canary's hold is answered on the Canary panel, and ends with its release; an answer of the holds', which
        // the admin service refuses, would leave the canary paused with nothing on the line saying so.
        if (cause === 'canary') break;
        const resolution = ANSWERS[cause][event.payload.decision];
        // His words on a work item a visitor's report opened stay his: no agent reads them, as none reads a report,
        // since what an agent writes is public and a paraphrase of a report would pass any redactor. His answer still
        // does what it does.
        const words = event.payload.report ? undefined : event.payload.answer;
        // Approved or answered in words, a scope hold goes back to the planner, which is told what it may not take in.
        const replanScope = cause === 'scope' && resolution === 'replan';
        const reading = replanScope
          ? scopeAnswered(state.hold, event.payload.decision, words)
          : words
            ? { answer: words }
            : undefined;
        // Words settle nothing for triage's holds: the hold stands, and the work item waits as it did.
        if (event.payload.decision === 'answered' && WORDS_LEAVE_HELD.includes(cause)) break;
        if ((stage === 'plan' || resolution === 'replan') && reading) {
          state.answers.push({ ...askedOf(state.hold, state.fenced), ...reading });
        }
        if (resolution === 'replan') {
          // What the reviewer found beyond the ticket, when its escalation is what he answered.
          const beyond = cause === 'beyond-ticket' ? state.review?.findings.filter((f) => f.ticket) : undefined;
          state.replan = {
            cause,
            approved: event.payload.decision === 'approved',
            answered: words !== undefined,
            reason: state.hold.reason,
            ...(state.hold.needs ? { needs: state.hold.needs } : {}),
            ...(cause === 'scope' && state.fenced ? { fenced: state.fenced } : {}),
            ...(beyond?.length ? { beyond } : {}),
          };
        }
        state.hold = undefined;
        forgetLook(state);
        state.answer = {
          cause,
          stage,
          decision: event.payload.decision,
          resolution,
          text: words,
        };
        state.fenceRefusals = 0;
        if (resolution === 'replan') state.spec = undefined;
        if (cause === 'spec' && resolution === 'carry-on') state.specApproved = true;
        if (resolution === 'approve') {
          // His approval overrules the review of the latest push, if there is one, and the review that sent the work
          // back, if one did: the coder has nothing to do. With no review of the spec in force, the reviewer runs. The
          // review's open threads are answered first, as his acceptance.
          const { blocking, suggestions } = acceptedFindings(state);
          if (blocking.length || suggestions.length) state.accepted = { words, answer: answers - 1 };
          if (state.review) state.review = { ...state.review, verdict: 'approved' };
          state.rebuild = undefined;
        }
        break;
      }
      case 'action.refused':
        if (event.payload.mechanism === 'scope-fence') {
          state.fenced = event.payload.output;
          state.fenceRefusals += 1;
        }
        break;
      case 'pull-request.merged':
        state.merged = true;
        // His merge answers whatever held the change before it: the change is in, and goes on to Release.
        state.hold = undefined;
        state.release = undefined;
        state.verification = undefined;
        break;
      // A release before the merge cannot have carried the change.
      case 'release.started':
        if (!state.merged) break;
        state.release = { started: event.payload, promoted: undefined, ended: undefined };
        state.verification = undefined;
        if (state.hold?.cause === 'deploy' || state.hold?.cause === 'canary') state.hold = undefined;
        break;
      // The end of a release other than the latest to carry the change says nothing about it. Its end, however it
      // came, ends a canary's hold.
      case 'release.promoted':
        if (state.release?.started.release === event.payload.release) {
          state.release = { ...state.release, promoted: event.payload };
          endCanaryHold(state);
        }
        break;
      case 'release.rolled-back':
        if (state.release?.started.release === event.payload.release) {
          state.release = { ...state.release, ended: { how: 'rolled-back', by: event.payload.by } };
          endCanaryHold(state);
        }
        break;
      case 'release.aborted':
        if (state.release?.started.release === event.payload.release) {
          state.release = { ...state.release, ended: { how: 'aborted', by: event.payload.by } };
          endCanaryHold(state);
        }
        break;
      case 'release.errored':
        if (state.release?.started.release === event.payload.release) {
          state.release = { ...state.release, ended: { how: 'errored' } };
          endCanaryHold(state);
        }
        break;
      case 'verification.finished':
        state.verification = event.payload;
        if (event.payload.outcome === 'persists') state.persisted.push(event.payload);
        break;
      case 'work-item.closed':
        state.closed = true;
        break;
      // The same defect came back after it was verified: a fresh pass, as after a return to Plan. Nothing that held
      // or answered the closed pass carries over to it.
      case 'work-item.reopened':
        startAgain(state);
        Object.assign(state, { hold: undefined, answer: undefined, closed: false });
        // A ticket a dry run verified comes back with nothing shipped: a first plan again, not a replan of the dry
        // run's spec, whose flag no one moved.
        if (event.payload.dryRun) Object.assign(state, { lastSpec: undefined, replan: undefined });
        else state.replan = { cause: 'reopened' };
        state.reopened.push(event.payload);
        state.persistedBefore = state.persisted.length;
        break;
    }
  }
  return state;
}

/** Whether a release is the one in flight that carries the change: started, and neither promoted nor ended. */
const inFlight = (state: WorkItemState, release: string | undefined) =>
  state.release !== undefined &&
  state.release.started.release === release &&
  !state.release.promoted &&
  !state.release.ended;

/** Ends a hold of a canary paused for Martin: its release has ended. */
function endCanaryHold(state: WorkItemState): void {
  if (state.hold?.cause === 'canary') state.hold = undefined;
}

/**
 * Work sent back to Plan starts a fresh pass: the planner writes a new spec, and the coder's first round opens a new
 * pull request, with its own gates, review, merge and release. Only the ticket or the request, the hold, Martin's
 * answers, the verifications that persisted and the reopenings carry over: the planner should not forget an answer,
 * nor a fix that did not work or did not last. So do the ticket's signals, the last spec, which still says what it is
 * about, and why the work came back.
 */
function startAgain(state: WorkItemState): void {
  const { ticket, request, hold, answer, answers, persisted, reopened, persistedBefore, closed } = state;
  const { firstSense, seenOn, lastSpec, replan } = state;
  Object.assign(state, initial(), { ticket, request, hold, answer, answers, persisted, reopened, persistedBefore });
  Object.assign(state, { closed, firstSense, seenOn, lastSpec, replan });
}

/**
 * One of Martin's answers at Plan, or one that sent the work back to it, as an agent is told it. Only his own words
 * are his: what the line reads into an answer, and what an agent said that he read with it, are told beside them,
 * and no criterion may quote either.
 */
export interface Answer {
  /** What he was asked: the planner's question, why the work item was held, or what the scope fence printed. */
  asked: string;
  /** What an agent said that he read with it: the files the coder needs, and why. */
  said?: string;
  /** His own words, when he wrote any. */
  answer?: string;
  /** What the line reads his answer as, beside his words or in place of them for an approval in none. */
  line?: string;
  /** Whether he approved, rather than answering in words. */
  approved?: true;
}

/** Why the work item is back at Plan: the hold Martin answered, or the return or reopening that sent it there. */
export type Replan =
  | {
      cause: HoldCause;
      /** Whether he approved, rather than answering in words. */
      approved: boolean;
      /** Whether he answered in words the planner is told: not on a work item a visitor's report opened. */
      answered: boolean;
      /** Why the work item was held, as the hold said it. */
      reason: string;
      /** The files the coder named outside the scope, each with why, for a `scope` hold it made. */
      needs?: NonNullable<PayloadOf<'hold.started'>['needs']>;
      /** What the scope fence printed of the coder's last patch, for a `scope` hold the fence made. */
      fenced?: string;
      /** The review's findings that cite the ticket, for a `beyond-ticket` hold. */
      beyond?: PayloadOf<'review.submitted'>['findings'];
    }
  /** Returned from a stage after the merge, as when the signal persisted after the fix was released. */
  | { cause: 'returned'; from: Stage; reason: string }
  /** The ticket reopened: the defect came back after its fix was verified. */
  | { cause: 'reopened' };

/** What the line reads Martin's approval of a hold of the scope fence's as, for the planner. */
const FENCE_APPROVED = 'The coder needed those files: let the scope take them in.';

/**
 * What an answer to a scope hold says, for the planner: his words, if any, and what the line reads into his answer:
 * of a file no scope may name, that it stays out of the scope.
 */
function scopeAnswered(
  hold: PayloadOf<'hold.started'>,
  decision: HoldAnswer,
  words: string | undefined,
): Pick<Answer, 'answer' | 'line' | 'approved'> | undefined {
  const approved = decision === 'approved';
  const his = { ...(words ? { answer: words } : {}), ...(approved ? { approved: true as const } : {}) };
  if (!hold.needs?.some((need) => need.barred)) {
    if (words) return his;
    return approved ? { ...his, line: FENCE_APPROVED } : undefined;
  }
  // His own words never drop what the planner may not do.
  const said = !words && approved ? 'Let the scope take in the files the coder needed that a scope may name. ' : '';
  return { ...his, line: `${said}A file no scope may name stays out of it: if the fix needs one, reject the ticket.` };
}

/**
 * What Martin was asked by a hold, as the planner is told it, and what the coder said of each file it needs, which
 * the planner is told beside it, but may quote no criterion from: an agent's words are not what he asked for.
 */
function askedOf(hold: PayloadOf<'hold.started'>, fenced: string | undefined): { asked: string; said?: string } {
  if (hold.needs) {
    const said = hold.needs.map(
      ({ path, reason, barred }) =>
        `The coder said of ${path}${barred ? ', which no scope may name' : ''}: ${reason.replace(/[.\s]+$/, '')}.`,
    );
    return { asked: hold.reason.endsWith('…') ? hold.reason : `${hold.reason}.`, said: said.join(' ') };
  }
  if (hold.cause === 'scope' && fenced)
    return { asked: `${hold.reason}. The scope fence printed: ${fenced.split('\n').join('; ')}.` };
  return { asked: hold.question ?? hold.reason };
}

const MOVES_ON = new Set<LineEvent['type']>([
  'spec.written',
  'pull-request.pushed',
  'suggestions.answered',
  'wait.started',
  'review.submitted',
  'work-item.summarised',
  'work.returned',
  'hold.started',
  'pull-request.merged',
  'release.started',
  'release.promoted',
  'release.rolled-back',
  'release.aborted',
  'release.errored',
  'verification.finished',
  'work-item.reopened',
]);

/** One thing to do next. */
export type Next =
  /** Open the ticket's issue in the app's repository, as the work item enters Plan. */
  | { do: 'open-issue' }
  /** Run an agent's step in a runner. A coder's later round resumes its own session. */
  | { do: 'step'; agent: LineAgent; round: number }
  /**
   * Send the work back to an earlier stage, with what sent it as figures: the review's blocking findings, an approving
   * review's suggestions, or the required checks that failed. Martin's answer sends it back with none of them.
   */
  | { do: 'return'; from: Stage; to: Stage; reason: string; blocking?: number; suggestions?: number; failed?: string[] }
  /** Hold the work item for Martin. */
  | { do: 'hold'; hold: PayloadOf<'hold.started'> }
  /**
   * Answer the open threads of the latest review (`acceptedFindings`), and of each earlier finding one holds again,
   * saying Martin accepted it in the console, with his words if they are not his alone, and resolve them: his approval
   * of the hold stood in for the reviewer's.
   */
  | { do: 'accept'; review: number; answer: number; words?: string }
  /**
   * Nothing to do until something outside the line happens: the gates, Martin, the release in flight, or the work in
   * flight a spec that overlaps waits on.
   */
  | { do: 'wait'; for: 'gates' | 'martin' | 'release' | 'overlap' }
  /** Wait on the work in flight whose specs share files with this one's, before the coder starts. */
  | { do: 'wait-on'; on: string[]; files: string[] }
  /** Verify the promoted release that carries the change, by the sense that saw the defect. */
  | { do: 'verify'; release: PayloadOf<'release.promoted'> }
  /**
   * Hand a released improvement over to the flag pass: its change is in the app behind its flag, off, and Martin
   * widens it from the console. Its row on the line ends; the work item stays open, for the flag pass to judge.
   */
  | { do: 'hand-over'; release: PayloadOf<'release.promoted'> }
  /**
   * Look again at a work item's signal, by the sense that saw it, at the version the stable Service runs: at a held or
   * waiting one, after a release (`release`), or as the work it waited on ended (`wait`); at a ticket the line has just
   * taken, before Plan (`take`).
   */
  | { do: 'recheck'; for: 'release' | 'wait' | 'take' }
  /**
   * Close the work item as verified, and its issue as completed, saying what cleared it: the verification, Martin's
   * word, with what he said, or a look again that found the defect gone on a release that did not carry its fix,
   * naming the fixes the releases since its signal was last seen carried. Its pull request, if it has one open, closes
   * with it. A ticket that cleared as the line took it has no issue yet, and none is opened.
   */
  | {
      do: 'verified';
      verification: PayloadOf<'verification.finished'> | undefined;
      answer?: string;
      rechecked?: PayloadOf<'signal.rechecked'>;
    }
  /** Close the work item, as Martin answered: before its merge, or after it, at Release or Verify. */
  | { do: 'close'; reason: string; merged: boolean }
  /** The work item is over: it closed. */
  | { do: 'finish' };

/** What the line knows of a work item beside its events: its issue, and how often its step in hand has failed. */
export interface Facts {
  issue: number | null;
  failures: number;
  /** Why the last attempt failed. */
  failure: string | null;
  /**
   * What the work item has spent on models, as the gateway counts it, and the most it may: the gateway refuses its
   * agents' calls from then on, so the line holds it rather than start a step that cannot finish. None, no cap.
   */
  spend?: { spentUsd: number; limitUsd: number };
  /**
   * The work items in flight whose specs share files with this one's, each with the files: given only at the point
   * after Plan where a spec is checked against them. None known, no wait.
   */
  overlaps?: { workItem: string; files: string[] }[];
  /** For each work item it waits on, when it closed, or null while it is open. Not known, it waits on. */
  waitedOn?: Record<string, { closedAt: string } | null>;
  /**
   * The latest real release promoted, which the stable Service runs, and whether a look again at it is still due: no
   * more than the policy's wait after it, or after the hold or wait started, whichever is later; always, for a ticket
   * the line has just taken (`atTake`). None known, no look.
   */
  stable?: Stable;
}

/** The release the stable Service runs, as a look again at a held or waiting work item needs it. */
export interface Stable {
  release: string;
  version: string;
  /** Whether it is soon enough, after the release or the hold or wait, to look. */
  due: boolean;
}

/** The stage a decision puts a work item in, as the line's table records it. */
export type QueueStage = 'plan' | 'build' | 'waiting' | 'gates' | 'review' | 'release' | 'verify' | 'held' | 'ended';

export interface Decision {
  stage: QueueStage;
  next: Next;
}

/** The stage each agent works in. */
export const STAGE_OF: Record<LineAgent, 'plan' | 'build' | 'review'> = {
  planner: 'plan',
  coder: 'build',
  reviewer: 'review',
  describer: 'review',
};

export function decide(events: readonly LineEvent[], facts: Facts): Decision {
  const s = fold(events);
  if (s.closed) return { stage: 'ended', next: { do: 'finish' } };
  if (s.hold) {
    if (!WORDS_LEAVE_HELD.includes(s.hold.cause)) {
      if (s.cleared && closesWhenCleared(s)) {
        return { stage: 'held', next: { do: 'verified', verification: undefined, rechecked: s.cleared } };
      }
      if (lookDue(s, facts.stable)) return { stage: 'held', next: { do: 'recheck', for: 'release' } };
    }
    return { stage: 'held', next: { do: 'wait', for: 'martin' } };
  }
  const answered = s.answer && afterAnswer(s.answer, s.merged);
  if (answered) return answered;
  if (s.merged) return afterMerge(s);

  const step = (agent: LineAgent): Decision => {
    const stage = STAGE_OF[agent];
    if (facts.spend && facts.spend.spentUsd >= facts.spend.limitUsd) {
      const { spentUsd, limitUsd } = facts.spend;
      const reason = `The work item has spent $${spentUsd.toFixed(2)} on models, and may spend $${limitUsd.toFixed(2)}`;
      return {
        stage: 'held',
        next: { do: 'hold', hold: { stage, kind: 'held', cause: 'spend', reason, limitUsd, spentUsd } },
      };
    }
    if (facts.failures >= LIMITS.failures) {
      const why = facts.failure ? `: ${facts.failure}` : '';
      return {
        stage: 'held',
        next: {
          do: 'hold',
          hold: {
            stage,
            kind: 'held',
            cause: 'failures',
            reason: cutTo(`The ${agent} failed ${facts.failures} times${why}`, 300),
          },
        },
      };
    }
    return { stage, next: { do: 'step', agent, round: s.round } };
  };

  if (!s.spec) {
    // Before its issue opens and the planner starts: a ticket whose signal is gone from the stable version, which a
    // release since may have fixed, closes as verified, with nothing spent on it.
    if (atTake(s) && facts.issue === null) {
      if (s.cleared) return { stage: 'plan', next: { do: 'verified', verification: undefined, rechecked: s.cleared } };
      if (lookDue(s, facts.stable)) return { stage: 'plan', next: { do: 'recheck', for: 'take' } };
    }
    if (facts.issue === null) return { stage: 'plan', next: { do: 'open-issue' } };
    return step('planner');
  }
  // Before the coder starts, and before a spec that always needs Martin is held for him: the work item may close as
  // verified on another's fix.
  if (s.waiting) {
    if (s.cleared) return { stage: 'waiting', next: { do: 'verified', verification: undefined, rechecked: s.cleared } };
    if (!s.waiting.ended) {
      const { waitedOn } = facts;
      const over = waitedOn !== undefined && s.waiting.on.every((workItem) => waitedOn[workItem]);
      // An improvement has no signal to look at again: the work it waited on closed, and it goes on.
      if (over && !s.request) return { stage: 'waiting', next: { do: 'recheck', for: 'wait' } };
      if (!over) {
        if (lookDue(s, facts.stable)) return { stage: 'waiting', next: { do: 'recheck', for: 'release' } };
        return { stage: 'waiting', next: { do: 'wait', for: 'overlap' } };
      }
    }
  } else if (!s.pullRequest && !s.rebuild && facts.overlaps?.length) {
    const on = facts.overlaps.map((o) => o.workItem).slice(0, 40);
    const files = [...new Set(facts.overlaps.flatMap((o) => o.files))].slice(0, 40);
    return { stage: 'waiting', next: { do: 'wait-on', on, files } };
  }
  // Every spec of an improvement waits for Martin before any code: it widens what the app does, whatever its risks.
  if (s.request && !s.specApproved) {
    const reason =
      'The spec of an improvement Martin asked for: it waits for his approval before any code is written, in every autonomy mode';
    return { stage: 'held', next: { do: 'hold', hold: { stage: 'plan', kind: 'approval', cause: 'spec', reason } } };
  }
  // The rule holds the specs written under it: the planner's since its criteria named where each comes from. One in
  // the store from before carries on as it was.
  const underRule = s.spec.criteria.some((criterion) => criterion.from !== undefined);
  const held = underRule ? s.spec.risks.filter((risk) => ALWAYS_HELD.includes(risk)) : [];
  if (held.length && !s.specApproved) {
    const reason = `The spec is tagged ${held.join(', ')}: the fix changes behaviour beyond what the ticket is about, which needs Martin in every autonomy mode`;
    return { stage: 'held', next: { do: 'hold', hold: { stage: 'plan', kind: 'approval', cause: 'spec', reason } } };
  }
  // The change was made to the spec before: the coder meets the new one in a round of its own.
  if (s.respecified && !s.rebuild) {
    const reason = 'The planner wrote the spec again: the change is held to the new one';
    return { stage: 'build', next: { do: 'return', from: 'review', to: 'build', reason } };
  }
  if (!s.pullRequest || s.rebuild) {
    if (s.fenceRefusals >= LIMITS.fenceRefusals) {
      return { stage: 'held', next: { do: 'hold', hold: fenceHold(s.fenceRefusals) } };
    }
    return step('coder');
  }
  if (!s.gatesPassed) {
    if (s.gates?.conclusion !== 'failed') return { stage: 'gates', next: { do: 'wait', for: 'gates' } };
    const reason = cutTo(`The gates failed: ${s.gates.failed.join(', ') || 'a check'}`, 200);
    if (s.gateReturns >= LIMITS.gateReturns) {
      return { stage: 'held', next: { do: 'hold', hold: { stage: 'gates', kind: 'held', cause: 'gates', reason } } };
    }
    return { stage: 'build', next: { do: 'return', from: 'gates', to: 'build', reason, failed: s.gates.failed } };
  }
  if (!s.review) return step('reviewer');
  switch (s.review.verdict) {
    case 'escalated': {
      const cause = s.review.findings.some((f) => f.ticket) ? 'beyond-ticket' : 'review';
      return {
        stage: 'held',
        next: { do: 'hold', hold: { stage: 'review', kind: 'held', cause, reason: cutTo(s.review.note, 300) } },
      };
    }
    case 'changes-requested': {
      const reason = cutTo(`Review asked for changes: ${s.review.note}`, 200);
      if (s.reviews.length >= LIMITS.reviews) {
        return {
          stage: 'held',
          next: { do: 'hold', hold: { stage: 'review', kind: 'held', cause: 'review', reason } },
        };
      }
      const blocking = s.review.findings.filter((f) => f.blocking).length;
      return { stage: 'build', next: { do: 'return', from: 'review', to: 'build', reason, blocking } };
    }
    case 'approved': {
      // His approval of a held review answers its open threads before the change goes on, so none stays open.
      if (s.accepted) {
        const { words, answer } = s.accepted;
        return {
          stage: 'review',
          next: { do: 'accept', review: s.reviews.length, answer, ...(words === undefined ? {} : { words }) },
        };
      }
      const suggestions = s.review.findings.filter((f) => !f.blocking).length;
      // His approval stands in for the reviewer's, and sends the change on as it is.
      if (suggestions && suggestionsGoBack(s) && s.answer?.resolution !== 'approve') {
        const reason = `The review approved, with ${suggestions === 1 ? 'a suggestion' : `${suggestions} suggestions`} to take or decline`;
        return { stage: 'build', next: { do: 'return', from: 'review', to: 'build', reason, suggestions } };
      }
      if (!s.described) return step('describer');
      return {
        stage: 'held',
        next: {
          do: 'hold',
          hold: {
            stage: 'review',
            kind: 'approval',
            cause: 'merge',
            reason: s.request
              ? `The improvement in pull request #${s.pullRequest.number} has passed its gates and review, and waits for Martin to merge it, as an improvement does in every mode`
              : `The fix in pull request #${s.pullRequest.number} has passed its gates and review, and waits for Martin to merge it`,
          },
        },
      };
    }
  }
}

/**
 * The findings of the latest review whose threads Martin's approval of its hold answers, so that he resolves none by
 * hand: what it blocked on, and its suggestions, which his approval sends on with no round of their own, less those
 * the coder declined, whose threads it answered already.
 */
export function acceptedFindings(state: WorkItemState): { blocking: Finding[]; suggestions: Finding[] } {
  const findings = state.review?.findings ?? [];
  return {
    blocking: findings.filter((f) => f.blocking),
    suggestions: suggestionsLeft(findings, state.suggestionsAnswered),
  };
}

/**
 * Whether a held work item closes as verified by itself when a look again finds its signal cleared: the line held it
 * because its steps, gates or cap stopped the work, as the fence kept refusing the coder, the gates kept failing, a
 * step kept failing, the spend reached its cap, or the reviewer asked for changes once too often (the latest review
 * asks for changes). Any other hold waits on Martin's judgement, and only says the signal cleared.
 */
export function closesWhenCleared(state: WorkItemState): boolean {
  // An improvement has no defect to clear.
  if (state.request) return false;
  const cause = state.hold?.cause;
  if (cause === 'review') return state.reviews.at(-1)?.verdict === 'changes-requested';
  return cause === 'scope' || cause === 'gates' || cause === 'failures' || cause === 'spend';
}

/**
 * Whether a ticket is where the line looks again at its signal as it takes it: never planned, never sent back to Plan
 * by Verify or Martin, never reopened, held or waiting. One that came back was looked at already, by Verify or triage.
 */
export const atTake = (state: WorkItemState) =>
  state.ticket !== undefined &&
  !state.request &&
  !state.lastSpec &&
  !state.replan &&
  !state.persisted.length &&
  !state.reopened.length &&
  !state.hold &&
  !state.waiting &&
  !state.closed;

/**
 * Whether the sense that saw a held or waiting work item's defect, or that of a ticket the line has just taken, should
 * look again at the release the stable Service runs: one it has not looked at under this hold or wait, or since the
 * take, still due, that does not carry its own fix, by a sense that can look again (not a visitor's report or the
 * planner), and with no signal of the ticket seen on that version, which already says the defect is there.
 */
export function lookDue(state: WorkItemState, stable: Stable | undefined): boolean {
  if (!stable?.due || !state.ticket || state.request) return false;
  // A release of its own fix is in the stable version, or on its way: Verify's to look at, not this.
  if (state.release && !state.release.ended) return false;
  if (!state.firstSense || state.firstSense === 'report' || state.firstSense === 'planner') return false;
  if (state.rechecked?.release === stable.release) return false;
  return !state.seenOn.some((version) => sameVersion(version, stable.version));
}

/** Why a change whose release ended without its promotion waits for Martin again. */
function endedReason(
  change: 'fix' | 'improvement',
  version: string,
  ended: NonNullable<NonNullable<WorkItemState['release']>['ended']>,
): string {
  if (ended.how === 'rolled-back' && ended.by === 'martin')
    return `Martin aborted the release that carried the ${change}, ${version}, which the analysis judged bad, so it rolled back: it waits for the next deploy pull request to carry it, or for his retry`;
  if (ended.how === 'rolled-back')
    return `The release that carried the ${change}, ${version}, rolled back: it waits for the next deploy pull request to carry it, or for Martin to retry it`;
  if (ended.how === 'errored')
    return `The release that carried the ${change}, ${version}, stopped when its analysis could not judge it: it waits for Martin to retry it, or for the next deploy pull request to carry it`;
  const who = ended.by === 'martin' ? 'him' : 'Martin';
  return `${whoAborted(ended.by)} the release that carried the ${change}, ${version}: it waits for ${who} to retry it, or for the next deploy pull request to carry it`;
}

/**
 * Whether an approving review's suggestions would send the work back to the coder: once in a pass, and only before
 * the describer has written the change up.
 */
export const suggestionsGoBack = (s: WorkItemState) => s.suggestionReturns < LIMITS.suggestions && !s.described;

/**
 * Where a merged change is: waiting for a release to carry it, in one, or verified by the sense that saw the defect.
 * A dry run's merge, which no deploy pull request can carry, waits at Release for the dry run's release instead. An
 * improvement, once a release that carries it is promoted, is handed over to the flag pass: no sense saw it.
 */
function afterMerge(s: WorkItemState): Decision {
  const { release } = s;
  const change = s.request ? 'improvement' : 'fix';
  if (!release && (s.pullRequest?.number ?? 0) >= DRY_RUN_NUMBERS_FROM) {
    return { stage: 'release', next: { do: 'wait', for: 'release' } };
  }
  if (!release || release.ended) {
    const reason = release?.ended
      ? endedReason(change, release.started.version, release.ended)
      : `The ${change}${s.pullRequest ? ` in pull request #${s.pullRequest.number}` : ''} is merged, and waits for a deploy pull request to carry it to the app`;
    return {
      stage: 'held',
      next: { do: 'hold', hold: { stage: 'release', kind: 'approval', cause: 'deploy', reason } },
    };
  }
  if (!release.promoted) return { stage: 'release', next: { do: 'wait', for: 'release' } };
  // Handed over at its promotion, for good: a promoted release is over, and the release watch records nothing more of
  // it (`forTarget` in `release/watch.ts`), so it never rolls back, errs or is aborted after this. A later release that
  // takes the change back out is another release; until then the flag is Martin's to turn off.
  if (s.request) return { stage: 'ended', next: { do: 'hand-over', release: release.promoted } };
  const { verification } = s;
  if (!verification) return { stage: 'verify', next: { do: 'verify', release: release.promoted } };
  if (verification.outcome === 'cleared') return { stage: 'verify', next: { do: 'verified', verification } };
  const seen = `${verification.sense ? `The ${verification.sense}` : 'Verify'} still saw “${verification.check}”`;
  const on = `on ${verification.version ?? release.promoted.version}`;
  const persisted = s.persisted.length - s.persistedBefore;
  if (persisted >= LIMITS.persists) {
    const reason = cutTo(`${seen} ${on}, after ${persisted} fixes were released: it needs Martin`, 300);
    return { stage: 'held', next: { do: 'hold', hold: { stage: 'verify', kind: 'held', cause: 'verify', reason } } };
  }
  const reason = cutTo(`${seen} ${on}, the release that carried the fix`, 200);
  return { stage: 'plan', next: { do: 'return', from: 'verify', to: 'plan', reason } };
}

/**
 * What a dry run left on a work item that a line running live must end, or undefined for none, given the work item's
 * issue. A work item whose pull request is the dry run's, merged or not, or whose issue is, has nothing GitHub ever had
 * to carry on from, and closes with no change. A ticket a dry run verified, whose fix never shipped, still has its
 * defect, and reopens. The line asks only of a work item that is not waiting to come back into Plan after a
 * reopening: taking it back forgets a dry run's issue. A
 * work item that already ended either way, that a dry run never touched, or that Martin judged verified, which the
 * line closes as he answered, has nothing left.
 */
export function dryRunLeft(
  events: readonly LineEvent[],
  issue: number | null,
): { end: 'close'; why: 'merge' | 'pull-request' | 'issue' } | { end: 'reopen'; against: string } | undefined {
  const s = fold(events);
  if (!s.closed) {
    if (s.answer?.resolution === 'verified') return undefined;
    if ((s.pullRequest?.number ?? 0) >= DRY_RUN_NUMBERS_FROM) {
      return { end: 'close', why: s.merged ? 'merge' : 'pull-request' };
    }
    return (issue ?? 0) >= DRY_RUN_NUMBERS_FROM ? { end: 'close', why: 'issue' } : undefined;
  }
  const closed = events.findLast((event) => event.type === 'work-item.closed');
  if (closed?.type !== 'work-item.closed' || closed.payload.outcome !== 'verified') return undefined;
  return s.verification?.dryRun ? { end: 'reopen', against: s.verification.against } : undefined;
}

/**
 * The hold for a coder that changed nothing, and said why. After a return, it holds where the work came back from,
 * under that stage's cause: Martin's answer to it means what it means for gates that kept failing, or a review that
 * still blocks. A first round, with no pull request yet, has nothing to have returned: the coder found the code
 * already doing what the spec asks, which questions the spec.
 */
export function unchangedHold(state: WorkItemState, why: string): PayloadOf<'hold.started'> {
  if (!state.rebuild) {
    const reason = cutTo(`The coder found nothing to fix: ${why}`, 300);
    return { stage: 'build', kind: 'held', cause: 'nothing-to-fix', reason };
  }
  const from = state.rebuild.from === 'gates' ? 'gates' : 'review';
  const reason = cutTo(`The coder changed nothing when the work came back from ${from}: ${why}`, 300);
  return { stage: from, kind: 'held', cause: from, reason };
}

/** How many times something happened, in words: once, twice, or the number. */
export const timesOf = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/**
 * The hold for a scope the coder's patches kept straying from: the fence refused it this many times. The planner is
 * told the same, in the same words (`whyBack`).
 */
export function fenceHold(refusals: number): PayloadOf<'hold.started'> {
  const reason = `The scope fence refused the coder’s patch ${timesOf(refusals)}: it changed files outside the spec’s scope`;
  return { stage: 'build', kind: 'held', cause: 'scope', reason };
}

/**
 * The hold for a coder that named files outside the spec's scope it needs to change: `scope`, as when the fence kept
 * refusing its patch, so Martin's approval sends the work back to the planner, told the files, to widen the scope to
 * them. Those no scope may name (`protectedPaths`) are marked `barred`, and said first, so a reason cut to fit still
 * says it: the planner may not widen to them, and rejects the work item if it needs them. Nothing of the round is
 * pushed. Each reason is one line, as the card and the planner's prompt show it.
 */
export function needsHold(
  named: readonly { path: string; reason: string }[],
  protectedPaths: readonly string[],
): PayloadOf<'hold.started'> {
  const needs = named.map(({ path, reason }) => ({
    path,
    reason: reason.replace(/\s+/g, ' ').trim(),
    ...(touches(path, protectedPaths) ? { barred: true as const } : {}),
  }));
  const barred = needs.filter((need) => need.barred).map(({ path }) => path);
  const files = `${needs.length === 1 ? 'a file' : `${needs.length} files`} outside the spec’s scope`;
  const never = barred.length ? `, and no scope may name ${barred.join(', ')}` : '';
  const reason = `The coder needs ${files} to meet its criteria${never}: ${needs.map(({ path }) => path).join(', ')}`;
  return { stage: 'build', kind: 'held', cause: 'scope', reason: cutTo(reason, 300), needs };
}

/** What the line does straight after Martin's answer, or undefined to carry on as the work item's events say. */
function afterAnswer(answer: NonNullable<WorkItemState['answer']>, merged: boolean): Decision | undefined {
  const words = answer.text;
  const said = words ? `: ${words}` : '';
  switch (answer.resolution) {
    case 'verified':
      return {
        stage: 'verify',
        next: { do: 'verified', verification: undefined, ...(words ? { answer: words } : {}) },
      };
    case 'replan':
      // After the merge, the planner's new spec starts a fresh pass: the work goes back to Plan for it.
      if (!merged) return undefined;
      return {
        stage: 'plan',
        next: { do: 'return', from: answer.stage, to: 'plan', reason: cutTo(`Martin sent it back${said}`, 200) },
      };
    case 'close': {
      // Approving closes only a rejection, the planner's or the coder's finding nothing to fix: he agrees with it.
      const agent = answer.cause === 'nothing-to-fix' ? 'coder' : 'planner';
      const why = answer.decision === 'approved' ? `Martin agreed with the ${agent}` : 'Martin rejected it';
      return { stage: 'held', next: { do: 'close', reason: cutTo(`${why}${said}`, 200), merged } };
    }
    case 'wait':
      return { stage: 'held', next: { do: 'wait', for: 'martin' } };
    case 'return':
      // Only from a stage after Build; the rules never ask for more.
      if (STAGES.indexOf(answer.stage) <= STAGES.indexOf('build')) return undefined;
      return {
        stage: 'build',
        next: { do: 'return', from: answer.stage, to: 'build', reason: cutTo(`Martin sent it back${said}`, 200) },
      };
    default:
      return undefined;
  }
}
