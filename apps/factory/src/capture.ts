/**
 * Capturing a page of the app as evidence: a screenshot, and where on it the elements the probe checked are, so
 * the console can mark the problem and the fix. Both go into the artifact store, and the result is the reference
 * an event carries. Milestone 4's probes start here.
 */
import type { Screenshot } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import type { LaunchOptions, Page, PageScreenshotOptions } from 'playwright';

/**
 * How every browser the factory launches is started: the probes', the crawler's, the canary's journeys', and the
 * captures of the samples and the console's test data; the console's own browser tests too. Text is set unhinted, as
 * Chrome on a desktop does: headless Chromium on Linux hints a web font fully by default, which snaps each glyph's
 * advance to a whole pixel, so small text comes out squeezed or stretched ("Pricesbelow zero"). System fonts are set
 * the same either way.
 */
export const BROWSER_LAUNCH: LaunchOptions = { args: ['--font-render-hinting=none'] };

/**
 * What Chromium says when it could not produce a frame for a screenshot, in its own words, which Playwright passes on
 * after its own (`page.screenshot: Protocol error (Page.captureScreenshot): …`). It has come back once in a while
 * under a busy CPU, and the same call a moment later succeeds, so it alone is tried again. Playwright gives it no
 * class of its own, so its text is all there is to tell it by.
 */
const UNABLE_TO_CAPTURE = 'Unable to capture screenshot';

/** How long to wait before trying a screenshot again. */
const PAUSE_MS = 250;

/**
 * Takes a screenshot as Playwright does, trying it once more, after a short pause, when Chromium could not capture
 * the frame. Any other error, or that one twice, is thrown as it came.
 */
export async function screenshot(
  page: Page,
  options: PageScreenshotOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Uint8Array> {
  try {
    return await page.screenshot(options);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(UNABLE_TO_CAPTURE)) throw error;
    await sleep(PAUSE_MS);
    return page.screenshot(options);
  }
}

/** An element the probe looked at: where the problem shows, or the thing as it should be. */
export interface Check {
  selector: string;
  kind: 'problem' | 'fix';
  label?: string;
}

export interface CaptureOptions {
  /** The route as the app names it, such as `/products/:slug`. */
  route: string;
  /** The version the page came from, as its `/version` reported it. */
  version: string;
  checks?: Check[];
}

/**
 * Screenshots what the page shows now, at the size of its viewport. Boxes and the recorded width and height are in
 * CSS pixels; the image itself may be denser, at the page's device scale factor.
 */
export async function capture(page: Page, store: ArtifactStore, options: CaptureOptions): Promise<Screenshot> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A capture needs a page with a fixed viewport');
  const boxes: Screenshot['boxes'] = [];
  for (const check of options.checks ?? []) {
    const box = await page.locator(check.selector).first().boundingBox();
    if (!box) throw new Error(`Nothing on ${page.url()} matches ${check.selector}`);
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const width = Math.round(Math.min(box.x + box.width, viewport.width) - x);
    const height = Math.round(Math.min(box.y + box.height, viewport.height) - y);
    if (width <= 0 || height <= 0) throw new Error(`${check.selector} is outside the viewport on ${page.url()}`);
    boxes.push({ x, y, width, height, kind: check.kind, ...(check.label && { label: check.label }) });
  }
  const png = await screenshot(page, { type: 'png', animations: 'disabled', caret: 'hide' });
  return {
    kind: 'screenshot',
    hash: await store.put(png),
    type: 'image/png',
    size: png.byteLength,
    route: options.route,
    version: options.version,
    width: viewport.width,
    height: viewport.height,
    boxes,
  };
}

export interface PageCaptureOptions extends CaptureOptions {
  /** The tallest the screenshot may be, in CSS pixels, from the top of the page. */
  maxHeight: number;
}

/**
 * Screenshots the whole page from its top, down to `maxHeight`, for comparing one version of a page with another:
 * what has changed below the fold counts too. The boxes are in the page's own coordinates, and an element that is not
 * on the page, or not in the picture, has none: a page that changed may have lost it. The PNG comes back with its
 * reference, to be compared, and with the selector of each box, in the order of the boxes. It boxes every element it
 * is given, which may be more than an event's screenshot takes: the line keeps a ticket's own (`line/pictures.ts`).
 */
export async function capturePage(
  page: Page,
  store: ArtifactStore,
  options: PageCaptureOptions,
): Promise<{ png: Uint8Array; screenshot: Screenshot; selectors: string[] }> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A capture needs a page with a fixed viewport');
  await page.evaluate('window.scrollTo(0, 0)');
  const tall = Number(await page.evaluate('document.documentElement.scrollHeight'));
  const width = viewport.width;
  const height = Math.max(viewport.height, Math.min(Math.round(tall) || 0, options.maxHeight));
  // The page laid out at the picture's size, before anything is measured: a full-page screenshot would resize the
  // viewport itself, and a page sized by the viewport's height would move under the boxes.
  await page.setViewportSize({ width, height });
  const boxes: Screenshot['boxes'] = [];
  const selectors: string[] = [];
  for (const check of options.checks ?? []) {
    const box = await page
      .locator(check.selector)
      .first()
      .boundingBox({ timeout: 2_000 })
      .catch(() => null);
    if (!box) continue;
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.round(Math.min(box.x + box.width, width) - x);
    const h = Math.round(Math.min(box.y + box.height, height) - y);
    if (w > 0 && h > 0) {
      boxes.push({ x, y, width: w, height: h, kind: check.kind, ...(check.label && { label: check.label }) });
      selectors.push(check.selector);
    }
  }
  const png = await screenshot(page, {
    type: 'png',
    clip: { x: 0, y: 0, width, height },
    animations: 'disabled',
    caret: 'hide',
  }).finally(() => page.setViewportSize(viewport));
  return {
    png,
    screenshot: {
      kind: 'screenshot',
      hash: await store.put(png),
      type: 'image/png',
      size: png.byteLength,
      route: options.route,
      version: options.version,
      width,
      height,
      boxes,
    },
    selectors,
  };
}

/**
 * Runs in the browser, where images decode for free: the share of pixels that differ between two images of the
 * same size. A string, because this package is type-checked for Node, not for the DOM.
 */
const DIFFERENCE = `async ([first, second]) => {
  const pixels = async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data;
  };
  const [x, y] = await Promise.all([pixels(first), pixels(second)]);
  if (x.length !== y.length) return 1;
  let differ = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) differ++;
  }
  return differ / (x.length / 4);
}`;

/** The share of pixels that differ between two screenshots of the same size. The page can be about:blank. */
export async function pixelDifference(page: Page, a: Uint8Array, b: Uint8Array): Promise<number> {
  const toDataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  return page.evaluate(`(${DIFFERENCE})(${JSON.stringify([toDataUrl(a), toDataUrl(b)])})`) as Promise<number>;
}
