/**
 * Each work item's state at a time t, folded from its events. Everything else the console shows is derived from
 * these states and the events behind them.
 */
import type {
  Category,
  Evidence,
  HoldCause,
  Kind,
  PayloadOf,
  PublicEvent,
  Screenshot,
  Stage,
} from '@software-factory/events';
import { clearedOnWords, SENSES, STAGES, sameVersion, WORDS_LEAVE_HELD } from '@software-factory/events';
import { shortVersion } from '../format.ts';
import { flagWaits } from './flags.ts';
import type { StoppedBy } from './release.ts';

/**
 * How a work item stands. Besides the line's own: `waiting`, a ticket or an improvement Martin asked for, queued for
 * the planner, with nothing being done to it yet; `waits-on-work`, a spec queued before Build while work in flight
 * whose spec shares its files is verified or closed; `merged`, a fix Martin merged, queued at Release for a release to
 * take it; `deploying`, a fix Martin merged, held for a deploy whose pull request is not his to merge yet (not open,
 * its checks running or failed, or already merged); `quarantined`, a report that gave orders to the system;
 * `no-ticket`, a report that described nothing wrong.
 */
export type Outcome =
  | 'verified'
  | 'rolled-back'
  | 'closed'
  | 'quarantined'
  | 'no-ticket'
  | 'turned-off'
  | 'held'
  | 'needs-you'
  | 'waiting'
  | 'waits-on-work'
  | 'merged'
  | 'deploying'
  | 'in-progress';

export interface Hold {
  /** Its `hold.started` event's id, which an answer to it names. */
  id: string;
  stage: Stage;
  kind: 'approval' | 'question' | 'held';
  /** Why the line holds it, which decides the picture the card draws for it. */
  cause: HoldCause;
  reason: string;
  /** A spend hold's cap, and what the work item had spent when it reached it. */
  limitUsd: number | undefined;
  spentUsd: number | undefined;
  question: string | undefined;
  /** A scope hold the coder asked for: each file outside the spec's scope it needs, and why. */
  needs: { path: string; reason: string; barred?: true | undefined }[] | undefined;
  since: number;
}

interface Visit {
  /** When the item last came into the stage. */
  enteredAt: number;
  /** When it last left the stage for a later one, or closed in it, if it has. Not set by being sent back. */
  leftAt: number | undefined;
}

/** A screenshot, and what it shows in the item's story. */
export interface Capture {
  shot: Screenshot;
  at: number;
  /**
   * before: the app before the change; broken: the problem; fixed or after: the change, live; canary: on the
   * canary; page: the page a visitor reported on.
   */
  side: 'before' | 'broken' | 'fixed' | 'after' | 'canary' | 'page';
}

