/**
 * The admin service's side of the store: the tables of signing in (0023_martins-commands.sql), which only its role and
 * the enrolment's may touch, and Martin's events, appended in the same transaction as what they record. Every time is
 * the store's own clock, so the service cannot stretch a session or a code with its own.
 */
import { randomUUID } from 'node:crypto';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import type { Sql, TransactionSql } from 'postgres';
import { ENROLMENT_CODE, PASSKEYS, STEP_UP } from '../../../../policy/access.ts';
import { sha256 } from './secrets.ts';

/**
 * The events the admin service appends, all of them Martin's: his commands, and the opening of the improvement his
 * request opens and of the attack his launch opens, the only work items it opens.
 */
export type AdminEvent =
  | 'attack.launched'
  | 'admin.signed-in'
  | 'admin.signed-out'
  | 'admin.stepped-up'
  | 'alerts.switched'
  | 'controls.changed'
  | 'flag.staged'
  | 'improvement.requested'
  | 'line.started'
  | 'line.stopped'
  | 'passkey.enrolled'
  | 'passkey.revoked'
  | 'release.controlled'
  | 'settings.changed'
  | 'work-item.opened';

/** A session that is live: not ended, not expired, and its passkey not revoked. */
export interface Session {
  /** The SHA-256 of its id, as the store keeps it. */
  hash: string;
  passkey: { id: string; name: string; transports: string[] };
  signedInAt: Date;
  expiresAt: Date;
  /** When the passkey was last given again in it, if it has been. */
  steppedUpAt: Date | null;
  /** Whether that was within `STEP_UP.minutes`, by the store's clock. */
  steppedUp: boolean;
}

export interface Passkey {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  signCount: number;
  transports: string[];
  name: string;
}

export interface PasskeyListed {
  id: string;
  name: string;
  enrolledAt: Date;
  lastUsedAt: Date | null;
}

export type ChallengePurpose = 'enrol' | 'sign-in' | 'step-up';

/** How long a WebAuthn ceremony has, from its options to the passkey's answer. */
export const CEREMONY_MINUTES = 5;

/** A refusal the store makes, which the service turns into its answer. */
export class Refused extends Error {
  readonly refused: string;
  readonly status: number;

  constructor(refused: string, status: number, message: string) {
    super(message);
    this.name = 'Refused';
    this.refused = refused;
    this.status = status;
  }
}

export const TOO_MANY_PASSKEYS = `Martin holds ${PASSKEYS.most} passkeys already: revoke one before enrolling another.`;

/** The SQLSTATE the store's limit on passkeys raises (0025_admin-service.sql). */
const TOO_MANY = 'SF002';

/** The newest enrolment code, the only one that can be live: a new `factory admin enrol` replaces any before it. */
export const newestCode = (sql: Sql | TransactionSql) =>
  sql`select code_sha256 from enrolment_codes order by created_at desc, code_sha256 limit 1`;

/**
 * Starting a session and ending every session take this lock, so a sign-in in flight cannot start one that signing
 * out everywhere, or `factory admin enrol --revoke-others`, has already passed over.
 */
export const lockSessions = (tx: TransactionSql) => tx`select pg_advisory_xact_lock(hashtext('sessions'))`;

