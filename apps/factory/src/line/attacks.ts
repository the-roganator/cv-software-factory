/**
 * The line's judgement of each red-team attack (`policy/attacks.ts`), from the event stream alone. The harness does not
 * grade itself: it records how an attack ended (`attack.finished`), and the line reads that record again against the
 * refusals it cites, and pages Martin, through the security count (`security.ts`), when the attack was not refused,
 * when the line cannot agree that it was, or when it did not finish within its limit.
 *
 * Only an `attack.finished` the harness's role appended, on a work item one of Martin's roles launched that attack on,
 * is judged: row security holds both to those roles (0045_red-team-attacks.sql), and the line reads `appended_by` too,
 * so a hole in a policy is not the only lock. Each is:
 *
 * - **not refused** (`attack-not-refused`) when the harness says so, or when any attempt it records got through,
 *   whatever it says of the attack as a whole;
 * - **by the wrong mechanism** (`attack-wrong-mechanism`) when it says refused and the line cannot agree: the refusals it
 *   expects are not the attack's, in order; or one of the refusals it cites is not there, is no refusal, came before the
 *   launch, is by another mechanism than the one expected at its place, was appended by a role that may not append
 *   that mechanism's refusals (`policy/refusals.ts`), does not verify where it is signed, or is about something other
 *   than the attack's own subject: its report, by the id triage gives the report's refusal; its pod, by its uid; its
 *   pull request, by the repository and number the signed record names; or, for an attack whose refusals the harness
 *   records itself, its own work item. The egress attack must have reached its control, the gateway, too. A record
 *   the line cannot read at all is judged so too, as the line cannot agree;
 * - **unfinished** (`attack-unfinished`) when the harness says so (its control failed, or it found its own launch past
 *   its limit), or when no `attack.finished` that says how it ended came from the harness's role within its limit
 *   (`attackLimitMs`). There is no event to react to for that: the line counts, each time it reads, the launches whose
 *   limit has passed with no end within it, by the store's own clock (`appended_at`), so a count never falls and two
 *   replicas agree. An end that comes late does not undo it.
 *
 * A refusal itself pages nobody: it is the guardrail working.
 */
import type { KeyObject } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { ATTACKS, type Attack, type PayloadOf, upcast } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { type ArtifactStore, byMartin } from '@software-factory/store';
import { refusalIdFor } from '@software-factory/triage/events';
import type { Sql } from 'postgres';
import { attackLimitMs, expectedRefusals } from '../../../../policy/attacks.ts';
import { mayAppend } from '../../../../policy/refusals.ts';
import type { STORE_GRANTS } from '../../../../policy/store-grants.ts';
import { canonical, SIGNED_MECHANISMS, verifyRefusal } from '../signed-refusals.ts';

/** The one role whose record of an attack's end is trusted (0045_red-team-attacks.sql). */
export const HARNESS_ROLE = 'factory_redteam' satisfies keyof typeof STORE_GRANTS;

/**
 * What each attack's refusals must be about, so none from someone else's report, pull request or pod is counted:
 * - `report`: triage's refusal of the very report the attack sent, which goes on triage's own work item for it;
 * - `pod`: admission control's refusal of the very pod the attack asked for, which the line records with no work item;
 * - `pull-request`: the review check's on the attack's own work item, its signed record naming the attack's pull request;
 * - `own`: what the harness records itself, relayed or its pod's own record, on the attack's own work item.
 */
export const ATTACK_SUBJECTS: Record<Attack, 'report' | 'pod' | 'pull-request' | 'own'> = {
  report: 'report',
  workflow: 'own',
  test: 'pull-request',
  egress: 'own',
  image: 'pod',
};

/** How the line judges an attack's end: as the harness says it ended, or not. */
export type Verdict =
  | { verdict: 'refused' }
  | { verdict: 'not-refused'; why: string }
  | { verdict: 'unfinished' }
  | { verdict: 'wrong-mechanism'; why: string };

/** An `attack.finished`, as stored. */
export interface StoredFinished {
  seq: number;
  workItem: string;
  version: number;
  payload: unknown;
  /** When the store took it, by its own clock. */
  at: Date;
}

/** The launch it ends: the latest `attack.launched` one of Martin's roles appended on its work item before it. */
export interface StoredLaunch {
  seq: number;
  attack: string;
  /** When the store took it, by its own clock. */
  at: Date;
}

