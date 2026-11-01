/**
 * Needs you: one card per hold, the line's and triage's, oldest first, with what the hold is, the one piece of
 * evidence that explains it, and each answer it takes beside what that answer does; and under them, Martin's answers
 * today. A visitor reads the same, as Waiting on Martin.
 *
 * What each answer does is the line's own table, `ANSWERS` in the events package, so the two cannot drift; only the
 * words are the console's. An answer that would do nothing is left off (`answersTo`): a fix waiting for Martin's
 * deploy takes only his rejection.
 *
 * A canary paused for Martin (auto-rollback off, judged bad) has one card of its own, drawn from the release's events
 * (`release.ts`'s `judgedBad`), whether or not it carries a work item: Martin's drill releases a change that carries
 * none, which the line holds nothing for. Where it carries some, the line's `canary` hold on each is the same card, not
 * another. Its answers are the Canary panel's own controls, through `/admin/release/*`: no answer of the holds' does
 * anything to it.
 */
import {
  ANSWERS,
  answersTo,
  type HoldAnswer,
  type HoldCause,
  type PayloadOf,
  type PublicEvent,
  type Resolution,
  type Stage,
  WORDS_LEAVE_HELD,
} from '@software-factory/events';
import { GUARDRAIL_HOLDS, IMPROVEMENT_STEP_UP } from '../access.ts';
import { APP_REPO, clock, duration, money, shortVersion, startOfDay } from '../format.ts';
import { deployWords } from './fixing.ts';
import { deployWaitsForMartin, type Hold, type ItemState } from './items.ts';
import { judgedSaid, judgedWords, type Release } from './release.ts';

/** The one piece of evidence that explains a hold: a check's or the fence's own output, a question, or words. */
export type Evidence =
  | { kind: 'output'; heading: string; text: string }
  /** The files a coder needs outside its scope, with why, each marked when no scope may name it. */
  | { kind: 'needs'; heading: string; needs: { path: string; reason: string; barred: boolean }[] }
  | { kind: 'question'; before: string; question: string }
  | { kind: 'words'; text: string }
  /** An improvement's spec: the flag it names, the pages it changes, and how many acceptance criteria it has. */
  | { kind: 'spec'; flag: string | undefined; pages: string[]; criteria: number };

export interface AnswerRow {
  answer: HoldAnswer;
  label: string;
  /** What it does, in a sentence. */
  does: string;
  /** Whether it asks for the passkey again: approving a guardrail's hold, or an improvement's spec. */
  stepUp: boolean;
}

export interface Need {
  workItem: string;
  /** The hold's own id, which an answer names, so the admin service answers this hold or none. */
  hold: string;
  cause: HoldCause;
  /** What the hold is, in Martin's words: "Held by a gate". */
  kicker: string;
  stage: Stage;
  /** How long it has waited: "1d", "50min". */
  waited: string;
  since: number;
  title: string;
  evidence: Evidence;
  /** A link the card offers beside its evidence: the pull request to merge, or the settings to raise a cap. */
  link: { href: string; label: string } | undefined;
  answers: AnswerRow[];
  /** A visitor's report opened the work item, so Martin's words on it stay his: no visitor and no agent reads them. */
  aboutReport: boolean;
  /** Whether it waits for Martin now: every hold but a deploy that is not his to merge yet, which the count leaves out. */
  forMartin: boolean;
}

export interface Answered {
  at: number;
  workItem: string;
  /** How he answered: "Approved", "Answered in words, still held". */
  how: string;
  /** His words, or `kept` when they stay his (a hold about a visitor's report), or none when he gave none. */
  words: string | 'kept' | undefined;
  /** What the answer did, in a few words: "Sent back to the coder." */
  did: string | undefined;
}

/**
 * A canary paused for Martin: the release, judged bad by its analysis with auto-rollback off, and what its card says.
 * Its answers are the release's own controls (`release.ts`'s `controlsOf`).
 */
