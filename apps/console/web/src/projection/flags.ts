/**
 * The feature flags, as everyone sees them: each flag an improvement ships behind, the stage Martin set it at, and what
 * each stop of its slider would take now, judged by the rules the admin service refuses a move by
 * (`policy/flag-moves.ts`), so the console says why a stop can't be taken in the service's own words.
 *
 * A flag's stage is read from Martin's `flag.staged` events, as the admin service records each move, Verify's
 * `flag.compared` at Share and its `flag.checked` at Checks and Preview; which flag is whose, from the latest spec of
 * each improvement. The service judges a move from the stage `flags` holds, and refuses one that the events have run
 * behind: the console only draws.
 *
 * A flag shows once its release is out, or once Martin has staged it. Waiting for Martin to widen, it is a card in
 * Needs you, but while Verify is still checking it at Checks or Preview, or comparing its two sides at Share.
 */
import { inBothSchemes, type PayloadOf, type PublicEvent, type Screenshot } from '@software-factory/events';
import {
  type Around,
  type Check,
  type Comparison,
  checkOf,
  comparisonOf,
  type FlagNow,
  type FlagRecord,
  flagsFrom,
  type Move,
  movesOf,
  sameStage,
  stageWords,
  turnedOffFromEveryone,
} from '@software-factory/policy/flag-moves';
import { type Share, STAGES, type Stage, type StageName } from '@software-factory/policy/flags';
import { controlsInForce } from '@software-factory/policy/line';
import { clock, percent, shortVersion } from '../format.ts';
import type { ItemState } from './items.ts';
import { waited } from './needs.ts';
import { inFlight, type Release, type Tone } from './release.ts';

export type { Check, Comparison, Move } from '@software-factory/policy/flag-moves';
export type { Share, Stage, StageName } from '@software-factory/policy/flags';

/** A stage's name, as the console says it everywhere. */
export const STAGE_NAME: Record<StageName, string> = {
  off: 'Off',
  checks: 'Checks',
  preview: 'Preview',
  share: 'Share',
  everyone: 'Everyone',
};

/** Who gets a flag on at each stage, in the README's words (the design system's "The stages"). */
export function stageSays(stage: Stage): string {
  switch (stage.stage) {
    case 'off':
      return 'Off for everyone, a preview too. The code is in the app, and nothing runs it.';
    case 'checks':
      return 'On for the factory’s own checks alone: the probes, the crawler and the canary’s journeys. Nobody else sees it.';
    case 'preview':
      return 'On for the checks, and for anyone who asks to preview it, in their own browser.';
    case 'share':
      return `On for the checks, a preview, and ${stage.share}% of the traffic generator’s requests, so Verify can compare the two sides. Visitors still don’t see it.`;
    case 'everyone':
      return 'On for every visitor.';
  }
}

/** One stop of a flag's slider: its stage (Share at the share it shows), and the move there, judged. */
export interface Stop {
  stage: StageName;
  to: Stage;
  move: Move;
  /** Passed (filled), where it stands (ringed), or ahead (hollow). */
  place: 'done' | 'now' | 'ahead';
}

/** Verify's latest comparison of a flag at Share since Martin last moved it, with when. */
export type Compared = PayloadOf<'flag.compared'> & { at: number };

/** Verify's check of a flag with the probes at Checks or Preview since Martin moved it there, with when and its pictures. */
export type Checked = Exclude<PayloadOf<'flag.checked'>, { stage: 'off' }> & { at: number; shots: Screenshot[] };

/** A check's payload and its event's screenshots, as the sheet and the card draw them. */
export function checkedOf(event: PublicEvent & { type: 'flag.checked' }): Checked | undefined {
  if (event.payload.stage === 'off') return undefined;
  const shots = event.artifacts.filter((artifact): artifact is Screenshot => artifact.kind === 'screenshot');
  return { ...event.payload, at: Date.parse(event.ts), shots };
}

/** A screenshot a check names by its hash, among its event's. */
export const shotOf = (checked: Checked, hash: string | undefined): Screenshot | undefined =>
  hash === undefined ? undefined : checked.shots.find((shot) => shot.hash === hash);

