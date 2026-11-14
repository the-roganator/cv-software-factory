/**
 * Each kind of sheet's code, in a chunk of its own that arrives the first time one of its kind opens: a work item's
 * (`Sheet.tsx`, with the sheet's projection), Patching's and Guardrails'. The page asks for a chunk here and draws a
 * sheet only once its code is in, so the sheet already open stays until the next can take its place, with no moment
 * between them where neither is drawn. A chunk that never came is asked for again the next time, not remembered as
 * failed.
 */
import type { GuardrailsSheet } from './components/Guardrails.tsx';
import type { PatchingSheet } from './components/Patching.tsx';
import type { Sheet } from './components/Sheet.tsx';
import type { SheetAsk } from './sheets.ts';

export interface SheetCode {
  item: typeof Sheet;
  patching: typeof PatchingSheet;
  guardrails: typeof GuardrailsSheet;
}
type Kind = SheetAsk['kind'];

const LOADERS: { [K in Kind]: () => Promise<SheetCode[K]> } = {
  item: () => import('./components/Sheet.tsx').then((module) => module.Sheet),
  patching: () => import('./components/Patching.tsx').then((module) => module.PatchingSheet),
  guardrails: () => import('./components/Guardrails.tsx').then((module) => module.GuardrailsSheet),
};

const loaded: Partial<SheetCode> = {};
const loading: { [K in Kind]?: Promise<SheetCode[K]> } = {};

/** A kind's code, if it has arrived. */
export const sheetCode = <K extends Kind>(kind: K): SheetCode[K] | undefined => loaded[kind];

/** Asks for a kind's code, once while it is on its way; a failed fetch is forgotten, so the next ask tries again. */
export function loadSheet<K extends Kind>(kind: K): Promise<SheetCode[K]> {
  const done = loaded[kind];
  if (done) return Promise.resolve(done);
  const pending =
    (loading[kind] as Promise<SheetCode[K]> | undefined) ??
    (LOADERS[kind] as () => Promise<SheetCode[K]>)().then(
      (code) => {
        loaded[kind] = code;
        delete loading[kind];
        return code;
      },
      (error: unknown) => {
        delete loading[kind];
        throw error;
      },
    );
  (loading as Record<Kind, Promise<unknown>>)[kind] = pending;
  return pending;
}
