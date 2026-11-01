/**
 * One work item in full, at time t: what happened, a chapter per step through the line with the site as it was
 * at each, the evidence, the change, the facts, the agents and models, and the gates.
 */
import type {
  DefectCategory,
  Kind,
  PayloadOf,
  PublicEvent,
  Screenshot,
  Sense,
  SymptomClass,
} from '@software-factory/events';
import { clearedOnWords, knownInScope, LIMITS, SENSES } from '@software-factory/events';
import { FLAG_STEP_UP } from '../access.ts';
import { clock, listed, plural, shortVersion } from '../format.ts';
import {
  type Attempt,
  attempts,
  deployPicture,
  type RoundsNow,
  reviewThread,
  roundsNow,
  startsPass,
  type ThreadReview,
} from './fixing.ts';
import { checkedOf, type FlagBlock, type FlagNeed, type FlagRow, fromVerify, itemFlag, STAGE_NAME } from './flags.ts';
import { type Capture, clearanceWords, endsRelease, type Hold, type ItemState, summaryOf } from './items.ts';
import type { CanaryNeed, Need } from './needs.ts';
import { bySense, type Card, card, type Picture, picture, pictureOfSignal } from './reel.ts';
import { endedAt, type Release, releases, type StoppedBy, stoppedBy } from './release.ts';
import { reportText } from './report.ts';
import { SENSE } from './senses.ts';

export interface Chapter {
  label: string;
  at: number;
  actor: PublicEvent['actor'] | undefined;
  text: string;
  /** Where along the scrubber by time, from 0 to 100: the scrubber spreads them out (`scrubbed`). */
  position: number;
  /**
   * The pass through the line it belongs to: a return to Plan (a persisting verification, or Martin's after the
   * merge) sends the work round again, and a reopening starts it again (`startsPass`).
   */
  pass: number;
  /** The site's screenshot as it stood at this point, if the factory had captured one. */
  site: Capture | undefined;
  tone: 'signal' | 'ok' | 'attn' | 'faint';
  /** The chapter where the work waits for a stage to take it, drawn as a larger hollow ring. */
  waiting?: boolean;
}

