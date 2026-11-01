/**
 * The line at time t: whether it runs, each station's state and figure, the returns waiting to be drawn, and what
 * each stage panel lists.
 */
import type { Autonomy, PayloadOf, PublicEvent, Sense, Stage } from '@software-factory/events';
import { isSense, returnWords, SENSES, STAGES } from '@software-factory/events';
import { DEFAULT_CONTROLS } from '../../../../../policy/line.ts';
import { shortVersion } from '../format.ts';
import { deployWords, endedSinceMerge } from './fixing.ts';
import { itemFlag, STAGE_NAME } from './flags.ts';
import type { ItemState } from './items.ts';
import { holdKicker } from './needs.ts';
import { endedWords, inFlight, type Release, SIGNALLED, stopWait, stopWords } from './release.ts';

export type Status = 'idle' | 'working' | 'returning' | 'passing' | 'blocked' | 'failed';
/** A person should look at a station that is still at work: an item in it failed, or waits on them. */
export type Beacon = 'needs-you' | 'failed';

/** How long a return keeps its sender "sending back". */
export const RETURNING_MS = 5 * 60_000;
/** How long a stage reads "passed" after an item leaves it, with nothing else in it. */
export const PASSING_MS = 15 * 60_000;
/** How far back returns are kept: drawn one at a time while still true, and rows in their senders' panels. */
export const RETURNS_MS = 24 * 3_600_000;

type Cap = 'day' | 'month';
type ProviderCapped = Extract<PayloadOf<'spend.capped'>, { cap: 'provider' }>;

/** A spend cap reached, and when it cleared, if it has. */
export interface CapSpell {
  cap: Cap;
  limitUsd: number;
  spentUsd: number;
  /** When the cap was due to reset, as the gateway said when it was reached. */
  resets: number;
  reached: number;
  cleared: number | undefined;
}

/** A provider that refused for a cap the factory does not own, and when it answered again, if it has. */
export interface ProviderSpell {
  provider: ProviderCapped['provider'];
  reason: ProviderCapped['reason'];
  /** The provider's own words. */
  message: string;
  reached: number;
  cleared: number | undefined;
}

export interface Header {
  running: boolean;
  /** The autonomy level in force: Martin's control (`controls.changed`), Supervised until he sets one. */
  autonomy: Autonomy;
  /** Why the line was stopped, when it is. */
  stopped: string | undefined;
  /** A spend cap reached and not yet cleared: the gateway refuses every model call until it resets. */
  capped: CapSpell | undefined;
  /** Every cap reached so far, oldest first. */
  caps: CapSpell[];
  /** A provider refusing for now: agent calls wait until it answers again. */
  waiting: ProviderSpell | undefined;
  /** Every time a provider refused so, oldest first. */
  providers: ProviderSpell[];
}

export interface Station {
  stage: Stage;
  status: Status;
  /** Lit when an item failed or waits on a human while another is in progress, so the station is still at work. */
  beacon: Beacon | undefined;
  /** One short figure for the caption, such as "2 PRs" or "25%". */
  figure: string;
  /** Tickets queued in the stage, waiting for it to take them: drawn as parcels on the belt in front of it. */
  queued: number;
  /** At Triage, while a spend cap holds: when it resets. The station says "capped", and until when. */
  cappedUntil: number | undefined;
}

export interface Return {
  item: string;
  from: Stage;
  to: Stage;
  /** What the pill says: "#1311 · round 2 · 2 blocking". */
  text: string;
  /** The same without the work item, for a row that names it already: "round 2 · 2 blocking". */
  detail: string;
  at: number;
}

export type RowState = 'in-hand' | 'held' | 'waiting' | 'passed' | 'sent-back' | 'verified';

export interface PanelRow {
  /** The work item's number, or for a release with no work item, its version. */
  item: string;
  /** A release with no work item: its row opens nothing. */
  release?: true;
  title: string;
  note: string;
  /** States it went through in the stage today before this one, struck through in the row: "sent back". */
  earlier: string[];
  /** `signal` for what the station is at work on now. */
  tone: 'signal' | 'ok' | 'attn' | 'faint';
  /**
   * Where it stands, for the row's status icon: in hand, held or failed, waiting for the stage to take it, passed on
   * (or closed) today, sent back upstream today, or verified.
   */
  state: RowState;
  /** It left the stage today: listed after what is in it, under a stronger hairline. */
  left?: true;
  /**
   * At work on it while the station says it is working: the row is marked as the station marks itself. Stopped,
   * capped or held, the station says "blocked", and its rows are not marked.
   */
  working?: true;
  at: number;
}

