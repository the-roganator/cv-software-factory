/**
 * The reel at time t: one card per work item, oldest first, and the timeline under them.
 */
import type {
  Category,
  Evidence,
  Kind,
  PayloadOf,
  PublicEvent,
  Screenshot,
  Sense,
  Stage,
} from '@software-factory/events';
import { isSense, STAGES } from '@software-factory/events';
import { capital, startOfDay } from '../format.ts';
import { waitPicture } from './fixing.ts';
import { itemFlag, STAGE_NAME } from './flags.ts';
import { type Capture, type ItemState, type Outcome, ofType, stopsRelease, summaryOf } from './items.ts';
import type { Release, StoppedBy } from './release.ts';

type Segment = 'passed' | 'skipped' | 'now' | 'queued' | 'stopped' | 'waiting' | 'closed' | 'none';

export type Tag = 'BEFORE' | 'BROKEN' | 'FIXED' | 'AFTER' | 'NOW' | 'SEEN';

/**
 * The probability of holding instructions at which triage quarantines a report: `REPORTS.quarantine` in
 * policy/triage.ts. The console's image is built without policy/, so it keeps this copy, and a test holds the two
 * together.
 */
export const QUARANTINE_AT = 0.5;

type Http = Extract<Evidence, { kind: 'http' }>;
type Console = Extract<Evidence, { kind: 'console' }>;
type Accessibility = Extract<Evidence, { kind: 'accessibility' }>;
type Judgement = PayloadOf<'judgement.made'>;

/** A signal from one of the senses, and not the planner's finding, which carries nothing a sense captured. */
export const bySense = (
  signal: PublicEvent<'signal.received'>,
): signal is PublicEvent<'signal.received'> & { payload: { sense: Sense } } => isSense(signal.payload.sense);

/** Who captured a picture's evidence, with which check, on which version, and whether on one page or every page. */
export interface Source {
  sense: Sense;
  check: string;
  version: string;
  every: boolean;
}