export interface AgentRow {
  agent: string;
  /** Who served the calls, read from the events: Jev is always TypeSafe's; Claude is Anthropic's or Bedrock's. */
  provider: PayloadOf<'model.called'>['provider'] | 'typesafe';
  model: string;
  /** The settings, or for Jev each question set asked and how many questions it holds. */
  details: string[];
  calls: number;
  /** The agent's steps: each `model.called` is one. A resumed coder is one agent over two steps. */
  steps: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface GateRow {
  check: string;
  /** Neutral is a review that asked for changes: a signal, and nothing failed. */
  conclusion: 'success' | 'failure' | 'skipped' | 'neutral';
  durationMs: number | undefined;
  /** The check's own one line, where it gave one. */
  summary: string | undefined;
  /** Required by the rules on main; a signal otherwise, which informs the line and never blocks a merge. */
  required: boolean;
}

/** One path the spec lets the coder change, or one changed outside it. */
interface ScopeRow {
  path: string;
  /** The lines added and removed there; nothing when it is untouched. */
  added: number | undefined;
  removed: number | undefined;
  /** A path outside the scope: refused by the fence, or pushed anyway. */
  outside: boolean;
}

/**
 * What the scope's rows measure: the pull request's whole change, every round together, or the coder's last patch
 * when the fence refused it since. Nothing before the coder has handed anything back.
 */
type ScopeOf = { pullRequest: number } | { refused: number } | undefined;

/** What the work item waits for now, under its rounds. */
export interface After {
  outcome: Card['outcome'];
  text: string;
}

interface PageComparison {
  page: string;
  screenshot: Screenshot | undefined;
  changed: number;
  intended: boolean;
  /** Another work item the release carried, whose own page this is: the change is its fix's. */
  intendedFor: string | undefined;
}

/** What Verify found after a release: the sense that saw the problem, asked again. */
export interface Verified {
  outcome: 'cleared' | 'persists';
  /** A second persisting signal: the work holds for Martin. */
  held: boolean;
  sense: Sense | undefined;
  check: string;
  at: number;
  version: string | undefined;
  against: string;
  /** The line's words on what it found: why it closed, sent the work back, or held it. */
  words: string;
  dryRun: boolean;
  /**
   * Up to four pages, the intended first, then any that changed or another work item the release carried intended,
   * then the same; marked only by a sense that looks at pages.
   */
  pages: PageComparison[];
  /** Whether the sense looks at a page, so that its check can be marked on one. */
  marked: boolean;
  /** The pages left out, and whether every one of them was the same to the pixel. */
  more: { count: number; same: boolean };
}

/** A release that carried the work item, and what Verify found after it. */
export interface Shipped {
  release: Release;
  verification: Verified | undefined;
}

/** One sense that saw a ticket's problem: the check it ran, and when it first saw it. */
export interface Sighting {
  sense: Sense;
  check: string | undefined;
  at: number | undefined;
  /** The sense whose signal opened the ticket. */
  opened: boolean;
  /** What it added, in a few words. */
  added: string | undefined;
  /**
   * The later versions of the app it saw the problem in, in order, each adding its evidence again, such as another
   * release rolled back on it, and when it saw the latest. Within a version, the inbox counts it.
   */
  again: { versions: string[]; at: number } | undefined;
}

/** One sense's evidence, the first time it saw the problem. */
interface SenseEvidence {
  sense: Sense;
  at: number;
  picture: Picture;
}

/** An improvement's flag on its sheet, in place of Release and Verify: the slider, read-only, and a block per move. */
export interface FlagSheet {
  row: FlagRow;
  /** Newest first. */
  blocks: FlagBlock[];
}

export interface Sheet {
  card: Card;
  /**
   * A visitor's report, or the planner's finding: shown as withheld here, since only Martin (and a report's author)
   * may read its words. `times` is how often the planner noticed it: a finding with a held one's fingerprint joins it.
   * `texts` is what each visitor, or the planner, wrote, made plain (`reportText`): only the full events, Martin's,
   * carry any.
   */
  report: { page: string; quarantined: boolean; by: 'visitor' | 'planner'; times: number; texts: string[] } | undefined;
  /** For an improvement Martin asked for: his request, in his words as everyone may read them, and when. */
  request: ItemState['request'];
  story: string;
  chapters: Chapter[];
  /** Screenshots taken at the signal, on the canary and at rollout, for the evidence. */
  captures: Capture[];
  /** Each release that carried it, newest first, with its verification. */
  shipped: Shipped[];
  /** For an improvement out behind its flag: the flag, in place of Release and Verify. */
  flag: FlagSheet | undefined;
  /**
   * What waits on Martin for it, as Needs you draws it, at the head of the sheet: its open hold, and its flag waiting
   * for him to widen it.
   */
  needs: { hold: Need | undefined; canary: CanaryNeed | undefined; flag: FlagNeed | undefined };
  /** While a merged fix is held for a deploy: the pull request it waits with, and the deploy pull request's state. */
  deploy: Extract<Picture, { type: 'deploy' }> | undefined;
  /** Who wrote the paragraph at the top: the describer, once it has. */
  storyBy: 'describer' | undefined;
  /**
   * The story's last sentence, the console's own, for a work item closed after its summary was written: how it closed,
   * from its events. A summary says what happened, not where the work item stands, so nothing else ends it.
   */
  closing: string | undefined;
  /** The evidence of the problem, which the card's picture stands in for while the work waits on Martin. */
  evidence: Picture;
  spec: PayloadOf<'spec.written'> | undefined;
  /** The spec's scope, with what the pull request, or a patch the fence refused since, changes in it. */
  scope: { of: ScopeOf; rows: ScopeRow[] } | undefined;
  /** The pull request's whole change, as of its latest push. */
  files: PayloadOf<'pull-request.pushed'>['whole'] | undefined;
  /** Each attempt the coder pushed, and what the work item waits for after the last. */
  rounds: Attempt[];
  /** The round a return sent the work into, before its first event, and what is in hand now. */
  roundsNow: RoundsNow;
  after: After | undefined;
  review: ThreadReview[];
  facts: {
    foundBy: string;
    humanLines: number;
    /**
     * The reviews the fix has had in the work's latest pass, of the most it may have in a pass before what still
     * blocks waits for Martin, and which pass that is once there is more than one.
     */
    reviews: { done: number; of: number; pass: number | undefined } | undefined;
    /** A ticket's category and severity, and its fingerprint in words. */
    ticket: { category: string; severity: string; fingerprint: string } | undefined;
    /** An improvement's flag and its stage, "delivery-dates · preview", or "price-sort · not built yet". */
    flag: string | undefined;
  };
  /** For a ticket: every sense, those that saw it first, in the order they did. */
  seenBy: Sighting[] | undefined;
  /** For a ticket more than one sense saw: each one's evidence, the first time it saw it. */
  senseEvidence: SenseEvidence[];
  agents: AgentRow[];
  /** Why no model was called, when none was. */
  noModel: string | undefined;
  /** The required checks on the latest attempt, the signals beside them, and a line for each attempt before. */
  gates: GateRow[];
  signals: GateRow[];
  gatesAttempt: number | undefined;
  earlier: string[];
}

/** Who or what noticed the work, in a few words. */
function foundBy(item: ItemState): string {
  const signal = item.events.find((event) => event.type === 'signal.received');
  if (item.openedBy === 'martin') return 'Martin, from the console';
  if (item.openedBy === 'dependabot') return 'Dependabot';
  if (item.kind === 'red-team') return 'Red-team harness';
  if (signal?.type === 'signal.received') {
    const { sense, check } = signal.payload;
    if (sense === 'report') return 'Visitor report';
    return `${sense === 'planner' ? 'Planner' : SENSE[sense].name} · ${check}`;
  }
  return 'The factory';
}

/**
 * How a closed work item closed, in a sentence to end its story: verified on which version by which check, closed by
 * Martin or the line with the reason, or closed with its pull request unmerged. None while it is open, nor when its
 * summary comes after its close among its events, which says so itself.
 */
function closing(item: ItemState): string | undefined {
  if (!item.closedAt) return undefined;
  const at = item.events.findLastIndex((event) => event.type === 'work-item.closed');
  const close = item.events[at];
  if (close?.type !== 'work-item.closed') return undefined;
  if (item.events.findLastIndex((event) => event.type === 'work-item.summarised') > at) return undefined;
  const reason = `It closed: ${close.payload.reason.replace(/\.$/, '')}.`;
  if (close.payload.outcome === 'verified') {
    // Only a verification that closed it tells how: the pass's last, cleared, with no hold for Martin after it, who
    // otherwise judged it himself, and the close's reason says so.
    const since = item.events.findLastIndex((event) => event.type === 'work-item.reopened');
    const after = item.events.slice(since + 1, at);
    const last = after.findLastIndex(
      (event) => event.type === 'verification.finished' || event.type === 'signal.rechecked',
    );
    const verification = after[last];
    // A look again that cleared, on a release that did not carry the fix, closed it, by itself or with Martin's close
    // of its pull request; not when he answered the hold since, whose words the close's reason gives.
    const answered = after.slice(last + 1).some((event) => event.type === 'hold.answered');
    if (verification?.type === 'signal.rechecked' && verification.payload.outcome === 'cleared' && !answered) {
      const { sense, check, version } = verification.payload;
      const on = version ? ` on ${shortVersion(version)}` : '';
      return `It was verified${on} by ${sense ? SENSE[sense].check : 'the check'} “${check}”, on ${clearedOnWords(verification.payload)}, and closed.`;
    }
    const held = after.slice(last + 1).some((event) => event.type === 'hold.started');
    if (verification?.type !== 'verification.finished' || verification.payload.outcome !== 'cleared' || held) {
      return reason;
    }
    const { dryRun, sense, check, version } = verification.payload;
    if (dryRun) return 'It closed on the dry run’s word: its release never shipped, so no sense looked.';
    const on = version ? ` on ${shortVersion(version)}` : '';
    return `It was verified${on} by ${sense ? SENSE[sense].check : 'the check'} “${check}”, and closed.`;
  }
  // Martin's reason for turning its flag off, which the close gives.
  if (close.payload.outcome === 'turned-off') {
    return `Martin turned its flag off: ${close.payload.reason.replace(/\.$/, '')}. It closed as turned off, its code still in the app, off, and nothing rolled back.`;
  }
  // GitHub's word that a pull request closed unmerged, which the line records as Martin's.
  const unmerged = /^Pull request #(\d+) was closed without being merged/.exec(close.payload.reason);
  if (close.payload.outcome === 'no-change' && close.actor === 'martin' && unmerged) {
    return `It closed with pull request #${unmerged[1]} unmerged.`;
  }
  return reason;
}

/** Openings worth a chapter of their own; the others open as their first signal or pull request arrives. */
const OPENING: Partial<Record<Kind, string>> = {
  improvement: 'REQUEST',
  'red-team': 'ATTACK',
  'injected-defect': 'INJECT',
};

/** The label for an event that marks a step in the item's story, or nothing for those that don't. */
function chapterOf(event: PublicEvent, item: ItemState): Pick<Chapter, 'label' | 'tone'> | undefined {
  switch (event.type) {
    case 'work-item.opened': {
      const label = OPENING[item.kind];
      return label ? { label, tone: 'signal' } : undefined;
    }
    case 'defect.injected':
      return { label: 'ON SITE', tone: 'attn' };
    case 'signal.received':
      // Once there is a ticket, a signal is another sense adding its evidence: it is named by its sense.
      if (event.payload.sense === 'planner') return { label: 'FINDING', tone: 'signal' };
      if (event.payload.sense !== 'report' && item.ticket && ticketedBefore(item, event)) {
        return { label: event.payload.sense.toUpperCase(), tone: 'signal' };
      }
      return { label: event.payload.sense === 'report' ? 'REPORT' : 'SIGNAL', tone: 'signal' };
    case 'judgement.made':
      return { label: 'TRIAGE', tone: 'signal' };
    case 'ticket.opened':
      return { label: 'TICKET', tone: 'signal' };
    case 'spec.written':
      return { label: 'SPEC', tone: 'signal' };
    case 'wait.started':
      return { label: 'WAITS', tone: 'faint' };
    // A look again moves the work item nowhere: it cleared, it is still seen, or, at the end of a wait or as the line
    // took the ticket, it could not tell, and the work went on. The look at a take reads as one by its summary.
    case 'signal.rechecked':
      if (event.payload.outcome === 'cleared') return { label: 'CLEARED', tone: 'ok' };
      if (event.payload.outcome === 'persists') return { label: 'STILL SEEN', tone: 'faint' };
      return event.payload.for === 'wait' || event.payload.for === 'take'
        ? { label: 'UNSURE', tone: 'faint' }
        : undefined;
    case 'hold.started':
      return { label: { approval: 'WAITING', question: 'QUESTION', held: 'HELD' }[event.payload.kind], tone: 'attn' };
    case 'hold.answered':
      return {
        label: { approved: 'APPROVED', rejected: 'REJECTED', answered: 'ANSWERED' }[event.payload.decision],
        tone: 'signal',
      };
    case 'pull-request.pushed':
      return { label: event.payload.attempt > 1 ? `TRY ${event.payload.attempt}` : 'PR', tone: 'signal' };
    case 'gates.finished':
      return { label: 'GATES', tone: event.payload.conclusion === 'passed' ? 'signal' : 'attn' };
    case 'work.returned':
      return event.payload.from === 'verify' ? { label: 'PLAN', tone: 'signal' } : { label: 'SENT BACK', tone: 'attn' };
    case 'review.submitted':
      return { label: 'REVIEW', tone: 'signal' };
    case 'work-item.summarised':
      // Triage writes the first summary; the describer's is a step of Review.
      return event.actor === 'describer' ? { label: 'DESCRIBED', tone: 'signal' } : undefined;
    case 'pull-request.merged':
      return { label: 'MERGED', tone: 'signal' };
    // A persisting signal sends the work round again by itself, so it is not warm the first time; nothing reopens.
    case 'verification.finished':
      if (event.payload.dryRun)
        return { label: event.payload.outcome === 'cleared' ? 'VERIFIED' : 'PERSISTS', tone: 'faint' };
      // A second time, the work holds for Martin, and that is warm.
      if (event.payload.outcome === 'cleared') return { label: 'VERIFIED', tone: 'ok' };
      return { label: 'PERSISTS', tone: afterVerify(item, event)?.type === 'hold.started' ? 'attn' : 'signal' };
    case 'work-item.reopened':
      return { label: 'REOPENED', tone: 'attn' };
    case 'action.refused':
      return { label: 'REFUSED', tone: 'attn' };
    // Each stage Martin set, by its name, and Verify's comparison at Share.
    case 'flag.staged':
      return {
        label: STAGE_NAME[event.payload.to.stage].toUpperCase(),
        tone: event.payload.to.stage === 'off' ? 'attn' : 'signal',
      };
    case 'flag.compared':
      return { label: 'COMPARED', tone: event.payload.outcome === 'passed' ? 'ok' : 'attn' };
    // Verify's checks with the probes at Checks and Preview; the baseline with the flag off moves nothing.
    case 'flag.checked':
      if (event.payload.stage === 'off') return undefined;
      if (event.payload.outcome === 'unsure') return { label: 'CHECKED', tone: 'faint' };
      return { label: 'CHECKED', tone: event.payload.outcome === 'passed' ? 'ok' : 'attn' };
    case 'work-item.closed':
      // A guardrail that worked needs nobody: quarantine is told in the quiet tone, as closed work is.
      if (event.payload.outcome === 'quarantined') return { label: 'QUARANTINED', tone: 'faint' };
      // An improvement is verified by its close at Everyone, as a fix is by Verify's pass.
      if (event.payload.outcome === 'verified' && item.kind === 'improvement') return { label: 'VERIFIED', tone: 'ok' };
      return event.payload.outcome === 'no-change' ||
        event.payload.outcome === 'discarded' ||
        event.payload.outcome === 'turned-off'
        ? { label: 'CLOSED', tone: 'faint' }
        : undefined;
    default:
      return undefined;
  }
}

/** Whether the item's ticket had opened before an event. */
const ticketedBefore = (item: ItemState, event: PublicEvent) => {
  const opened = item.events.findIndex((e) => e.type === 'ticket.opened');
  return opened >= 0 && opened < item.events.indexOf(event);
};

/**
 * Positions along the scrubber, from positions by time: never closer than a minimum gap, so labels stay apart and each
 * chapter keeps a target of its own. Pushed right where they crowd, then back from the end where that runs past it;
 * evenly spread when there are too many for the gap.
 */
export function spread(raw: readonly number[], gap = 7.5): number[] {
  if (raw.length < 2) return [...raw];
  if ((raw.length - 1) * gap > 100) return raw.map((_, i) => (i / (raw.length - 1)) * 100);
  const out: number[] = [];
  for (const [i, p] of raw.entries()) out.push(i === 0 ? p : Math.max(p, (out[i - 1] ?? 0) + gap));
  for (let i = out.length - 1; i >= 0; i--)
    out[i] = Math.min(out[i] ?? 0, i === out.length - 1 ? 100 : (out[i + 1] ?? 100) - gap);
  return out;
}

/** One chapter on the scrubber: a chapter, or a pass folded to one, at its place and with its label or none. */
export interface Shown {
  /** The first chapter it stands for, which choosing it chooses, and how many it stands for. */
  index: number;
  count: number;
  /** A pass folded to one chapter: PASS 2. */
  pass: number | undefined;
  left: number;
  /** Past twelve, only the chosen chapter, the first and the last keep their labels. */
  labelled: boolean;
}

/** The narrowest gap between two chapters' targets, in pixels (WCAG 2.2's target size). */
export const TARGET = 24;

/**
 * The chapters the scrubber draws, with the chapter at `at` chosen, in `width` pixels. The first pass and the pass
 * holding the chosen chapter are drawn in full, and every other pass is one chapter, which opens when chosen; when
 * that leaves too many to keep a target's width apart, the first pass folds too. A work item with one pass is spread
 * by time, and one with more evenly.
 */
export function scrubbed(chapters: readonly Chapter[], at: number, width: number): Shown[] {
  const room = Math.max(2, Math.floor(width / TARGET) + 1);
  const chosen = chapters[at]?.pass ?? 1;
  const passes = new Set(chapters.map((c) => c.pass)).size > 1;
  const fold = (open: Set<number>) => {
    const out: Omit<Shown, 'left' | 'labelled'>[] = [];
    chapters.forEach((c, index) => {
      const last = out.at(-1);
      if (!passes || open.has(c.pass)) out.push({ index, count: 1, pass: undefined });
      else if (last?.pass === c.pass) last.count += 1;
      else out.push({ index, count: 1, pass: c.pass });
    });
    return out;
  };
  let shown = fold(new Set([1, chosen]));
  if (shown.length > room) shown = fold(new Set([chosen]));
  const here = shown.findIndex((s) => at >= s.index && at < s.index + s.count);
  const lefts = passes
    ? shown.map((_, j) => (shown.length < 2 ? 0 : (j / (shown.length - 1)) * 100))
    : spread(
        shown.map((s) => chapters[s.index]?.position ?? 0),
        Math.max(7.5, 100 / (room - 1)),
      );
  return shown.map((s, j) => ({
    ...s,
    left: lefts[j] ?? 0,
    labelled: shown.length <= 12 || j === here || j === 0 || j === shown.length - 1,
  }));
}

const SETTINGS = (settings: PayloadOf<'model.called'>['settings']) =>
  [settings.effort && `effort ${settings.effort}`, settings.maxTurns && `≤ ${settings.maxTurns} turns`]
    .filter(Boolean)
    .join(' · ');

function agents(item: ItemState): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  // Jev's questions, by question set, in the order first asked: each set's row line says how many it holds.
  const asked = new Map<string, number>();
  for (const event of item.events) {
    if (event.type === 'model.called') {
      const { agent, provider, model, settings, tokens, costUsd } = event.payload;
      const key = `${agent}/${provider}/${model}`;
      const row = rows.get(key) ?? {
        agent,
        provider,
        model,
        details: [],
        calls: 0,
        steps: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      };
      row.calls += event.payload.calls;
      row.steps += 1;
      const line = [SETTINGS(settings), row.steps > 1 && `${row.steps} steps`].filter(Boolean).join(' · ');
      row.details = line ? [line] : [];
      row.tokensIn += tokens.input + tokens.cacheRead + tokens.cacheWrite;
      row.tokensOut += tokens.output;
      row.cost += costUsd;
      rows.set(key, row);
    } else if (event.type === 'judgement.made') {
      const key = `triage/typesafe/${event.payload.model}`;
      const row = rows.get(key) ?? {
        agent: 'triage',
        provider: 'typesafe',
        model: event.payload.model,
        details: [],
        calls: 0,
        steps: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      };
      if (!asked.has(event.payload.questionSet)) asked.set(event.payload.questionSet, event.payload.answers.length);
      row.details = [...asked].map(([set, n]) => `${set} · ${plural(n, 'question')}`);
      row.calls += 1;
      row.cost += event.payload.costUsd;
      rows.set(key, row);
    }
  }
  const order = ['triage', 'planner', 'coder', 'reviewer', 'describer', 'red-team'];
  return [...rows.values()].sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent));
}