/** A refusal an attack's end cites, as stored, with what the line made of its signature. */
export interface StoredRefusal {
  seq: number;
  id: string;
  workItem: string | null;
  type: string;
  version: number;
  appendedBy: string | null;
  sample: boolean;
  payload: unknown;
  /**
   * For a refusal that carries a signature: the repository, number and time its signed record names, once its record
   * and signature verify, or null when they do not. Undefined for one with no signature.
   */
  signed?: SignedFacts | null;
}

/** What a verified signed record says of a refusal, beyond its payload. */
export interface SignedFacts {
  repo: string;
  number: number | null;
  /** When the mechanism refused, as it signed it. */
  at: Date;
}

/**
 * The mechanisms whose refusals are relayed, and so must verify: the GitHub worker's guard, GitHub's 403, and the review
 * check, whose run the GitHub worker reads and signs (`policy/refusals.ts`).
 */
const RELAYED: readonly string[] = [...SIGNED_MECHANISMS, 'review-gate'];

/**
 * How far the GitHub worker's clock, by which it signs a refusal's time, may be from the store's: a minute, so a
 * refusal signed in the attack is never taken for an earlier one, and one from an earlier attack still is.
 */
const SKEW_MS = 60_000;

type Finished = PayloadOf<'attack.finished'>;
type Refusal = PayloadOf<'action.refused'>;

/** The current version of a stored payload of a type, if it reads as one, or undefined. */
function read<T extends 'attack.finished' | 'action.refused'>(
  type: T,
  version: number,
  payload: unknown,
): PayloadOf<T> | undefined {
  const raised = upcast({ type, version, payload: payload as Record<string, unknown> });
  if (!raised.ok) return undefined;
  const parsed = PAYLOADS[type].safeParse(raised.event.payload);
  return parsed.success ? (parsed.data as PayloadOf<T>) : undefined;
}

/** Whether a refusal must carry a signature that verifies: a relayed mechanism's always, and any that carries one. */
const mustVerify = (refusal: Refusal) => refusal.signature !== undefined || RELAYED.includes(refusal.mechanism);

/** Why a cited refusal is not about the attack's own subject, or undefined when it is. */
function offSubject(finished: Finished, workItem: string, stored: StoredRefusal, refusal: Refusal): string | undefined {
  const subject = finished.subject;
  switch (ATTACK_SUBJECTS[finished.attack]) {
    case 'report':
      if (!subject?.report) return 'it names no report';
      return stored.id === refusalIdFor(subject.report) ? undefined : 'it is not the refusal of the report it sent';
    case 'pod': {
      const pod = subject?.pod;
      if (!pod) return 'it names no pod';
      const about = refusal.subject;
      const same =
        about?.kind === 'Pod' && about.uid === pod.uid && about.namespace === pod.namespace && about.name === pod.name;
      return same ? undefined : 'it is not about the pod it asked for';
    }
    case 'pull-request': {
      const pullRequest = subject?.pullRequest;
      if (!pullRequest) return 'it names no pull request';
      if (stored.workItem !== workItem) return 'it is not on the attack’s own work item';
      const signed = stored.signed;
      const same = signed && signed.repo === pullRequest.repository && signed.number === pullRequest.number;
      return same ? undefined : 'its signed record is not about the pull request it opened';
    }
    case 'own':
      return stored.workItem === workItem ? undefined : 'it is not on the attack’s own work item';
  }
}

/**
 * The line's verdict on one `attack.finished` the harness's role appended, given the launch it ends and the refusals it
 * cites, by seq, as the store holds them. Pure.
 */