/**
 * Whether an event may be Verify's: the line appends its comparisons and checks as the factory. The public log does not
 * say which role appended an event, as the store and the admin service read it, so another worker's under that actor
 * is still drawn: the service refuses by the store's reading.
 */
export const fromVerify = (event: PublicEvent) => event.actor === 'factory';

export interface FlagRow {
  name: string;
  /** The work item it ships on: the improvement whose spec names it, or the one it was staged on. */
  workItem: string;
  title: string;
  /** The first page its spec changes, which a preview opens: the front page when the spec names none. */
  page: string;
  /** Where it stands: off until Martin stages it. */
  stage: Stage;
  /** The share its Share stop shows: the one it is at, or was last at, or half and half. */
  share: Share;
  stops: Stop[];
  /** Every stage it could go to, Share at each share, judged. */
  moves: Move[];
  /** At Share, Verify's comparison as it stands. */
  comparison: Comparison | undefined;
  compared: Compared | undefined;
  /** At Checks or Preview, Verify's check with the probes as it stands, and the check itself once it has run. */
  check: Check | undefined;
  checked: Checked | undefined;
  /** Turned off from Everyone: it may go straight back. */
  backOn: boolean;
  /** Turned off by Martin, rather than never widened. */
  turnedOff: boolean;
  /**
   * Turned off, but not from Everyone, and its work item closed, as turned off (the line closes it once Martin turns
   * the flag off) or as verified (it was on for everyone, then narrowed): folded under Turned off and closed. One
   * turned off from Everyone may go straight back, so it stays.
   */
  closed: boolean;
  /** Its work item is still open: turning the flag off closes it. */
  open: boolean;
  /** Its work item closed as verified, once the flag was on for everyone: turning it off then closes nothing more. */
  done: boolean;
  /**
   * The work item Martin's take of Just one names, when it is another: the line acts on that one alone, so it closes
   * this one as turned off only once it takes more.
   */
  justOne: string | undefined;
  /** When it came to stand where it does: Martin's last move, or its release. */
  since: number;
  /** The release that shipped it, with the flag off. */
  released: { version: string; at: number } | undefined;
}

/** A flag waiting for Martin to widen it: its card in Needs you. */
export interface FlagNeed {
  flag: string;
  workItem: string;
  title: string;
  /** "Ready to widen", "Shipped behind its flag" (released, still off), or "Turned off". */
  kicker: string;
  stage: Stage;
  waited: string;
  since: number;
  /** The one thing to know before widening, in a sentence. */
  evidence: string;
  /** At Checks, the first page the probes pictured, with the flag off (none without a run to compare with) and on. */
  pictures: { page: string; off: Screenshot | undefined; on: Screenshot } | undefined;
  /** The next stage, judged: Widen to it, or why it can't be taken now. */
  widen: Move;
  /** Turn off, when the flag is on for anyone. */
  turnOff: Move | undefined;
}

export interface FlagsView {
  /** The flags in the app, oldest work item first. */
  flags: FlagRow[];
  /** Turned off before everyone had them, their work items closed. */
  closed: FlagRow[];
  /** Each flag waiting for Martin to widen it, oldest first. */
  needs: FlagNeed[];
}

/** The flag an improvement's latest spec names, if it is one. */
function specFlag(item: ItemState): string | undefined {
  return improvementSpec(item)?.flag;
}

/** An improvement's latest spec, the planner's, as the line and the admin service read only the line's own. */
function improvementSpec(item: ItemState): PayloadOf<'spec.written'> | undefined {
  if (item.kind !== 'improvement') return undefined;
  const spec = item.events.findLast((event) => event.type === 'spec.written' && event.actor === 'planner');
  return spec?.type === 'spec.written' ? spec.payload : undefined;
}

/**
 * The events a flag's state is read from: Martin's moves, which only his roles can append, and Verify's comparisons,
 * its checks at Checks and Preview, and its baselines with the flag off, which let Checks be taken.
 */
