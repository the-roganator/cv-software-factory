/**
 * What every browser test shares: the widths and themes it runs at, the samples' last moment to pin the time to,
 * the milestone 4 test data's server and moments, and a guard that fails a test on any content security policy
 * violation, any request to another origin, any error nothing on the page caught, and anything left on the device but
 * Martin's session cookie.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, test as base, expect, type Locator, type Page } from '@playwright/test';
import type { RawEvent } from '@software-factory/events';
import { keptOnDevice as readDevice } from '../../factory/src/senses/device.ts';
import { full } from './full.ts';

export const PORT = 18_321;
/** A second server, with the console's milestone 4 test data (test/fixture) instead of the samples. */
export const FIXTURE_PORT = 18_322;
const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

const log = fileURLToPath(new URL('../../../packages/samples/log/events.ndjson', import.meta.url));
const lines = readFileSync(log, 'utf-8').trim().split('\n');

/** When the samples' last event happened: the server is told it is now, and pages pin t to it. */
export { MERGE_WAITING } from '../test/projection/support.ts';

export const END = Date.parse((JSON.parse(lines.at(-1) ?? '{}') as { ts: string }).ts);

const fixtureLog = fileURLToPath(new URL('../test/fixture/log/events.ndjson', import.meta.url));
const fixtureLines = readFileSync(fixtureLog, 'utf-8').trim().split('\n');

/** When the test data's last event happened: its server is told it is now. */
export const FIXTURE_END = Date.parse((JSON.parse(fixtureLines.at(-1) ?? '{}') as { ts: string }).ts);

/**
 * A third server, with the red-team attacks' test data (test/attacks) instead of the samples: no attack can be
 * launched yet, so the samples hold none, and the tests of an attack's card, sheet and Launch read these.
 */
export const ATTACKS_PORT = 18_323;
const ATTACKS_ORIGIN = `http://localhost:${ATTACKS_PORT}`;
const attacksLog = fileURLToPath(new URL('../test/attacks/log/events.ndjson', import.meta.url));
const attackLines = readFileSync(attacksLog, 'utf-8').trim().split('\n');

/** When the attacks' last event happened: their server is told it is now. */
export const ATTACKS_END = Date.parse((JSON.parse(attackLines.at(-1) ?? '{}') as { ts: string }).ts);

/** The console showing the attacks' test data, at their last moment or another, with motion off unless asked for. */
export function attacksUrl(options: Parameters<typeof consoleUrl>[0] = {}): string {
  return `${ATTACKS_ORIGIN}${consoleUrl({ ...options, at: options.at ?? ATTACKS_END })}`;
}

/**
 * Stands in for the flag that makes an attack available (`web/src/attacks-seam.ts`), so the page draws every attack's
 * Launch and dialog as it will once the harness is built. Call it before `goto`.
 */
export async function attacksAvailable(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as { __attacksAvailable?: boolean }).__attacksAvailable = true;
  });
}

/** Moments in the test data's day, in London: the afternoon's work done, the cap reached, and the cap cleared. */
export const MOMENTS = {
  afternoon: '2026-10-03T16:10:00+01:00',
  capped: '2026-10-03T21:20:00+01:00',
  cleared: '2026-10-04T01:05:00+01:00',
} as const;

/** The console showing the test data at one of its moments, with motion off. */
export function fixtureUrl({
  at = 'afternoon',
  theme = 'paper',
  item,
  sheet = false,
}: {
  at?: keyof typeof MOMENTS;
  theme?: 'paper' | 'ink';
  item?: string;
  sheet?: boolean;
} = {}): string {
  const params = new URLSearchParams({ t: MOMENTS[at], theme, motion: 'off' });
  if (item) params.set('item', item);
  if (sheet) params.set('sheet', '');
  return `${FIXTURE_ORIGIN}/?${params}`;
}

/**
 * Moments in the samples that show each of the Canary panel's states (the design system's README, "Shipping"). The
 * samples' last moment shows a release in flight.
 */
