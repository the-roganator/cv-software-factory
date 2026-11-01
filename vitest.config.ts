import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LOG_LEVEL: 'silent' },
    projects: [
      {
        extends: true,
        // The console's browser code is written to React's API and runs on Preact's, as its Vite build says
        // (apps/console/vite.config.ts): its own tests, in apps/console/web/test, import it as that build does.
        resolve: { alias: [{ find: /^react$/, replacement: 'preact/compat' }] },
        oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
        test: {
          name: 'unit',
          include: [
            'apps/*/test/**/*.test.ts',
            'apps/console/web/test/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'scripts/**/*.test.ts',
            '.claude/skills/*/bin/*.test.ts',
          ],
          exclude: ['packages/store/test/**', 'packages/*/test/database/**', 'apps/factory/test/**'],
        },
      },
      {
        // Against a real Postgres, which the setup provides.
        extends: true,
        test: {
          name: 'database',
          include: [
            'packages/store/test/**/*.test.ts',
            'packages/*/test/database/**/*.test.ts',
            'apps/factory/test/**/*.test.ts',
          ],
          exclude: ['apps/factory/test/browser/**'],
          globalSetup: ['packages/store/test/postgres.ts'],
        },
      },
      {
        // Needs Chromium, so it runs in the pinned Playwright image (`make e2e`, and CI's senses browser job), not in
        // `make check`.
        extends: true,
        test: {
          name: 'browser',
          // Each file side by side with the others, with its own Chromium, test servers on free ports and artifact
          // store in a temporary directory of its own.
          include: ['apps/factory/test/browser/**/*.test.ts'],
        },
      },
    ],
  },
});
