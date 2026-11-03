/**
 * A refusal signed by the mechanism that made it, so that a worker relaying it cannot make one up or change one. The
 * GitHub worker has no role in the event store (deviation 5), so what its guard refuses, what GitHub refuses its
 * token, and the review check's refusal it reads for the red-team harness, are recorded by the worker that asked: the
 * GitHub worker answers each refusal with this, and the line, or the harness for an attack, appends it as
 * `action.refused` only once it verifies.
 *
 * The record is the refusal as the artifact store keeps it: its repository, its issue or pull request (or none), when
 * it was refused, and the `action.refused` payload, as JSON with its keys in order, so that the same refusal is always
 * the same bytes. Its hash is the artifact's, and the signature (Ed25519) is over those bytes, so it covers the
 * payload, the repository, the number, the time and, through them, the hash. A relay sends the payload, the repository,
 * the number and the time; the reader makes the bytes again from them, and checks the hash and the signature.
 *
 * The private key is the Secret `refusal-signing-key`, which only the GitHub worker's pod reads; the public key is the
 * ConfigMap `refusal-key` (`make refusal-key`).
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import type { PayloadOf, REFUSAL_MECHANISMS } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { z } from 'zod';

/** The mechanisms a refusal is signed for: those with no role of their own in the store, which a worker relays. */
export const SIGNED_MECHANISMS = [
  'github-guard',
  'token-permission',
  'review-gate',
] as const satisfies (typeof REFUSAL_MECHANISMS)[number][];

/** A refusal as it is signed: the payload without what the relay adds (its record, its signature, its fold). */
export type SignedPayload = Omit<PayloadOf<'action.refused'>, 'record' | 'signature' | 'count' | 'lastAt'>;

/** What the record holds, besides its type. */
export interface RefusalFacts {
  repo: string;
  /** The issue or pull request it was refused on, or null for a branch, a commit or a new pull request. */
  number: number | null;
  /** When it was refused, as an ISO time. */
  at: string;
  payload: SignedPayload;
}

/** A refusal as the GitHub worker answers it: the facts, the record's hash, and the signature over it, if it has a key. */
export interface SignedRefusal extends RefusalFacts {
  record: string;
  signature?: string;
}

/** The record's bytes: its fields, and theirs, in order, so that the same refusal is always the same bytes. */
export function recordBytes({ repo, number, at, payload }: RefusalFacts): Uint8Array {
  return new TextEncoder().encode(`${canonical({ type: 'action.refused', repo, number, at, payload })}\n`);
}

/** The record's hash, as the artifact store names it. */
export const recordHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The signature over a record's bytes, in base64. */
export const signRecord = (key: KeyObject, bytes: Uint8Array): string => sign(null, bytes, key).toString('base64');

/** An Ed25519 private key, from PEM; anything else is refused, without quoting it. */
export function signingKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('The refusal signing key is not a private key in PEM.');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The refusal signing key is not Ed25519.');
  return key;
}

/** An Ed25519 public key, from PEM; anything else is refused, without quoting it. */
export function verifyingKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error('The refusal key is not a public key in PEM.');
  }
  // Node derives a public key from a private one: a private key here is a mistake, and is refused as one.
  if (/PRIVATE KEY-----/.test(pem) || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('The refusal key is not an Ed25519 public key.');
  }
  return key;
}

const signedPayload = PAYLOADS['action.refused'].pipe(
  z.custom<SignedPayload>(
    (payload) =>
      typeof payload === 'object' &&
      payload !== null &&
      !['record', 'signature', 'count', 'lastAt'].some((field) => Object.hasOwn(payload, field)) &&
      (SIGNED_MECHANISMS as readonly string[]).includes((payload as { mechanism: string }).mechanism),
    'a signed mechanism’s refusal, as it was made',
  ),
);

const ANSWER = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  number: z.number().int().positive().nullable(),
  at: z.iso.datetime(),
  payload: signedPayload,
  record: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]{86}==$/)
    .optional(),
});

export type Verified = { ok: true; refusal: Required<SignedRefusal> } | { ok: false; why: string };

/**
 * Whether a relayed refusal is what the GitHub worker signed: one of its mechanisms' payloads, whose record hashes to
 * what it names, and whose signature over that record verifies with the key. Never throws.
 */
export function verifyRefusal(key: KeyObject, answer: unknown): Verified {
  const parsed = ANSWER.safeParse(answer);
  if (!parsed.success) return { ok: false, why: 'it is not a signed refusal’s shape' };
  const { signature, ...refusal } = parsed.data;
  if (signature === undefined) return { ok: false, why: 'it is not signed' };
  // The schema trims text: what was signed must be what is appended, word for word, so a payload it changed is refused.
  if (canonical(refusal.payload) !== canonical((answer as { payload: unknown }).payload)) {
    return { ok: false, why: 'its payload is not as the store would keep it' };
  }
  const bytes = recordBytes(refusal);
  if (recordHash(bytes) !== refusal.record) return { ok: false, why: 'its record is not the refusal it names' };
  let good = false;
  try {
    good = verify(null, bytes, key, Buffer.from(signature, 'base64'));
  } catch {
    good = false;
  }
  return good ? { ok: true, refusal: { ...refusal, signature } } : { ok: false, why: 'its signature does not verify' };
}

/** JSON with every object's keys in order: the one way to write a value. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