export const CANARY = {
  'first-step': Date.parse('2026-10-06T14:19:30Z'),
  'no-work-item': Date.parse('2026-10-06T07:04:00Z'),
  promoted: Date.parse('2026-10-06T07:10:00Z'),
  'rolled-back': Date.parse('2026-10-02T07:26:30Z'),
  'rolled-back-no-step': Date.parse('2026-10-05T10:25:00Z'),
  stopped: Date.parse('2026-10-06T06:40:00Z'),
  aborted: Date.parse('2026-10-06T06:55:00Z'),
  errored: Date.parse('2026-10-05T20:15:00Z'),
  'dry-run': Date.parse('2026-10-05T13:09:40Z'),
  none: Date.parse('2026-09-29T08:00:00Z'),
};

/**
 * Moments in the samples that show each of the scoreboard's states: off before it has its key, counting from
 * nothing before the first verified fix, and with every figure by the end.
 */
export const SCORE = {
  off: Date.parse('2026-09-29T07:30:00Z'),
  first: Date.parse('2026-09-29T09:00:00Z'),
  figures: END,
};

/** A minute after Verify sent #1306 back to Plan, while its return is drawn on the line. */
export const RETURNED =
  Date.parse(
    lines
      .map((line) => JSON.parse(line) as { ts: string; type: string; work_item: string | null })
      .find((e) => e.work_item === '1306' && e.type === 'work.returned')?.ts ?? '',
  ) + 60_000;

export const WIDTHS = {
  phone: { width: 390, height: 844 },
  laptop: { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
};
export const THEMES = ['paper', 'ink'] as const;

/** The console at the samples' last moment, or another, with motion off unless asked for. */
export function consoleUrl({
  theme = 'paper',
  motion = false,
  item,
  sheet = false,
  debug,
  at,
}: {
  theme?: 'paper' | 'ink';
  motion?: boolean;
  item?: string | undefined;
  sheet?: boolean;
  debug?: string;
  at?: number | undefined;
} = {}): string {
  const params = new URLSearchParams({ t: new Date(at ?? END).toISOString(), theme });
  if (!motion) params.set('motion', 'off');
  if (item) params.set('item', item);
  if (sheet) params.set('sheet', '');
  if (debug) params.set('debug', debug);
  return `/?${params}`;
}

/**
 * An empty store of a given kind: no events, and a stream that opens, says what the store holds as the server's
 * does (test/app.test.ts checks the server's side), and then stays open with nothing more to say.
 */
export async function emptyStore(page: Page, kind: 'sample' | 'real' | null): Promise<void> {
  await page.route('**/api/events?after=0', (route) => route.fulfill({ json: [] }));
  await page.addInitScript((kind) => {
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
          this.dispatchEvent(new MessageEvent('store', { data: JSON.stringify({ kind }) }));
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    (globalThis as { EventSource: unknown }).EventSource = Quiet;
  }, kind);
}

/** The Canary panel drawn, with the fonts it is set in: at a moment before any work item, there is no card to wait for. */
export async function shown(page: Page): Promise<void> {
  await page.locator('section.canary').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** The scoreboard drawn beside the app's name, with the fonts it is set in. */
export async function scored(page: Page): Promise<void> {
  await page.locator('.intro').locator('.score, .score-off').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

export async function ready(page: Page): Promise<void> {
  await page.locator('.card[data-place="centre"]').waitFor();
  // The bottom row arrives in chunks of their own after the first view, and draws once the last is in.
  await page.locator('#guardrails-summary').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Has every picture on the page load at once and decode as it is drawn, from the first frame it is in. The console
 * loads pictures lazily and decodes them off the main thread, and Chromium can draw such a picture blank until its
 * decode comes round, one picture after another: on a slow runner the last of a card's four was still blank when
 * the snapshot settled. Asking a picture to decode as it is drawn once it has been drawn is too late, as it keeps
 * the way it was first drawn, so this asks as each one reaches the page, before any frame. Call it before `goto`.
 */
export async function picturesDecodeAsDrawn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = (img: HTMLImageElement) => {
      if (img.loading !== 'eager') img.loading = 'eager';
      if (img.decoding !== 'sync') img.decoding = 'sync';
    };
    new MutationObserver((records) => {
      for (const record of records) {
        const nodes = record.type === 'attributes' ? [record.target] : [...record.addedNodes];
        for (const node of nodes) {
          if (node instanceof HTMLImageElement) now(node);
          if (node instanceof Element) for (const img of node.querySelectorAll('img')) now(img);
        }
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['loading', 'decoding'],
    });
  });
}

/**
 * Waits until every picture in a part of the page is loaded, decoded and drawn, so a failure says so here and not
 * as a pixel difference. The pictures decode as they are drawn (`picturesDecodeAsDrawn`).
 */
export async function picturesShown(part: Locator): Promise<void> {
  await part.evaluate(async (el) => {
    const pictures = [...el.querySelectorAll('img')];
    await Promise.all(pictures.map((img) => img.decode()));
    const empty = pictures.filter((img) => !img.naturalWidth).map((img) => img.src);
    if (empty.length) throw new Error(`No pixels in ${empty.join(', ')}`);
    await new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn)));
  });
}

