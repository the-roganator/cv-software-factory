/**
 * The console as a pure function of events and a time t (ADR 0002). Live is t = now; replay is any other t; the
 * code is the same, because the projection cannot tell where its events came from.
 *
 * Plain TypeScript with no components in it, so Node tests it directly.
 */
import type { PublicEvent, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import { type ControlsView, controlsOf } from './controls.ts';
import { type FlagsView, flagsView } from './flags.ts';
import { foldItems, type ItemState } from './items.ts';
import {
  drawn,
  type Header,
  header,
  panel,
  type Return,
  returnsAt,
  type Score,
  type StagePanel,
  type Station,
  score,
  station,
  ticketWaits,
} from './line.ts';
import { type NeedsView, needsView } from './needs.ts';
import { type Card, card, type Timeline, timeline } from './reel.ts';
import { type CanaryView, canaryView, inFlight, releases } from './release.ts';
import { type Sheet, sheet } from './sheet.ts';

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
export type { Answered, CanaryNeed, Evidence, Need, NeedsView } from './needs.ts';
export type { Card, Picture, Source, Tag, Timeline, Versions } from './reel.ts';
export { QUARANTINE_AT, segmentsLabel } from './reel.ts';
export type { CanaryView, Carried, End, Measured, Release, Step } from './release.ts';
export { SENSE } from './senses.ts';
export type { Meter, SettingsView, SpendView } from './settings.ts';
export { settingsView } from './settings.ts';
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
export { marksNote, scrubbed, TARGET } from './sheet.ts';

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

export function project(events: readonly PublicEvent[], t: number): View {
  const seen = upTo(events, t);
  const items = foldItems(seen);
  const controls = controlsOf(seen);
  const line = header(seen, controls.autonomy);
  const sent = returnsAt(seen, t);
  const returns = drawn(sent, items);
  const cards = items.map((item) => card(item, seen, t));
  const shipped = releases(seen, items, t);
  return {
    t,
    sample: items.some((item) => item.sample),
    header: line,
    score: score(seen),
    stations: STAGES.map((stage) => station(stage, items, sent, line, t, shipped)),
    returns,
    panels: Object.fromEntries(
      STAGES.map((stage) => [stage, panel(stage, items, sent, seen, line, t, shipped)]),
    ) as Record<Stage, StagePanel>,
    canary: canaryView(shipped),
    cards,
    timeline: timeline(cards, shipped),
    needs: needsView(items, t, inFlight(shipped)),
    controls,
    flags: flagsView(seen, items, shipped, t),
    improve: improveView(items),
  };
}

/** One work item's sheet at t, or nothing if it had not opened by then. */
export function projectSheet(events: readonly PublicEvent[], item: string, t: number): Sheet | undefined {
  const seen = upTo(events, t);
  const state: ItemState | undefined = foldItems(seen.filter((event) => event.work_item === item))[0];
  if (!state) return undefined;
  // An improvement's flag, as Controls draws it: judged against every other flag and the canary in flight.
  const items = state.kind === 'improvement' ? foldItems(seen) : [];
  const flags = state.kind === 'improvement' ? flagsView(seen, items, releases(seen, items, t), t) : undefined;
  const flag = flags && [...flags.flags, ...flags.closed].find((row) => row.workItem === item);
  // A canary paused for Martin that carries it, drawn from every release's events, as Needs you draws it.
  const released = state.events.some((event) => event.type === 'release.started');
  const flight = released ? inFlight(releases(seen, flags ? items : foldItems(seen), t)) : undefined;
  const canary = flight?.items.some((i) => i.number === item) ? flight : undefined;
  // What waits on Martin for it, drawn as Needs you draws it: its hold, its canary, and its flag waiting to be widened.
  const waits = needsView([state], t, canary);
  const needs = {
    hold: waits.holds[0],
    canary: waits.canary,
    flag: flags?.needs.find((need) => need.workItem === item),
  };
  return { ...sheet(state, seen, t, flag), needs };
}
