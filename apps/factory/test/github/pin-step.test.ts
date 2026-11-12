/**
 * The GitHub worker's guard on the pin step's patches: they may change the version or digest on a pin's line in a
 * file the app's CODEOWNERS gives Martin, a manifest's ranges and the lockfile, and nothing else; an agent's patch may
 * change none of those. Each neighbour of what the pin step may do is refused here, one test each.
 */
import { describe, expect, it } from 'vitest';
import { LOCKFILES as RUNNER_LOCKFILES, PNPM_SETTINGS as RUNNER_SETTINGS } from '../../../runner/src/pins.ts';
import { DryRunActions } from '../../src/github/actions.ts';
import { LOCKFILE_NAMES, PNPM_SETTINGS } from '../../src/github/paths.ts';
import { quiet, REPO, SHA } from './fake.ts';

const FILES: Record<string, string> = {
  '.github/CODEOWNERS': '/Dockerfile @mrogan\n/mise.toml @mrogan\n/mise.lock @mrogan\n/pnpm-workspace.yaml @mrogan\n',
  'mise.toml': '[settings]\nlockfile = true\n\n[tools]\nnode = "24.22.1"\npnpm = "12"\n',
  'mise.lock':
    '[[tools.node]]\nversion = "24.22.1"\nbackend = "core:node"\n\n[tools.node."platforms.linux-x64"]\nchecksum = "sha256:' +
    'a'.repeat(64) +
    '"\nurl = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz"\n',
  Dockerfile: `FROM node:24.22.1-alpine3.24@sha256:${'b'.repeat(64)} AS build\nRUN pnpm install\n`,
  'package.json': '{\n  "devDependencies": {\n    "vitest": "^5.0.5"\n  }\n}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\n  vitest@5.0.5:\n    resolution: {integrity: sha512-old}\n",
  'pnpm-workspace.yaml': 'trustPolicy: no-downgrade\n',
  'src/money.ts': 'export const pence = 1;\n',
  'tools/seed.Dockerfile': `FROM node:24.22.1-alpine3.24@sha256:${'b'.repeat(64)}\n`,
};

