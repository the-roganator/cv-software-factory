/**
 * Which sheet the page shows, and the hand-over from one to the next. Preact, which runs the console, has no
 * transitions that keep what is shown while a lazy part loads (its `startTransition` runs at once), so this does it by
 * hand, in one place, with three rules:
 *
 * - A sheet is shown only once its code is in (`sheet-chunks.ts`); until then the one already shown stays, so there
 *   is no moment with no sheet, or with the page behind it free to scroll.
 * - Each sheet shown is a new one (its `n`, which keys it): a close one started never carries over to the next, and the
 *   next one is always risen. It rises from below only when nothing was shown before it.
 * - Closing closes whatever is shown and drops a sheet still on its way. A sheet whose code never came takes the one
 *   shown away, and the page says so instead (`failed`).
 */
import { useCallback, useRef, useState } from 'react';
import { loadSheet, sheetCode } from './sheet-chunks.ts';
import type { SheetAsk } from './sheets.ts';

export interface Shown {
  ask: SheetAsk;
  /** Which sheet this is, of all those shown on the page: a new one for each, which keys its frame. */
  n: number;
  /** Whether it rises from below, as it does when no sheet was shown before it. */
  rise: boolean;
}

export function useSheet() {
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const [failed, setFailed] = useState<SheetAsk | undefined>(undefined);
  /** The sheet whose code is on its way, which is shown when it comes unless another is asked for, or none, first. */
  const pending = useRef<SheetAsk | undefined>(undefined);
  const count = useRef(0);

  const show = useCallback((ask: SheetAsk) => {
    const n = ++count.current;
    setShown((before) => ({ ask, n, rise: before === undefined }));
  }, []);

  /** Opens a sheet, or, with none, closes the one shown and drops any on its way. */
  const open = useCallback(
    (ask: SheetAsk | undefined) => {
      pending.current = ask;
      setFailed(undefined);
      if (!ask) return setShown(undefined);
      if (sheetCode(ask.kind)) {
        pending.current = undefined;
        return show(ask);
      }
      loadSheet(ask.kind).then(
        () => {
          if (pending.current !== ask) return;
          pending.current = undefined;
          show(ask);
        },
        (error: unknown) => {
          console.error(`The ${ask.kind} sheet’s code:`, error);
          if (pending.current !== ask) return;
          pending.current = undefined;
          setShown(undefined);
          setFailed(ask);
        },
      );
    },
    [show],
  );

  const close = useCallback(() => open(undefined), [open]);
  const dismiss = useCallback(() => setFailed(undefined), []);

  return { shown, failed, open, close, dismiss };
}
