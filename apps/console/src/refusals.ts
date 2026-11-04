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
import { buffer } from 'node:stream/consumers';
import { checkRecord, publicKeyOf, type RefusalCheck, type SignedPayload } from '@software-factory/events/signed-check';
import type { ArtifactStore } from '@software-factory/store';
import { log } from './log.ts';

export type Check = RefusalCheck;

/** A public refusal that carries a record and a signature, as the feed holds it. */
export interface SignedRefusal {
  seq: number;
  payload: SignedPayload;
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
export class RefusalChecks {
  readonly #made = new Map<number, Promise<Check>>();
  readonly #store: Pick<ArtifactStore, 'open'>;
  readonly #key: KeyObject | undefined;

  constructor(store: Pick<ArtifactStore, 'open'>, key: KeyObject | undefined) {
    this.#store = store;
    this.#key = key;
  }

  /** The checks of these refusals, by seq. A store that cannot be read is logged, and asked again next time. */
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
        return [seq, await made.catch((): Check => 'unverified')] as const;
      }),
    );
    return Object.fromEntries(checks);
  }
}