/** A session as the admin service describes it (`GET /admin/session`), for pages drawn as Martin's. */
export const SESSION = {
  signedInAt: '2026-10-06T14:40:00Z',
  expiresAt: '2026-10-06T15:40:00Z',
  steppedUpAt: null,
  steppedUp: false,
  token: 'test-token',
  passkey: { id: 'passkey-laptop', name: 'MacBook Air' },
  passkeys: [
    {
      id: 'passkey-laptop',
      name: 'MacBook Air',
      enrolledAt: '2026-10-01T09:00:00Z',
      lastUsedAt: '2026-10-06T14:40:00Z',
      current: true,
    },
  ],
  tools: { grafana: 'http://grafana.localhost:8080/', argocd: 'http://argocd.localhost:8080/' },
};

/**
 * The admin service as the page meets it, standing in for the real one (`signing-in.spec.ts` and `martin.spec.ts` use
 * that): there, with no session for this browser; or Martin's session, with the full events streamed to it.
 */
export async function adminService(
  page: Page,
  as: 'visitor' | 'martin',
  extra: readonly RawEvent[] = [],
  from: 'samples' | 'attacks' = 'samples',
): Promise<void> {
  await page.route('**/admin/session', (route) =>
    as === 'martin'
      ? route.fulfill({ json: SESSION })
      : route.fulfill({ status: 401, json: { refused: 'session', message: 'Sign in first.' } }),
  );
  if (as === 'martin') await fullStream(page, extra, from === 'attacks' ? attackLines : lines);
}

/**
 * The full-event stream, standing in for the admin service's: the samples (or the attacks' test data), each visitor's report with its text, and any
 * events a test adds after them, sent once and then held open, as the service's is while nothing new happens. Every other stream is the browser's own.
 */
