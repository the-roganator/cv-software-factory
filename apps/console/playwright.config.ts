/**
 * The console's browser tests, against the production build, fed from the samples' event log with no Postgres
 * behind it, from the red-team attacks' test data by a third (no attack can be launched yet, so the samples hold none),
 * and from the milestone 4 test data by a second server (the live test and the sign-in test, which need a
 * store, start their own). Snapshots are taken in the pinned Playwright
 * image, so they match from one machine to the next: `make e2e` runs them there.
 */
import { defineConfig, devices } from '@playwright/test';
import { ATTACKS_END, ATTACKS_PORT, END, FIXTURE_END, FIXTURE_PORT, PORT } from './e2e/support.ts';

/** Snapshots only mean something in the pinned image (`make e2e` and CI set this); elsewhere they are skipped. */
const pinned = Boolean(process.env.SF_PINNED_BROWSER);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One for each of the CI runner's four cores. The timed test (the `speed` project) runs alone, on a runner of its own.
  ...(process.env.CI && { workers: 4 }),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  snapshotPathTemplate: '{testDir}/snapshots/{testFileName}/{arg}{ext}',
  // How far a pixel's colour may drift before it counts as changed: half Playwright's default of 0.2, so a token's
  // colour that moves a little still fails. It is the least of those tried that passes every snapshot run after run in
  // the pinned image: at 0.05 two fail by a pixel or ten at an edge, and at 0 which ones fail changes from run to run.
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', threshold: 0.1 } },
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: 'Europe/London',
    locale: 'en-GB',
    trace: 'retain-on-failure',
    // Headless Chromium on Linux hints fonts fully by default, which snaps each glyph's advance to a whole pixel: at a
    // small size a space loses half its width ("Pricesbelow zero"), and every line is set wider or narrower than a
    // browser on a desktop sets it. Unhinted, it places glyphs at fractions of a pixel, as Chrome on the Mac does.
    launchOptions: { args: ['--font-render-hinting=none'] },
  },
  projects: [
    {
      name: 'console',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: pinned
        ? /(live|signing-in|martin|canary-controls|canary-paused|needs-you|line-controls|improvements|attacks|speed)\.spec\.ts/
        : /(live|signing-in|martin|canary-controls|canary-paused|needs-you|line-controls|improvements|attacks|speed|visual)\.spec\.ts/,
    },
    // The tests that need a store: the console live, and signing in, Martin's view, the canary's controls and its pause for Martin, Needs you,
    // the line's controls, the "+" and launching an attack against the admin service.
    {
      name: 'live',
      use: { ...devices['Desktop Chrome'] },
      testMatch:
        /(live|signing-in|martin|canary-controls|canary-paused|needs-you|line-controls|improvements|attacks)\.spec\.ts/,
    },
    // Timed alone, so other tests' browsers don't share its CPU: after the rest, or on its own with `--no-deps` as CI
    // and `make e2e` run it.
    { name: 'speed', testMatch: /speed\.spec\.ts/, dependencies: ['console', 'live'] },
  ],
  webServer: [
    { port: PORT, log: '../../packages/samples/log', now: END },
    { port: FIXTURE_PORT, log: 'test/fixture/log', now: FIXTURE_END },
    { port: ATTACKS_PORT, log: 'test/attacks/log', now: ATTACKS_END },
  ].map(({ port, log, now }) => ({
    command: 'node src/server.ts',
    // On 127.0.0.1 alone, and asked there: another program holding the port fails the run rather than answering it.
    url: `http://127.0.0.1:${port}/health`,
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      EVENT_LOG: log,
      EVENT_LOG_NOW: new Date(now).toISOString(),
      NODE_ENV: 'production',
      // Only what went wrong, such as a port it could not listen on, which Playwright shows.
      LOG_LEVEL: 'error',
      OTEL_SDK_DISABLED: 'true',
      // The app a flag's "Preview it" opens: the local cluster's, as its Deployment names it.
      APP_URL: 'http://website.localhost:8080',
    },
    stdout: 'pipe' as const,
    reuseExistingServer: false,
  })),
});