export class AdminStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  get sql(): Sql {
    return this.#sql;
  }

  /** The live session with this id's hash, if there is one. */
  async session(hash: string): Promise<Session | undefined> {
    const [row] = await this.#sql<SessionRow[]>`
      select s.id_sha256, s.passkey, p.name, p.transports, s.signed_in_at, s.expires_at, s.stepped_up_at,
             coalesce(s.stepped_up_at > now() - make_interval(mins => ${STEP_UP.minutes}), false) as stepped_up
      from sessions s join passkeys p on p.id = s.passkey
      where s.id_sha256 = ${hash} and s.ended_at is null and s.expires_at > now() and p.revoked_at is null`;
    return row && sessionOf(row);
  }

  /** The passkeys Martin holds, oldest first. */
  async passkeys(): Promise<PasskeyListed[]> {
    const rows = await this.#sql<{ id: string; name: string; enrolled_at: Date; last_used_at: Date | null }[]>`
      select id, name, enrolled_at, last_used_at from passkeys where revoked_at is null order by enrolled_at`;
    return rows.map((r) => ({ id: r.id, name: r.name, enrolledAt: r.enrolled_at, lastUsedAt: r.last_used_at }));
  }

  /** A passkey Martin holds, by its credential's id, with what checking an assertion needs. */
  async passkey(id: string): Promise<Passkey | undefined> {
    const [row] = await this.#sql<
      { id: string; public_key: Uint8Array; sign_count: string; transports: string[]; name: string }[]
    >`select id, public_key, sign_count, transports, name from passkeys where id = ${id} and revoked_at is null`;
    return (
      row && {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        signCount: Number(row.sign_count),
        transports: row.transports,
        name: row.name,
      }
    );
  }

  /**
   * Counts a try of an enrolment code against the live code, as the policy counts them across every client, and says
   * whether this is it, and how many tries it has left after this one: none when no code is live, so a wrong code can
   * be told from one that can no longer be used. Only the newest code `factory admin enrol` printed can be live, so
   * those tries are its own; it is no longer live once used, past its tries or expired, and no older code takes its place.
   */
  async tryCode(hash: string): Promise<{ match: boolean; left: number }> {
    const [row] = await this.#sql<{ code_sha256: string; tries: number }[]>`
      update enrolment_codes set tries = tries + 1
      where code_sha256 = (${newestCode(this.#sql)})
        and used_at is null and expires_at > now() and tries < ${ENROLMENT_CODE.tries}
      returning code_sha256, tries`;
    return { match: row?.code_sha256 === hash, left: row ? ENROLMENT_CODE.tries - row.tries : 0 };
  }

  /** A new challenge for a ceremony, bound to the session or the code it is for. Expired ones go as it is made. */
  async challenge(
    challenge: string,
    purpose: ChallengePurpose,
    bound: { session?: string; code?: string } = {},
  ): Promise<void> {
    await this.#sql`delete from webauthn_challenges where expires_at < now()`;
    await this.#sql`
      insert into webauthn_challenges (challenge, purpose, session, code_sha256, expires_at)
      values (${challenge}, ${purpose}, ${bound.session ?? null}, ${bound.code ?? null},
              now() + make_interval(mins => ${CEREMONY_MINUTES}))`;
  }

  /**
   * Uses a challenge, once: it must be one the service made for this purpose (and, to give the passkey again, for this
   * session), unused and in time. Used whatever the passkey's answer turns out to be, so no answer is tried twice.
   * Returns the code it was bound to, for enrolment, or undefined if it cannot be used.
   */
  async spendChallenge(
    challenge: string,
    purpose: ChallengePurpose,
    session?: string,
  ): Promise<{ code: string | null } | undefined> {
    const [row] = await this.#sql<{ code_sha256: string | null }[]>`
      update webauthn_challenges set used_at = clock_timestamp()
      where challenge = ${challenge} and purpose = ${purpose} and used_at is null and expires_at > now()
        and session is not distinct from ${session ?? null}
      returning code_sha256`;
    return row && { code: row.code_sha256 };
  }

  /**
   * Does the writes of an action and appends the events that record it, in one transaction: an action is done and
   * recorded, or neither.
   */
  async record<T>(act: (tx: TransactionSql) => Promise<T>, events: (result: T) => NewEvent[]): Promise<T> {
    try {
      return (await this.#sql.begin(async (tx) => {
        const result = await act(tx);
        await appendMartins(this.#sql, tx, events(result));
        return result;
      })) as T;
    } catch (error) {
      throw refusalOf(error) ?? error;
    }
  }

  /**
   * Starts a session for a passkey, in a transaction of the caller's, ending the one it replaces if there is one. Says
   * whether that one was live, so the caller records its end as signing out does; one already expired, or whose passkey
   * is revoked, had ended for Martin before.
   */
  async startSession(
    tx: TransactionSql,
    passkey: string,
    hash: string,
    replaces?: string,
  ): Promise<{ ended: boolean }> {
    await lockSessions(tx);
    const ended = replaces
      ? await tx<{ live: boolean }[]>`
          update sessions s set ended_at = now(), ended_by = 'sign-out'
          where id_sha256 = ${replaces} and ended_at is null
          returning s.expires_at > now()
            and exists (select 1 from passkeys p where p.id = s.passkey and p.revoked_at is null) as live`
      : [];
    await tx`insert into sessions (id_sha256, passkey) values (${hash}, ${passkey})`;
    return { ended: ended[0]?.live ?? false };
  }

  /** Records a passkey's use: its signature counter, and when. */
  async used(tx: TransactionSql, passkey: string, signCount: number): Promise<void> {
    await tx`update passkeys set sign_count = ${signCount}, last_used_at = now() where id = ${passkey}`;
  }
}

interface SessionRow {
  id_sha256: string;
  passkey: string;
  name: string;
  transports: string[];
  signed_in_at: Date;
  expires_at: Date;
  stepped_up_at: Date | null;
  stepped_up: boolean;
}

const sessionOf = (row: SessionRow): Session => ({
  hash: row.id_sha256,
  passkey: { id: row.passkey, name: row.name, transports: row.transports },
  signedInAt: row.signed_in_at,
  expiresAt: row.expires_at,
  steppedUpAt: row.stepped_up_at,
  steppedUp: row.stepped_up,
});

/** The store's own refusals, which its triggers raise, as the service's. */
function refusalOf(error: unknown): Refused | undefined {
  if (error instanceof Refused) return error;
  const { code } = error as { code?: string };
  if (code === TOO_MANY) return new Refused('passkeys', 409, TOO_MANY_PASSKEYS);
  return undefined;
}

/**
 * Appends Martin's events within a transaction, in whichever kind of store this is: a store of samples takes samples
 * alone. His events carry no artifacts, so the writer never looks in the artifact store.
 */
export async function appendMartins(sql: Sql, tx: TransactionSql, events: NewEvent[]): Promise<void> {
  if (!events.length) return;
  const [store] = await tx<{ sample: boolean }[]>`select sample from store`;
  const writer = new EventWriter(sql, {
    kind: store?.sample ? 'sample' : 'real',
    artifacts: new DiskArtifacts('/nonexistent'),
  });
  await writer.appendWithin(tx, events);
}

/** One of Martin's events, now: on the line, or on the work item given. */
export function adminEvent<K extends AdminEvent>(
  type: K,
  summary: string,
  payload: PayloadOf<K>,
  workItem: string | null = null,
): NewEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor: 'martin',
    summary,
    payload,
    artifacts: [],
  } as NewEvent;
}

/**
 * Whether a session is live (not ended, not expired, its passkey not revoked) and its passkey was given again within
 * `STEP_UP.minutes`, by the store's clock, as the action is taken: asked again after the lock an action takes, as the
 * passkey given may have gone stale while it waited.
 */
export async function steppedUpNow(tx: Sql | TransactionSql, session: Session): Promise<boolean> {
  const [fresh] = await tx`
    select 1 from sessions s join passkeys p on p.id = s.passkey
    where s.id_sha256 = ${session.hash} and s.ended_at is null and s.expires_at > now()
      and p.revoked_at is null and s.stepped_up_at > now() - make_interval(mins => ${STEP_UP.minutes})`;
  return fresh !== undefined;
}

/** The hash the store keeps of a session's id. */
export const sessionHash = (id: string) => sha256(id);

/**
 * An event checked as the store will check it, for an action made outside the store (a patch of the Rollout, a write
 * of `flags`): checked before the action, so one whose event the store would refuse is a fault here, and nothing is
 * done.
 */
export function checked(event: NewEvent): NewEvent {
  const valid = validate(event);
  if (!valid.ok) throw new Error(`${event.type} is not valid: ${valid.problems.join('; ')}`);
  return event;
}

/**
 * The event of an action made outside the store, appended once it is made, in a transaction of its own, so no
 * connection to the store waits on Kubernetes; once more if that fails. Its id is the same each time, so one that did
 * commit after all is found, and recorded once. Throws the second failure.
 */
export async function appendMade(sql: Sql, event: NewEvent): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.begin((tx) => appendMartins(sql, tx, [event]));
      return;
    } catch (error) {
      const recorded = await sql`select 1 from events where id = ${event.id}`.catch(() => []);
      if (recorded.length) return;
      if (attempt >= 2) throw error;
    }
  }
}
