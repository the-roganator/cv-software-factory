/**
 * A relayed refusal's record, as the GitHub worker keeps and signs it (`apps/factory/src/signed-refusals.ts` signs and
 * verifies it; the console's server checks a stored one against its public view): its repository, its issue or pull
 * request (or none), when it was refused, and the `action.refused` payload as the worker made it, as JSON with every
 * object's keys in order, so that the same refusal is always the same bytes. Its hash names it in the artifact store,
 * and the signature is over these bytes.
 *
 * No Node, so it is safe anywhere; the hashing and the signature are the caller's.
 */
import type { RefusalMechanism } from './vocabulary.ts';

/**
 * The mechanisms a refusal is signed for: those with no role of their own in the store, whose refusals a worker relays
 * from the GitHub worker's answers, and which count only with a signed record that checks out.
 */
export const SIGNED_MECHANISMS = [
  'github-guard',
  'token-permission',
  'review-gate',
] as const satisfies readonly RefusalMechanism[];

/** How a relayed refusal's public view stands against its record (`signed-check.ts` says how each is decided). */
export const REFUSAL_CHECKS = ['verified', 'redacted', 'unverified'] as const;
export type RefusalCheck = (typeof REFUSAL_CHECKS)[number];

/** What the check needs of a public refusal: its payload, naming its record and the signature over it. */
export type SignedPayload = Record<string, unknown> & { record: string; signature: string };

/**
 * A public refusal's payload if it names a record, by its hash, and a signature, as a relayed one does; any other,
 * nothing. The server checks only these, and the page asks it only about these.
 */
export function signedPayloadOf(event: { type: string; payload?: unknown }): SignedPayload | undefined {
  if (event.type !== 'action.refused') return undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  const { record, signature } = payload ?? {};
  if (typeof record !== 'string' || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(record)) return undefined;
  return { ...payload, record, signature };
}

/** What a refusal's record holds, besides its type. */
export interface RecordFacts<P = unknown> {
  repo: string;
  /** The issue or pull request it was refused on, or null for a branch, a commit or a new pull request. */
  number: number | null;
  /** When it was refused, as an ISO time. */
  at: string;
  payload: P;
}

/** A record's bytes: its fields, and theirs, in order. */
export function recordBytes({ repo, number, at, payload }: RecordFacts): Uint8Array {
  return new TextEncoder().encode(`${canonical({ type: 'action.refused', repo, number, at, payload })}\n`);
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

/**
 * What a relay adds to the payload the worker signed: the record and its signature, a fold's count and last time, and,
 * for a refusal on no work item, what was refused. Anything else beside the signed payload was not signed.
 */
export const RELAY_ADDS: readonly string[] = ['record', 'signature', 'count', 'lastAt', 'subject'];

/**
 * An event-log folder's public key for its relayed refusals, beside its events, as the cluster's ConfigMap
 * `refusal-key` holds the GitHub worker's: the console's server checks the folder's refusals with it.
 */
export const REFUSAL_KEY_FILE = 'refusal-key.pem';
