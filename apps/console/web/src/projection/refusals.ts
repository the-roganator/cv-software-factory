/**
 * What each guardrail has refused in the last seven days, for its opened row in Guardrails: the last three, a line each,
 * and how many in all.
 *
 * - **Under which rows:** those the refusal's own `guardrails` names, which its appender set, knowing why it refused;
 *   never by its mechanism alone (`github-guard` shows under 1 or 10, `gateway` under 6, 7 or 9). Only a guardrail its
 *   mechanism can show (`policy/refusals.ts`) counts it: row security refuses any other, and the reader checks too.
 * - **From whom:** only a role `policy/refusals.ts` lets append its mechanism, by `appended_by`. Any other's is no
 *   refusal at all, and is not shown.
 * - **Relayed:** what the GitHub worker's guard, GitHub and the review check refuse is appended by the worker that asked,
 *   with the record the GitHub worker kept and its signature over it. The console's server checks each against the
 *   worker's public key (`apps/console/src/refusals.ts`, `/api/refusals`): verified counts; **redacted**, whose public
 *   words are the signed ones through the redactor, counts too, the line having checked it when it was recorded; and
 *   **unverified** shows so, and is not counted, as is a relayed one with no signature at all. Any refusal that carries
 *   a signature is held to it, whatever its mechanism. Until the server has answered, one reads as being checked.
 * - **How many:** a folded refusal stands for `count` of them, and counts so.
 *
 * Reading them needs nothing from the store but what the console already holds: every public event, which the fold
 * reads once. `foldRefusals` keeps each guardrail's trusted refusals in time order, with no time applied; the view at t
 * walks each list back from its newest, past any after t, until it leaves the seven days, so a later time reads only
 * the refusals in its window and never the whole store again.
 *
 * Plain TypeScript, so Node tests it directly.
 */
import type { PublicEvent, RefusalMechanism } from '@software-factory/events';
import { type RefusalCheck, SIGNED_MECHANISMS, signedPayloadOf } from '@software-factory/events/signed';
import { mayAppend, REFUSALS } from '@software-factory/policy/refusals';

/** How far back a row's refusals go. */
export const REFUSAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How many lines an opened row shows. */
export const REFUSAL_LINES = 3;

/** The mechanisms whose refusals are relayed from the GitHub worker, and so are counted only with a signed record. */
const RELAYED: readonly RefusalMechanism[] = SIGNED_MECHANISMS;

/** The server's word on a relayed refusal (`/api/refusals`). */
export type Check = RefusalCheck;

/** Each relayed refusal's check, by seq: one not in it has not been answered yet. */
export type Checks = ReadonlyMap<number, Check>;

/** The mechanisms, in the designs' words (the mockup's `MECH`). */
export const MECHANISM_WORDS: Record<RefusalMechanism, string> = {
  'token-permission': 'token permission',
  ruleset: 'ruleset',
  'egress-policy': 'egress policy',
  'admission-control': 'admission control',
  'scope-fence': 'scope fence',
  gateway: 'gateway',
  'typed-judgement': 'typed judgement',
  'github-guard': 'GitHub worker’s guard',
  'review-gate': 'review gate',
};

/** One trusted refusal, as the fold keeps it. */
export interface Refusal {
  seq: number;
  at: number;
  mechanism: RefusalMechanism;
  /** What was refused, in a few words: the mechanism's own `action`. */
  action: string;
  /** How many refusals it stands for. */
  count: number;
  /** Its work item, or none: then the audit log is where it is. */
  workItem: string | null;
  /** Whether it must check out against a signed record to count: relayed, or carrying a signature. */
  signed: boolean;
  /** Whether it carries a record and a signature to check. */
  checkable: boolean;
}

/** Each guardrail's trusted refusals, oldest first, with no time applied. */
export type FoldedRefusals = ReadonlyMap<number, readonly Refusal[]>;

/** The guardrails each mechanism can show, from policy. */
const SHOWS = new Map(
  (Object.keys(REFUSALS) as RefusalMechanism[]).map((mechanism) => [
    mechanism,
    new Set(Object.values(REFUSALS[mechanism].guardrails as Record<string, readonly number[]>).flat()),
  ]),
);