export interface CanaryNeed {
  release: Release;
  kicker: string;
  /** What the card names on the right: the first work item it carries, or its version when it carries none. */
  label: string;
  /** The work item it opens, if it carries one. */
  workItem: string | undefined;
  title: string;
  waited: string;
  since: number;
  /** The analysis's own words, on the station face. */
  said: string[];
  /** What the analysis judged bad, and by how much. */
  bad: string;
}

export interface NeedsView {
  holds: Need[];
  /** The canary paused for Martin, if one is. */
  canary: CanaryNeed | undefined;
  /** Today's answers, the viewer's own day, newest first. */
  answered: Answered[];
}

const STAGE_NAME: Record<Stage, string> = {
  sense: 'Sense',
  triage: 'Triage',
  plan: 'Plan',
  build: 'Build',
  gates: 'Gates',
  review: 'Review',
  release: 'Release',
  verify: 'Verify',
};

/** The agent that works at a stage, for a question it asks. */
const ASKS: Partial<Record<Stage, string>> = { plan: 'planner', build: 'coder', review: 'reviewer' };

/** The signal that opened a work item, which says who opened it. */
const openerOf = (item: ItemState) =>
  item.events.find((event) => event.type === 'signal.received')?.payload as PayloadOf<'signal.received'> | undefined;

/**
 * What a work item's hold is, in Martin's words: its card's kicker, and the note on its row at a station, so the two
 * say the same thing. Closed over every cause, so a new one does not type-check until it has its words.
 */
export const holdKicker = (item: ItemState, hold: Hold) =>
  kickerOf(hold.cause, hold.stage, openerOf(item)?.sense, item.kind === 'improvement');

function kickerOf(cause: HoldCause, stage: Stage, opener: string | undefined, improvement: boolean): string {
  switch (cause) {
    case 'suggestion':
      return opener === 'planner' ? 'The planner suggests' : 'A visitor suggests';
    case 'finding':
      return 'The planner found';
    case 'burst':
      return 'A burst of problems';
    case 'environment':
      return 'Held for its backends';
    case 'spec':
      return improvement ? 'An improvement’s spec' : 'A spec to approve';
    case 'question':
      return `The ${ASKS[stage] ?? 'line'} asks`;
    case 'ticket-rejected':
      return 'The planner turned it down';
    case 'scope':
      return 'Held to its scope';
    case 'nothing-to-fix':
      return 'The coder found nothing';
    case 'failures':
      return 'A step kept failing';
    case 'gates':
      return 'Held by a gate';
    case 'review':
      return 'Held by review';
    case 'beyond-ticket':
      return 'Beyond its ticket';
    case 'merge':
      return 'Waiting for your merge';
    case 'deploy':
      return 'Waiting for your deploy';
    case 'canary':
      return 'A canary paused for you';
    case 'verify':
      return 'Verify asks you';
    case 'spend':
      return 'At its spend cap';
    case 'tests-first':
      return 'Tests that prove nothing';
    case 'unknown':
      return 'Held';
  }
}