function records(events: readonly PublicEvent[]): FlagRecord[] {
  return events.flatMap((event): FlagRecord[] => {
    if (event.type === 'flag.staged' && event.actor === 'martin' && event.work_item) {
      const { flag, from, to, revision } = event.payload;
      return [{ type: 'flag.staged', flag, workItem: event.work_item, from, to, revision }];
    }
    if (event.type === 'flag.compared' && fromVerify(event)) {
      const { flag, share, outcome, moveRevision } = event.payload;
      return [{ type: 'flag.compared', flag, share, outcome, moveRevision }];
    }
    if (event.type === 'flag.checked' && fromVerify(event) && event.work_item) {
      const check = event.payload;
      if (check.stage === 'off') {
        const bothSchemes = inBothSchemes(check.pages);
        return [{ type: 'flag.checked', flag: check.flag, stage: 'off', workItem: event.work_item, bothSchemes }];
      }
      const { flag, stage, outcome, moveRevision } = check;
      return [{ type: 'flag.checked', flag, stage, outcome, moveRevision }];
    }
    return [];
  });
}

/** When an item's release that went to all the traffic did, and its version: the first one, with the flag off. */
function releasedOf(item: ItemState): FlagRow['released'] {
  const promoted = item.events.find((event) => event.type === 'release.promoted');
  return promoted?.type === 'release.promoted'
    ? { version: promoted.payload.version, at: Date.parse(promoted.ts) }
    : undefined;
}

/** Where a flag stands on its own work item's events alone: what the card and the item's outcome need. */
export function itemFlag(item: ItemState): { name: string; now: FlagNow; built: boolean } | undefined {
  const name = specFlag(item);
  if (!name) return undefined;
  const now = flagsFrom(
    records(item.events).filter((record) => record.flag === name),
    { [name]: item.number },
  )[name] ?? { stage: { stage: 'off' } };
  return { name, now, built: Boolean(releasedOf(item)) || now.last !== undefined };
}

/**
 * Whether an open improvement waits for Martin to widen its flag: built, short of Everyone, and not while Verify is
 * still checking it at Checks or Preview, or comparing its two sides at Share. Its outcome is then Needs you.
 */
export function flagWaits(item: ItemState): boolean {
  const flag = itemFlag(item);
  // As its card in Needs you: only once its release is out.
  if (!flag || !releasedOf(item)) return false;
  const { now } = flag;
  return now.stage?.stage !== 'everyone' && comparisonOf(now) !== 'comparing' && checkOf(now) !== 'checking';
}

/** The latest of a flag's moves on the events, and the comparison and the check since it. */
function latest(events: readonly PublicEvent[], flag: string) {
  let staged: (PublicEvent & { type: 'flag.staged' }) | undefined;
  let compared: Compared | undefined;
  let checked: Checked | undefined;
  for (const event of events) {
    // A move as `flagsFrom` counts it: Martin's, on a work item.
    if (event.type === 'flag.staged' && event.actor === 'martin' && event.work_item && event.payload.flag === flag) {
      staged = event;
      compared = undefined;
      checked = undefined;
    }
    // Each judgement of the latest move alone, as `flagsFrom` counts them: by the revision the move wrote.
    const judged = (moveRevision: string) => staged?.payload.revision === moveRevision;
    if (event.type === 'flag.compared' && fromVerify(event) && event.payload.flag === flag) {
      if (judged(event.payload.moveRevision)) compared = { ...event.payload, at: Date.parse(event.ts) };
    }
    if (event.type === 'flag.checked' && fromVerify(event) && event.payload.flag === flag) {
      const check = checkedOf(event);
      if (check && judged(check.moveRevision)) checked = check;
    }
  }
  return { staged, compared, checked };
}

/** The share a flag's Share stop shows: the one it is at or last went to, or 50, which fills both sides soonest. */
function shareOf(events: readonly PublicEvent[], flag: string, now: FlagNow): Share {
  if (now.stage?.stage === 'share') return now.stage.share;
  const last = events.findLast(
    (event) =>
      event.type === 'flag.staged' &&
      event.actor === 'martin' &&
      event.payload.flag === flag &&
      event.payload.to.stage === 'share',
  );
  return last?.type === 'flag.staged' && last.payload.to.stage === 'share' ? last.payload.to.share : 50;
}