/** The trusted refusals by t, under each guardrail they show, in time order. */
export function foldRefusals(seen: readonly PublicEvent[]): FoldedRefusals {
  const by = new Map<number, Refusal[]>();
  for (const event of seen) {
    if (event.type !== 'action.refused') continue;
    const { mechanism, action, guardrails, count, signature } = event.payload;
    if (!mayAppend(mechanism, event.appended_by ?? '')) continue;
    const refusal: Refusal = {
      seq: event.seq,
      at: Date.parse(event.ts),
      mechanism,
      action,
      count: count ?? 1,
      workItem: event.work_item,
      signed: RELAYED.includes(mechanism) || signature !== undefined,
      // Only one the server will check: a record named by its hash, and a signature. Any other is unverified here.
      checkable: signedPayloadOf(event) !== undefined,
    };
    for (const n of new Set(guardrails ?? [])) {
      if (!SHOWS.get(mechanism)?.has(n)) continue;
      const list = by.get(n) ?? [];
      list.push(refusal);
      by.set(n, list);
    }
  }
  // Seq order is nearly time order; a relay can append a refusal a little after one made later.
  for (const list of by.values()) list.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return by;
}

/** How a refusal on a row stands: counted, counted though its public words are redacted, unverified, or being checked. */
export type Standing = 'counted' | 'redacted' | 'unverified' | 'checking';

export interface RefusalLine extends Omit<Refusal, 'signed' | 'checkable'> {
  standing: Standing;
}

export interface RefusalsView {
  /** The last few in the window, newest first. */
  lines: RefusalLine[];
  /** How many refusals the window holds that count, folded ones by their count. */
  counted: number;
  /** How many it holds that are shown but not counted. */
  unverified: number;
}

/** How one refusal stands, by the server's check. */
function standingOf(refusal: Refusal, checks: Checks): Standing {
  if (!refusal.signed) return 'counted';
  if (!refusal.checkable) return 'unverified';
  const check = checks.get(refusal.seq);
  return check === undefined ? 'checking' : check === 'verified' ? 'counted' : check;
}

/** A guardrail's refusals in the seven days to t. */
export function refusalsAt(list: readonly Refusal[] | undefined, t: number, checks: Checks): RefusalsView {
  const view: RefusalsView = { lines: [], counted: 0, unverified: 0 };
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
    const refusal = list?.[i];
    if (!refusal || refusal.at > t) continue;
    if (refusal.at <= t - REFUSAL_WINDOW_MS) break;
    const { signed: _signed, checkable: _checkable, ...shown } = refusal;
    const standing = standingOf(refusal, checks);
    if (standing === 'counted' || standing === 'redacted') view.counted += refusal.count;
    if (standing === 'unverified') view.unverified += refusal.count;
    if (view.lines.length < REFUSAL_LINES) view.lines.push({ ...shown, standing });
  }
  return view;
}

/** The relayed refusals the server is asked about: those it checks, by the same test (`signedPayloadOf`). */
export const toCheck = (events: readonly PublicEvent[]): number[] =>
  events.flatMap((event) => (signedPayloadOf(event) !== undefined ? [event.seq] : []));

/** The last rollback the line recorded, and who made it: what proves guardrail 9 where nothing refuses. */
export interface LastRollback {
  version: string;
  at: number;
  by: 'analysis' | 'martin';
}

/** The role every release event is held to (`release.*`, task 25): one from any other rolled nothing back. */
const LINE_ROLE = 'factory_line';

/** The newest rollback by t, from the line's role alone, and not a dry run's. */
export function lastRollback(seen: readonly PublicEvent[]): LastRollback | undefined {
  for (let i = seen.length - 1; i >= 0; i--) {
    const event = seen[i];
    if (event?.type !== 'release.rolled-back' || event.appended_by !== LINE_ROLE) continue;
    if ((event.payload as { dryRun?: boolean }).dryRun) continue;
    return { version: event.payload.version, at: Date.parse(event.ts), by: event.payload.by ?? 'analysis' };
  }
  return undefined;
}
