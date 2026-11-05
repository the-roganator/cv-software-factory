/**
 * The browser the senses launch sets text unhinted, as Chrome on a desktop does, and not as headless Chromium on Linux
 * does by default: a web font in the probes' pictures of the app is set the way a visitor's browser sets it.
 */
import type { Browser } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_LAUNCH } from '../../src/capture.ts';
import { SharedBrowser } from '../../src/senses/browser.ts';

const launch = vi.hoisted(() =>
  vi.fn(async (_options?: unknown) => ({ isConnected: () => true, close: async () => {} }) as unknown as Browser),
);
vi.mock('playwright', async (original) => ({
  ...(await original<typeof import('playwright')>()),
  chromium: { launch },
}));

describe('the browser the factory launches', () => {
  it('sets text unhinted', () => {
    expect(BROWSER_LAUNCH.args).toContain('--font-render-hinting=none');
  });

  it('is launched so by the senses, unless they are given a launch of their own', async () => {
    await new SharedBrowser(undefined).ready();
    expect(launch).toHaveBeenCalledExactlyOnceWith(BROWSER_LAUNCH);
  });
});
