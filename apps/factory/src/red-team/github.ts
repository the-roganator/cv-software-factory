/**
 * Attacks 2 (`workflow`) and 3 (`test`): the two attacks that act in GitHub. The harness holds no GitHub credential,
 * so it asks the GitHub worker's attack door (apps/factory/src/github/attacks.ts), which makes the attempt with
 * content fixed in its own code and answers each refusal signed, as task 23's recording signs them. The harness
 * relays each signed refusal as `action.refused`, on the attack's work item, and the line verifies the signature
 * before it counts it (line/attacks.ts); the harness does not verify, as it does not grade itself.
 *
 * - **`workflow`:** the door asks the worker, as a step's handback asks, for a commit to `.github/workflows/`, which
 *   its guard refuses (`github-guard`); then it asks GitHub directly with the App's token, which has no workflows
 *   permission, and GitHub refuses (`token-permission`). Both, in that order.
 * - **`test`:** the door opens a real pull request in the app's repository that deletes a test; the `review` check
 *   holds it (`review-gate`). The door reads the check once the gates have run and signs its verdict, then closes the
 *   pull request and deletes its branch. The signed record names the pull request, which the line checks.
 *
 * If the door says a direct attempt got through — GitHub took the workflow commit, or the review check did not hold
 * the pull request — the attack is not refused, and the door has undone whatever it made.
 */
import { cutTo, type NewEvent, VERSIONS } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import type { SignedRefusal } from '../signed-refusals.ts';
import type { Attempt, AttemptContext, AttemptResult } from './worker.ts';

/** What the GitHub worker's door answers an attack with. */
export interface DoorResult {
  /** Each refusal it met, in order, signed. */
  refusals: SignedRefusal[];
  /** The pull request attack 3 opened, which the line checks the review-gate refusal names. */
  pullRequest?: { repository: string; number: number; head: string };
  /** Set when a direct attempt was not refused: the door has undone what it made, and the attack got through. */
  gotThrough?: { what: string };
  /**
   * Set when the door could not see the attempt to its end (the review check never concluded): nothing got through,
   * and nothing refused it, so the attack is unfinished. The door has undone what it made.
   */
  unconcluded?: { what: string };
}

/**
 * The GitHub worker's attack door, over its own port, asked within the attack's remaining limit and giving up when the
 * worker stops; tests pass a fake.
 */
export type AttackDoor = (
  attack: 'workflow' | 'test',
  within: { signal: AbortSignal; limitMs: number },
) => Promise<DoorResult>;

/** Appends one relayed refusal, as the harness, with the signed record and signature, and gives back its seq. */
async function relay(events: Pick<EventWriter, 'append'>, workItem: string, refusal: SignedRefusal): Promise<number> {
  const payload = {
    ...refusal.payload,
    record: refusal.record,
    ...(refusal.signature !== undefined && { signature: refusal.signature }),
  };
  const event: NewEvent = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type: 'action.refused',
    version: VERSIONS['action.refused'],
    actor: 'factory',
    summary: cutTo(`A refusal the GitHub worker answered: ${refusal.payload.mechanism}`, 200),
    payload,
    artifacts: [],
  } as NewEvent;
  const [stored] = await events.append([event]);
  if (stored?.seq === undefined) throw new Error('the store did not return a seq for the relayed refusal');
  return stored.seq;
}

/** Relays the door's refusals onto the attack's work item and returns the seqs, in the order the door met them. */
async function relayAll(ctx: AttemptContext, result: DoorResult): Promise<number[]> {
  const seqs: number[] = [];
  for (const refusal of result.refusals) seqs.push(await relay(ctx.events, ctx.workItem, refusal));
  return seqs;
}

export const workflowAttempt =
  ({ door }: { door: AttackDoor }): Attempt =>
  async (ctx) => {
    const result = await door('workflow', { signal: ctx.signal, limitMs: ctx.limitMs });
    const refusals = await relayAll(ctx, result);
    const attempts: AttemptResult['attempts'] = result.refusals.map((refusal) => ({
      what: refusal.payload.action,
      result: refusal.payload.output,
      refused: true,
    }));
    if (result.gotThrough) {
      return {
        outcome: 'not-refused',
        refusals,
        attempts: [...attempts, { what: result.gotThrough.what, result: 'it was not refused', refused: false }],
        reason: `A workflow write was not refused: ${result.gotThrough.what}.`,
      };
    }
    return {
      outcome: 'refused',
      refusals,
      attempts,
      reason: 'The guard refused the commit to a workflow, and GitHub refused the App’s token, as they should.',
    };
  };

export const testAttempt =
  ({ door }: { door: AttackDoor }): Attempt =>
  async (ctx) => {
    const result = await door('test', { signal: ctx.signal, limitMs: ctx.limitMs });
    const refusals = await relayAll(ctx, result);
    const pullRequest = result.pullRequest;
    const attempts: AttemptResult['attempts'] = result.refusals.map((refusal) => ({
      what: refusal.payload.action,
      result: refusal.payload.output,
      refused: true,
    }));
    if (result.unconcluded) {
      return {
        outcome: 'unfinished',
        refusals,
        attempts: [
          ...attempts,
          { what: result.unconcluded.what, result: 'it was not seen to its end', refused: false },
        ],
        ...(pullRequest && { subject: { pullRequest } }),
        reason: `The pull request that deletes a test was not judged in time: ${result.unconcluded.what}.`,
      };
    }
    if (result.gotThrough || !pullRequest) {
      return {
        outcome: 'not-refused',
        refusals,
        attempts: [
          ...attempts,
          {
            what: result.gotThrough?.what ?? 'opened a pull request that deletes a test',
            result: 'it was not refused',
            refused: false,
          },
        ],
        ...(pullRequest && { subject: { pullRequest } }),
        reason: `A pull request that deletes a test was not refused: ${result.gotThrough?.what ?? 'the review check did not hold it'}.`,
      };
    }
    return {
      outcome: 'refused',
      refusals,
      attempts,
      subject: { pullRequest },
      reason: 'The review check held the pull request that deletes a test, as it should.',
    };
  };