/** The checks on the latest commit that went through Gates, in the order they started: required ones and signals. */
function gates(item: ItemState): GateRow[] {
  const started = [...item.events].reverse().find((event) => event.type === 'gates.started');
  if (started?.type !== 'gates.started') return [];
  const results = new Map<string, GateRow>();
  for (const event of item.events) {
    if (event.type === 'gate.finished' && event.payload.commit === started.payload.commit) {
      const { check, conclusion, durationMs, summary, required } = event.payload;
      results.set(check, { check, conclusion, durationMs, summary, required });
    }
  }
  return started.payload.checks.flatMap((check) => results.get(check) ?? []);
}

/** The reviewer's latest verdict, as a signal beside the gates: it informs the line, and never blocks a merge. */
function reviewSignal(item: ItemState, reviews: readonly ThreadReview[]): GateRow | undefined {
  const review = reviews.at(-1);
  if (!review) return undefined;
  const step = [...item.events]
    .reverse()
    .find((event) => event.type === 'model.called' && event.payload.agent === 'reviewer');
  const words = { approved: 'approved', 'changes-requested': 'changes asked', escalated: 'escalated to Martin' };
  return {
    // The check run the reviewer's step posts beside its review (the line's `REVIEW_CHECK`).
    check: 'factory review',
    required: false,
    conclusion: review.verdict === 'approved' ? 'success' : 'neutral',
    durationMs: step?.type === 'model.called' ? step.payload.durationMs : undefined,
    summary: `${words[review.verdict]}, review ${review.number}`,
  };
}

