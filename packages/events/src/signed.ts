/**
 * A relayed refusal's record, as the GitHub worker keeps and signs it (`apps/factory/src/signed-refusals.ts` signs and
 * verifies it; the console's server checks a stored one against its public view): its repository, its issue or pull
 * request (or none), when it was refused, and the `action.refused` payload as the worker made it, as JSON with every
 * object's keys in order, so that the same refusal is always the same bytes. Its hash names it in the artifact store,
 * and the signature is over these bytes.
 *
 * No Node, so it is safe anywhere; the hashing and the signature are the caller's.
 */

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