/** What one sense has sent Triage, counted from events: the signals it became, and the tickets they opened. */
export interface SenseCount {
  sense: Sense;
  signals: number;
  tickets: number;
  /** For reports: where triage sent each one that did not open a ticket. */
  routes: { quarantined: number; parked: number; closed: number; joined: number } | undefined;
}

export interface StagePanel {
  stage: Stage;
  rows: PanelRow[];
  /** Triage: where its work comes from. */
  senses: SenseCount[] | undefined;
  /** Triage: a spend cap that holds, or that cleared today, so one that has cleared can still be seen. */
  caps: CapSpell[];
  /** Tickets waiting in the stage for it to take them. */
  queued: number;
}

/** The line's state for the header, at the autonomy level the controls hold. */
export function header(events: readonly PublicEvent[], autonomy: Autonomy = DEFAULT_CONTROLS.autonomy): Header {
  let state: Header = {
    running: false,
    autonomy,
    stopped: undefined,
    capped: undefined,
    caps: [],
    waiting: undefined,
    providers: [],
  };
  for (const event of events) {
    if (event.type === 'line.started') {
      // The level a start from before the controls named sets nothing: the controls hold the only one.
      state = { ...state, running: true, stopped: undefined };
    }
    if (event.type === 'line.stopped') state = { ...state, running: false, stopped: event.payload.reason };
    if (event.type === 'spend.capped') {
      const capped = event.payload;
      const reached = Date.parse(event.ts);
      if (capped.cap === 'provider') {
        const { provider, reason, message } = capped;
        state = {
          ...state,
          providers: [...state.providers, { provider, reason, message, reached, cleared: undefined }],
        };
      } else {
        const { cap, limitUsd, spentUsd, resets } = capped;
        const spell = { cap, limitUsd, spentUsd, resets: Date.parse(resets), reached, cleared: undefined };
        state = { ...state, caps: [...state.caps, spell] };
      }
    }
    if (event.type === 'spend.cleared') {
      const cleared = event.payload;
      const at = Date.parse(event.ts);
      if (cleared.cap === 'provider') {
        const providers = state.providers.map((spell) =>
          spell.provider === cleared.provider && spell.cleared === undefined ? { ...spell, cleared: at } : spell,
        );
        state = { ...state, providers };
      } else {
        const caps = state.caps.map((spell) =>
          spell.cap === cleared.cap && spell.cleared === undefined ? { ...spell, cleared: at } : spell,
        );
        state = { ...state, caps };
      }
    }
  }
  // When the day's and the month's caps both hold, the month's says when work resumes: it resets last.
  const holding = state.caps.filter((spell) => spell.cleared === undefined);
  const waiting = state.providers.filter((spell) => spell.cleared === undefined).at(-1);
  return { ...state, capped: holding.find((spell) => spell.cap === 'month') ?? holding[0], waiting };
}

/** The scoreboard's figures, or that it is off. */
export type Score = PayloadOf<'score.updated'>;

/** What the scoreboard said last, or nothing if it never has: an older store, or the replay site. */
export function score(events: readonly PublicEvent[]): Score | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'score.updated') return event.payload;
  }
  return undefined;
}

/** Items in a stage now: open, and that stage their latest. */
const inStage = (items: readonly ItemState[], stage: Stage) =>
  items.filter((item) => item.closedAt === undefined && item.stage === stage);

/** How an item closed by a stage's own work, with no failure, ended: it passed through the stage, and is done. */
const CLOSED_NOTE: Partial<Record<ItemState['outcome'], string>> = {
  verified: 'verified',
  closed: 'closed, no change',
  quarantined: 'quarantined',
  'no-ticket': 'closed, no ticket',
  'turned-off': 'turned off',
};

/** Items that left a stage for a later one, or closed in it successfully, and when. */
function leavers(items: readonly ItemState[], stage: Stage): { item: ItemState; at: number }[] {
  return items.flatMap((item) => {
    const left = item.visits[stage]?.leftAt;
    if (left === undefined) return [];
    const closedHere = item.closedAt !== undefined && item.stage === stage;
    if (closedHere && (!CLOSED_NOTE[item.outcome] || item.failure)) return [];
    if (!closedHere && item.stage && STAGES.indexOf(item.stage) < STAGES.indexOf(stage)) return [];
    return [{ item, at: left }];
  });
}