/** The picture on a card: always evidence the factory captured, never an illustration. */
export type Picture =
  | { type: 'wipe'; before: Screenshot; after: Screenshot; tags: [Tag, Tag] }
  | { type: 'screenshot'; shot: Screenshot; tag: Tag }
  /** A metric over time: a fix's effect once verified, or, when `seen`, the problem as a sense saw it. */
  | { type: 'metric'; evidence: Extract<Evidence, { kind: 'metric' }>; unchanged: Screenshot[]; seen?: boolean }
  | {
      type: 'logs';
      before: Extract<Evidence, { kind: 'logs' }> | undefined;
      after: Extract<Evidence, { kind: 'logs' }>;
      seen?: boolean;
    }
  | {
      type: 'package';
      dependency: Dependency;
      files: PayloadOf<'pull-request.pushed'>['files'];
      checks: { passed: number; total: number } | undefined;
      unchanged: Screenshot[];
    }
  | { type: 'scan'; dependency: Dependency; findings: Findings; unchanged: Screenshot[] }
  /** A canary rolled back: the series of the first measure that failed it, and how much of the traffic saw it. */
  | { type: 'rollback'; dependency: Dependency | undefined; weight: number; restored: string; series: Series }
  /** A mechanism's refusal, in its own words; `admission` when admission control (Kyverno) refused an image. */
  | { type: 'refusal'; mechanism: string; output: string; admission?: true }
  | { type: 'judgement'; page: Screenshot | undefined; judgement: Judgement }
  /** A report quarantined: the answer that decided it, against its threshold, and no page at all. */
  | { type: 'quarantine'; judgement: Judgement }
  /** A visitor's suggestion, parked for Martin: the page it named and Jev's answers, waiting on him. */
  | { type: 'suggestion'; page: Screenshot | undefined; judgement: Judgement }
  /** A spec: the decision Martin is asked to make while it holds for his answer, and otherwise what the work set out to do. */
  | { type: 'spec'; spec: PayloadOf<'spec.written'>; waiting: boolean; question: string | undefined }
  /**
   * A merged fix held for a deploy: the pull request it waits with, its merge, the release that carried it and rolled
   * back, when it waits for the next deploy, and the deploy pull request that carries it, as the line last recorded it.
   */
  | {
      type: 'deploy';
      pullRequest: number | undefined;
      title: string | undefined;
      merged: { at: number; commit: string; byMartin: boolean } | undefined;
      /** The release that carried the merge, if it ended without shipping. */
      ended: Ended | undefined;
      /** The deploy pull request that carries it, once the App has opened one. */
      deploy: Pick<PayloadOf<'deploy.changed'>, 'pullRequest' | 'state' | 'failed'> | undefined;
      /** Whether it waits for Martin: his deploy to merge, its checks passed, or his retry. */
      waitsForMartin: boolean;
    }
  /** A fix waiting for Martin's merge: the pull request, and what says it is safe to merge. */
  | {
      type: 'merge';
      pullRequest: number;
      title: string;
      /** The required checks on its last commit. */
      checks: { passed: number; total: number };
      testsFirst: { failedOnBase: boolean; figure: string | undefined } | undefined;
      /** The review that approved it, by number, and its suggestions. */
      review: { suggestions: number; number: number } | undefined;
      /** The pull request's whole change, every round together: what a merge brings in. */
      files: number;
      added: number;
      removed: number;
      /** Every file it changes is one its spec allows. */
      inScope: boolean;
    }
  /** Held: the scope fence refused the coder's patch again. Its own output, and the refusal before it. */
  | {
      type: 'scope';
      /** The coder's patch it refused, counting every patch the fence judged, pushed or refused. */
      patch: number;
      /** Its refusals since Martin last answered a hold: the count the line holds at. */
      refusals: number;
      output: string;
      earlier: { patch: number; same: boolean } | undefined;
      /** Whether an earlier patch reached GitHub; a refused one never does. */
      reachedGitHub: boolean;
    }
  /** Held: the change's new tests pass on the base, without the fix. The tests-first check's own output. */
  | { type: 'tests-pass'; output: string }
  /** Held: the work item reached its spend cap. What it spent, and on which agent. */
  | {
      type: 'spend';
      stage: Stage;
      spent: number;
      cap: number;
      agents: { agent: string; cost: number; steps: number }[];
      stopped: { agent: string; step: number } | undefined;
    }
  /** Held: findings still blocking after the last review. */
  | {
      type: 'blocking';
      reviews: number;
      /** Each open finding, and the reviews that blocked the same file on the same rule or criterion. */
      findings: { where: string; cites: string | undefined; comment: string; reviews: number[] }[];
    }
  /** A problem found on every page: a few of the pages, each marked, and how many more. */
  | { type: 'pages'; shots: Screenshot[]; more: number; source: Source }
  /** A request and what came back: what a screenshot cannot show, such as a redirect or a missing header. */
  | { type: 'http'; exchange: Http; source: Source }
  /** What the browser's console said, word for word, beside the page it said it on. */
  | { type: 'console'; console: Console; shot: Screenshot | undefined; source: Source }
  /** What an accessibility check found, with each element it named numbered on the screenshot. */
  | { type: 'accessibility'; findings: Accessibility; shot: Screenshot | undefined; source: Source }
  | { type: 'none' };

type Dependency = NonNullable<PayloadOf<'work-item.opened'>['dependency']>;
type Findings = NonNullable<PayloadOf<'gate.finished'>['findings']>;
type Series = NonNullable<PayloadOf<'release.rolled-back'>['failed'][number]['series']>;

/** A release that ended without shipping: rolled back, or stopped, and by what. */
export interface Ended {
  at: number;
  version: string;
  stopped: StoppedBy | undefined;
}