/** One line for each attempt before the latest: how its gates went, and what sent it back. */
function earlierAttempts(list: readonly Attempt[]): string[] {
  return list.slice(0, -1).map((a) => {
    const gates =
      a.gates?.state === 'failed'
        ? `failed ${a.gates.failed.join(', ') || 'a required check'}`
        : a.gates?.state === 'passed'
          ? 'passed every required check'
          : 'did not finish its checks';
    const back =
      a.returned?.from === 'review'
        ? 'the reviewer sent it back'
        : a.returned?.from === 'gates'
          ? 'Gates sent it back'
          : 'the coder pushed again';
    return `Attempt ${a.attempt} ${gates}; ${back}.`;
  });
}

/**
 * The spec's scope, each path with what changed there, and anything changed outside it. What changed is the pull
 * request's whole change, every round together, since that is what a merge brings in; or, when the fence refused the
 * coder's last patch, that patch, with its own verdict on each file.
 */
function scopeOf(item: ItemState, spec: PayloadOf<'spec.written'>): Sheet['scope'] {
  let patches = 0;
  let of: ScopeOf;
  let files: { path: string; added: number; removed: number; cut?: true | undefined }[] = [];
  for (const event of item.events) {
    if (event.type === 'pull-request.pushed' && event.actor === 'coder') {
      patches += 1;
      of = { pullRequest: event.payload.number };
      files = event.payload.whole;
    }
    if (event.type === 'action.refused' && event.payload.mechanism === 'scope-fence') {
      patches += 1;
      of = { refused: patches };
      files = event.payload.files ?? [];
    }
  }
  const rows = spec.scope.map((entry): ScopeRow => {
    const touched = files.filter((file) => knownInScope(file, [entry]));
    return {
      path: entry,
      added: touched.length ? touched.reduce((n, f) => n + f.added, 0) : undefined,
      removed: touched.length ? touched.reduce((n, f) => n + f.removed, 0) : undefined,
      outside: false,
    };
  });
  // A path cut to what an event records is shown outside the scope unless what was kept of it shows it is in.
  const outside = files
    .filter((file) => !knownInScope(file, spec.scope))
    .map(({ path, added, removed }): ScopeRow => ({ path, added, removed, outside: true }));
  return { of, rows: [...rows, ...outside] };
}

