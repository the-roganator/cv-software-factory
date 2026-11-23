import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * A deploy runs no tests (check.yml's `deploy` kind): it changes only the digests of the images the local profile's
 * two pin files pin, each still `sha256:` and 64 hex digits (scripts/check-kind.sh), and no test reads a digest's
 * value, so the commit it is made on, which passed the tests in the merge queue, stands for it. Its static half still
 * runs, and renders the manifests with the new digests; its image check confirms each was built and signed on main.
 */

const PINS = [
  'deploy/overlays/local/console-image/kustomization.yaml',
  'deploy/overlays/local/factory-image/kustomization.yaml',
];

/** The tracked files that match, or none: `git grep` exits 1 when nothing does. */
const named = (pattern: string, ...paths: string[]) => {
  const grep = spawnSync('git', ['grep', '-lE', pattern, '--', ...paths], { encoding: 'utf-8' });
  if (grep.status !== 0 && grep.status !== 1) throw new Error(grep.stderr);
  return grep.stdout.split('\n').filter(Boolean);
};

describe('the files a deploy changes', () => {
  it('are named, but in prose and the manifests, only where they are written, checked or read for names', () => {
    expect(
      named('overlays/local/(console|factory|\\*)-image', ':!*.md', ':!deploy/', ':!scripts/deploy-files.test.ts'),
    ).toEqual([
      // The patching harness, which writes a scratch copy's pins and names them for its tests, in its own clone of that
      // copy: never this checkout's.
      '.claude/skills/patching-harness/bin/catalogue.ts',
      '.claude/skills/patching-harness/bin/copies.sh',
      '.claude/skills/patching-harness/bin/forge.ts',
      // The app's gates, which run the journeys on the factory's browser at the digest pinned here; called from the
      // app's repository at a pinned commit, and never by this repository's checks.
      '.github/workflows/app-gates.yml',
      // The image check, which confirms each pin was built and signed on main.
      '.github/workflows/check.yml',
      // The GitHub worker, which writes the deploys.
      'apps/factory/src/github/deploys.ts',
      // In a comment, saying where the journeys' image is pinned.
      'apps/factory/src/release/analysis.ts',
      // The images admission must admit, by name: each pin's `newName`, never its digest.
      'apps/factory/test/admission.test.ts',
      // The kind job, which tells a deploy by them.
      'scripts/check-kind.sh',
      'scripts/check-kind.test.ts',
    ]);
  });

  it('pin digests no other file holds, so no test compares anything with them', () => {
    const digests = PINS.flatMap((file) => [...readFileSync(file, 'utf-8').matchAll(/sha256:([0-9a-f]{64})/g)]);
    expect(digests).toHaveLength(4);
    for (const [, digest = ''] of digests) expect(named(digest).filter((file) => !PINS.includes(file))).toEqual([]);
  });
});