export interface ItemState {
  number: string;
  kind: Kind;
  sample: boolean;
  openedBy: PublicEvent['actor'];
  openedAt: number;
  /** The last event's time, at or before t. */
  lastAt: number;
  title: string;
  description: string | undefined;
  story: string | undefined;
  category: Category;
  /** Every event of the item at or before t, in order. */
  events: PublicEvent[];
  /** The stage the item is in, or was in when it closed. Null before it reaches the line. */
  stage: Stage | null;
  /** The first stage it reached: stages before it were skipped. */
  entry: Stage | null;
  visits: Partial<Record<Stage, Visit>>;
  hold: Hold | undefined;
  outcome: Outcome;
  closedAt: number | undefined;
  /** A failure that nothing has followed yet: no retry, return, hold or close. */
  failure: { stage: Stage; at: number } | undefined;
  /** The last thing that happened in each stage, for the stage panels. */
  latest: Partial<Record<Stage, PublicEvent>>;
  dependency: PayloadOf<'work-item.opened'>['dependency'];
  pullRequest: number | undefined;
  /**
   * Versions: the one it broke (an injection) or replaced, the one it shipped, and whether that was rolled back, or
   * stopped, and by what.
   */
  versions: {
    from: string | undefined;
    to: string | undefined;
    rolledBack: boolean;
    stopped: StoppedBy | undefined;
    live: boolean;
  };
  /** A release still on its canary, at this share of traffic. */
  canary: { version: string; weight: number } | undefined;
  captures: Capture[];
  evidence: { signal: Evidence | undefined; verified: Evidence | undefined };
  spend: number;
  /**
   * Agents' steps that called a model, and Jev's judgements, so that none at all can be said as such. A step is one
   * `model.called` however many calls it made: the sheet counts the calls.
   */
  calls: number;
  /** The ticket triage opened, if it has. */
  ticket: PayloadOf<'ticket.opened'> | undefined;
  /** Martin's request, for an improvement he asked for with the "+": his words, when, and whether with his passkey. */
  request: (PayloadOf<'improvement.requested'> & { at: number }) | undefined;
  /**
   * Work queued at a stage that has not taken it: a ticket waiting for the planner, its last step the ticket, or an
   * improvement, its last step Martin's request; or a merged fix waiting for a release, its last step the merge.
   */
  queued: boolean;
  /** The app's version when a sense first saw the problem. */
  seenOn: string | undefined;
  /** The page a visitor's report came from, at its path only. */
  reportPage: string | undefined;
  /** When it was last sent back, while it has not moved on since: to another stage, a hold or its close. */
  sentBack: number | undefined;
  /** While a verified ticket is open again: when, and what the sense saw, on which version. */
  reopened: (PayloadOf<'work-item.reopened'> & { at: number }) | undefined;
  /** While its spec waits for work in flight whose spec shares its files: which, and the files. */
  waitingOn: PayloadOf<'wait.started'> | undefined;
  /**
   * A look again under its hold that found the signal cleared, on a release that did not carry its fix, while nothing
   * since says the defect is back.
   */
  cleared: PayloadOf<'signal.rechecked'> | undefined;
  /**
   * While it is held for a deploy: the deploy pull request that carries it, as the line last recorded it under that
   * hold, and when. None before the App opens one.
   */
  deploy: (PayloadOf<'deploy.changed'> & { at: number }) | undefined;
  /**
   * The release that carried its latest merge rolled back, or was stopped, by Martin, the line or an error, and none has
   * started since: Martin may retry it.
   */
  releaseStopped: boolean;
}

const REFUSED_AT: Record<PayloadOf<'action.refused'>['mechanism'], Stage | null> = {
  'scope-fence': 'build',
  'github-guard': 'build',
  'token-permission': 'build',
  'egress-policy': 'build',
  ruleset: 'build',
  'review-gate': 'gates',
  'admission-control': 'release',
  'typed-judgement': 'triage',
  gateway: null,
};

/** Admission control refusing a runner's step: the only admission refusal the line puts on a work item. */
const runnersStep = ({ mechanism, subject }: PayloadOf<'action.refused'>) =>
  mechanism === 'admission-control' && subject?.namespace === 'runners' && subject.kind === 'Job';

