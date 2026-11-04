/**
 * Whether a relayed refusal's public view is what the GitHub worker signed, from the record it names (`signed.ts`). The
 * console's server answers it for the page (`apps/console/src/refusals.ts`), and an event-log folder writes it beside
 * its events (`refusals.json`), since a page reading the folder has no server to ask. Node only.
 *
 * - **verified** when the record's bytes hash to the name the refusal gives them, the signature over them verifies with
 *   the GitHub worker's public key, and the public payload is the payload it signed, with only what a relay adds beside
 *   it;
 * - **redacted** when all of that holds but the public payload is the signed one through the redactor, which replaced
 *   something shaped like a secret: the words differ, but only as the public view changes them (Martin's decision,
 *   2026-10-31: it shows as redacted, and counts);
 * - **unverified** otherwise: no key, no record, a record of another hash, a signature that does not verify, or a
 *   payload that is neither.
 */
import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import { redactDeep } from './public.ts';
import { canonical, RELAY_ADDS } from './signed.ts';

export type RefusalCheck = 'verified' | 'redacted' | 'unverified';

/** What the check needs of a public refusal: its payload, naming its record and the signature over it. */
export type SignedPayload = Record<string, unknown> & { record: string; signature: string };

/** An Ed25519 public key from PEM, or none: anything else, a private key included, is no key. */
export function publicKeyOf(pem: string | undefined): KeyObject | undefined {
  if (!pem?.trim() || /PRIVATE KEY-----/.test(pem)) return undefined;
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** How a public refusal stands against the bytes of the record it names, or none found. Never throws. */
export function checkRecord(
  bytes: Uint8Array | undefined,
  key: KeyObject | undefined,
  payload: SignedPayload,
): RefusalCheck {
  if (!key || !bytes) return 'unverified';
  if (createHash('sha256').update(bytes).digest('hex') !== payload.record) return 'unverified';
  let good = false;
  try {
    good = verify(null, bytes, key, Buffer.from(payload.signature, 'base64'));
  } catch {
    good = false;
  }
  if (!good) return 'unverified';
  let record: { type?: unknown; payload?: unknown } | null;
  try {
    record = JSON.parse(new TextDecoder().decode(bytes)) as typeof record;
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

/** A public refusal's payload if it names a record and a signature, as a relayed one does; any other, nothing. */
export function signedPayloadOf(event: { type: string; payload?: unknown }): SignedPayload | undefined {
  if (event.type !== 'action.refused') return undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  const { record, signature } = payload ?? {};
  if (typeof record !== 'string' || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(record)) return undefined;
  return { ...payload, record, signature };
}

/** The checks an event-log folder keeps beside its events, for a page that reads the folder with no server. */
export const REFUSAL_CHECKS_FILE = 'refusals.json';