export function judge(
  stored: StoredFinished,
  launch: StoredLaunch,
  refusals: ReadonlyMap<number, StoredRefusal>,
): Verdict {
  const finished = read('attack.finished', stored.version, stored.payload);
  if (!finished) {
    const said = (stored.payload as { outcome?: unknown } | null)?.outcome;
    const why = 'its record cannot be read';
    return said === 'not-refused' ? { verdict: 'not-refused', why } : { verdict: 'wrong-mechanism', why };
  }
  const through = finished.attempts.find((attempt) => !attempt.refused);
  if (through) return { verdict: 'not-refused', why: `an attempt got through: ${through.what}` };
  if (finished.outcome === 'not-refused') return { verdict: 'not-refused', why: 'the harness says so' };
  if (finished.outcome === 'unfinished') return { verdict: 'unfinished' };

  const wrong = (why: string): Verdict => ({ verdict: 'wrong-mechanism', why });
  if (finished.attack !== launch.attack) return wrong(`it ends a launch of ${launch.attack}, not ${finished.attack}`);
  const expected = expectedRefusals(finished.attack);
  if (canonical(finished.expected) !== canonical(expected)) {
    return wrong(`it expects ${finished.expected.join(', ')}, not ${expected.join(', ')}`);
  }
  // The schema holds a refused egress attack to a control it reached; read again, as a record the line cannot agree
  // with otherwise fails closed.
  if (finished.attack === 'egress' && finished.control?.reached !== true) {
    return wrong(finished.control ? 'its control, the gateway, was not reached' : 'it records no control');
  }
  if (finished.refusals.length !== expected.length) {
    return wrong(`it cites ${finished.refusals.length} refusals for the ${expected.length} expected`);
  }
  for (const [place, seq] of finished.refusals.entries()) {
    const cited = refusals.get(seq);
    const at = `refusal ${seq}`;
    if (cited?.type !== 'action.refused' || cited.sample) return wrong(`${at} is no refusal in the store`);
    if (cited.seq <= launch.seq || cited.seq >= stored.seq) {
      return wrong(`${at} is not from between its launch and end`);
    }
    const refusal = read('action.refused', cited.version, cited.payload);
    if (!refusal) return wrong(`${at} cannot be read`);
    if (refusal.mechanism !== expected[place]) {
      return wrong(`${at} is by ${refusal.mechanism}, where ${expected[place]} was expected`);
    }
    if (!cited.appendedBy || !mayAppend(refusal.mechanism, cited.appendedBy)) {
      return wrong(`${at} was appended by ${cited.appendedBy ?? 'no role'}, which may not record ${refusal.mechanism}`);
    }
    if (mustVerify(refusal) && !cited.signed) return wrong(`${at} does not verify`);
    // A signed refusal says when it was made: one from before the launch, appended again, is another attack's.
    const signedAt = cited.signed?.at.getTime();
    if (
      signedAt !== undefined &&
      (signedAt < launch.at.getTime() - SKEW_MS || signedAt > stored.at.getTime() + SKEW_MS)
    ) {
      return wrong(`${at} was signed outside its launch and end`);
    }
    const off = offSubject(finished, stored.workItem, cited, refusal);
    if (off) return wrong(`${at}: ${off}`);
  }
  return { verdict: 'refused' };
}

/** What the line needs to verify a relayed refusal: the GitHub worker's public key, and where its records are kept. */
export interface Verifier {
  key: KeyObject | undefined;
  artifacts: Pick<ArtifactStore, 'open'> | undefined;
}

/** The most bytes a signed refusal's record may have: its payload's output is at most 4000 characters. */
const MOST_RECORD_BYTES = 64 * 1024;

/**
 * The repository and number a stored refusal's signed record names, if the record is in the artifact store, is the
 * refusal as stored, and its signature verifies with the GitHub worker's key; null if not, or with no key or no
 * store to verify it by. A store that cannot be read throws, so the read is tried again rather than judged.
 */