/** The stage an event moves its item to, if any. */
export function stageOf(event: PublicEvent): Stage | null {
  switch (event.type) {
    case 'signal.received':
      return 'sense';
    case 'judgement.made':
    case 'ticket.opened':
      return 'triage';
    case 'spec.written':
      return 'plan';
    // A spec that overlaps work in flight waits before Build.
    case 'wait.started':
      return 'build';
    case 'pull-request.pushed':
      // Dependabot's pull requests are built outside the factory: they reach the line at Gates.
      return event.actor === 'dependabot' ? null : 'build';
    case 'gates.started':
    case 'gate.finished':
    case 'gates.finished':
      return 'gates';
    case 'review.submitted':
      return 'review';
    // A merge leaves Review: the fix waits at Release for a release to take it.
    case 'pull-request.merged':
      return 'release';
    case 'release.started':
    case 'canary.stepped':
    case 'release.rolled-back':
    case 'release.errored':
    case 'release.aborted':
      return 'release';
    // The line moves the work a release carries to Verify as it promotes, and records nothing more until a sense has
    // looked, which can take the log watcher half an hour.
    case 'release.promoted':
    case 'verification.finished':
      return 'verify';
    // A verified ticket whose defect came back goes back to Plan, for a fresh pass.
    case 'work-item.reopened':
      return 'plan';
    case 'work.returned':
      return event.payload.to;
    case 'hold.started':
      return event.payload.stage;
    // Where each mechanism stands on the line. The gateway refuses a call from whichever stage its work item is at, and
    // admission control a runner's step Job (in `runners`) from whichever stage started it, so their refusals leave the
    // item there (`foldItem` fails it at that stage).
    case 'action.refused':
      return runnersStep(event.payload) ? null : REFUSED_AT[event.payload.mechanism];
    case 'model.called':
      return {
        planner: 'plan',
        coder: 'build',
        reviewer: 'review',
        describer: 'review',
        'red-team': 'build',
        triage: 'triage',
      }[event.payload.agent] as Stage;
    default:
      return null;
  }
}

/** A work item's events of one type, in order. */
export const ofType = <K extends PublicEvent['type']>(item: ItemState, type: K) =>
  item.events.filter((event): event is PublicEvent<K> => event.type === type);

/** The events that end a release without shipping it: a rollback, an analysis error, or an abort. */
const STOPS = ['release.rolled-back', 'release.errored', 'release.aborted'] as const;
/** The events that end a release: a promotion, or one that stops it. */
const ENDS = ['release.promoted', ...STOPS] as const;
export type ReleaseStop = PublicEvent<(typeof STOPS)[number]>;
type ReleaseEnd = PublicEvent<(typeof ENDS)[number]>;

/** Whether an event ends its release without shipping it. */
export const stopsRelease = (event: PublicEvent): event is ReleaseStop =>
  (STOPS as readonly string[]).includes(event.type);

/** Whether an event ends its release, however it ended. */
export const endsRelease = (event: PublicEvent): event is ReleaseEnd =>
  (ENDS as readonly string[]).includes(event.type);

const isFailure = (event: PublicEvent) =>
  (event.type === 'gates.finished' && event.payload.conclusion === 'failed') ||
  event.type === 'action.refused' ||
  event.type === 'release.rolled-back';

const DEFAULT_CATEGORY: Record<Kind, Category> = {
  'defect-fix': 'functional',
  'injected-defect': 'functional',
  improvement: 'improvement',
  'dependency-update': 'dependency',
  'red-team': 'red-team',
  'visitor-report': 'not-a-defect',
  'planner-finding': 'improvement',
};

/**
 * A summary of triage's without the fixed words that once ended it with where the work item stood then, which its
 * later events overtake. Summaries no longer say it, and the sheet ends the story from what it projects; those
 * already in the store keep it, and triage's are fixed words, so they go exactly. The describer's own words cannot.
 */
function withoutStanding(summary: PayloadOf<'work-item.summarised'>): PayloadOf<'work-item.summarised'> {
  return {
    title: summary.title,
    description: summary.description
      .replace(/, which waits for the planner\.$/, '.')
      .replace(
        /, so it waits for a sense to see it, or for Martin\.$/,
        ', so triage held it for a sense to see it, or for Martin.',
      ),
    story: summary.story.replace(/ (?:Nothing has been fixed yet: the ticket waits at Plan|It waits at Plan)\.$/, ''),
  };
}

/** What moves a work item on, as the line's fold reads it (`MOVES_ON` in its machine): it ends an improvement's wait. */
const ENDS_A_WAIT = new Set<PublicEvent['type']>([
  'spec.written',
  'pull-request.pushed',
  'suggestions.answered',
  'review.submitted',
  'work-item.summarised',
  'work.returned',
  'hold.started',
  'pull-request.merged',
  'release.started',
  ...ENDS,
  'verification.finished',
  'work-item.reopened',
]);