const rank = (stage: StageName) => STAGES.indexOf(stage);

/** A stage at a share, Share at the one given. */
export const stageAt = (stage: StageName, share: Share): Stage => (stage === 'share' ? { stage, share } : { stage });

/** The move to a stage among a flag's judged moves. */
export const moveTo = (moves: readonly Move[], to: Stage): Move | undefined =>
  moves.find((move) => sameStage(move.to, to));

/** What a move into Share waits for: another flag there, and the canary in flight, as the samples' releases say. */
function aroundOf(flags: Record<string, FlagNow>, flag: string, shipped: readonly Release[]): Around {
  const atShare = Object.entries(flags).find(([name, now]) => name !== flag && now.stage?.stage === 'share')?.[0];
  const flight = inFlight(shipped);
  return {
    ...(atShare && { atShare }),
    // A dry run sends nothing to a canary, so no traffic of it mixes the two sides.
    ...(flight && !flight.dryRun && { canary: { version: shortVersion(flight.version), weight: flight.weight } }),
  };
}

/** The flags, as their events had them by now. */
export function flagsView(
  seen: readonly PublicEvent[],
  items: readonly ItemState[],
  shipped: readonly Release[],
  t: number,
): FlagsView {
  const byNumber = new Map(items.map((item) => [item.number, item]));
  // The flag each improvement's latest spec names; the work item of the latest such spec wins, as the admin service reads it.
  const named: Record<string, string> = {};
  const specs = items.flatMap((item) => {
    const flag = specFlag(item);
    const spec = item.events.findLast((event) => event.type === 'spec.written' && event.actor === 'planner');
    return flag && spec ? [{ flag, number: item.number, seq: spec.seq }] : [];
  });
  for (const { flag, number } of specs.sort((a, b) => a.seq - b.seq)) named[flag] = number;
  const all = flagsFrom(records(seen), named);
  const chosen = seen.findLast((event) => event.type === 'controls.changed' && event.actor === 'martin');
  const take = controlsInForce(chosen?.payload).take;
  const rows: FlagRow[] = [];
  for (const [name, now] of Object.entries(all)) {
    const workItem = now.workItem ?? now.stagedOn;
    const item = workItem ? byNumber.get(workItem) : undefined;
    if (!workItem || !item) continue;
    const released = releasedOf(item);
    // A flag shows once its release is out, or once Martin has moved it.
    if (!released && !now.last) continue;
    const stage = now.stage ?? { stage: 'off' };
    const share = shareOf(seen, name, now);
    const moves = movesOf(name, now, aroundOf(all, name, shipped));
    const { staged, compared, checked } = latest(seen, name);
    const at = rank(stage.stage);
    const backOn = turnedOffFromEveryone(now);
    const turnedOff = stage.stage === 'off' && now.last?.to.stage === 'off';
    rows.push({
      name,
      workItem,
      title: item.title,
      page: improvementSpec(item)?.pages?.[0] ?? '/',
      stage,
      share,
      stops: STAGES.map((s, i): Stop => {
        const to = stageAt(s, share);
        return {
          stage: s,
          to,
          move: moveTo(moves, to) ?? { to, action: undefined },
          place: i < at ? 'done' : i === at ? 'now' : 'ahead',
        };
      }),
      moves,
      comparison: comparisonOf(now),
      compared: compared && stage.stage === 'share' && compared.share === stage.share ? compared : undefined,
      check: checkOf(now),
      checked: checked && checked.stage === stage.stage ? checked : undefined,
      backOn,
      turnedOff,
      closed: stage.stage === 'off' && (item.outcome === 'turned-off' || item.outcome === 'verified') && !backOn,
      open: item.closedAt === undefined,
      done: item.outcome === 'verified',
      justOne: take?.kind === 'just-one' && take.workItem !== workItem ? take.workItem : undefined,
      since: staged ? Date.parse(staged.ts) : (released?.at ?? item.openedAt),
      released,
    });
  }
  const order = (a: FlagRow, b: FlagRow) =>
    (byNumber.get(a.workItem)?.openedAt ?? 0) - (byNumber.get(b.workItem)?.openedAt ?? 0);
  const flags = rows.filter((row) => !row.closed).sort(order);
  return {
    flags,
    closed: rows.filter((row) => row.closed).sort(order),
    needs: flags
      .filter((row) => {
        const item = byNumber.get(row.workItem);
        return (
          item?.closedAt === undefined &&
          row.stage.stage !== 'everyone' &&
          row.comparison !== 'comparing' &&
          row.check !== 'checking' &&
          row.released
        );
      })
      .map((row) => needOf(row, t))
      .sort((a, b) => a.since - b.since),
  };
}

