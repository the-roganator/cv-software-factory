/**
 * Whether each relayed refusal a visitor reads is what the GitHub worker signed. The GitHub worker has no role in the
 * store, so what its guard, GitHub and the review check refuse is appended by the worker that asked, with the record the
 * GitHub worker kept of it and its signature over that record (deviation 5). The Guardrails panel counts one only once
 * it checks out, and only the server can check it: the record holds the refusal's own words before redaction, which a
 * visitor may not read, and the key is the cluster's.
 *
 * So, for each public `action.refused` that carries a record and a signature, the server opens the record, by its hash,
 * from the artifact store, and checks the public view against it (`@software-factory/events/signed-check`): verified,
 * redacted or unverified. Each is checked once, when it is first asked for, and kept: a record is named by its hash, so
 * it cannot change. Nothing of a record leaves the server but the verdict.
 */
import type { KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { buffer } from 'node:stream/consumers';
import { REFUSAL_CHECKS } from '@software-factory/events/signed';
import { checkRecord, publicKeyOf, type RefusalCheck, type SignedPayload } from '@software-factory/events/signed-check';
import type { ArtifactStore } from '@software-factory/store';
import { log } from './log.ts';

export type Check = RefusalCheck;

/** A public refusal that carries a record and a signature, as the feed holds it. */
export interface SignedRefusal {
  seq: number;
  payload: SignedPayload;
}

/** What `/api/refusals` answers from: each relayed refusal's check, by seq. */
export interface Checker {
  of(refusals: readonly SignedRefusal[]): Promise<Record<string, Check>>;
}

/** The most bytes a record may have: its payload's output is at most 4000 characters. */
const MOST_RECORD_BYTES = 64 * 1024;

/** The GitHub worker's public key, from PEM, or none: a key that is not an Ed25519 public key is logged, not used. */
export function refusalKey(pem: string | undefined): KeyObject | undefined {
  if (!pem?.trim()) return undefined;
  const key = publicKeyOf(pem);
  if (!key) log.error('REFUSAL_PUBLIC_KEY is not an Ed25519 public key: every relayed refusal reads as unverified');
  return key;
}

/** How one relayed refusal's public view stands against the record it names. A store that cannot be read throws. */
export async function checkRefusal(
  store: Pick<ArtifactStore, 'open'>,
  key: KeyObject | undefined,
  payload: SignedPayload,
): Promise<Check> {
  if (!key) return 'unverified';
  const opened = await store.open(payload.record);
  if (!opened) return 'unverified';
  if (opened.size > MOST_RECORD_BYTES) {
    opened.body.destroy();
    return 'unverified';
  }
  return checkRecord(await buffer(opened.body), key, payload);
}

/** Every relayed refusal's check, by seq, each made once. */
export class RefusalChecks implements Checker {
  readonly #made = new Map<number, Promise<Check>>();
  readonly #store: Pick<ArtifactStore, 'open'>;
  readonly #key: KeyObject | undefined;

  constructor(store: Pick<ArtifactStore, 'open'>, key: KeyObject | undefined) {
    this.#store = store;
    this.#key = key;
  }

  /**
   * The checks of these refusals, by seq. One whose record the store could not read is logged and left out, so the page
   * asks again, and so is the store.
   */
  async of(refusals: readonly SignedRefusal[]): Promise<Record<string, Check>> {
    const checks = await Promise.all(
      refusals.map(async ({ seq, payload }) => {
        let made = this.#made.get(seq);
        if (!made) {
          made = checkRefusal(this.#store, this.#key, payload);
          this.#made.set(seq, made);
          made.catch((error: unknown) => {
            log.error({ err: error, seq }, 'a relayed refusal’s record could not be read');
            this.#made.delete(seq);
          });
        }
        return [seq, await made.catch(() => undefined)] as const;
      }),
    );
    return Object.fromEntries(checks.flatMap(([seq, check]) => (check ? [[seq, check] as const] : [])));
  }
}

/**
 * The checks an event-log folder keeps beside its events (`refusals.json`), made when the folder was written, for a
 * server serving the folder as for a page reading it with none. A folder is what the replay site publishes whole, so it
 * holds no record, whose words are those before redaction: the verdicts are all it has. A refusal it has none for, or
 * one not a check's word, is unverified.
 */
export class RecordedChecks implements Checker {
  readonly #checks: ReadonlyMap<number, Check>;

  constructor(file: string) {
    const checks = new Map<number, Check>();
    const body: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      for (const [seq, check] of Object.entries(body)) {
        if ((REFUSAL_CHECKS as readonly unknown[]).includes(check)) checks.set(Number(seq), check as Check);
      }
    }
    this.#checks = checks;
  }

  async of(refusals: readonly SignedRefusal[]): Promise<Record<string, Check>> {
    return Object.fromEntries(refusals.map(({ seq }) => [seq, this.#checks.get(seq) ?? 'unverified']));
  }
}