/** The outcome each way of closing gives. */
const CLOSED: Record<PayloadOf<'work-item.closed'>['outcome'], Outcome> = {
  verified: 'verified',
  'rolled-back': 'rolled-back',
  'no-change': 'closed',
  quarantined: 'quarantined',
  discarded: 'no-ticket',
  'turned-off': 'turned-off',
};

/** Folds one work item's events (all at or before t, in order) into its state. */
export function foldItem(events: readonly PublicEvent[]): ItemState | undefined {
  const opened = events.find((event): event is PublicEvent<'work-item.opened'> => event.type === 'work-item.opened');
  if (!opened?.work_item) return undefined;
  const at = (event: PublicEvent) => Date.parse(event.ts);
  const state: ItemState = {
    number: opened.work_item,
    kind: opened.payload.kind,
    sample: opened.payload.sample,
    openedBy: opened.actor,
    openedAt: at(opened),
    lastAt: at(opened),
    title: opened.payload.title,
    description: undefined,
    story: undefined,
    category: opened.payload.category ?? DEFAULT_CATEGORY[opened.payload.kind],
    events: [...events],
    stage: null,
    entry: null,
    visits: {},
    hold: undefined,
    outcome: 'in-progress',
    closedAt: undefined,
    failure: undefined,
    latest: {},
    dependency: opened.payload.dependency,
    pullRequest: undefined,
    versions: { from: undefined, to: undefined, rolledBack: false, stopped: undefined, live: false },
    canary: undefined,
    captures: [],
    evidence: { signal: undefined, verified: undefined },
    spend: 0,
    calls: 0,
    ticket: undefined,
    request: undefined,
    queued: false,
    seenOn: undefined,
    reportPage: undefined,
    sentBack: undefined,
    reopened: undefined,
    waitingOn: undefined,
    cleared: undefined,
    deploy: undefined,
    releaseStopped: false,
  };
  /** Moves the item into a stage: leaving the one it was in, if this is further along the line. */
  const enter = (stage: Stage, time: number) => {
    if (!state.entry) state.entry = stage;
    if (stage === state.stage) return;
    const previous = state.stage;
    // Moving on is leaving a stage behind, done. Being sent back is not: the sender has not passed it.
    const forward = previous && STAGES.indexOf(stage) > STAGES.indexOf(previous);
    if (previous && forward && state.visits[previous]) {
      state.visits[previous] = { ...state.visits[previous], leftAt: time };
    }
    state.visits[stage] = { enteredAt: time, leftAt: undefined };
    state.stage = stage;
  };
  /** The latest release to carry the item. */
  let release: string | undefined;
  /**
   * The gates of the latest push: the commit of their latest run, and whether they passed in the latest run that
   * ended. Once they have, a run on a newer commit of the same push (main merged into the branch, as to resolve a
   * conflict) does not take the work item back to Gates while it runs, or if it passes, as the line does not: it stays
   * where it waits, for the review or the merge. If it fails, it does, and ends a wait for the merge GitHub would
   * refuse.
   */
  const gates: { commit: string | undefined; passed: boolean } = { commit: undefined, passed: false };
  /** Whether the work went back to Build and the coder has not pushed since: gates then leave it at Build. */
  let rebuilding = false;
  /** Whether the change has merged since the work item last went back to Plan: a release before it carries nothing. */
  let merged = false;
  for (const event of events) {
    // A look of a canary's background analysis lands every minute and changes nothing of the work item's: its time is
    // not the work item's latest.
    if (event.type === 'canary.measuring') continue;
    const time = at(event);
    state.lastAt = time;
    // An improvement has no signal to look at again, so no look ends its wait on overlapping work: whatever the line
    // does next ends it, as the line's own fold reads it.
    if (state.request && state.waitingOn && ENDS_A_WAIT.has(event.type)) {
      state.waitingOn = undefined;
      state.queued = false;
    }
    // Once there is a ticket, another sense's signal or a report that repeats it adds evidence: it does not take
    // the ticket back up the line.
    const joining = state.ticket && (event.type === 'signal.received' || event.type === 'judgement.made');
    // A step or end of a release other than the latest to carry the item says nothing about it.
    const stale = (event.type === 'canary.stepped' || endsRelease(event)) && event.payload.release !== release;
    if (stale) continue;
    const passedBefore = gates.passed;
    // A new push, or a fresh pass, starts its gates afresh, as the line's `fold` does.
    if (
      event.type === 'pull-request.pushed' ||
      event.type === 'work-item.reopened' ||
      (event.type === 'work.returned' && event.payload.to === 'plan')
    ) {
      Object.assign(gates, { commit: undefined, passed: false });
    }
    if (event.type === 'pull-request.pushed') rebuilding = false;
    if (event.type === 'work.returned') rebuilding = event.payload.to === 'build';
    if (event.type === 'gates.started') gates.commit = event.payload.commit;
    const failed =
      event.type === 'gates.finished' && event.payload.commit === gates.commit && event.payload.conclusion === 'failed';
    if (event.type === 'gates.finished' && event.payload.commit === gates.commit) {
      gates.passed = event.payload.conclusion === 'passed';
    }
    if (failed && state.hold?.cause === 'merge') state.hold = undefined;
    const rerun =
      passedBefore &&
      (!failed || rebuilding) &&
      (event.type === 'gates.started' || event.type === 'gate.finished' || event.type === 'gates.finished');
    // The gateway's refusal, and admission control's of a runner's step, fail the item at whichever stage it is at,
    // where every other refusal fails it at its mechanism's stage.
    const stage = joining || rerun ? null : (stageOf(event) ?? (event.type === 'action.refused' ? state.stage : null));
    if (stage) {
      if (stage !== state.stage) state.sentBack = undefined;
      enter(stage, time);
      state.latest[stage] = event;
      state.queued = false;
      if (event.type !== 'model.called') state.failure = isFailure(event) ? { stage, at: time } : undefined;
    }

    switch (event.type) {
      case 'work-item.summarised': {
        const { title, description, story } = event.actor === 'triage' ? withoutStanding(event.payload) : event.payload;
        state.title = title;
        state.description = description;
        state.story = story;
        break;
      }
      case 'improvement.requested':
        // Martin's request waits at Plan, behind every open ticket, until the planner takes it.
        state.request = { ...event.payload, at: time };
        enter('plan', time);
        state.latest.plan = event;
        state.queued = true;
        break;
      case 'spec.written':
        // Only the planner's spec counts, as the line and the admin service read only the line's own.
        if (event.actor !== 'planner') break;
        // An improvement's spec names its title, in place of the one made from Martin's words.
        if (event.payload.title && state.kind === 'improvement') state.title = event.payload.title;
        // A spec written again replaces the one held for Martin: his answer to the old card would answer nothing, as
        // the admin service refuses it, and the line holds the new one afresh if it needs him.
        if (state.hold?.cause === 'spec') state.hold = undefined;
        break;
      case 'ticket.opened':
        state.category = event.payload.category;
        state.ticket = event.payload;
        if (!state.description) state.title = event.payload.title;
        // A ticket has left Triage: it sits at Plan, waiting for the planner, until something happens there.
        enter('plan', time);
        state.latest.plan = event;
        state.queued = true;
        break;
      case 'defect.injected':
        state.versions.from = event.payload.version;
        state.versions.live = true;
        break;
      case 'signal.received':
        // A signal on any version but the one before the look says the defect is there after all.
        if (state.cleared?.against && !sameVersion(state.cleared.against, event.payload.version)) {
          state.cleared = undefined;
        }
        state.evidence.signal ??= event.payload.evidence?.[0];
        state.seenOn ??= event.payload.version;
        if (event.payload.report) state.reportPage ??= event.payload.report.page;
        break;
      case 'pull-request.pushed':
        state.pullRequest = event.payload.number;
        break;
      case 'work.returned':
        state.sentBack = time;
        // Back to Plan, the work comes round again to a release of its own.
        if (event.payload.to === 'plan') {
          merged = false;
          release = undefined;
          state.canary = undefined;
          state.releaseStopped = false;
        }
        break;
      case 'pull-request.merged':
        merged = true;
        release = undefined;
        state.releaseStopped = false;
        // The merge is Martin's answer to a wait for it: the line writes no other.
        state.hold = undefined;
        // And it leaves Review, even when a round recorded with it, which failed after the gates had passed, took the
        // work item back to Gates first.
        if (state.visits.review && state.visits.review.leftAt === undefined) {
          state.visits.review = { ...state.visits.review, leftAt: time };
        }
        state.queued = true;
        break;
      case 'wait.started':
        state.waitingOn = event.payload;
        state.queued = true;
        state.cleared = undefined;
        break;
      case 'signal.rechecked':
        if (event.payload.outcome === 'cleared') state.cleared = event.payload;
        else if (event.payload.outcome === 'persists') state.cleared = undefined;
        // At the end of a wait, a signal still there sends the work on to Build: no longer queued for anything.
        if (event.payload.for === 'wait') {
          state.waitingOn = undefined;
          state.queued = false;
        }
        break;
      case 'hold.started':
        // A hold for a deploy decided as a release that carries the fix started is already answered by it, as the line
        // and the admin service read it: a merged fix's release in flight, not rolled back, aborted or stopped.
        if (
          event.payload.cause === 'deploy' &&
          merged &&
          release !== undefined &&
          !state.versions.rolledBack &&
          state.versions.stopped === undefined
        ) {
          break;
        }
        // A canary's hold is of the release in flight that carries the item, as the line reads it: one of any other,
        // or one that has ended, holds nothing.
        if (event.payload.cause === 'canary' && (event.payload.release !== release || !state.canary)) break;
        state.sentBack = undefined;
        state.cleared = undefined;
        // A hold that starts again waits for a deploy pull request of its own.
        state.deploy = undefined;
        state.hold = {
          id: event.id,
          stage: event.payload.stage,
          kind: event.payload.kind,
          cause: event.payload.cause,
          reason: event.payload.reason,
          limitUsd: event.payload.limitUsd,
          spentUsd: event.payload.spentUsd,
          question: event.payload.question,
          needs: event.payload.needs,
          since: time,
        };
        break;
      case 'deploy.changed':
        state.deploy = { ...event.payload, at: time };
        break;
      case 'hold.answered':
        // A canary's hold is answered on the Canary panel and ends with its release, as the line reads it: an answer
        // of the holds' settles nothing.
        if (state.hold?.cause === 'canary') break;
        // Words settle nothing for a hold of triage's, as the line reads them: it still waits for Martin.
        if (event.payload.decision === 'answered' && state.hold && WORDS_LEAVE_HELD.includes(state.hold.cause)) break;
        state.hold = undefined;
        state.cleared = undefined;
        break;
      case 'release.started':
        // A release that carries the fix is the answer to its wait for a deploy, as the line reads it, and a new one ends
        // a canary's hold of the last.
        if (state.hold?.cause === 'deploy' || state.hold?.cause === 'canary') state.hold = undefined;
        state.deploy = undefined;
        state.releaseStopped = false;
        release = event.payload.release;
        state.versions.from ??= event.payload.previous;
        state.versions.to = event.payload.version;
        state.versions.rolledBack = false;
        state.versions.stopped = undefined;
        state.canary = { version: event.payload.version, weight: 0 };
        break;
      case 'canary.stepped':
        state.canary = { version: event.payload.version, weight: event.payload.weight };
        break;
      case 'release.promoted':
        state.canary = undefined;
        endCanaryHold(state);
        state.versions.live = true;
        break;
      case 'release.rolled-back':
        state.canary = undefined;
        endCanaryHold(state);
        state.versions.rolledBack = true;
        // Martin may retry a rollback too, as he may a stop: the fix waits for him.
        state.releaseStopped = merged;
        break;
      case 'release.errored':
        state.canary = undefined;
        endCanaryHold(state);
        state.versions.stopped = 'error';
        state.releaseStopped = merged;
        break;
      case 'release.aborted':
        state.canary = undefined;
        endCanaryHold(state);
        state.versions.stopped = event.payload.by;
        state.releaseStopped = merged;
        break;
      case 'verification.finished':
        state.evidence.verified = event.payload.evidence;
        break;
      case 'model.called':
        state.spend += event.payload.costUsd;
        state.calls += 1;
        break;
      case 'work-item.closed':
        state.closedAt = time;
        state.hold = undefined;
        state.waitingOn = undefined;
        state.sentBack = undefined;
        state.reopened = undefined;
        state.queued = false;
        state.outcome = CLOSED[event.payload.outcome];
        if (state.stage) state.visits[state.stage] = { ...(state.visits[state.stage] as Visit), leftAt: time };
        if (event.payload.outcome === 'discarded') state.category = 'not-a-defect';
        break;
      case 'work-item.reopened':
        // Open again, it waits at Plan for the planner, and comes round to a release and a verification of its own.
        state.closedAt = undefined;
        state.hold = undefined;
        state.queued = true;
        merged = false;
        release = undefined;
        state.canary = undefined;
        state.releaseStopped = false;
        state.versions = { from: undefined, to: undefined, rolledBack: false, stopped: undefined, live: false };
        state.evidence.verified = undefined;
        state.reopened = { ...event.payload, at: time };
        break;
    }
    if (event.type === 'judgement.made') {
      state.spend += event.payload.costUsd;
      state.calls += 1;
    }

    event.artifacts.forEach((shot, index) => {
      const side = shot.kind === 'screenshot' ? sideOf(event, state.kind, index) : undefined;
      if (shot.kind === 'screenshot' && side) state.captures.push({ shot, at: time, side });
    });
  }

  if (!state.closedAt) {
    if (state.hold?.cause === 'deploy' && !deployWaitsForMartin(state)) state.outcome = 'deploying';
    else if (state.hold) state.outcome = state.hold.kind === 'held' ? 'held' : 'needs-you';
    // An improvement out behind its flag waits for Martin to widen it, as its card in Needs you says.
    else if (flagWaits(state)) state.outcome = 'needs-you';
    else if (state.queued)
      state.outcome = state.waitingOn ? 'waits-on-work' : state.stage === 'release' ? 'merged' : 'waiting';
    else state.outcome = 'in-progress';
  }
  return state;
}