const NOUNS: Record<Stage, [one: string, many: string]> = {
  sense: ['signal', 'signals'],
  triage: ['signal', 'signals'],
  plan: ['spec', 'specs'],
  build: ['change', 'changes'],
  gates: ['PR', 'PRs'],
  review: ['PR', 'PRs'],
  release: ['release', 'releases'],
  verify: ['check', 'checks'],
};

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** The start of the day t falls in, where the viewer is. */
export function startOfDay(t: number): number {
  const day = new Date(t);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * A station's state at t, by the first rule that matches (the design system's README, "From events to a station's
 * status"), and its beacon. Under Stop the line, every station needs you.
 */
export function station(
  stage: Stage,
  items: readonly ItemState[],
  returns: readonly Return[],
  line: Header,
  t: number,
  shipped: readonly Release[] = [],
): Station {
  const present = inStage(items, stage);
  // A ticket waiting for the planner is in the stage, but nothing is being done to it: it queues, and the station
  // stays idle rather than look busy with nobody at work. So does a fix held for a deploy that is not Martin's yet.
  const queued = present.filter(waitsHere);
  const here = present.filter((item) => !waitsHere(item));
  const held = here.filter(waitsOnMartin);
  const failed = here.filter((item) => item.failure?.stage === stage && !item.hold);
  // At Release, the canary in flight, whether it carries work or not.
  const flight = stage === 'release' ? inFlight(shipped) : undefined;
  // A failure or a hold stops the station only when nothing else in it is in progress; otherwise it lights the beacon.
  const busy = Boolean(flight) || here.some((item) => !waitsOnMartin(item) && !failed.includes(item));
  const left = leavers(items, stage);
  const today = left.filter(({ at }) => at >= startOfDay(t)).length;
  // At a spend cap, triage takes no reports until it resets. The senses' tickets need no model, so they still open.
  const capped = stage === 'triage' ? line.capped : undefined;

  let status: Status;
  if (line.stopped !== undefined) status = 'blocked';
  else if (failed.length && !busy) status = 'failed';
  else if ((held.length && !busy) || capped) status = 'blocked';
  else if (returns.some((r) => r.from === stage && t - r.at <= RETURNING_MS)) status = 'returning';
  else if (here.length || flight) status = 'working';
  else if (
    left.some(({ at }) => t - at <= PASSING_MS) ||
    (stage === 'release' && shipped.some((r) => r.end?.kind === 'promoted' && t - r.end.at <= PASSING_MS))
  )
    status = 'passing';
  else status = 'idle';
  const lit = status === 'working' || status === 'returning';
  const beacon = !lit ? undefined : failed.length ? 'failed' : held.length ? 'needs-you' : undefined;

  const share = flight && (flight.weight ? `${flight.weight}%` : 'starting');
  let figure: string;
  // Held when a mechanism stopped every one of them; waiting when the line asked Martin something.
  if (held.length) {
    const words = `${held.length} ${held.every((item) => item.hold?.kind === 'held') ? 'held' : 'waiting'}`;
    figure = share ? `${share} · ${words}` : words;
  } else if (share) {
    // A deploy not Martin's yet waits here as a held one would: counted, as a held one is, beside the canary's share.
    const deploys = queued.filter(deploying).length;
    figure = deploys ? `${share} · ${deploys} waiting` : share;
  } else if (here.length) figure = count(here.length, NOUNS[stage]);
  else if (queued.length) figure = `${queued.length} waiting`;
  else figure = today ? `${today} today` : 'none';
  return { stage, status, beacon, figure, queued: queued.length, cappedUntil: capped?.resets };
}

/**
 * What a station shows while the line draws one of its returns: "sending back", unless it has stopped, failed or
 * waiting on a human (the rules above). A beacon stays lit while it sends.
 */
export function whileSending(status: Status, sending: boolean): Status {
  return sending && status !== 'failed' && status !== 'blocked' ? 'returning' : status;
}

/**
 * The returns to draw: those whose work item has not moved on since, to another stage, a hold or its close. Once it
 * has, the arc would say something no longer true, and the return is only a row in its sender's panel.
 */
export function drawn(returns: readonly Return[], items: readonly ItemState[]): Return[] {
  const sentBack = new Map(items.map((item) => [item.number, item.sentBack]));
  return returns.filter((r) => sentBack.get(r.item) === r.at);
}

/** Work sent back upstream in the last day, newest first. */
export function returnsAt(events: readonly PublicEvent[], t: number): Return[] {
  return events
    .flatMap((event) =>
      event.type === 'work.returned' && event.work_item && t - Date.parse(event.ts) <= RETURNS_MS
        ? [returnOf(event.work_item, event.payload, event.summary, Date.parse(event.ts))]
        : [],
    )
    .reverse();
}

/**
 * A return in words, from what its event records: the round the coder starts and what sent it back, as the line
 * writes them in its summary. A return that recorded no round (version 1) has only its summary to say.
 */
function returnOf(item: string, returned: PayloadOf<'work.returned'>, summary: string, at: number): Return {
  const { from, to, round } = returned;
  // Verify sends work back only when the signal persists: the line's summary says only where it came from.
  if (from === 'verify') return { item, from, to, text: `#${item} · persists · back to Plan`, detail: 'persists', at };
  if (round === undefined) return { item, from, to, text: summary, detail: summary, at };
  const detail = `round ${round} · ${returnWords(returned)}`;
  return { item, from, to, text: `#${item} · ${detail}`, detail, at };
}

/**
 * Work queued at a stage, which nobody there is at: a ticket waiting for the planner, a merged fix waiting for a
 * release, or one held for a deploy that is not Martin's to merge yet, which waits for the build, its checks or Argo
 * CD as a merged fix waits for a release.
 */
const waitsHere = (item: ItemState) => item.queued || deploying(item);

/**
 * An open ticket waiting at Plan for the planner, which an improvement Martin asked for waits behind. A ticket on a work
 * item opened as an improvement is none the line's queue takes.
 */
export const ticketWaits = (item: ItemState) =>
  item.queued &&
  item.ticket !== undefined &&
  item.kind !== 'improvement' &&
  item.stage === 'plan' &&
  item.closedAt === undefined;
const deploying = (item: ItemState) => item.outcome === 'deploying';

/**
 * A row's note for an item in a stage now: what it waits for, or the last thing that happened to it there. `behind`
 * is whether open tickets wait at Plan, which an improvement Martin asked for waits behind. A held item whose signal a
 * look again found cleared says on which version; the sheet says the rest.
 */
function noteOf(item: ItemState, stage: Stage, behind = false): string {
  const note = holdNote(item, stage, behind);
  if (!item.hold || !item.cleared) return note;
  const { version } = item.cleared;
  return `${note} · cleared${version ? ` on ${shortVersion(version)}` : ''}`;
}

/** A kicker after "Needs you · ", in lower case but for a station's name: "held by a gate", "Verify asks you". */
const midSentence = (words: string) =>
  STAGES.some((stage) => words.startsWith(`${stage[0]?.toUpperCase()}${stage.slice(1)} `))
    ? words
    : `${words[0]?.toLowerCase()}${words.slice(1)}`;

/** Whether a work item waits on Martin where it is: a hold, or an improvement's flag waiting for him to widen it. */
const waitsOnMartin = (item: ItemState) => item.hold !== undefined || item.outcome === 'needs-you';

function holdNote(item: ItemState, stage: Stage, behind: boolean): string {
  if (item.waitingOn) return item.waitingOn.reason;
  // Martin's request, until the planner takes it: the line takes it once no open ticket waits.
  if (item.queued && item.request && stage === 'plan') {
    return `Asked by Martin · ${behind ? 'waiting behind the open tickets' : 'waiting for the planner'}`;
  }
  // Held for a deploy that is not Martin's yet: what it waits for, and the deploy pull request by number.
  if (item.outcome === 'deploying') {
    return `${endedSinceMerge(item) ? 'Rolled back' : 'Merged'} · ${deployWords(item.deploy).short}`;
  }
  if (item.queued) return item.stage === 'release' ? 'Merged · waiting for release' : 'Waiting for the planner';
  if (item.hold?.cause === 'merge') return 'Needs you · waiting for Martin’s merge';
  // A merged fix waits for a deploy pull request, again when the release that carried it rolled back, was aborted or
  // stopped by an analysis error, or for Martin's retry of that release.
  if (item.hold?.cause === 'deploy') {
    const ended = endedSinceMerge(item);
    if (!ended) return 'Needs you · waiting for Martin’s deploy';
    if (!ended.stopped) return 'Needs you · rolled back, waiting for Martin’s retry or next deploy';
    return `Needs you · ${stopWords(ended.stopped)}, ${stopWait(ended.stopped)}`;
  }
  // Every other hold in its card's words, never the agent's own: those are on its sheet and its card.
  if (item.hold) return `Needs you · ${midSentence(holdKicker(item, item.hold))}`;
  // An improvement out behind its flag, waiting for Martin to widen it.
  const flag = item.outcome === 'needs-you' ? itemFlag(item) : undefined;
  if (flag?.now.stage) return `Needs you · flag at ${STAGE_NAME[flag.now.stage.stage]} · waiting for Martin to widen`;
  // Promoted, it is at Verify while the sense that saw it looks again: the promotion is Release's news, not Verify's.
  const latest = item.latest[stage];
  if (latest?.type === 'release.promoted') {
    const { dryRun, watched } = latest.payload;
    return `${dryRun ? 'Promoted in a dry run' : watched ? 'Promoted' : 'Found live'} · verifying`;
  }
  return latest?.summary ?? '';
}

/** Where a return went, and why, as a row's note: "Sent back to Build · round 2 · 2 blocking". */
const sentTo = (r: Return) => `Sent back to ${r.to[0]?.toUpperCase()}${r.to.slice(1)} · ${r.detail}`;

/** Returns kept in a row as earlier states: "sent back", or "sent back 2 times". */
const sentBackWords = (n: number) => (n === 1 ? 'sent back' : `sent back ${n} times`);

/** Rows by work-item number, the newest first. */
const newestFirst = (a: PanelRow, b: PanelRow) => Number(b.item) - Number(a.item);

/**
 * What is in a stage, by what the station is doing with it: at work on it, held or failed in it, waiting for it. No
 * row in the stage has left it; those states have a place so that every state does.
 */
const IN_STAGE: Record<RowState, number> = {
  'in-hand': 0,
  held: 1,
  waiting: 2,
  passed: 3,
  'sent-back': 3,
  verified: 3,
};

/** What the station is working on first, then what is held or failed, then what waits; each newest first. */
const inHandFirst = (a: PanelRow, b: PanelRow) => IN_STAGE[a.state] - IN_STAGE[b.state] || newestFirst(a, b);

/**
 * What a stage panel lists: the items in the stage now, then what left it today, one row each. A work item the
 * stage sent back today keeps its returns in its row as earlier states, or, gone upstream, is a row for its return.
 */
export function panel(
  stage: Stage,
  items: readonly ItemState[],
  returns: readonly Return[],
  events: readonly PublicEvent[],
  line: Header,
  t: number,
  shipped: readonly Release[] = [],
): StagePanel {
  const present = inStage(items, stage);
  const behind = present.some(ticketWaits);
  const now = present.map(
    (item): PanelRow => ({
      item: item.number,
      title: item.title,
      note: noteOf(item, stage, behind),
      earlier: [],
      tone: deploying(item) ? 'faint' : waitsOnMartin(item) || item.failure ? 'attn' : item.queued ? 'faint' : 'signal',
      state: deploying(item)
        ? 'waiting'
        : waitsOnMartin(item) || item.failure
          ? 'held'
          : item.queued
            ? 'waiting'
            : 'in-hand',
      at: item.lastAt,
    }),
  );
  const done = leavers(items, stage)
    .filter(({ at }) => at >= startOfDay(t))
    .map(
      ({ item, at }): PanelRow => ({
        item: item.number,
        title: item.title,
        note: stage === item.stage ? (CLOSED_NOTE[item.outcome] ?? 'passed') : `passed on to ${item.stage ?? ''}`,
        earlier: [],
        // Only a verified result is `ok`: one closed at Verify for another reason passed through it.
        tone: stage === 'verify' && item.outcome === 'verified' ? 'ok' : 'faint',
        state: stage === 'verify' && item.outcome === 'verified' ? 'verified' : 'passed',
        left: true,
        at,
      }),
    );
  // The stage's returns today, by work item, each newest first.
  const sent = new Map<string, Return[]>();
  for (const r of returns) {
    if (r.from === stage && r.at >= startOfDay(t)) sent.set(r.item, [...(sent.get(r.item) ?? []), r]);
  }
  const back: PanelRow[] = [];
  for (const [number, [latest, ...before]] of sent) {
    const row = [...now, ...done].find((r) => r.item === number);
    const item = items.find((i) => i.number === number);
    // One that has passed the stage since and gone upstream from a later one is not this stage's to list.
    const since = item?.visits[stage]?.leftAt;
    if (row) row.earlier.push(sentBackWords(before.length + 1));
    else if (latest && item && (since === undefined || since < latest.at)) {
      back.push({
        item: number,
        title: item.title,
        note: sentTo(latest),
        earlier: before.length ? [sentBackWords(before.length)] : [],
        tone: 'faint',
        state: 'sent-back',
        left: true,
        at: latest.at,
      });
    }
  }
  const triage = stage === 'triage';
  // Release lists the releases that carry no work item too, by version: the one in flight first, then today's.
  const flight = inFlight(shipped);
  const own = (stage === 'release' ? shipped : [])
    .filter((r) => !r.items.length && (r === flight || (r.end && r.end.at >= startOfDay(t))))
    .reverse()
    .map(ownRow);
  const { status } = station(stage, items, returns, line, t, shipped);
  const lit = status === 'working' || status === 'returning';
  const mark = (row: PanelRow): PanelRow => (lit && row.state === 'in-hand' ? { ...row, working: true } : row);
  return {
    stage,
    // What is in the stage, the work in hand first, then what left it today, each newest first: the store numbers
    // work items in order. The line takes the oldest ticket, so by number alone the one in hand would sit below
    // every newer one waiting behind it.
    rows: [
      ...own.filter((row) => row.state === 'in-hand'),
      ...now.sort(inHandFirst),
      ...[...done, ...back].sort(newestFirst),
      ...own.filter((row) => row.state !== 'in-hand'),
    ].map(mark),
    senses: triage ? senseCounts(items, events) : undefined,
    caps: triage ? line.caps.filter((spell) => spell.cleared === undefined || spell.cleared >= startOfDay(t)) : [],
    queued: present.filter(waitsHere).length,
  };
}

/** A release with no work item, as a row in Release's panel: "v0.9.10 · rolled back at 25% · opened #1308". */
function ownRow(r: Release): PanelRow {
  const { end } = r;
  const note = !end
    ? r.weight
      ? `canary at ${r.weight}%`
      : 'canary starting'
    : end.kind === 'promoted'
      ? 'promoted'
      : end.kind !== 'rolled-back'
        ? `${endedWords(end)} at ${end.weight}%`
        : `rolled back at ${end.weight}%${end.ticket ? ` · ${SIGNALLED[end.ticket.how]} #${end.ticket.number}` : ''}`;
  const tone = !end ? 'signal' : end.kind === 'promoted' ? 'faint' : 'attn';
  return {
    item: r.version,
    release: true,
    title: 'A release with no work item',
    note,
    earlier: [],
    tone,
    state: !end ? 'in-hand' : end.kind === 'promoted' ? 'passed' : 'held',
    ...(end && { left: true as const }),
    at: end?.at ?? r.startedAt,
  };
}

/**
 * What each sense has sent Triage, from events alone: every signal triage made an event of (one that opened a
 * ticket, or the first time a sense added its evidence to one), and the tickets each sense's signal opened. A sense
 * seeing an open ticket's problem again is counted by the inbox, which is not events, so not here.
 */
export function senseCounts(items: readonly ItemState[], events: readonly PublicEvent[]): SenseCount[] {
  const counts = new Map<Sense, SenseCount>(
    SENSES.map((sense) => [
      sense,
      {
        sense,
        signals: 0,
        tickets: 0,
        routes: sense === 'report' ? { quarantined: 0, parked: 0, closed: 0, joined: 0 } : undefined,
      },
    ]),
  );
  const routes = counts.get('report')?.routes;
  // A judgement follows the signal it judged, in its work item: a report's, or a planner's finding, which is no sense's.
  const judging = new Map<string | null, string>();
  for (const event of events) {
    if (event.type === 'signal.received') {
      judging.set(event.work_item, event.payload.sense);
      const found = isSense(event.payload.sense) ? counts.get(event.payload.sense) : undefined;
      if (found) found.signals += 1;
    }
    if (event.type === 'judgement.made' && routes && judging.get(event.work_item) === 'report') {
      if (event.payload.route === 'quarantine') routes.quarantined += 1;
      if (event.payload.route === 'park') routes.parked += 1;
      if (event.payload.route === 'discard') routes.closed += 1;
      if (event.payload.route === 'repeat') routes.joined += 1;
    }
  }
  for (const item of items) {
    if (!item.ticket) continue;
    const opener = item.events.find((event) => event.type === 'signal.received');
    const found =
      opener?.type === 'signal.received' && isSense(opener.payload.sense)
        ? counts.get(opener.payload.sense)
        : undefined;
    if (found) found.tickets += 1;
  }
  return [...counts.values()];
}
