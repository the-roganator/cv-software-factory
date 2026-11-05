/**
 * The browser the senses launch sets text unhinted, in a real browser: a line of a web font at a small size is the
 * width Chrome on a desktop sets it. Hinted, as headless Chromium on Linux sets text unless told not to, each glyph's
 * advance snaps to a whole pixel, and this line of Geist at 10px is 86px, not 82.67px. So a web font in the probes'
 * pictures is set as a visitor's browser sets it. Only in the pinned image does this prove the flag: the Mac's Chromium
 * sets text unhinted whatever it is told, so `senses/launch.test.ts` checks the launch itself, on any host.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { SharedBrowser } from '../../src/senses/browser.ts';

/**
 * Geist, the console's own: the font the console's snapshots found set hinted (#853). A dev dependency of this package
 * too, whose exports name only its CSS, so its file is read from where pnpm links it.
 */
const GEIST = readFileSync(
  new URL('../../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', import.meta.url),
).toString('base64');

const shared = new SharedBrowser(undefined);
afterAll(() => shared.close());

describe('the text in a sense’s browser', () => {
  it('is set unhinted, at a fraction of a pixel', async () => {
    const page = await (await shared.ready()).newPage();
    try {
      await page.setContent(`<style>
        @font-face { font-family: Geist; src: url(data:font/woff2;base64,${GEIST}) format('woff2'); }
        span { font: 500 10px Geist; letter-spacing: 0; white-space: nowrap; }
      </style><span>Prices below zero</span>`);
      // A string, because this package is type-checked for Node, not for the DOM.
      const width = await page.evaluate(`(async () => {
        await document.fonts.load('500 10px Geist');
        return document.querySelector('span').getBoundingClientRect().width;
      })()`);
      // At a fraction of a pixel, whatever Geist's or Chromium's version makes it exactly: hinted, it is whole.
      expect(typeof width).toBe('number');
      expect(Number.isInteger(width)).toBe(false);
    } finally {
      await page.close();
    }
  });
});