/** What the work item waits for once its rounds are done: Martin's merge, Martin's decision, or a release. */
function afterRounds(item: ItemState, hold: Hold | undefined, described: boolean): After | undefined {
  if (item.outcome === 'merged') {
    const merged = [...item.events].reverse().find((event) => event.type === 'pull-request.merged');
    const by = merged?.type === 'pull-request.merged' && merged.payload.by === 'martin' ? 'Martin' : 'the factory';
    return {
      outcome: 'merged',
      text: `Merged by ${by} at ${clock(merged ? Date.parse(merged.ts) : item.lastAt)}; it ships with the next release`,
    };
  }
  if (!hold || (item.outcome !== 'needs-you' && item.outcome !== 'held' && item.outcome !== 'deploying'))
    return undefined;
  const cleared = clearanceWords(item);
  const and = (text: string) => (cleared ? `${text.replace(/\.$/, '')}. ${cleared}` : text);
  if (hold.cause === 'merge') {
    const since = clock(hold.since);
    return {
      outcome: item.outcome,
      text: and(
        described
          ? `Described, ready, and waiting for Martin’s merge since ${since}`
          : `Waiting for Martin’s merge since ${since}`,
      ),
    };
  }
  return { outcome: item.outcome, text: and(hold.reason) };
}

/** How each sense is named in a sighting. */
const SENSE_ADDED: Record<string, (evidence: NonNullable<PayloadOf<'signal.received'>['evidence']>[number]) => string> =
  {
    logs: (e) => (e.kind === 'logs' ? plural(e.lines.length, 'log line') : ''),
    metric: () => 'its series',
    http: (e) => (e.kind === 'http' ? `${e.method} ${e.url}, answered ${e.status ?? 'nothing'}` : ''),
    console: (e) => (e.kind === 'console' ? `${e.messages.length} console messages` : ''),
    accessibility: (e) =>
      e.kind === 'accessibility' ? `${e.findings.reduce((n, f) => n + f.elements.length, 0)} elements` : '',
    canary: (e) => (e.kind === 'canary' ? `the analysis of its ${e.measure.name}` : ''),
  };

/** What a sense's signal added to the ticket, in a few words. */
function added(signal: PublicEvent<'signal.received'>): string | undefined {
  const [first] = signal.payload.evidence ?? [];
  const words = first ? SENSE_ADDED[first.kind]?.(first) : undefined;
  if (words) return `with ${words}`;
  return signal.artifacts.some((a) => a.kind === 'screenshot') ? 'with a screenshot' : undefined;
}

/** Every sense, those that saw the ticket's problem first and in the order they did, and the rest as not yet. */
function seenBy(item: ItemState): Sighting[] {
  const first = new Map<Sense, PublicEvent<'signal.received'> & { payload: { sense: Sense } }>();
  const later = new Map<Sense, NonNullable<Sighting['again']>>();
  for (const event of item.events) {
    if (event.type !== 'signal.received' || !bySense(event)) continue;
    const { sense, version } = event.payload;
    const opened = first.get(sense);
    if (!opened) {
      first.set(sense, event);
    } else if (sense !== 'report' && version !== opened.payload.version) {
      const versions = later.get(sense)?.versions.filter((v) => v !== version) ?? [];
      later.set(sense, { versions: [...versions, version], at: Date.parse(event.ts) });
    }
  }
  const opener = [...first.values()][0];
  const seen = [...first.values()].map(
    (signal): Sighting => ({
      sense: signal.payload.sense,
      check: signal.payload.sense === 'report' ? 'A visitor’s report' : signal.payload.check,
      at: Date.parse(signal.ts),
      opened: signal === opener,
      added: signal === opener ? undefined : added(signal),
      again: later.get(signal.payload.sense),
    }),
  );
  // The canary sees only a release doing worse than the version before it, so it is no sense a ticket waits on.
  const unseen = SENSES.filter((sense) => sense !== 'canary' && !first.has(sense)).map(
    (sense): Sighting => ({
      sense,
      check: undefined,
      at: undefined,
      opened: false,
      added: undefined,
      again: undefined,
    }),
  );
  return [...seen, ...unseen];
}

