import { defineConfig } from 'vitest/config';
import { COPY_LIMIT_MS } from './packages/store/test/postgres.ts';

export default defineConfig({
  test: {
    // The real two repositories, whatever a shell set for a try against copies (policy/repositories.ts).
    env: { LOG_LEVEL: 'silent', FACTORY_REPOSITORY: '', APP_REPOSITORY: '' },
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
            '.claude/hooks/*.test.ts',
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
          // Most of these tests make a database of their own, many in the test and not in a hook: a copy of the run's
          // template, which a busy machine takes seconds over, and which fails, naming its cause, past COPY_LIMIT_MS.
          // Each test has that, and vitest's five seconds for its own work, so a slow copy never times it out first.
          testTimeout: COPY_LIMIT_MS + 5_000,
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
