/**
 * Whether the app holds the flags as set, asked of the admin service while the page is shown (`held.ts` reads the
 * answer). A module of its own, apart from the Flags panel's, because the page asks from its first view and hands the
 * answer to Flags and Needs you, whose code arrives after it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type HeldAnswer, heldFlags } from './held.ts';

/** How often the page asks again whether the app holds the flags, while it is shown. */
const HELD_EVERY_MS = 15_000;

/**
 * Whether the app holds the flags as set, asked of the admin service now and every 15 seconds while the page is shown,
 * and soon after Martin moves one (`refresh`). Only where there is an admin service to ask.
 */
export function useHeld(enabled: boolean): { answer: HeldAnswer; refresh: () => void } {
  const [answer, setAnswer] = useState<HeldAnswer>({ kind: 'unknown' });
  const again = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const ask = () => {
      if (document.visibilityState !== 'visible') return;
      void heldFlags().then((got) => {
        if (live) setAnswer(got);
      });
    };
    ask();
    again.current = ask;
    const timer = setInterval(ask, HELD_EVERY_MS);
    document.addEventListener('visibilitychange', ask);
    return () => {
      live = false;
      again.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [enabled]);
  // A move is checked within seconds of its write: asked again a little after it, as well as on the minute.
  const refresh = useCallback(() => {
    setTimeout(() => again.current(), 3000);
  }, []);
  return { answer, refresh };
}