/** What a screenshot attached to an event shows, in the item's story. Pages compared at verify are not sides. */
function sideOf(event: PublicEvent, kind: Kind, index: number): Capture['side'] | undefined {
  switch (event.type) {
    case 'defect.injected':
    case 'spec.written':
      return 'before';
    case 'signal.received':
      return kind === 'visitor-report' || kind === 'planner-finding' ? 'page' : 'broken';
    case 'canary.stepped':
      return 'canary';
    case 'verification.finished':
      return index === fixedOf(event) ? (kind === 'improvement' ? 'after' : 'fixed') : undefined;
    default:
      return undefined;
  }
}

/**
 * Which of a verification's screenshots shows the fix. The line attaches, for each page compared, the page on the
 * version before and then on the canary, whose hash the page names; then the ticket's own pages again after the
 * rollout (`apps/factory/src/line/pictures.ts`). The fix is shown by a page after the rollout, or else by the ticket's
 * own page on the canary. An event laid out otherwise, as the samples are, has a marked screenshot first, or none.
 */
function fixedOf(event: Extract<PublicEvent, { type: 'verification.finished' }>): number | undefined {
  const { artifacts } = event;
  const { pages } = event.payload;
  const paired = pages.length > 0 && pages.every((page, i) => artifacts[2 * i + 1]?.hash === page.screenshot);
  if (paired) {
    if (artifacts.length > 2 * pages.length) return 2 * pages.length;
    const own = pages.findIndex((page) => page.intended);
    return own < 0 ? undefined : 2 * own + 1;
  }
  const first = artifacts[0];
  return first?.kind === 'screenshot' && first.boxes.length ? 0 : undefined;
}

