/**
 * The GitHub worker's attack door, as the harness calls it (apps/factory/src/github/attacks.ts): one POST an attack,
 * which the worker makes with content fixed in its own code and answers with each refusal signed. The door is on a
 * port of its own, which only the harness's pod may reach (a NetworkPolicy), because attack 2 asks GitHub past the
 * guard, which the line must never be able to do.
 *
 * The call may be slow: attack 3 opens a pull request and waits for the app's gates and the review check before it
 * reads the verdict. The worker holds the request until the attempt is done, so the harness makes one call an attack.
 */
import type { AttackDoor, DoorResult } from './github.ts';

/** How long the harness waits on the door: longer than attack 3's own wait for the gates, within its limit. */
const DOOR_TIMEOUT_MS = 40 * 60_000;

export function attackDoor(url: string, fetchImpl: typeof fetch = fetch): AttackDoor {
  const base = url.replace(/\/$/, '');
  return async (attack) => {
    const response = await fetchImpl(`${base}/v1/attacks/${attack}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(DOOR_TIMEOUT_MS),
    });
    const body = (await response.json()) as DoorResult & { error?: string; message?: string };
    if (!response.ok) {
      throw new Error(
        `the GitHub worker's attack door answered ${response.status}: ${body.message ?? body.error ?? ''}`,
      );
    }
    return body as DoorResult;
  };
}