export interface Versions {
  /** The version it broke or replaced. */
  from: string | undefined;
  /** The version it shipped, or is shipping. */
  to: string | undefined;
  rolledBack: boolean;
  stopped: ItemState['versions']['stopped'];
  /** Still on the canary: `to` is not yet live. */
  onCanary: boolean;
}

export interface Card {
  number: string;
  kind: Kind;
  /** A visitor started it. Which visitor is never public. */
  byVisitor: boolean;
  category: Category;
  outcome: Outcome;
  sample: boolean;
  title: string;
  description: string;
  picture: Picture;
  versions: Versions;
  /** The app's version when a sense first saw it, for work that has not reached a release. */
  seenOn: string | undefined;
  /** The page a visitor's report came from, at its path only. */
  from: string | undefined;
  /** Agents' steps that called a model, and Jev's judgements: none at all is said as "no model". */
  calls: number;
  /** Every model call was served by the local model, at no cost. */
  local: boolean;
  pullRequest: number | undefined;
  startedAt: number;
  /** Start to finish, or so far. */
  durationMs: number;
  spend: number;
  segments: Segment[];
  /** The version the app was on once this item was done with it, or now if it is not. */
  appVersion: string | undefined;
  /** While a verified ticket is open again: when, and what the sense saw, on which version. */
  reopened: ItemState['reopened'];
  /** An improvement out behind its flag: the flag, and the stage it stands at, in a word ("preview"). */
  flag: { name: string; stage: string } | undefined;
}

export interface Timeline {
  /** Where each card sits along the timeline, from 0 to 1, with a little space between days and room for releases. */
  positions: number[];
  /** Where each day starts along the timeline, and the day's start. */
  days: { at: number; day: number }[];
  /**
   * How many card widths the timeline spans, from the first mark to the last: one between work items on the same day.
   * A position's step from one work item to the next on the same day is one over this.
   */
  span: number;
  /**
   * The version each release left the app on, where it sits along the timeline: under the work item it carried, or,
   * for a release with no work item, a place of its own at its time. Struck through when the app went back.
   */
  versions: { at: number; card: number | undefined; version: string; rolledBack: boolean }[];
}

/** The segments under a card: how far the item got through the eight stages, and where it stopped. */
export function segments(item: ItemState): Segment[] {
  const current = item.stage ? STAGES.indexOf(item.stage) : -1;
  const entry = item.entry ? STAGES.indexOf(item.entry) : -1;
  return STAGES.map((stage, i): Segment => {
    if (current < 0 || i < entry) return entry < 0 && current < 0 ? 'none' : 'skipped';
    if (i < current) return item.visits[stage] ? 'passed' : 'skipped';
    if (i > current) return 'none';
    switch (item.outcome) {
      case 'verified':
        return 'passed';
      case 'rolled-back':
      case 'held':
        return 'stopped';
      case 'needs-you':
        return 'waiting';
      case 'waiting':
      case 'waits-on-work':
      case 'merged':
      case 'deploying':
        return 'queued';
      case 'closed':
      case 'quarantined':
      case 'no-ticket':
      case 'turned-off':
        return item.failure ? 'stopped' : 'closed';
      default:
        return 'now';
    }
  });
}

/** Where the item got to, in words, for the segments' accessible name. */
export function segmentsLabel(list: readonly Segment[]): string {
  const at = list.findIndex(
    (s) => s === 'now' || s === 'queued' || s === 'stopped' || s === 'waiting' || s === 'closed',
  );
  if (at < 0) return list.every((s) => s === 'none') ? 'Not on the line yet' : 'Every stage passed';
  const stage = STAGES[at] as Stage;
  const name = capital(stage);
  return {
    now: `Now at ${name}`,
    queued: stage === 'plan' ? 'Waiting at Plan for the planner' : `Waiting at ${name}`,
    stopped: `Stopped at ${name}`,
    waiting: `Waiting at ${name}`,
    closed: `Closed at ${name}`,
  }[list[at] as 'now' | 'queued' | 'stopped' | 'waiting' | 'closed'];
}

