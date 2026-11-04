/**
 * The server's word on each relayed refusal the page holds (`GET /api/refusals`, public): whether it is what the GitHub
 * worker signed, which only the server can check (`apps/console/src/refusals.ts`). Guardrails counts one only once it
 * checks out, and reads one it has no word on yet as being checked. Asked when the page holds a relayed refusal it has
 * no word on, and again a few seconds later, for a minute, while one stays so: one the server had not read yet.
 */
import type { PublicEvent } from '@software-factory/events';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Check, type Checks, toCheck } from './projection/index.ts';
import type { Origin } from './source.ts';

const CHECKS: readonly string[] = ['verified', 'redacted', 'unverified'];

/** How long to wait before asking again for a refusal the server had no word on, and how many times. */
const AGAIN_MS = 5000;
const MOST_TRIES = 12;

/** The answer, as checks by seq: anything else in it is left out. */
export function checksOf(body: unknown): Map<number, Check> {
  const checks = new Map<number, Check>();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return checks;
  for (const [seq, check] of Object.entries(body)) {
    const n = Number(seq);
    if (Number.isSafeInteger(n) && typeof check === 'string' && CHECKS.includes(check)) checks.set(n, check as Check);
  }
  return checks;
}

/** Where the checks are: the server's, or beside a recorded log's events, as `refusals.json`. */
const checksUrl = (from: Origin) => (from.kind === 'live' ? '/api/refusals' : `${from.base}refusals.json`);

/** Each relayed refusal's check, as far as the server has answered. */
export function useRefusalChecks(events: readonly PublicEvent[], from: Origin): Checks {
  const [checks, setChecks] = useState<Checks>(() => new Map());
  const [tries, setTries] = useState(0);
  const wanted = useMemo(() => toCheck(events), [events]);
  const missing = wanted.filter((seq) => !checks.has(seq)).length;
  // Read when the answer comes, so a new event that changes nothing asked does not ask again.
  const asked = useRef(wanted);
  asked.current = wanted;

  useEffect(() => {
    if (missing === 0 || tries > MOST_TRIES) return;
    const wanted = asked.current;
    let gone = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    const url = checksUrl(from);
    fetch(url, { cache: 'no-store' })
      .then(async (res) => {
        // A recorded log with no checks beside it has none to give: each of its relayed refusals is unverified.
        if (from.kind === 'log' && res.status === 404)
          return new Map(wanted.map((seq) => [seq, 'unverified' as const]));
        return res.ok ? checksOf(await res.json()) : undefined;
      })
      .catch(() => undefined)
      .then((answered) => {
        if (gone) return;
        if (answered) setChecks((held) => new Map([...held, ...answered]));
        // One it had no word on yet, or no answer at all: asked again in a while.
        if (!answered || wanted.some((seq) => !answered.has(seq))) {
          again = setTimeout(() => setTries((n) => n + 1), AGAIN_MS);
        }
      });
    return () => {
      gone = true;
      clearTimeout(again);
    };
  }, [missing, from, tries]);

  return checks;
}
