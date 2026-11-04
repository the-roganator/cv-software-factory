/**
 * Whether each relayed refusal a visitor reads is what the GitHub worker signed. The GitHub worker has no role in the
 * store, so what its guard, GitHub and the review check refuse is appended by the worker that asked, with the record the
 * GitHub worker kept of it and its signature over that record (deviation 5). The Guardrails panel counts one only once
 * it checks out, and only the server can check it: the record holds the refusal's own words before redaction, which a
 * visitor may not read, and the key is the cluster's.
 *
 * So, for each public `action.refused` that carries a record and a signature, the server opens the record, by its hash,
 * from the artifact store, and finds it:
 *
 * - **verified** when its bytes hash to the name it is given, the signature over them verifies with the GitHub worker's
 *   public key (the ConfigMap `refusal-key`), and the public payload is the payload it signed, with only what a relay
 *   adds beside it;
 * - **redacted** when all of that holds but the public payload is the signed one through the redactor, which replaced
 *   something shaped like a secret: the words differ, but only as the public view changes them (Martin's decision, F-25,
 *   2026-10-31: it shows as redacted, and counts);
 * - **unverified** otherwise: no key, no record, a record of another size or hash, a signature that does not verify, or
 *   a payload that is neither. The panel shows it so, and does not count it.
 *
 * Each is checked once, when it is first asked for, and kept: a record is named by its hash, so it cannot change.
 * Nothing of a record leaves the server but the verdict.
 */
import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { redactDeep } from '@software-factory/events/public';
import { canonical, RELAY_ADDS } from '@software-factory/events/signed';
import type { ArtifactStore } from '@software-factory/store';
import { log } from './log.ts';

export type Check = 'verified' | 'redacted' | 'unverified';

/** A public refusal that carries a record and a signature, as the feed holds it. */
export interface SignedRefusal {
  seq: number;
  payload: Record<string, unknown> & { record: string; signature: string };
}

/** The most bytes a record may have: its payload's output is at most 4000 characters. */
const MOST_RECORD_BYTES = 64 * 1024;

/** The GitHub worker's public key, from PEM, or none: a key that is not an Ed25519 public key is logged, not used. */
export function refusalKey(pem: string | undefined): KeyObject | undefined {
  if (!pem?.trim()) return undefined;
  try {
    const key = createPublicKey(pem);
    // Node derives a public key from a private one: a private key here is a mistake, and is refused as one.
    if (!/PRIVATE KEY-----/.test(pem) && key.asymmetricKeyType === 'ed25519') return key;
  } catch {
    // Said below, without quoting it.
  }
  log.error('REFUSAL_PUBLIC_KEY is not an Ed25519 public key: every relayed refusal reads as unverified');
  return undefined;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** How one relayed refusal's public view stands against the record it names. Never throws for a bad record. */
export async function checkRefusal(
  store: Pick<ArtifactStore, 'open'>,
  key: KeyObject | undefined,
  payload: SignedRefusal['payload'],
): Promise<Check> {
  if (!key) return 'unverified';
  const opened = await store.open(payload.record);
  if (!opened) return 'unverified';
  if (opened.size > MOST_RECORD_BYTES) {
    opened.body.destroy();
    return 'unverified';
  }
  const bytes = await buffer(opened.body);
  if (sha256(bytes) !== payload.record) return 'unverified';
  let good = false;
  try {
    good = verify(null, bytes, key, Buffer.from(payload.signature, 'base64'));
  } catch {
    good = false;
  }
  if (!good) return 'unverified';
  let record: { type?: unknown; payload?: unknown } | null;
  try {
    record = JSON.parse(bytes.toString('utf-8')) as typeof record;
  } catch {
    return 'unverified';
  }
  const signed = record?.payload;
  if (record?.type !== 'action.refused' || !signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return 'unverified';
  }
  // The public payload, without what a relay adds: anything else beside what was signed was not signed.
  const keys = new Set(Object.keys(signed));
  if (Object.keys(payload).some((name) => !keys.has(name) && !RELAY_ADDS.includes(name))) return 'unverified';
  const shown = canonical(Object.fromEntries(Object.entries(payload).filter(([name]) => keys.has(name))));
  if (shown === canonical(signed)) return 'verified';
  if (shown === canonical(redactDeep(signed))) return 'redacted';
  return 'unverified';
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