const last = <T>(list: readonly T[], test: (value: T) => boolean) => [...list].reverse().find(test);

const MECHANISMS: Record<PayloadOf<'action.refused'>['mechanism'], string> = {
  'token-permission': 'Token permissions',
  ruleset: 'The ruleset on main',
  'egress-policy': 'The egress policy',
  'admission-control': 'Admission control',
  'scope-fence': 'The scope fence',
  'github-guard': 'The GitHub worker’s guard',
  'review-gate': 'The review gate',
  gateway: 'The gateway',
  'typed-judgement': 'Typed judgement',
};

/** The pages verification found unchanged, for the strip under a picture of something with nothing to see. */
function unchangedPages(item: ItemState): Screenshot[] {
  const verification = last(ofType(item, 'verification.finished'), () => true);
  if (!verification) return [];
  const shots = new Map(verification.artifacts.flatMap((a) => (a.kind === 'screenshot' ? [[a.hash, a]] : [])));
  return verification.payload.pages.flatMap((page) => {
    const shot = shots.get(page.screenshot);
    return page.changed === 0 && shot ? [shot] : [];
  });
}

/**
 * The picture for a card: the evidence that best shows what changed, or, while the work waits on Martin, the thing
 * he is asked to decide. Without `waits`, the evidence alone, which the sheet shows whatever the card shows.
 */
export function picture(item: ItemState, { waits = true }: { waits?: boolean } = {}): Picture {
  // The rollback of the latest release to carry the item, if it rolled back: one before it is history.
  const latest = last(ofType(item, 'release.started'), () => true)?.payload.release;
  const rolledBack = last(ofType(item, 'release.rolled-back'), (event) => event.payload.release === latest)?.payload;
  // A rollback with no series to draw (the journeys failed it, say) is told by its other evidence.
  const series = rolledBack?.failed.find((measure) => measure.series)?.series;
  if (rolledBack && series) {
    const { weight, restored } = rolledBack;
    return { type: 'rollback', dependency: item.dependency, weight, restored, series };
  }

  if (item.kind === 'red-team') {
    const refused = last(ofType(item, 'action.refused'), () => true);
    if (refused)
      return {
        type: 'refusal',
        mechanism: MECHANISMS[refused.payload.mechanism],
        output: refused.payload.output,
        ...(refused.payload.mechanism === 'admission-control' && { admission: true as const }),
      };
    const gate = last(ofType(item, 'gate.finished'), (event) => event.payload.conclusion === 'failure');
    if (gate?.payload.output) return { type: 'refusal', mechanism: gate.payload.check, output: gate.payload.output };
  }

  // A report shows what triage made of it: the request that routed it, which is its first. One that ended at triage
  // shows it for good; one that became a ticket only until the line has evidence of its own, such as a fix. So does a
  // planner's finding, which is judged as a report is; a defect it noticed waits as a judgement, not a suggestion.
  const judgement = ofType(item, 'judgement.made').find((event) => event.payload.route)?.payload;
  // A defect the planner noticed that Martin opened as a ticket left triage after all.
  const endedAtTriage =
    judgement?.route === 'quarantine' ||
    (judgement?.route === 'park' && !item.ticket) ||
    judgement?.route === 'discard';
  const pastPlan = item.stage !== null && STAGES.indexOf(item.stage) > STAGES.indexOf('plan');
  const judged = item.kind === 'visitor-report' || item.kind === 'planner-finding';
  if (judged && judgement && (endedAtTriage || !pastPlan)) {
    const page = capture(item, 'page')?.shot;
    if (judgement.route === 'quarantine') return { type: 'quarantine', judgement };
    // Triage's hold says which it parked, and stays in the events once Martin has answered it.
    const defect = ofType(item, 'hold.started').some((event) => event.payload.cause === 'finding');
    if (judgement.route === 'park' && !defect) return { type: 'suggestion', page, judgement };
    return { type: 'judgement', page, judgement };
  }

  const found = last(ofType(item, 'spec.written'), () => true);
  // Only a spec held at Plan for Martin's approval, or for his answer to the planner's question, waits for him.
  const held = item.hold?.stage === 'plan' && (item.hold.cause === 'spec' || item.hold.cause === 'question');
  const spec = found && {
    type: 'spec' as const,
    spec: found.payload,
    waiting: held,
    question: held ? item.hold?.question : undefined,
  };
  if (waits) {
    const waiting = waitPicture(item);
    if (waiting) return waiting;
    if (held && spec) return spec;
  }

  if (item.dependency) {
    const findings = last(ofType(item, 'gate.finished'), (event) => Boolean(event.payload.findings))?.payload.findings;
    if (item.dependency.security && findings) {
      return { type: 'scan', dependency: item.dependency, findings, unchanged: unchangedPages(item) };
    }
    const gates = last(ofType(item, 'gates.finished'), () => true)?.payload;
    return {
      type: 'package',
      dependency: item.dependency,
      files: last(ofType(item, 'pull-request.pushed'), () => true)?.payload.files ?? [],
      checks: gates && { passed: gates.passed, total: gates.passed + gates.failed.length },
      unchanged: unchangedPages(item),
    };
  }

  const wipe = wipeOf(item);
  if (wipe) return wipe;

  const { signal, verified } = item.evidence;
  if (verified?.kind === 'metric') return { type: 'metric', evidence: verified, unchanged: unchangedPages(item) };
  if (verified?.kind === 'logs') {
    return { type: 'logs', before: signal?.kind === 'logs' ? signal : undefined, after: verified };
  }
  if (signal?.kind === 'metric') return { type: 'metric', evidence: signal, unchanged: [], seen: true };

  const opened = opening(item);
  const seen = opened && pictureOfSignal(opened);
  if (seen) return seen;

  const broken = capture(item, 'broken');
  if (broken) return { type: 'screenshot', shot: broken.shot, tag: 'SEEN' };
  // With nothing better to show, the spec says what the work set out to do, and waits only while it holds for Martin.
  if (spec) return spec;
  return { type: 'none' };
}