/** What an answer does, by what the line does with it, for the hold's cause. */
function doesOf(cause: HoldCause, answer: HoldAnswer, workItem: string, improvement: boolean): string {
  const resolution: Resolution = ANSWERS[cause][answer];
  if (answer === 'answered' && WORDS_LEAVE_HELD.includes(cause)) {
    return cause === 'suggestion'
      ? 'Kept with the hold. It stays held until you reject it.'
      : 'Kept with the hold. It stays held until you approve or reject it.';
  }
  if (answer === 'rejected') {
    if (cause === 'deploy')
      return `Closes #${workItem}. Its change stays merged, and goes out with the next deploy anyway.`;
    if (cause === 'finding') return 'Dropped. No ticket is opened.';
    if (cause === 'suggestion') return `Closes #${workItem}. Nothing is built.`;
    if (cause === 'burst' || cause === 'environment') {
      return 'Closes it with no tickets. A problem still there is found again.';
    }
    return `Closes #${workItem}${cause === 'question' || cause === 'spec' ? '. Nothing is built.' : ', unmerged.'}`;
  }
  if (answer === 'approved') {
    if (cause === 'finding') return 'Triage opens its ticket, and it goes down the line like any other.';
    if (cause === 'burst' || cause === 'environment') return 'Triage opens a ticket for each problem it holds.';
    if (cause === 'gates') return 'Sends it back to the coder for one more round, past the gates’ limit.';
    if (cause === 'scope') return 'The planner writes the spec again, told the coder needed those files.';
    if (cause === 'spend') return 'The line carries on, and holds again until the cap is raised.';
    if (cause === 'spec' && improvement) {
      return 'The coder starts: tests first, with the flag on and off. Its pull request waits for you too.';
    }
    if (cause === 'spec') return 'The spec goes on to Build as it stands.';
    if (cause === 'question') return 'The line carries on with the spec as it stands.';
  }
  if (answer === 'answered' && cause === 'question') return 'The planner reads your answer, and carries on with it.';
  switch (resolution) {
    case 'carry-on':
      return answer === 'answered'
        ? 'The line carries on from where it was held, with your words.'
        : 'The line carries on from where it was held.';
    case 'replan':
      return answer === 'answered'
        ? 'The planner reads your words and writes the spec again.'
        : 'The planner writes the spec again.';
    case 'approve':
      return 'Stands in for the reviewer’s approval: it goes on to its write-up and your merge.';
    case 'return':
      return 'Sends it back to the coder, with your words as the reason.';
    case 'verified':
      return `Closes #${workItem} as verified: you judge the fix works in production.`;
    case 'close':
      return `Agrees with the ${cause === 'nothing-to-fix' ? 'coder' : 'planner'}, and closes #${workItem}.`;
    case 'wait':
      return 'Changes nothing: it waits as it is.';
  }
}

const LABEL: Record<HoldAnswer, string> = { approved: 'Approve', answered: 'Answer in words', rejected: 'Reject' };

/** What an answer did, in a few words, for Answered today. */
function didOf(cause: HoldCause | undefined, decision: HoldAnswer): string | undefined {
  if (!cause) return undefined;
  if (decision === 'answered' && WORDS_LEAVE_HELD.includes(cause)) return undefined;
  const resolution = ANSWERS[cause][decision];
  if (decision === 'approved' && (cause === 'finding' || cause === 'burst' || cause === 'environment')) {
    return 'Triage opened its tickets.';
  }
  return {
    'carry-on': 'The line carried on.',
    replan: 'Back to the planner.',
    approve: 'On to its write-up.',
    return: 'Sent back to the coder.',
    wait: undefined,
    verified: 'Closed as verified.',
    close: 'Closed.',
  }[resolution];
}

const latest = <K extends PublicEvent['type']>(item: ItemState, type: K) =>
  item.events.findLast((event): event is PublicEvent<K> => event.type === type);

/** A check's output, cut to its first lines: the sheet has the rest. */
const OUTPUT_LINES = 6;
const firstLines = (text: string) => {
  const lines = text.trim().split('\n');
  return lines.length > OUTPUT_LINES ? `${lines.slice(0, OUTPUT_LINES).join('\n')}\n…` : lines.join('\n');
};