async function fullStream(page: Page, extra: readonly RawEvent[], log: readonly string[]): Promise<void> {
  const events = [...log.map((line) => full(JSON.parse(line) as RawEvent)), ...extra].map((e) => JSON.stringify(e));
  await page.addInitScript((events: string[]) => {
    const Real = globalThis.EventSource;
    class Full extends EventTarget {
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        super();
        const after = Number(new URL(url, location.href).searchParams.get('after') ?? 0);
        setTimeout(() => {
          if (this.readyState === 2) return;
          this.readyState = 1;
          this.onopen?.(new Event('open'));
          for (const data of events) {
            const seq = (JSON.parse(data) as { seq: number }).seq;
            if (seq > after) this.onmessage?.(new MessageEvent('message', { data, lastEventId: String(seq) }));
          }
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    class Either {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      constructor(url: string, init?: EventSourceInit) {
        // biome-ignore lint/correctness/noConstructorReturn: one name for two kinds of stream, as the page knows it
        return url.startsWith('/admin/events/stream') ? new Full(url) : new Real(url, init);
      }
    }
    (globalThis as { EventSource: unknown }).EventSource = Either;
  }, events);
}

/** The one thing the console may leave on a device: the admin service's session cookie, once Martin signs in. */
export const SESSION_COOKIE = 'cookie __Host-session';

/**
 * Everything the browser keeps for the console, as `<kind> <name>`, read as the journeys gate reads the app's
 * (`apps/factory/src/senses/device.ts`): its cookies, whoever set them and whether a script could read them, and local
 * and session storage, IndexedDB, Cache Storage and service workers. The privacy page says the console keeps nothing on
 * a visitor's device: this is what holds it to that. A page between documents is read once it has loaded.
 */
export async function keptOnDevice(page: Page): Promise<string[]> {
  const read = () => readDevice(page.context(), page);
  return read().catch(async () => {
    await page.waitForLoadState('load');
    return read();
  });
}

interface Guard {
  violations: string[];
  foreign: string[];
  /** Errors nothing on the page caught, a thrown value or a rejection, as the browser reports them. */
  uncaught: string[];
  /** Origins a test serves itself, by route, so no request to one leaves the machine: the replay site's stand-in. */
  served: string[];
}

/** Everything kept on the device of each context still open, read through each of its pages, or its own when it has none. */
export async function keptInEvery(contexts: Iterable<BrowserContext>): Promise<string[]> {
  const kept = new Set<string>();
  for (const context of contexts) {
    const pages = context.pages();
    const read = pages.length
      ? (await Promise.all(pages.map((each) => keptOnDevice(each)))).flat()
      : (await context.storageState()).cookies.map((cookie) => `cookie ${cookie.name}`);
    for (const thing of read) kept.add(thing);
  }
  return [...kept];
}

/**
 * Every test fails on a policy violation, a request to another origin, an error nothing on the page caught, or
 * anything left on the device but Martin's session cookie, whatever else it checks: in every context and page it opens, its own and popups alike, not only the
 * default page. A context the test closed keeps nothing, so only those still open are read.
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page, browser, baseURL }, use) => {
      const guard: Guard = { violations: [], foreign: [], uncaught: [], served: [] };
      const origins = [new URL(baseURL ?? '').origin, FIXTURE_ORIGIN, ATTACKS_ORIGIN];
      const open = new Set<BrowserContext>();
      const watchPage = (watched: Page) => {
        watched.on('console', (message) => {
          if (message.text().startsWith('CSP violation') || message.text().includes('Content Security Policy')) {
            guard.violations.push(message.text());
          }
        });
        watched.on('pageerror', (error) => guard.uncaught.push(`${watched.url()}: ${error.stack ?? error.message}`));
        watched.on('request', (request) => {
          const url = new URL(request.url());
          if (!['data:', 'blob:'].includes(url.protocol) && ![...origins, ...guard.served].includes(url.origin))
            guard.foreign.push(request.url());
        });
      };
      const watchContext = async (watched: BrowserContext) => {
        open.add(watched);
        watched.on('close', () => open.delete(watched));
        watched.on('page', watchPage);
        for (const existing of watched.pages()) watchPage(existing);
        await watched.addInitScript(() => {
          document.addEventListener('securitypolicyviolation', (event) => {
            console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
          });
        });
      };
      // The default page comes first, so it is still open when this reads what it keeps.
      await watchContext(page.context());
      const onContext = (opened: BrowserContext) => void watchContext(opened);
      browser.on('context', onContext);
      try {
        await use(guard);
      } finally {
        browser.off('context', onContext);
      }
      expect(guard.violations, 'content security policy violations').toEqual([]);
      expect(guard.foreign, 'requests to another origin').toEqual([]);
      expect(guard.uncaught, 'errors nothing on the page caught').toEqual([]);
      expect(
        (await keptInEvery(open)).filter((thing) => thing !== SESSION_COOKIE),
        'kept on the device',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