/** The sense's signal that opened the work item, if a sense opened it. */
const opening = (item: ItemState) =>
  ofType(item, 'signal.received').find((event) => event.payload.sense !== 'report' && bySense(event));

/**
 * The picture a sense's own capture makes: a screenshot where it marked something on the page, and otherwise what
 * the sense recorded instead (every page, the browser's console, an accessibility check, an HTTP exchange, a metric
 * or log lines), or the unmarked page.
 */
export function pictureOfSignal(signal: PublicEvent<'signal.received'>): Picture | undefined {
  if (!bySense(signal)) return undefined;
  const { sense, check, version, route, evidence = [] } = signal.payload;
  const source: Source = { sense, check, version, every: route === '*' };
  const shots = signal.artifacts.filter((a): a is Screenshot => a.kind === 'screenshot');
  const find = <K extends Evidence['kind']>(kind: K) =>
    evidence.find((e): e is Extract<Evidence, { kind: K }> => e.kind === kind);
  const [shot] = shots;
  if (source.every && shots.length > 1) {
    return { type: 'pages', shots: shots.slice(0, 4), more: Math.max(0, shots.length - 4), source };
  }
  if (shot?.boxes.length) return { type: 'screenshot', shot, tag: 'SEEN' };
  const consoled = find('console');
  if (consoled) return { type: 'console', console: consoled, shot, source };
  const accessibility = find('accessibility');
  if (accessibility) return { type: 'accessibility', findings: accessibility, shot, source };
  const http = find('http');
  if (http) return { type: 'http', exchange: http, source };
  const metric = find('metric');
  if (metric) return { type: 'metric', evidence: metric, unchanged: [], seen: true };
  const logs = find('logs');
  if (logs) return { type: 'logs', before: undefined, after: logs, seen: true };
  if (shot) return { type: 'screenshot', shot, tag: 'SEEN' };
  return undefined;
}