/** The one piece of evidence that explains a hold, from the work item's events. */
function evidenceOf(item: ItemState, cause: HoldCause): Evidence {
  const hold = item.hold;
  const reason = hold?.reason ?? '';
  if (cause === 'gates') {
    const failed = item.events.findLast(
      (event): event is PublicEvent<'gate.finished'> =>
        event.type === 'gate.finished' &&
        event.payload.conclusion === 'failure' &&
        event.payload.required &&
        event.payload.pullRequest === item.pullRequest,
    );
    if (failed) {
      const text = firstLines(failed.payload.output ?? failed.payload.summary ?? reason);
      return { kind: 'output', heading: `${failed.payload.check} · PR #${failed.payload.pullRequest}`, text };
    }
  }
  // The coder said which files it needs, and why: the fence refused nothing. The hold's reason heads them, saying
  // first any no scope may name, and each of those is marked too, since a reason cut to fit may not reach them all.
  // Every one is shown, never cut: approving sends them all to the planner.
  if (cause === 'scope' && hold?.needs) {
    const needs = hold.needs.map(({ path, reason, barred }) => ({ path, reason, barred: barred === true }));
    return { kind: 'needs', heading: reason, needs };
  }
  if (cause === 'scope') {
    const refused = item.events.findLast(
      (event): event is PublicEvent<'action.refused'> =>
        event.type === 'action.refused' && event.payload.mechanism === 'scope-fence',
    );
    if (refused) return { kind: 'output', heading: 'scope fence', text: firstLines(refused.payload.output) };
  }
  if (hold?.question) return { kind: 'question', before: reason, question: hold.question };
  if (cause === 'spend' && hold?.limitUsd !== undefined) {
    const spent = hold.spentUsd === undefined ? '' : `It had spent ${money(hold.spentUsd)} `;
    return {
      kind: 'words',
      text: `${spent}${spent ? 'of' : 'It reached'} its ${money(hold.limitUsd)} cap on models. Raising a work item’s cap past what it has spent carries it on.`,
    };
  }
  if (cause === 'deploy') return { kind: 'words', text: deployEvidence(item) };
  // The planner's latest spec, which the line holds: no other's counts.
  const spec =
    item.kind === 'improvement' && cause === 'spec'
      ? item.events.findLast(
          (event): event is PublicEvent<'spec.written'> => event.type === 'spec.written' && event.actor === 'planner',
        )
      : undefined;
  if (spec) {
    const { flag, pages = [], criteria } = spec.payload;
    return { kind: 'spec', flag, pages, criteria: criteria.length };
  }
  return { kind: 'words', text: reason };
}

/**
 * What a fix held for a deploy waits for, from the deploy pull request that carries it as the line last recorded it:
 * none yet, while its image is built and signed; its checks running or failed; passed, when merging it is Martin's;
 * merged, until Argo CD syncs; or closed unmerged, for the next build's. After a release that carried it was stopped,
 * the hold's own reason, which names his retry.
 */
function deployEvidence(item: ItemState): string {
  const merged = latest(item, 'pull-request.merged');
  const at = `Merged${merged ? ` at ${clock(Date.parse(merged.ts))}` : ''}.`;
  if (!item.deploy && item.releaseStopped) return item.hold?.reason ?? at;
  return `${at} ${deployWords(item.deploy).evidence}`;
}

/** The pull request a merge or a deploy waits for, on GitHub; the settings for a spend cap. */
function linkOf(item: ItemState, cause: HoldCause): Need['link'] {
  if (cause === 'merge' && item.pullRequest !== undefined) {
    return { href: `${APP_REPO}/pull/${item.pullRequest}`, label: `Merge #${item.pullRequest} on GitHub` };
  }
  if (cause === 'deploy' && item.deploy) {
    const n = item.deploy.pullRequest;
    return { href: `${APP_REPO}/pull/${n}`, label: `Deploy #${n} on GitHub` };
  }
  if (cause === 'spend') return { href: '?view=settings', label: 'Raise the cap in the settings' };
  return undefined;
}

/** Whole units: "1d", "50min", the first part of a duration. */
/** How long something has waited, to its largest unit: "1d", "50min". */
export const waited = (ms: number) => duration(Math.max(1000, ms)).split(/\s/)[0] ?? '';