/** Each sense's evidence for a ticket, the first time it saw the problem. */
function senseEvidence(item: ItemState): SenseEvidence[] {
  const seen = new Set<Sense>();
  return item.events.flatMap((event) => {
    if (
      event.type !== 'signal.received' ||
      !bySense(event) ||
      event.payload.sense === 'report' ||
      seen.has(event.payload.sense)
    )
      return [];
    seen.add(event.payload.sense);
    const picture = pictureOfSignal(event);
    return picture ? [{ sense: event.payload.sense, at: Date.parse(event.ts), picture }] : [];
  });
}

/** A symptom as the policy's table names it, for saying why no model was needed. */
const SYMPTOM_WORDS: Record<SymptomClass, string> = {
  'broken-link': 'a broken link',
  'broken-image': 'a broken image',
  'redirect-loop': 'a redirect loop',
  'wrong-result': 'a wrong result',
  'rejects-valid-input': 'refused valid input',
  'server-error': 'a server error',
  'browser-error': 'an error in the browser',
  'slow-response': 'a slow response',
  'not-cached': 'a file the browser may not keep',
  'missing-alt': 'an image without alternative text',
  'low-contrast': 'text too faint to read',
  'unlabelled-field': 'a field without a label',
  'missing-header': 'a missing security header',
  'leaks-detail': 'an error that gives the server away',
  'missing-log': 'a request with no log record',
  'wrong-metric': 'a metric with a wrong label',
};

/** A ticket's category, as a noun the sentence below can use. */
const CATEGORY_WORDS: Record<DefectCategory, string> = {
  content: 'a content problem',
  navigation: 'a navigation problem',
  functional: 'a functional problem',
  errors: 'an error',
  performance: 'a performance problem',
  accessibility: 'an accessibility problem',
  security: 'a security problem',
  observability: 'an observability problem',
};

/** Why no model was called, said as a sentence, for work that called none. */
function noModel(item: ItemState): string | undefined {
  if (item.calls > 0) return undefined;
  const fingerprint = item.ticket?.fingerprint;
  if (item.ticket && fingerprint && 'class' in fingerprint) {
    const { category, severity } = item.ticket;
    const next = item.queued ? ' The planner will be the first model this ticket meets.' : '';
    return `A sense knows what it saw, so the category and severity come from a table in the factory’s policy: ${SYMPTOM_WORDS[fingerprint.class]} is ${CATEGORY_WORDS[category]}, and ${severity}.${next}`;
  }
  return item.closedAt === undefined
    ? 'None yet: nothing so far has needed a model.'
    : 'None of this work needed a model.';
}

const where = (route: string) => (route === '*' ? 'every page' : route);

/** A release's events, which the scrubber draws as one chapter for each release. */
const releaseOf = (event: PublicEvent) =>
  event.type === 'release.started' || event.type === 'canary.stepped' || endsRelease(event)
    ? event.payload.release
    : undefined;

/** A stopped release's chapter, by what stopped it. */
const CHAPTERS: Record<StoppedBy, string> = { stop: 'STOPPED', martin: 'ABORTED', error: 'ERROR' };

/** A release's one chapter, named by how it ended, or CANARY while it is in flight. A dry run earns no tone. */
function releaseChapter(r: Release): { label: string; tone: Chapter['tone']; text: string } {
  const { end } = r;
  const v = shortVersion(r.version);
  const by = stoppedBy(end);
  const passed = r.measured.filter((m) => m.stepped.analysis.phase === 'successful').map((m) => `${m.weight}%`);
  const [label, tone, text]: [string, Chapter['tone'], string] =
    end?.kind === 'promoted'
      ? ['PROMOTED', 'ok', `${v} promoted to all traffic${passed.length ? `, after ${listed(passed)} passed` : ''}`]
      : end?.kind === 'rolled-back'
        ? ['ROLLED BACK', 'attn', `${v} ${endedAt(end)}`]
        : end && by
          ? [CHAPTERS[by], 'attn', `${v} ${endedAt(end)}`]
          : ['CANARY', 'signal', `${v} on the canary at ${r.weight}%`];
  return r.dryRun ? { label, tone: 'faint', text: `${text}, in a dry run` } : { label, tone, text };
}

/** The senses that look at no page, so that nothing on one is their finding. */
const PAGELESS = new Set<string | undefined>(['logs', 'metrics', 'canary']);

/**
 * What the Verify block says under its pages: the pages left out, and whose marks they carry, or that the sense looks
 * at no page, which it says even when it compared none.
 */
export function marksNote(v: Verified): string {
  const more = v.more.count
    ? `And ${plural(v.more.count, 'more page')}${v.more.same ? ', the same to the pixel' : ''}. `
    : '';
  if (!v.marked)
    return `${more}No marks: ${v.sense ? SENSE[v.sense].the : 'the sense'} looks at no page, so nothing on one is its finding.`;
  return v.pages.some((page) => page.screenshot?.boxes.length)
    ? `${more}The mark is the sense’s own check, on its own page.`
    : more.trim();
}

/** The line's next word on a verification: its close, the work's return to Plan, or a hold for Martin. */
const afterVerify = (item: ItemState, event: PublicEvent) =>
  item.events
    .slice(item.events.indexOf(event) + 1)
    .find(
      (e) =>
        e.type === 'work-item.closed' ||
        e.type === 'work.returned' ||
        (e.type === 'hold.started' && e.payload.cause === 'verify'),
    );

