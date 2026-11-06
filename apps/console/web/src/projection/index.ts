/**
 * The console as a pure function of events and a time t (ADR 0002). Live is t = now; replay is any other t; the
 * code is the same, because the projection cannot tell where its events came from.
 *
 * Plain TypeScript with no components in it, so Node tests it directly.
 */
import type { Attack, PublicEvent, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import { attackAvailable } from '@software-factory/policy/attacks';
import { type ControlsView, controlsOf } from './controls.ts';
import { type FlagsView, type FoldedFlags, flagsView, foldFlags } from './flags.ts';
import { type FoldedProofs, foldProofs, type GuardrailsView, guardrailsView } from './guardrails.ts';
import { foldItems, type ItemState } from './items.ts';
import {
  drawn,
  everyReturn,
  type Header,
  header,
  panel,
  type Return,
  returnsWithin,
  type Score,
  type StagePanel,
  type Station,
  score,
  station,
  ticketWaits,
} from './line.ts';
import { type NeedsView, needsView } from './needs.ts';
import { type AppVersions, appVersions, type Card, card, type Timeline, timeline } from './reel.ts';
import { type Checks, type FoldedRefusals, foldRefusals, type LastRollback, lastRollback } from './refusals.ts';
import {
  type CanaryView,
  canaryView,
  type FoldedReleases,
  foldReleases,
  inFlight,
  type Release,
  releasesAt,
} from './release.ts';
import { foldSettings, type SettingsFold } from './settings.ts';

export type { Verdict } from './attacks.ts';
export type { ControlsView } from './controls.ts';
export type { Attempt, RoundsNow, ThreadReview } from './fixing.ts';
export { deployCaption, deployWords } from './fixing.ts';
export type {
  Checked,
  FlagBlock,
  FlagNeed,
  FlagRow,
  FlagsView,
  Move,
  Share,
  Stage as FlagStage,
  Stop,
} from './flags.ts';
export {
  blockWord,
  byWords,
  checkWords,
  comparedWords,
  moveTo,
  STAGE_NAME,
  shotOf,
  stageAt,
  stageSays,
} from './flags.ts';
export type { AttackRow, AttackRun, GuardrailRow, GuardrailsView, ProofResult, ProofSource } from './guardrails.ts';
export type { Outcome } from './items.ts';
export type {
  CapSpell,
  Header,
  PanelRow,
  ProviderSpell,
  Return,
  RowState,
  Score,
  SenseCount,
  StagePanel,
  Station,
  Status,
} from './line.ts';
export { whileSending } from './line.ts';
export type { Answered, CanaryNeed, Evidence, Need, NeedsView, WayThere } from './needs.ts';
export { SAMPLE_PULL } from './needs.ts';
export type { Card, Picture, Refused, Source, Tag, Timeline, Versions } from './reel.ts';
export { QUARANTINE_AT, segmentsLabel } from './reel.ts';
export type { Check, Checks, LastRollback, RefusalLine, RefusalsView, Standing } from './refusals.ts';
export { MECHANISM_WORDS, toCheck } from './refusals.ts';
export type { CanaryView, Carried, End, Measured, Release, Step } from './release.ts';
export { SENSE } from './senses.ts';
export type { Meter, SettingsView, SpendView } from './settings.ts';
export { settingsAt } from './settings.ts';
export type {
  After,
  AgentRow,
  Chapter,
  FlagSheet,
  GateRow,
  Sheet,
  Shipped,
  Shown,
  Sighting,
  Verified,
} from './sheet.ts';

export interface View {
  t: number;
  /** The store holds samples, and the console says so. */
  sample: boolean;
  header: Header;
  /** The scoreboard, beside the app's name; nothing when it has never published. */
  score: Score | undefined;
  stations: Station[];
  /** Work sent back upstream that has not moved on since, newest first, to be drawn one at a time. */
  returns: Return[];
  panels: Record<Stage, StagePanel>;
  /** The Canary panel: the newest release, on a work item or on the line. */
  canary: CanaryView;
  cards: Card[];
  timeline: Timeline;
  /** Needs you: every open hold, and Martin's answers today. */
  needs: NeedsView;
  /** The line's controls in force: the autonomy level, the switches and what the line takes. */
  controls: ControlsView;
  /** The feature flags, each at its stage, and those waiting for Martin to widen them. */
  flags: FlagsView;
  /** What the "+" on Plan says: what a new improvement would wait behind, and Martin's latest request. */
  improve: ImproveView;
  /** Every release by t, oldest first, as far as each had got: what a sheet draws its own from. */
  releases: Release[];
  /** Spec 6's guardrails, each with its last proof, and the attacks made against them. */
  guardrails: GuardrailsView;
}

/**
 * What the events by t say with no time applied: the work items folded, the header, the controls, the releases as far
 * as they go without a time, and every return and version. Folding is most of the work, and the live console's clock
 * moves t every few seconds with no new event, so a fold is kept for its events and serves every t that cuts them the
 * same; `viewAt` applies the time.
 */
export interface Fold {
  /** The events that had happened by t, in seq order. */
  seen: readonly PublicEvent[];
  items: ItemState[];
  controls: ControlsView;
  header: Header;
  score: Score | undefined;
  sample: boolean;
  improve: ImproveView;
  releases: FoldedReleases;
  flags: FoldedFlags;
  settings: SettingsFold;
  /** Each guardrail's latest proof of each kind from `make guardrails`. */
  proofs: FoldedProofs;
  /** Each guardrail's trusted refusals, in time order: which are in its seven days is a matter of t. */
  refusals: FoldedRefusals;
  /** The line's last rollback, which proves guardrail 9 where nothing refuses. */
  rollback: LastRollback | undefined;
  /** Every return, newest first: which are in the last day is a matter of t. */
  returns: Return[];
  versions: AppVersions;
  /** Each work item's card, once it has closed: an open one's time and version run on with t. */
  closed: (Card | undefined)[];
  timeline: Timeline;
}

export interface ImproveView {
  /** The open tickets waiting for the planner: an improvement waits behind every one of them. */
  tickets: number;
  /** Martin's latest request, which a visitor's form shows: his words, as everyone may read them, and when. */
  latest: { workItem: string; words: string; at: number } | undefined;
}

/** What the "+" says, from the work items. */
function improveView(items: readonly ItemState[]): ImproveView {
  let latest: ImproveView['latest'];
  for (const item of items) {
    const { request } = item;
    if (request && (!latest || request.at >= latest.at)) {
      latest = { workItem: item.number, words: request.words, at: request.at };
    }
  }
  return { tickets: items.filter(ticketWaits).length, latest };
}

/** The events that had happened by t, in seq order. */
export const upTo = (events: readonly PublicEvent[], t: number) => events.filter((event) => Date.parse(event.ts) <= t);

/** The fold of the events by t, which needs no time: what `foldAt` keeps. */
export function fold(seen: readonly PublicEvent[]): Fold {
  const items = foldItems(seen);
  const controls = controlsOf(seen);
  const folded = foldReleases(seen, items);
  const versions = appVersions(seen);
  return {
    seen,
    items,
    controls,
    header: header(seen, controls.autonomy),
    score: score(seen),
    sample: items.some((item) => item.sample),
    improve: improveView(items),
    releases: folded,
    flags: foldFlags(seen, items),
    settings: foldSettings(seen),
    proofs: foldProofs(seen),
    refusals: foldRefusals(seen),
    rollback: lastRollback(seen),
    returns: everyReturn(seen),
    versions,
    closed: items.map((item) => (item.closedAt === undefined ? undefined : card(item, versions, item.closedAt))),
    // How each release ended and where each card starts, neither of which a later time changes.
    timeline: timeline(
      items.map((item) => ({ number: item.number, startedAt: item.openedAt })),
      folded.map((f) => ('release' in f ? f.release : f.base)),
    ),
  };
}

/** The last fold of each list of events, kept as long as the list is. */
const folds = new WeakMap<readonly PublicEvent[], Fold>();

/** How many of the events had happened by t. */
const countUpTo = (events: readonly PublicEvent[], t: number) => {
  let n = 0;
  for (const event of events) if (Date.parse(event.ts) <= t) n++;
  return n;
};

/**
 * The fold of the events by t: the last one made of these events, while t cuts them the same, or a new one. The events
 * by one time hold those by any earlier one, so as many of them as the kept fold read are the same ones, and none is
 * copied to find that out. An event added to the same array is one more.
 */
export function foldAt(events: readonly PublicEvent[], t: number): Fold {
  const kept = folds.get(events);
  if (kept && kept.seen.length === countUpTo(events, t)) return kept;
  const made = fold(upTo(events, t));
  folds.set(events, made);
  return made;
}

/**
 * The fold each view was drawn from, which a sheet is drawn from too. Kept beside the view, not in it: the view is what
 * the console draws, the same for the same page whoever reads it, and the fold holds every event it read.
 */
const drawnFrom = new WeakMap<View, Fold>();

/** The fold a view was drawn from. */
export const foldOf = (view: View): Fold => {
  const folded = drawnFrom.get(view);
  if (!folded) throw new Error('A view is drawn by viewAt, which keeps its fold');
  return folded;
};

/**
 * The console at t, from a fold of the events by t: what depends on the time. `available` says which attacks Martin can
 * launch: policy's (`attackAvailable`), unless a browser test stands in for the flag (`attacks-seam.ts`). `checks` are
 * the server's word on each relayed refusal (`/api/refusals`), as far as it has answered.
 */
export function viewAt(
  folded: Fold,
  t: number,
  available: (attack: Attack) => boolean = attackAvailable,
  checks: Checks = new Map(),
): View {
  const { items, header: line } = folded;
  const sent = returnsWithin(folded.returns, t);
  const shipped = releasesAt(folded.releases, t);
  // A red-team attack never reaches the line: its work item meets its mechanism where it stands on the line, and is
  // drawn on the reel and in Guardrails, never at a station.
  const onLine = items.filter((item) => !item.attack);
  const atStages = STAGES.map((stage) => ({ stage, at: station(stage, onLine, sent, line, t, shipped) }));
  const shown: View = {
    t,
    sample: folded.sample,
    header: line,
    score: folded.score,
    stations: atStages.map(({ at }) => at),
    returns: drawn(sent, items),
    panels: Object.fromEntries(
      atStages.map(({ stage, at }) => [stage, panel(stage, onLine, sent, folded.seen, line, t, shipped, at)]),
    ) as Record<Stage, StagePanel>,
    canary: canaryView(shipped),
    cards: items.map((item, i) => folded.closed[i] ?? card(item, folded.versions, t)),
    timeline: folded.timeline,
    needs: needsView(items, t, inFlight(shipped)),
    controls: folded.controls,
    flags: flagsView(folded.flags, items, shipped, t),
    improve: folded.improve,
    releases: shipped,
    guardrails: guardrailsView(folded.proofs, items, t, available, {
      refusals: folded.refusals,
      checks,
      rollback: folded.rollback,
      autoRollback: folded.controls.autoRollback,
    }),
  };
  drawnFrom.set(shown, folded);
  return shown;
}

export const project = (
  events: readonly PublicEvent[],
  t: number,
  available: (attack: Attack) => boolean = attackAvailable,
  checks: Checks = new Map(),
): View => viewAt(foldAt(events, t), t, available, checks);