/** The stage after a flag's, which Widen to takes it to: back to Everyone for a flag turned off from there. */
function nextOf(row: FlagRow): Stage {
  if (row.backOn) return { stage: 'everyone' };
  const next = STAGES[rank(row.stage.stage) + 1] ?? 'everyone';
  return stageAt(next, row.stage.stage === 'share' ? row.share : 50);
}

const percentOf = (rate: number | null) => (rate === null ? 'none' : percent(rate, 2));

/**
 * A check's result in a sentence: "22 of 24 checks passed with it on, against 22 of 24 with it off: none that passed
 * with it off failed", and at Preview what the device check found, unless the sheet draws that itself. Failed or
 * unsure, Verify's own reason.
 */
function checkedWords(checked: Checked, device = true): string {
  const { change, base } = checked.journeys;
  const counted = `${change.passed} of ${change.ran} checks passed with it on${base ? `, against ${base.passed} of ${base.ran} with it off` : ''}`;
  if (checked.outcome !== 'passed') {
    const why = checked.reason ?? (checked.outcome === 'failed' ? 'It failed.' : 'It could not tell.');
    return `${counted}. ${why.replace(/([^.])$/, '$1.')}`;
  }
  return `${counted}: none that passed with it off failed${checked.stage === 'preview' && device ? ', and the device check found the preview cookie and nothing new kept' : ''}.`;
}

/** A comparison's figures in a sentence: "errors 0.97% and 1.01%, p99 41 ms and 40 ms, over 412 and 398 requests". */
export function comparedWords({ sides: { on, off } }: Compared): string {
  const p99 = (ms: number | null) => (ms === null ? 'none' : `${ms} ms`);
  return `errors ${percentOf(on.errorRate)} and ${percentOf(off.errorRate)}, p99 ${p99(on.p99Ms)} and ${p99(off.p99Ms)}, over ${on.requests} and ${off.requests} requests`;
}

function needOf(row: FlagRow, t: number): FlagNeed {
  const next = nextOf(row);
  const widen = moveTo(row.moves, next) ?? { to: next, action: undefined };
  const { stage } = row;
  const evidence =
    stage.stage === 'off'
      ? row.turnedOff
        ? `Turned off. ${row.backOn ? 'It was on for everyone, so it may go straight back.' : 'Widening it again starts at Checks.'}`
        : `Released in ${row.released ? shortVersion(row.released.version) : 'its release'} with ${row.name} off. At Checks, only the factory’s own checks see it on.`
      : stage.stage === 'checks'
        ? `${row.checked ? `${checkedWords(row.checked)} ` : ''}No probe knows a new feature: judge the pages off and on before you widen.`
        : stage.stage === 'preview'
          ? row.checked
            ? checkedWords(row.checked)
            : 'Anyone who asks can preview it, in their own browser, with only the cookie they asked for.'
          : row.compared
            ? `Flag on against off, on the traffic generator’s requests: ${comparedWords(row.compared)}. ${row.compared.outcome === 'passed' ? 'Within the canary’s thresholds.' : (row.compared.reason ?? 'It failed the canary’s thresholds.')}`
            : stageSays(stage);
  // The first page pictured with the flag on.
  const { checked } = row;
  const page = checked?.stage === 'checks' ? checked.pages.find((p) => shotOf(checked, p.on) !== undefined) : undefined;
  const on = page && checked && shotOf(checked, page.on);
  return {
    flag: row.name,
    workItem: row.workItem,
    title: row.title,
    kicker: stage.stage !== 'off' ? 'Ready to widen' : row.turnedOff ? 'Turned off' : 'Shipped behind its flag',
    stage,
    waited: waited(t - row.since),
    since: row.since,
    evidence,
    pictures: page && on && row.checked ? { page: page.page, off: shotOf(row.checked, page.off), on } : undefined,
    widen,
    turnOff: stage.stage === 'off' ? undefined : moveTo(row.moves, { stage: 'off' }),
  };
}