/**
 * What Verify found, from its event and the line's next word on it: a close, a return or a hold. Each page's screenshot
 * is the one the verification carries: a page the same in two versions is the same picture, with the same hash, and
 * names the version this verification took it on, not a later one's.
 */
function verified(item: ItemState, event: PublicEvent<'verification.finished'>): Verified {
  const p = event.payload;
  const shots = new Map(event.artifacts.flatMap((a) => (a.kind === 'screenshot' ? [[a.hash, a]] : [])));
  const next = afterVerify(item, event);
  const marked = !PAGELESS.has(p.sense);
  const order = (page: PageComparison) => (page.intended ? 0 : page.intendedFor || page.changed > 0 ? 1 : 2);
  const pages = p.pages
    .map((page): PageComparison => {
      const shot = shots.get(page.screenshot);
      return {
        page: page.page,
        screenshot: shot && !marked ? { ...shot, boxes: [] } : shot,
        changed: page.changed,
        intended: page.intended,
        intendedFor: page.intendedFor,
      };
    })
    .sort((a, b) => order(a) - order(b));
  const rest = pages.slice(4);
  return {
    outcome: p.outcome,
    held: next?.type === 'hold.started',
    sense: p.sense,
    check: p.check,
    at: Date.parse(event.ts),
    version: p.version,
    against: p.against,
    words: (next && 'reason' in next.payload && next.payload.reason) || event.summary,
    dryRun: p.dryRun,
    pages: pages.slice(0, 4),
    marked,
    more: { count: rest.length, same: rest.every((page) => page.changed === 0) },
  };
}

/**
 * The reviews of the latest pass the coder pushed in, the pass of the pull request beside them, against the line's
 * limit, which bounds each pass's reviews alone. A round sent back after the last review it allows passes it by one:
 * for an approval's suggestions, or by Martin. Every push is reviewed.
 */
function reviewsOfPass(item: ItemState): { done: number; of: number; pass: number | undefined } {
  let current = { pushed: false, done: 0 };
  const passes = [current];
  for (const event of item.events) {
    if (startsPass(event)) {
      current = { pushed: false, done: 0 };
      passes.push(current);
    }
    if (event.type === 'pull-request.pushed' && event.actor === 'coder') current.pushed = true;
    if (event.type === 'review.submitted') current.done += 1;
  }
  // The sheet shows it only once the coder has pushed, so there is a pass that pushed.
  const index = Math.max(
    0,
    passes.findLastIndex((p) => p.pushed),
  );
  const done = passes[index]?.done ?? 0;
  return { done, of: Math.max(LIMITS.reviews, done), pass: passes.length > 1 ? index + 1 : undefined };
}

