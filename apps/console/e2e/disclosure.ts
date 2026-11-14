/**
 * A vulnerable move of the app's lockfile, #1335, beside the samples: its public views, which withhold the package
 * until the line opens its issue (`issue.opened`), and name it from then on. It is not one of the samples, which load
 * into a store that refuses a withheld view (`packages/samples/src/withheld-move.ts`), so the console is given the
 * samples and then it, as the store would send them, with a stream that has nothing more to say.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { withheldMoveEvents } from '../../../packages/samples/src/withheld-move.ts';
import { END } from './support.ts';

const SAMPLES = readFileSync(
  fileURLToPath(new URL('../../../packages/samples/log/events.ndjson', import.meta.url)),
  'utf-8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { seq: number });

/** When #1335 opened: a minute past the samples' end. */
export const MOVE_START = END + 60_000;
const MOVE = withheldMoveEvents(new Date(MOVE_START).toISOString(), SAMPLES.at(-1)?.seq ?? 0);

const at = (type: string) => Date.parse(MOVE.find((event) => event.type === type)?.ts ?? '');
/** Before its issue opened: its ticket, with the package withheld. */
export const WITHHELD_AT = at('issue.opened') - 10_000;
/** Its issue open, and its pull request waiting for Martin's merge. */
export const NAMED_AT = at('hold.started') + 60_000;

/** The console fed the samples and #1335, as a store of samples that has sent everything it holds. */
export async function withTheMove(page: Page): Promise<void> {
  await page.route('**/api/events?after=0', (route) => route.fulfill({ json: [...SAMPLES, ...MOVE] }));
  await page.addInitScript(() => {
    class Quiet extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        super();
        setTimeout(() => {
          this.onopen?.(new Event('open'));
          this.dispatchEvent(new MessageEvent('store', { data: JSON.stringify({ kind: 'sample' }) }));
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    (globalThis as { EventSource: unknown }).EventSource = Quiet;
  });
}