/**
 * What a hold that waits on Martin's judgement says once a look again found its signal cleared: on which version, on
 * a release that carried what, and by which check. Closing its open pull request then closes it as verified.
 */
export function clearanceWords(item: ItemState): string | undefined {
  const { cleared } = item;
  if (!cleared || !item.hold) return undefined;
  const sense = SENSES.find((one) => one === cleared.sense);
  const by = sense ? `the ${sense} saw “${cleared.check}” pass there` : `“${cleared.check}” cleared there`;
  const on = `Its signal cleared on ${shortVersion(cleared.version ?? '')}, ${clearedOnWords(cleared)}: ${by}.`;
  const open =
    item.pullRequest !== undefined &&
    !item.events.some((e) => e.type === 'pull-request.merged' && e.payload.number === item.pullRequest);
  return open ? `${on} Closing its pull request closes it as verified.` : on;
}

/**
 * Whether a work item held for a deploy waits for Martin: once the deploy pull request that carries it is open and its
 * required checks have passed, so that it is his to merge; or when the release that carried it was stopped, which his
 * retry carries on. Before that, it waits for the image to be built and signed, for the checks, for Argo CD after
 * that pull request merged, or for the next build's after one was closed unmerged.
 */
export function deployWaitsForMartin(item: Pick<ItemState, 'hold' | 'deploy' | 'releaseStopped'>): boolean {
  if (item.hold?.cause !== 'deploy') return false;
  return item.deploy?.state === 'passed' || item.releaseStopped;
}