export function sheet(
  item: ItemState,
  events: readonly PublicEvent[],
  t: number,
  flag?: FlagRow,
): Omit<Sheet, 'needs'> {
  const end = item.closedAt ?? t;
  const own = releases(events, [item], t).filter((r) => r.items.some((i) => i.number === item.number));
  const byId = new Map(own.map((r) => [r.id, r]));
  // Each release is one chapter, where its last event on the item is (or, in an older history, the line's stop after it).
  const lastOf = new Map<string, PublicEvent>();
  for (const event of item.events) {
    const id = releaseOf(event);
    if (id) lastOf.set(id, event);
  }
  let pass = 1;
  const marks: {
    event: PublicEvent | undefined;
    label: string;
    tone: Chapter['tone'];
    text?: string;
    at?: number;
    pass: number;
  }[] = item.events.flatMap((event) => {
    const id = releaseOf(event);
    const r = id ? byId.get(id) : undefined;
    if (id) {
      if (!r || lastOf.get(id) !== event) return [];
      const at = Math.max(Date.parse(event.ts), r.end && stoppedBy(r.end) ? r.end.at : 0);
      return [{ event, ...releaseChapter(r), at, pass }];
    }
    if (startsPass(event)) pass += 1;
    const chapter = chapterOf(event, item);
    // Each widening says it was given with the passkey, as does Martin's request, which opens an improvement.
    const keyed =
      (event.type === 'flag.staged' && event.payload.steppedUp && FLAG_STEP_UP[event.payload.action]) ||
      (event.type === 'work-item.opened' && item.request?.steppedUp);
    return chapter ? [{ event, ...chapter, pass, ...(keyed && { text: `${event.summary}, with his passkey` }) }] : [];
  });
  // Work still on the line ends at now, or, for a ticket queued for the planner, waiting at Plan. Work waiting on
  // Martin ends at its wait, and a merged fix at its merge, drawn as work queued for a release.
  const waits = item.outcome === 'needs-you' || item.outcome === 'held' || item.outcome === 'deploying';
  const merged = item.outcome === 'merged';
  if (item.closedAt === undefined && !waits && !merged) {
    marks.push(
      item.waitingOn
        ? { event: undefined, label: 'WAITING · BUILD', tone: 'faint', text: item.waitingOn.reason, pass }
        : item.queued
          ? { event: undefined, label: 'WAITING · PLAN', tone: 'faint', pass }
          : { event: undefined, label: 'NOW', tone: 'signal', pass },
    );
  }
  const times = marks.map((m) => m.at ?? (m.event ? Date.parse(m.event.ts) : t));
  const span = Math.max(1, end - item.openedAt);
  const chapters = marks.map(
    (m, i): Chapter => ({
      label: m.label,
      at: times[i] ?? t,
      actor: m.event?.actor,
      text: m.text ?? (m.event ? summaryOf(m.event) : item.queued ? 'Waiting for the planner' : 'Still on the line'),
      position: Math.min(100, Math.max(0, (((times[i] ?? t) - item.openedAt) / span) * 100)),
      pass: m.pass,
      site: [...item.captures].reverse().find((c) => c.at <= (times[i] ?? t) && c.side !== 'page'),
      tone: merged && i === marks.length - 1 ? 'faint' : m.tone,
      // A merged fix waits, for a release or for Martin's deploy: its last chapter is the waiting ring.
      ...(((!m.event && item.queued) ||
        (i === marks.length - 1 &&
          (merged || (m.event?.type === 'hold.started' && m.event.payload.cause === 'deploy')))) && {
        waiting: true,
      }),
    }),
  );

  const report = item.events.find((event) => event.type === 'signal.received' && event.payload.report);
  const spec = [...item.events].reverse().find((event) => event.type === 'spec.written');
  const pushed = [...item.events].reverse().find((event) => event.type === 'pull-request.pushed');
  const humanLines = item.events
    .filter((event) => event.type === 'pull-request.pushed' && event.actor === 'martin')
    .reduce(
      (sum, event) =>
        sum +
        (event.type === 'pull-request.pushed' ? event.payload.files.reduce((n, f) => n + f.added + f.removed, 0) : 0),
      0,
    );

  const specPayload = spec?.type === 'spec.written' ? spec.payload : undefined;
  const tried = attempts(item);
  const thread = reviewThread(item, specPayload);
  const summarised = [...item.events].reverse().find((event) => event.type === 'work-item.summarised');
  const latestGates = gates(item);
  const signal = reviewSignal(item, thread);
  const coded = tried.length > 0;
  // Each verification is of the latest release to carry the work item before it.
  const checked = new Map<string, Verified>();
  let latest: string | undefined;
  for (const event of item.events) {
    if (event.type === 'release.started') latest = event.payload.release;
    if (event.type === 'verification.finished' && latest) checked.set(latest, verified(item, event));
  }
  return {
    card: card(item, events, t),
    report:
      report?.type === 'signal.received' && report.payload.report
        ? {
            page: report.payload.report.page,
            quarantined: item.outcome === 'quarantined',
            by: report.payload.sense === 'planner' ? 'planner' : 'visitor',
            times: item.events.filter(
              (event) => event.type === 'signal.received' && event.payload.sense === report.payload.sense,
            ).length,
            texts: item.events.flatMap((event) => {
              if (event.type !== 'signal.received' || event.payload.sense !== report.payload.sense) return [];
              const text = reportText(event.payload.report?.text);
              return text ? [text] : [];
            }),
          }
        : undefined,
    request: item.request,
    story: item.story ?? item.description ?? item.title,
    storyBy: summarised?.actor === 'describer' ? 'describer' : undefined,
    evidence: picture(item, { waits: false }),
    chapters,
    captures: item.captures.filter(
      (c) => c.side === 'broken' || c.side === 'canary' || c.side === 'fixed' || c.side === 'after',
    ),
    shipped: own.reverse().map((release) => ({ release, verification: checked.get(release.id) })),
    flag: flag && { row: flag, blocks: flagBlocks(item, flag) },
    deploy: deployPicture(item),
    closing: closing(item),
    spec: specPayload,
    scope: specPayload && scopeOf(item, specPayload),
    // What a merge brings in: every round together, not only the last round's own files.
    files: pushed?.type === 'pull-request.pushed' ? pushed.payload.whole : undefined,
    rounds: tried,
    roundsNow: roundsNow(item, tried),
    after: coded ? afterRounds(item, item.hold, Boolean(summarised && summarised.actor === 'describer')) : undefined,
    review: thread,
    facts: {
      foundBy: foundBy(item),
      humanLines,
      reviews: coded ? reviewsOfPass(item) : undefined,
      ticket: item.ticket && {
        category: item.ticket.category,
        severity: item.ticket.severity,
        fingerprint:
          'class' in item.ticket.fingerprint
            ? `${where(item.ticket.fingerprint.route)} · ${item.ticket.fingerprint.class}`
            : `${item.ticket.fingerprint.page} · “${item.ticket.fingerprint.text}”`,
      },
      flag: flagFact(item),
    },
    seenBy: item.ticket ? seenBy(item) : undefined,
    senseEvidence: item.ticket ? senseEvidence(item) : [],
    agents: agents(item),
    noModel: noModel(item),
    gates: latestGates.filter((g) => g.required),
    signals: [...latestGates.filter((g) => !g.required), ...(coded && signal ? [signal] : [])],
    gatesAttempt: tried.length > 1 ? tried.at(-1)?.attempt : undefined,
    earlier: earlierAttempts(tried),
  };
}

/** An improvement's flag as a fact: its name and stage, or that it is not built yet. */
function flagFact(item: ItemState): string | undefined {
  const flag = itemFlag(item);
  if (!flag) return undefined;
  const { stage } = flag.now;
  if (!flag.built) return `${flag.name} · not built yet`;
  return `${flag.name} · ${stage ? STAGE_NAME[stage.stage].toLowerCase() : 'outside every stage'}`;
}

/** The flag's blocks on the sheet, newest first: its release, then each of Martin's moves, with Verify's judgement. */
function flagBlocks(item: ItemState, row: FlagRow): FlagBlock[] {
  const blocks: FlagBlock[] = [];
  const promoted = item.events.find((event) => event.type === 'release.promoted');
  if (promoted?.type === 'release.promoted') {
    blocks.push({
      kind: 'released',
      at: Date.parse(promoted.ts),
      version: promoted.payload.version,
      release: promoted.payload.release,
    });
  }
  for (const event of item.events) {
    if (event.type === 'flag.staged' && event.actor === 'martin' && event.payload.flag === row.name) {
      const { to, from, action, steppedUp, reason, revision, dropped = [] } = event.payload;
      blocks.push({
        kind: 'staged',
        at: Date.parse(event.ts),
        stage: to,
        from,
        action,
        passkey: steppedUp && FLAG_STEP_UP[action],
        reason,
        dropped,
        current: false,
        revision,
        compared: undefined,
        checked: undefined,
      });
    }
    const last = blocks.at(-1);
    if (
      event.type === 'flag.compared' &&
      fromVerify(event) &&
      event.payload.flag === row.name &&
      last?.kind === 'staged' &&
      last.stage.stage === 'share' &&
      last.stage.share === event.payload.share &&
      last.revision === event.payload.moveRevision
    ) {
      last.compared = { ...event.payload, at: Date.parse(event.ts) };
    }
    if (
      event.type === 'flag.checked' &&
      fromVerify(event) &&
      event.payload.flag === row.name &&
      last?.kind === 'staged' &&
      last.stage.stage === event.payload.stage &&
      event.payload.stage !== 'off' &&
      last.revision === event.payload.moveRevision
    ) {
      last.checked = checkedOf(event);
    }
  }
  const last = blocks.at(-1);
  if (last?.kind === 'staged') last.current = true;
  return blocks.reverse();
}