export async function verifyStored(verifier: Verifier, payload: unknown): Promise<SignedFacts | null> {
  const { record, signature, count: _count, lastAt: _lastAt, ...signed } = (payload ?? {}) as Record<string, unknown>;
  if (typeof record !== 'string' || typeof signature !== 'string' || !verifier.key || !verifier.artifacts) return null;
  const opened = await verifier.artifacts.open(record);
  if (!opened) return null;
  if (opened.size > MOST_RECORD_BYTES) {
    opened.body.destroy();
    return null;
  }
  let facts: { type?: unknown; repo?: unknown; number?: unknown; at?: unknown; payload?: unknown };
  try {
    facts = JSON.parse((await buffer(opened.body)).toString('utf-8'));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (facts?.type !== 'action.refused' || canonical(facts.payload) !== canonical(signed)) return null;
  const verified = verifyRefusal(verifier.key, {
    repo: facts.repo,
    number: facts.number,
    at: facts.at,
    payload: signed,
    record,
    signature,
  });
  if (!verified.ok) return null;
  return { repo: verified.refusal.repo, number: verified.refusal.number, at: new Date(verified.refusal.at) };
}

/**
 * The line's verdict on each of these `attack.finished`, by seq, read from the store: each the harness's role appended,
 * on a work item with a launch by one of Martin's roles before it. One with no such launch is not judged, and is not
 * in the map.
 */
export async function judgeStored(
  sql: Sql,
  finished: readonly StoredFinished[],
  verifier: Verifier,
): Promise<Map<number, Verdict>> {
  const verdicts = new Map<number, Verdict>();
  for (const end of finished) {
    const [launch] = await sql<{ seq: string; attack: string; at: Date }[]>`
      select l.seq::text as seq, l.payload->>'attack' as attack, l.appended_at as at from events l
      where l.work_item = ${end.workItem} and l.type = 'attack.launched' and l.seq < ${end.seq}
        and ${byMartin(sql, 'l')}
      order by l.seq desc limit 1`;
    if (!launch) continue;
    const seqs = citedSeqs(end.payload);
    const rows = seqs.length
      ? await sql<
          {
            seq: string;
            id: string;
            work_item: string | null;
            type: string;
            version: number;
            appended_by: string | null;
            sample: boolean;
            payload: unknown;
          }[]
        >`
          select seq::text as seq, id, work_item, type, version, appended_by, sample, payload from events
          where seq in ${sql(seqs.map(String))}`
      : [];
    const refusals = new Map<number, StoredRefusal>();
    for (const row of rows) {
      // Only a refusal is verified: anything else cited is judged without opening a record.
      const signed =
        row.type === 'action.refused' && !row.sample
          ? (row.payload as { signature?: unknown } | null)?.signature
          : undefined;
      refusals.set(Number(row.seq), {
        seq: Number(row.seq),
        id: row.id,
        workItem: row.work_item,
        type: row.type,
        version: row.version,
        appendedBy: row.appended_by,
        sample: row.sample,
        payload: row.payload,
        ...(signed !== undefined && { signed: await verifyStored(verifier, row.payload) }),
      });
    }
    verdicts.set(end.seq, judge(end, { seq: Number(launch.seq), attack: launch.attack, at: launch.at }, refusals));
  }
  return verdicts;
}

/** The seqs an end cites, as far as they can be read: the judgement says whether the rest of it can. */
function citedSeqs(payload: unknown): number[] {
  const refusals = (payload as { refusals?: unknown } | null)?.refusals;
  if (!Array.isArray(refusals)) return [];
  return refusals.filter((seq): seq is number => Number.isSafeInteger(seq) && seq > 0).slice(0, 8);
}

/** Each attack's limit, in milliseconds, as the store reads it to judge a launch unfinished. */
const LIMITS = Object.fromEntries(ATTACKS.map((attack) => [attack, attackLimitMs(attack)]));

/**
 * How many launches by Martin's roles are unfinished now: the harness's role said one ended unfinished, or none of its
 * ends that says how the attack went (refused or not) came within the launch's limit, and the limit has passed. By the
 * store's clock alone, in one statement, so a line that restarts, or a second replica, gives the same figure, and it
 * never falls.
 */
export async function countUnfinished(sql: Sql): Promise<number> {
  // An end that records an attempt that got through: counted as not refused (`judge`), and so never as unfinished.
  const through = sql`exists (select 1 from jsonb_array_elements(
                                case when jsonb_typeof(f.payload->'attempts') = 'array' then f.payload->'attempts'
                                     else '[]'::jsonb end) a
                              where a->'refused' = 'false'::jsonb)`;
  const [row] = await sql<{ unfinished: number }[]>`
    with launches as (
      select l.seq, l.work_item, l.appended_at,
             l.appended_at + make_interval(secs => coalesce((${sql.json(LIMITS)}::jsonb ->> (l.payload->>'attack'))::float8,
                                                           ${attackLimitMs('')}) / 1000) as due
      from events l
      where l.type = 'attack.launched' and ${byMartin(sql, 'l')})
    select count(*)::int as unfinished from launches l
    where not exists (select 1 from events f
                      where f.work_item = l.work_item and f.type = 'attack.finished' and f.seq > l.seq
                        and not f.sample and f.appended_by = ${HARNESS_ROLE} and f.appended_at <= l.due and ${through})
      and (exists (select 1 from events f
                   where f.work_item = l.work_item and f.type = 'attack.finished' and f.seq > l.seq and not f.sample
                     and f.appended_by = ${HARNESS_ROLE} and f.payload->>'outcome' = 'unfinished' and not ${through})
           or (l.due <= now()
               and not exists (select 1 from events f
                               where f.work_item = l.work_item and f.type = 'attack.finished' and f.seq > l.seq
                                 and not f.sample and f.appended_by = ${HARNESS_ROLE}
                                 and f.payload->>'outcome' in ('refused', 'not-refused') and f.appended_at <= l.due)))`;
  return row?.unfinished ?? 0;
}