const capture = (item: ItemState, side: Capture['side']) => last(item.captures, (c) => c.side === side);

/** Before and after, when the factory captured both: the problem and its fix, or the page before and now. */
function wipeOf(item: ItemState): Picture | undefined {
  const before = item.captures.find((c) => c.side === 'before');
  const broken = item.captures.find((c) => c.side === 'broken');
  const after = capture(item, 'fixed') ?? capture(item, 'after');
  if (after && broken) return { type: 'wipe', before: broken.shot, after: after.shot, tags: ['BROKEN', 'FIXED'] };
  if (after && before) return { type: 'wipe', before: before.shot, after: after.shot, tags: ['BEFORE', 'AFTER'] };
  if (before && broken) return { type: 'wipe', before: before.shot, after: broken.shot, tags: ['BEFORE', 'NOW'] };
  return undefined;
}

/**
 * The version the app was on after each event, a dry run's release never moving it, and the latest time of any event
 * up to each, so that `appVersion` searches them rather than walk every event for every card.
 */
export interface AppVersions {
  latest: number[];
  version: (string | undefined)[];
}

/**
 * The version the app was on after each event: the last one promoted, injected or restored by then. A dry run's
 * release shipped nothing, so it never moves the app.
 */
export function appVersions(events: readonly PublicEvent[]): AppVersions {
  const latest: number[] = [];
  const versions: (string | undefined)[] = [];
  let version: string | undefined;
  let at = -Infinity;
  for (const event of events) {
    at = Math.max(at, Date.parse(event.ts));
    if (!('dryRun' in event.payload && event.payload.dryRun)) {
      if (event.type === 'release.promoted' || event.type === 'defect.injected') version = event.payload.version;
      if (stopsRelease(event)) version = event.payload.restored;
      if (event.type === 'release.started' && !version) version = event.payload.previous;
    }
    latest.push(at);
    versions.push(version);
  }
  return { latest, version: versions };
}

/** The version the app was on at a time: as it was after the events before the first one later than it. */
export function appVersion({ latest, version }: AppVersions, at: number): string | undefined {
  let [low, high] = [0, latest.length];
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((latest[mid] ?? 0) > at) high = mid;
    else low = mid + 1;
  }
  return low ? version[low - 1] : undefined;
}

/** Every call the work made was to the local model: something was called, and it cost nothing. */
function isLocal(item: ItemState): boolean {
  const called = ofType(item, 'model.called');
  return called.length > 0 && called.length === item.calls && called.every((e) => e.payload.provider === 'local');
}

export function card(item: ItemState, versions: AppVersions, t: number): Card {
  const end = item.closedAt ?? t;
  const latest = last(item.events, (e) => e.type !== 'model.called');
  return {
    number: item.number,
    kind: item.kind,
    byVisitor: item.openedBy === 'visitor',
    category: item.category,
    outcome: item.outcome,
    sample: item.sample,
    title: item.title,
    description: item.description ?? (latest ? summaryOf(latest) : ''),
    picture: picture(item),
    versions: {
      from: item.versions.from,
      to: item.versions.to,
      rolledBack: item.versions.rolledBack,
      stopped: item.versions.stopped,
      onCanary: Boolean(item.canary),
    },
    seenOn: item.seenOn,
    from: item.reportPage,
    calls: item.calls,
    local: isLocal(item),
    pullRequest: item.pullRequest,
    startedAt: item.openedAt,
    durationMs: Math.max(0, end - item.openedAt),
    spend: item.spend,
    segments: segments(item),
    appVersion: appVersion(versions, end),
    reopened: item.reopened,
    flag: flagOfCard(item),
  };
}