/**
 * One block of an improvement's flag on its sheet: its release, with the flag off, and then each move Martin made of it,
 * with Verify's check at Checks and Preview, and its comparison at Share.
 */
export type FlagBlock =
  | { kind: 'released'; at: number; version: string; release: string }
  | {
      kind: 'staged';
      at: number;
      stage: Stage;
      from: Stage | null;
      /** Martin widened it, narrowed it, turned it off, or turned it back on. */
      action: PayloadOf<'flag.staged'>['action'];
      /** Whether his passkey was given for it: every widening past Checks. */
      passkey: boolean;
      reason: string | undefined;
      /** Flags set by hand outside every stage that the write dropped, and so turned off. */
      dropped: string[];
      /** The move the flag stands at now. */
      current: boolean;
      /** The revision the move wrote, which Verify's judgement of it names. */
      revision: string;
      /** At Share, Verify's comparison there, if it has judged. */
      compared: Compared | undefined;
      /** At Checks or Preview, Verify's check there with the probes, if it has run. */
      checked: Checked | undefined;
    };

/** A block's word, in its tone: how the stage stands. */
export function blockWord(block: FlagBlock): [string, Tone] {
  if (block.kind === 'released') return ['Off', 'faint'];
  const { stage } = block;
  if (stage.stage === 'off') return ['Turned off', 'faint'];
  if (stage.stage === 'share') {
    if (block.compared) return block.compared.outcome === 'passed' ? ['Passed', 'ok'] : ['Failed', 'attn'];
    return block.current ? ['Comparing', 'signal'] : ['Stopped', 'faint'];
  }
  if (stage.stage === 'everyone') return block.current ? ['On for everyone', 'ok'] : ['Widened past', 'faint'];
  if (block.checked) {
    return { passed: ['Passed', 'ok'], failed: ['Failed', 'attn'], unsure: ['Could not tell', 'faint'] }[
      block.checked.outcome
    ] as [string, Tone];
  }
  return block.current ? ['Checking', 'signal'] : ['Widened past', 'faint'];
}

/** What Verify found at Checks or Preview, in a sentence; or, before it has, what it waits for. */
export function checkWords(block: Extract<FlagBlock, { kind: 'staged' }>, next: string): string {
  if (block.checked) return `Checked at ${clock(block.checked.at)}: ${checkedWords(block.checked, false)}`;
  return block.current
    ? `Verify checks it with the probes, against a run with it off. ${next} can be taken once the check has passed.`
    : 'Moved on before Verify had checked it.';
}

/** Each of Martin's moves of a flag, as a block of its sheet says who made it. */
const MADE_BY: Record<PayloadOf<'flag.staged'>['action'], string> = {
  'flag.to-checks': 'Widened by Martin',
  'flag.widen': 'Widened by Martin',
  'flag.back-on': 'Turned back on by Martin',
  'flag.narrow': 'Narrowed by Martin',
  'flag.off': 'Turned off by Martin',
};

/** How Martin made the move, in a few words: "widened by Martin, with his passkey". */
export function byWords(block: Extract<FlagBlock, { kind: 'staged' }>): string {
  return `${MADE_BY[block.action]}${block.from ? ` from ${stageWords(block.from)}` : ''}${block.passkey ? ', with his passkey' : ''}`;
}