/** The card of a canary paused for Martin: the release in flight, when its analysis judged it bad. */
export function canaryNeed(flight: Release | undefined, t: number): CanaryNeed | undefined {
  const judged = flight?.judgedBad;
  if (!flight || !judged) return undefined;
  const first = flight.items[0];
  const more = flight.items.length > 1 ? ` and ${flight.items.length - 1} more` : '';
  return {
    release: flight,
    kicker: 'A canary paused for you',
    label: first ? `#${first.number}` : shortVersion(flight.version),
    workItem: first?.number,
    title: first ? `${first.title}${more}` : `${shortVersion(flight.version)}, which carries no work item`,
    waited: waited(t - judged.at),
    since: judged.at,
    said: judgedSaid(judged),
    bad: judgedWords(judged),
  };
}

/**
 * Needs you at t: every open hold, oldest first, the canary paused for Martin among them, and his answers since the
 * viewer's day began. `flight` is the release in flight, if one is.
 */
export function needsView(items: readonly ItemState[], t: number, flight?: Release): NeedsView {
  const holds = items
    .flatMap((item): Need[] => {
      const hold = item.hold;
      // A canary's hold is the release's card, drawn from its events once, not one per work item it carries.
      if (!hold || item.closedAt !== undefined || hold.cause === 'canary') return [];
      const opener = openerOf(item);
      const guardrail = (GUARDRAIL_HOLDS as readonly HoldCause[]).includes(hold.cause);
      // Approving an improvement's spec sets the line building something new, so it asks for the passkey too, by the
      // work item's kind, as the admin service decides.
      const improvement = item.kind === 'improvement';
      const keyed =
        guardrail || (hold.cause === 'spec' && improvement && IMPROVEMENT_STEP_UP['hold.approve-improvement-spec']);
      // A deploy waits for Martin from when its pull request's checks passed, as the line's gauge counts it.
      const since = hold.cause === 'deploy' && item.deploy?.state === 'passed' ? item.deploy.at : hold.since;
      return [
        {
          workItem: item.number,
          hold: hold.id,
          cause: hold.cause,
          kicker:
            hold.cause === 'deploy' && !deployWaitsForMartin(item)
              ? deployWords(item.deploy).kicker
              : holdKicker(item, hold),
          stage: hold.stage,
          waited: waited(t - since),
          since,
          title: item.title,
          evidence: evidenceOf(item, hold.cause),
          link: linkOf(item, hold.cause),
          answers: answersTo(hold.cause).map((answer) => ({
            answer,
            label: LABEL[answer],
            does:
              answer === 'approved' && hold.needs?.some((n) => n.barred)
                ? 'The planner writes the spec again, told to take in the files a scope may name, or reject it.'
                : doesOf(hold.cause, answer, item.number, improvement),
            stepUp: answer === 'approved' && keyed,
          })),
          aboutReport: opener?.sense === 'report',
          forMartin: hold.cause !== 'deploy' || deployWaitsForMartin(item),
        },
      ];
    })
    .sort((a, b) => a.since - b.since);

  const from = startOfDay(t);
  const answered: Answered[] = [];
  for (const item of items) {
    let cause: HoldCause | undefined;
    for (const event of item.events) {
      if (event.type === 'hold.started') cause = event.payload.cause;
      if (event.type !== 'hold.answered') continue;
      const at = Date.parse(event.ts);
      if (at < from || at > t) continue;
      const { decision, answer, report } = event.payload;
      const kept = decision === 'answered' && cause !== undefined && WORDS_LEAVE_HELD.includes(cause);
      const how = { approved: 'Approved', rejected: 'Rejected', answered: 'Answered in words' }[decision];
      answered.push({
        at,
        workItem: item.number,
        how: kept ? `${how}, still held` : how,
        words: answer ?? (report && decision === 'answered' ? 'kept' : undefined),
        did: didOf(cause, decision),
      });
    }
  }
  answered.sort((a, b) => b.at - a.at);
  return { holds, canary: canaryNeed(flight, t), answered };
}

export const stageName = (stage: Stage) => STAGE_NAME[stage];
