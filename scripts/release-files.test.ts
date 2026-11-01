import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * A release pull request runs no tests (check.yml's `release` kind): it changes only the changelog, the release
 * manifest and the version line of package.json, and nothing the tests run reads any of them, so the commit on main
 * it is made on, which passed the tests in the merge queue before it landed, stands for it. Its static half still
 * runs, and its JSON is linted there.
 */

/** The tracked files that match, or none: `git grep` exits 1 when nothing does. */
const named = (pattern: string, ...paths: string[]) => {
  const grep = spawnSync('git', ['grep', '-lE', pattern, '--', ...paths], { encoding: 'utf-8' });
  if (grep.status !== 0 && grep.status !== 1) throw new Error(grep.stderr);
  return grep.stdout.split('\n').filter(Boolean);
};

describe('the files a release changes', () => {
  it('are named, but in prose, only where they are released or checked, never read from the checkout', () => {
    expect(named('CHANGELOG\\.md|release-please-manifest', ':!*.md', ':!scripts/release-files.test.ts')).toEqual([
      // release-please, which reads the manifest from main through GitHub's API.
      'apps/factory/src/github/releases.ts',
      // Biome leaves the manifest as release-please writes it.
      'biome.json',
      'release-please-config.json',
      // The kind job, which tells a release by them.
      'scripts/check-kind.sh',
      'scripts/check-kind.test.ts',
    ]);
  });

  it('include a version no code reads', () => {
    // npm and pnpm hand a script its package's version in the environment.
    expect(named('npm_package_version', ':!scripts/release-files.test.ts')).toEqual([]);
    const code = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.mts', '*.sh', 'Makefile'];
    const readers = named('package\\.json', ...code, ':!scripts/release-files.test.ts').filter((file) =>
      /version/i.test(readFileSync(file, 'utf-8')),
    );
    expect(readers).toEqual([
      // flagd's evaluation library's own package.json, for the version the sides were recorded with.
      'apps/factory/test/line/compare.test.ts',
      // package.json's packageManager, for another pnpm of its major, and a package.json of its own, written for a
      // scratch repository to run the runner image's prepare step on.
      'apps/runner/scripts/image-check.sh',
      // A checkout's packageManager, for the pnpm it asks for, and not its version line.
      'apps/runner/src/prepare.ts',
      // package.json's packageManager, beside mise.lock's pnpm, and not its version line.
      'apps/runner/test/install-pnpm.test.ts',
      // A package.json of its own, written for a scratch copy.
      'apps/runner/test/prepare.test.ts',
      // Invented work items, whose changed files are named and whose releases have versions.
      'packages/samples/src/items/1262-pino.ts',
      'packages/samples/src/items/1276-otel-rollback.ts',
      // The kind job, which tells a release by the version line of package.json's change, and a package.json of its
      // own, written for a scratch repository to try it on.
      'scripts/check-kind.sh',
      'scripts/check-kind.test.ts',
      // flagd's evaluation library's own package.json, as for the test above.
      'scripts/flagd-sides.ts',
      // package.json's packageManager, beside mise.lock's pnpm, and not its version line.
      'scripts/toolchain.test.ts',
    ]);
  });
});