/** The flag a card's line of facts names, once its release is out: its name, and its stage in a word. */
function flagOfCard(item: ItemState): Card['flag'] {
  const flag = itemFlag(item);
  if (!flag?.built) return undefined;
  const { stage } = flag.now;
  return { name: flag.name, stage: stage ? STAGE_NAME[stage.stage].toLowerCase() : 'outside every stage' };
}

/** How a release last ended: while a retry is in flight, its earlier attempt's end still stands. */
const ending = (r: Marked | undefined) => r?.end ?? r?.retried.at(-1);
const endAt = (r: Marked | undefined) => ending(r)?.at ?? 0;

/** What the timeline reads of a release: how it ended, which no later time changes, and what it carried. */
type Marked = Pick<Release, 'end' | 'retried' | 'dryRun' | 'items' | 'version'>;

/**
 * The timeline: a card's width between work items, half one more between days, and a release marked under no card
 * takes a card's place without a card, so its version sits between the work items either side of it in time.
 *
 * A release marks the version it left the app on once it has ended: under the first card whose latest release it
 * is, or, when it carries no work item shown, all it carried went again in a later release, or it ended before the
 * mark of a card before it, in its own place. A rollback, an analysis error and an abort are struck through, since the
 * app went back to the version before. A dry run shipped nothing, and marks nothing.
 */
export function timeline(cards: readonly Pick<Card, 'number' | 'startedAt'>[], shipped: readonly Marked[]): Timeline {
  const ended = shipped.filter((r) => ending(r) && !r.dryRun).sort((a, b) => endAt(a) - endAt(b));
  const latest = new Map<string, Marked>();
  for (const r of ended) for (const item of r.items) latest.set(item.number, r);
  const under = new Map<number, Marked>();
  const marked = new Set<Marked>();
  // A card's mark that ended before an earlier card's would read out of order: it takes a place of its own instead.
  let last = 0;
  for (const [i, c] of cards.entries()) {
    const r = latest.get(c.number);
    if (!r || marked.has(r) || endAt(r) < last) continue;
    under.set(i, r);
    marked.add(r);
    last = endAt(r);
  }
  // The cards in the order they started, and each release in its own place before the first card that started after
  // it ended or whose own mark ended after it, so the versions read in the order the app's changed.
  type Entry = { at: number } & ({ card: number } | { release: Marked });
  const entries: Entry[] = cards.map((c, card) => ({ card, at: c.startedAt }));
  const changed = cards.map((c, i) => Math.max(c.startedAt, endAt(under.get(i))));
  for (const release of ended.filter((r) => !marked.has(r))) {
    const at = endAt(release);
    const next = entries.findIndex((e) => 'card' in e && (changed[e.card] ?? 0) > at);
    entries.splice(next < 0 ? entries.length : next, 0, { release, at });
  }

  // Days only go forwards: a card that started before a release placed ahead of it is drawn on the release's day.
  const days: { unit: number; day: number }[] = [];
  const units = entries.map((entry, i) => {
    const day = Math.max(startOfDay(entry.at), days.at(-1)?.day ?? 0);
    if (days.at(-1)?.day !== day) days.push({ unit: i + days.length * 0.5, day });
    return i + (days.length - 1) * 0.5;
  });
  const span = units.at(-1) || 1;
  const at = (unit: number) => (entries.length > 1 ? unit / span : 0.5);
  const positions: number[] = [];
  const versions: Timeline['versions'] = [];
  for (const [i, entry] of entries.entries()) {
    const place = at(units[i] ?? 0);
    const card = 'card' in entry ? entry.card : undefined;
    if (card !== undefined) positions.push(place);
    const release = 'release' in entry ? entry.release : under.get(entry.card);
    if (release)
      versions.push({ at: place, card, version: release.version, rolledBack: ending(release)?.kind !== 'promoted' });
  }
  return { positions, days: days.map(({ unit, day }) => ({ at: at(unit), day })), versions, span };
}
