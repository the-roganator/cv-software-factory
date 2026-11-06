/**
 * What the GitHub worker refuses, and what GitHub refuses it, kept and signed, so the worker that asked can record it
 * (`../signed-refusals.ts`). The worker has no role in the event store: it keeps each refusal as a record in the artifact
 * store, logs it with the record's hash (for Loki: a relay that drops one is caught there), and answers it signed.
 *
 * - **Its guard's** (`github-guard`): a patch that changes a protected path (a patch it cannot read or apply is the
 *   coder's failure, not a refusal), a branch the factory does not own, a deploy pull request or image that is not one,
 *   and an issue or pull request the App did not open (`issues.ts`).
 * - **GitHub's** (`token-permission`): a write GitHub answered 403, which is GitHub refusing the App's token. A 401 is a
 *   bad or expired token, and a 403 that is a rate limit is GitHub asking it to wait: neither refuses anything.
 * - **The review check's** (`review-gate`): the `review` check run the review App posted on a pull request's head,
 *   failing it, read when the line reads the gate's verdict on its pull request (`merging.ts`, a verdict whose rule is
 *   `held`), or when the red-team harness asks for its verdict on the pull request its attack opened (`attacks.ts`).
 *   Its words are the check's own: its title, and its summary.
 *
 * Without the signing key it still keeps and logs each refusal, and answers it unsigned, which no reader trusts.
 */

import type { KeyObject } from 'node:crypto';
import { cutTo } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import type { ArtifactStore } from '@software-factory/store';
import type { Logger } from 'pino';
import { guardrailsFor, type RefusalCause } from '../../../../policy/refusals.ts';
import {
  type RefusalFacts,
  recordBytes,
  recordHash,
  type SignedPayload,
  type SignedRefusal,
  signRecord,
} from '../signed-refusals.ts';

/** A refusal as the worker sees it, before it is kept. */
export type GitHubRefusal = {
  repo: string;
  number: number | null;
  /** What was refused, in a few words. */
  action: string;
  /** The refusal's own words: the guard's, GitHub's answer, or the review check's. */
  output: string;
  /** What was refused, when the repository and number do not say it all: the commit a review check judged. */
  subject?: { kind: string; name: string };
} & (
  | { mechanism: 'github-guard'; cause: RefusalCause<'github-guard'> }
  | { mechanism: 'token-permission'; cause: RefusalCause<'token-permission'> }
  | { mechanism: 'review-gate'; cause: RefusalCause<'review-gate'> }
);

/** The guardrails a refusal shows, for its mechanism and why. */
function guardrailsOf(refusal: GitHubRefusal): number[] {
  switch (refusal.mechanism) {
    case 'github-guard':
      return guardrailsFor('github-guard', refusal.cause);
    case 'token-permission':
      return guardrailsFor('token-permission', refusal.cause);
    case 'review-gate':
      return guardrailsFor('review-gate', refusal.cause);
  }
}

export interface RefusalRecorderOptions {
  /** Where each record is kept; without it, a refusal is only logged. */
  artifacts?: ArtifactStore | undefined;
  /** The signing key; without it, a refusal is answered unsigned. */
  key?: KeyObject | undefined;
  log?: Logger | undefined;
  now?: () => Date;
}

export class RefusalRecorder {
  readonly #o: RefusalRecorderOptions;

  constructor(options: RefusalRecorderOptions) {
    this.#o = options;
  }

  /** Whether it signs what it keeps. */
  get signs(): boolean {
    return this.#o.key !== undefined;
  }

  /**
   * Keeps one refusal, logs it with its record's hash, and gives it back signed, to answer with; undefined only with
   * nowhere to keep it. A store that cannot keep it throws, as an action that cannot be recorded does. `at` is when it
   * was refused, if not now: a review check's refusal is when the check concluded, so reading it again keeps the same
   * record.
   */
  async record(refusal: GitHubRefusal, at?: Date): Promise<SignedRefusal | undefined> {
    const payload: SignedPayload = PAYLOADS['action.refused'].parse({
      mechanism: refusal.mechanism,
      action: cutTo(refusal.action, 200),
      output: cutTo(refusal.output, 4000),
      guardrails: guardrailsOf(refusal),
      ...(refusal.subject && { subject: refusal.subject }),
    });
    const facts: RefusalFacts = {
      repo: refusal.repo,
      number: refusal.number,
      at: (at ?? this.#o.now?.() ?? new Date()).toISOString(),
      payload,
    };
    const bytes = recordBytes(facts);
    const record = recordHash(bytes);
    const kept = this.#o.artifacts ? await this.#o.artifacts.put(bytes) : undefined;
    this.#o.log?.warn(
      {
        mechanism: payload.mechanism,
        cause: refusal.cause,
        repo: refusal.repo,
        number: refusal.number,
        action: payload.action,
        record,
        kept: kept !== undefined,
        signed: this.signs,
      },
      'refused: recorded as action.refused',
    );
    if (kept === undefined) return undefined;
    return { ...facts, record, ...(this.#o.key && { signature: signRecord(this.#o.key, bytes) }) };
  }
}