/** Ends a hold of a canary paused for Martin: its release has ended, however it ended, as the line's fold reads it. */
function endCanaryHold(state: ItemState): void {
  if (state.hold?.cause === 'canary') state.hold = undefined;
}

/** The words for a hold at Release or Verify that its summary may lack, by cause. */
const AFTER_MERGE: Partial<Record<string, string>> = {
  deploy: 'Waiting for a deploy pull request to carry the fix',
  verify: 'Waiting for Martin to judge whether the fix cleared it',
};

/**
 * An event's summary, as the console tells it. The line once wrote its holds for a deploy and for Martin's judgement
 * at Verify as a wait for his merge, which he had already given; those read as the line now writes them. Verify sends
 * work back only when its signal persists, so a return from it says so, in the design's words.
 */
export function summaryOf(event: PublicEvent): string {
  if (event.type === 'work.returned' && event.payload.from === 'verify')
    return 'Persists · back to Plan, with the verification as evidence';
  if (event.type !== 'hold.started' || event.payload.kind !== 'approval') return event.summary;
  const words = AFTER_MERGE[event.payload.cause];
  return words && event.summary === 'Waiting for Martin to merge' ? words : event.summary;
}

/** Groups events by work item, keeping their order, and folds each. Events with no work item are left out. */
export function foldItems(events: readonly PublicEvent[]): ItemState[] {
  const byItem = new Map<string, PublicEvent[]>();
  for (const event of events) {
    if (!event.work_item) continue;
    const list = byItem.get(event.work_item);
    if (list) list.push(event);
    else byItem.set(event.work_item, [event]);
  }
  return [...byItem.values()].flatMap((list) => foldItem(list) ?? []).sort((a, b) => a.openedAt - b.openedAt);
}