/** A unified diff of one line of a file, as `git diff` writes one. */
function lineChange(path: string, before: string, after: string): string {
  const lines = (FILES[path] ?? '').split('\n');
  const at = lines.indexOf(before) + 1;
  if (at === 0) throw new Error(`${path} has no line ${before}`);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${at} +${at} @@\n-${before}\n+${after}\n`;
}

const NODE_PIN = lineChange('mise.toml', 'node = "24.22.1"', 'node = "24.22.2"');
const FROM_PIN = lineChange(
  'Dockerfile',
  `FROM node:24.22.1-alpine3.24@sha256:${'b'.repeat(64)} AS build`,
  `FROM node:24.22.2-alpine3.24@sha256:${'c'.repeat(64)} AS build`,
);
const LOCK_PIN = `diff --git a/mise.lock b/mise.lock
--- a/mise.lock
+++ b/mise.lock
@@ -1,7 +1,7 @@
 [[tools.node]]
-version = "24.22.1"
+version = "24.22.2"
 backend = "core:node"

 [tools.node."platforms.linux-x64"]
-checksum = "sha256:${'a'.repeat(64)}"
-url = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz"
+checksum = "sha256:${'d'.repeat(64)}"
+url = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz"
`;
const RANGE = lineChange('package.json', '    "vitest": "^5.0.5"', '    "vitest": "^5.1.0"');
const LOCKFILE = lineChange('pnpm-lock.yaml', '  vitest@5.0.5:', '  vitest@5.1.0:');
const FIX = lineChange('src/money.ts', 'export const pence = 1;', 'export const pence = 100;');

function worker(files: Record<string, string> = FILES) {
  const records: { args: { changes: { additions: { path: string; text?: string }[] } } }[] = [];
  const actions = new DryRunActions(
    {
      put: async (bytes: Uint8Array) => {
        records.push(JSON.parse(new TextDecoder().decode(bytes)));
        return String(records.length).padStart(64, 'e');
      },
    } as never,
    quiet,
    () => new Date(),
    async (_repo, path) => files[path] ?? null,
  );
  const apply = (commit: { patch: string; pins?: string; lockfile?: string }) =>
    actions.applyPatch(REPO, { branch: 'factory/1-node', expectedHead: SHA, message: 'chore(deps): node', ...commit });
  return { apply, records };
}

describe('the pin step’s patches, as the GitHub worker guards them', () => {
  it('may move the version and digest on each pin’s line in a code-owned file, a range and the lockfile', async () => {
    const { apply, records } = worker();
    await apply({ patch: FIX, pins: NODE_PIN + LOCK_PIN + FROM_PIN + RANGE + LOCKFILE });
    const committed = Object.fromEntries(
      (records.at(-1)?.args.changes.additions ?? []).map((a) => [a.path, a.text ?? '']),
    );
    expect(committed['mise.toml']).toContain('node = "24.22.2"');
    expect(committed.Dockerfile).toContain(`node:24.22.2-alpine3.24@sha256:${'c'.repeat(64)}`);
    expect(committed['src/money.ts']).toBe('export const pence = 100;\n');
  });

  it('applies the pins, the agent’s patch on them, and the lockfile on that, as one commit', async () => {
    const { apply, records } = worker();
    // The agent's patch reads the manifest as the pins left it, and the lockfile as the patch left the manifest.
    const coder = lineChange('package.json', '    "vitest": "^5.0.5"', '    "vitest": "^5.1.0"').replace(
      '+    "vitest": "^5.1.0"',
      '+    "vitest": "^5.1.0",\n+    "pino": "^10.4.0"',
    );
    await apply({ patch: coder.replace('@@ -3 +3 @@', '@@ -3 +3,2 @@'), lockfile: LOCKFILE });
    const committed = Object.fromEntries(
      (records.at(-1)?.args.changes.additions ?? []).map((a) => [a.path, a.text ?? '']),
    );
    expect(committed['package.json']).toContain('"pino": "^10.4.0"');
    expect(committed['pnpm-lock.yaml']).toContain('vitest@5.1.0:');
  });

  it('refuses the pin step’s change to another line of a pin’s file', async () => {
    // The node pin moved, and the line beside it in the same file with it.
    const other = `diff --git a/mise.toml b/mise.toml
--- a/mise.toml
+++ b/mise.toml
@@ -2,4 +2,4 @@
-lockfile = true
+lockfile = false
 
 [tools]
-node = "24.22.1"
+node = "24.22.2"
`;
    await expect(worker().apply({ patch: FIX, pins: other })).rejects.toMatchObject({ kind: 'protected' });
    await expect(worker().apply({ patch: FIX, pins: other })).rejects.toThrow(
      /mise\.toml: the pin step changes "lockfile = true", which names no version or digest/,
    );
  });

  it('refuses the same pin’s line from a coder’s commit: only the pin step moves a pin in a code-owned file', async () => {
    for (const patch of [NODE_PIN, FROM_PIN, LOCK_PIN]) {
      await expect(worker().apply({ patch })).rejects.toThrow(/which no patch may/);
    }
  });

  it('refuses a pin’s line whose new value is not a version or digest', async () => {
    for (const after of ['node = "latest"', 'node = "24.22.2-evil"', 'node = "24.22.2" # and more']) {
      const pins = lineChange('mise.toml', 'node = "24.22.1"', after);
      await expect(worker().apply({ patch: FIX, pins })).rejects.toThrow(/not only its version or digest/);
    }
    const tag = lineChange(
      'Dockerfile',
      `FROM node:24.22.1-alpine3.24@sha256:${'b'.repeat(64)} AS build`,
      `FROM evil/node:24.22.2-alpine3.24@sha256:${'c'.repeat(64)} AS build`,
    );
    await expect(worker().apply({ patch: FIX, pins: tag })).rejects.toThrow(/not only its version or digest/);
  });

  it('refuses the pin step’s change to pnpm’s settings, a file it does not pin, or one it adds', async () => {
    const settings = lineChange('pnpm-workspace.yaml', 'trustPolicy: no-downgrade', 'trustPolicy: off');
    await expect(worker().apply({ patch: FIX, pins: settings })).rejects.toThrow(/the pin step never writes it/);
    await expect(worker().apply({ patch: FIX, pins: FIX })).rejects.toThrow(/writes pins, ranges and lockfiles alone/);
    const added =
      'diff --git a/.npmrc b/.npmrc\nnew file mode 100644\n--- /dev/null\n+++ b/.npmrc\n@@ -0,0 +1 @@\n+x=1\n';
    await expect(worker().apply({ patch: FIX, pins: added })).rejects.toThrow(/never writes it/);
  });

  it('refuses a lockfile written after the agent that is anything but pnpm’s lockfile', async () => {
    await expect(worker().apply({ patch: FIX, lockfile: RANGE })).rejects.toThrow(/writes pnpm's lockfile alone/);
  });

  it('refuses an agent’s patch that writes a lockfile or pnpm’s settings', async () => {
    for (const patch of [LOCKFILE, `${FIX}${LOCKFILE}`]) {
      await expect(worker().apply({ patch })).rejects.toThrow(/pnpm-lock\.yaml, which no patch may/);
    }
    const npmrc =
      'diff --git a/.npmrc b/.npmrc\nnew file mode 100644\n--- /dev/null\n+++ b/.npmrc\n@@ -0,0 +1 @@\n+x=1\n';
    await expect(worker().apply({ patch: npmrc })).rejects.toThrow(/\.npmrc, which no patch may/);
  });

  it('names the lockfiles and pnpm’s settings the runner’s pin step names', () => {
    expect(LOCKFILE_NAMES).toEqual(RUNNER_LOCKFILES);
    expect(PNPM_SETTINGS).toEqual(RUNNER_SETTINGS.flatMap((entry) => [entry, `**/${entry}`]));
  });

  it('may move a FROM in a Dockerfile nobody owns, under the same rule', async () => {
    const pins = lineChange(
      'tools/seed.Dockerfile',
      `FROM node:24.22.1-alpine3.24@sha256:${'b'.repeat(64)}`,
      `FROM node:24.22.2-alpine3.24@sha256:${'c'.repeat(64)}`,
    );
    await worker().apply({ patch: FIX, pins });
    const other = lineChange(
      'tools/seed.Dockerfile',
      `FROM node:24.22.1-alpine3.24@sha256:${'b'.repeat(64)}`,
      'FROM evil',
    );
    await expect(worker().apply({ patch: FIX, pins: other })).rejects.toThrow(/not only its version or digest/);
  });

  it('commits the pins alone when the move is the whole change', async () => {
    const { apply, records } = worker();
    await apply({ patch: '', pins: NODE_PIN });
    expect(records.at(-1)?.args.changes.additions.map((a) => a.path)).toEqual(['mise.toml']);
  });

  it('refuses a lockfile that resolves anything but a registry package, whoever wrote it', async () => {
    const tarball = lineChange(
      'pnpm-lock.yaml',
      '    resolution: {integrity: sha512-old}',
      '    resolution: {tarball: https://example.com/vitest.tgz}',
    );
    await expect(worker().apply({ patch: FIX, lockfile: tarball })).rejects.toThrow(/not a registry package/);
    await expect(worker().apply({ patch: FIX, pins: tarball })).rejects.toThrow(/not a registry package/);
  });

  it('refuses the pins’ change to a manifest’s field that pins nothing, read as JSON', async () => {
    const manifest = '{\n  "packageManager": "pnpm@12.16.1",\n  "devDependencies": {\n    "vitest": "^5.0.5"\n  }\n}\n';
    const files = { ...FILES, 'package.json': manifest };
    const pnpm = `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -2 +2 @@\n-  "packageManager": "pnpm@12.16.1",\n+  "packageManager": "pnpm@12.0.0",\n`;
    await expect(worker(files).apply({ patch: FIX, pins: pnpm })).rejects.toThrow(
      /changes packageManager, which pins no dependency/,
    );
  });

  it('refuses a lockfile that still resolves a tarball after the patches, whatever lines they changed', async () => {
    const files = {
      ...FILES,
      'pnpm-lock.yaml': `${FILES['pnpm-lock.yaml']}\n  evil@1.0.0:\n    resolution: {tarball: https://example.com/evil.tgz}\n`,
    };
    await expect(worker(files).apply({ patch: FIX, lockfile: LOCKFILE })).rejects.toThrow(
      /resolves resolution: \{tarball: https:\/\/example\.com\/evil\.tgz\}, not a registry package/,
    );
  });

  it('refuses an agent’s patch to a branch’s pnpm lockfile', async () => {
    const branch =
      'diff --git a/pnpm-lock.feature.yaml b/pnpm-lock.feature.yaml\nnew file mode 100644\n--- /dev/null\n+++ b/pnpm-lock.feature.yaml\n@@ -0,0 +1 @@\n+x\n';
    await expect(worker().apply({ patch: branch })).rejects.toThrow(/pnpm-lock\.feature\.yaml, which no patch may/);
  });
});
