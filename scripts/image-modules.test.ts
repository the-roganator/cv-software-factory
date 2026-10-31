/**
 * Each Node image holds only what its Dockerfile copies into the stages its runtime takes, out of a build context its
 * `.dockerignore` lets through, with the production dependencies of the packages it installs. A module an entry point
 * reaches that is not in it fails only when the image starts, or when a command reaches it in the cluster, so this
 * follows every import from each image's entry points, the lazy ones too, as Node would run them in the image: a
 * type-only import is erased, so it loads nothing; anything else must be a file the image copies, a package the
 * importing package depends on, or Node's own.
 *
 * It reads the image's contents from the Dockerfile rather than building it, so it runs with the other tests and
 * needs no Docker, and it follows imports a command makes only when it runs, which loading each command would not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

interface Image {
  dockerfile: string;
  /**
   * The stages whose copies the runtime holds: those it copies `/repo` from whole, and the stages they are built
   * from. A stage it takes only a built output from (the console's `web`, for its `dist`) is not one.
   */
  stages: string[];
  /** What the image runs: its command, and any other a Job runs it with. */
  entries: string[];
  /**
   * Modules an entry reaches that run only on a developer's machine, with the whole repository, never in the image:
   * each still reached, so the list never outlives its reason.
   */
  hostOnly?: string[];
  /** Modules the walk must reach, so it is known to follow the imports that matter. */
  reaches: string[];
}

const IMAGES: Record<string, Image> = {
  console: {
    dockerfile: 'apps/console/Dockerfile',
    stages: ['base', 'server'],
    // The server, and the migration Job (deploy/base/migrate/job.yaml).
    entries: ['apps/console/src/server.ts', 'apps/console/src/telemetry.ts', 'packages/store/src/migrate.ts'],
    reaches: ['packages/store/src/flags.ts', 'policy/access.ts'],
  },
  factory: {
    dockerfile: 'apps/factory/Dockerfile',
    stages: ['base', 'server'],
    entries: ['apps/factory/src/cli.ts', 'apps/factory/src/telemetry.ts'],
    // `factory line bench`'s runner steps, and `factory guardrails`, which run on the Mac alone, never in the cluster.
    hostOnly: ['apps/runner/src/agent.ts', 'apps/runner/src/prepare.ts', 'apps/factory/src/guardrails/command.ts'],
    // The line's worker, which `factory line serve` imports only once it runs.
    reaches: ['apps/factory/src/line/worker.ts', 'packages/events/src/schemas.ts'],
  },
  runner: {
    dockerfile: 'apps/runner/Dockerfile',
    stages: ['runner'],
    entries: ['apps/runner/src/cli.ts'],
    reaches: ['apps/runner/src/agent.ts', 'apps/runner/src/prepare.ts'],
  },
};

/** What the named stages copy from the build context, as paths from the repository's root. */
function copied(dockerfile: string, stages: readonly string[]): string[] {
  const paths: string[] = [];
  let stage: string | undefined;
  for (const line of dockerfile.split('\n')) {
    const from = line.match(/^FROM\s+\S+(?:\s+AS\s+(\S+))?/i);
    if (from) stage = from[1];
    else if (stage && stages.includes(stage) && /^COPY\s/.test(line) && !line.includes('--from')) {
      paths.push(
        ...line
          .trim()
          .split(/\s+/)
          .slice(1, -1)
          .filter((word) => !word.startsWith('--')),
      );
    }
  }
  return paths;
}

/**
 * What a `.dockerignore` lets into the build context: each path it lets back after leaving out everything (`*`). One
 * written another way is not read here, and fails the test that reads it.
 */
function letThrough(dockerignore: string): string[] {
  const lines = dockerignore.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (lines[0] !== '*' || lines.slice(1).some((line) => !line.startsWith('!'))) {
    throw new Error('A .dockerignore here leaves out everything (`*`), then lets paths back (`!path`), and no more');
  }
  return lines.slice(1).map((line) => line.slice(1));
}

const under = (path: string, paths: readonly string[]) =>
  paths.some((p) => path === p || path.startsWith(`${p.replace(/\/$/, '')}/`));

/** Each module specifier a file loads when Node runs it: its types stripped, as Node strips them. */
function specifiers(source: string): string[] {
  const code = stripTypeScriptTypes(source, { mode: 'strip' });
  const found: string[] = [];
  // Biome formats every static import and re-export to start its line, so a comment never matches.
  for (const match of code.matchAll(/^(?:import|export)\s(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm)) {
    found.push(match[1] as string);
  }
  for (const line of code.split('\n')) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    for (const match of line.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1] as string);
  }
  return found;
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
}

/** The package a file belongs to: its nearest package.json, and where that is. */
function packageOf(file: string): { dir: string; manifest: Manifest } {
  let dir = dirname(file);
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return { dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest };
}

const WORKSPACE: Record<string, string> = {
  '@software-factory/events': 'packages/events',
  '@software-factory/store': 'packages/store',
  '@software-factory/triage': 'packages/triage',
  '@software-factory/factory': 'apps/factory',
};

/** Every problem with loading an image's entries in it: a file it does not hold, or a package nobody installs there. */
function walk(image: Image): { problems: string[]; loaded: string[] } {
  const paths = copied(readFileSync(join(ROOT, image.dockerfile), 'utf8'), image.stages);
  const context = letThrough(readFileSync(join(ROOT, `${image.dockerfile}.dockerignore`), 'utf8'));
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = image.entries.map((f) => join(ROOT, f));
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const path = relative(ROOT, file);
    if (image.hostOnly?.includes(path)) continue;
    if (!under(path, paths)) {
      found.push(`${path} is not in the image`);
      continue;
    }
    if (!under(path, context)) {
      found.push(`${path} is copied, but its .dockerignore leaves it out of the build context`);
      continue;
    }
    if (!file.endsWith('.ts')) continue;
    const owner = packageOf(file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      const where = `${path} imports ${specifier}`;
      if (name === undefined || !owner.manifest.dependencies?.[name]) {
        if (name !== owner.manifest.name) found.push(`${where}, which ${owner.manifest.name} does not depend on`);
        continue;
      }
      const workspace = WORKSPACE[name];
      if (!workspace) continue;
      const manifest = JSON.parse(readFileSync(join(ROOT, workspace, 'package.json'), 'utf8')) as Manifest;
      const target = manifest.exports?.[`.${specifier.slice(name.length)}`];
      if (!target) found.push(`${where}, which ${name} does not export`);
      else queue.push(join(ROOT, workspace, target));
    }
  }
  return { problems: found, loaded: [...seen].map((file) => relative(ROOT, file)) };
}

describe.each(Object.entries(IMAGES))('the %s image', (_, image) => {
  it('holds every module its entries load, the lazy ones too', () => {
    const { problems, loaded } = walk(image);
    expect(problems).toEqual([]);
    expect(loaded).toEqual(expect.arrayContaining(image.reaches));
    expect(loaded).toEqual(expect.arrayContaining(image.hostOnly ?? []));
  });
});

describe('reading an image', () => {
  it('finds the imports Node runs, and not the ones it erases', () => {
    const source = [
      "import type { Step } from '../../runner/src/step.ts';",
      "import { type Handback, RESULT_BYTES } from '../../runner/src/limits.ts';",
      "import { z } from 'zod';",
      "export * from './more.ts';",
      '/** Lazily, as in `await import("./not-this.ts")`. */',
      "const { Line } = await import('../line/worker.ts');",
    ].join('\n');
    expect(specifiers(source)).toEqual(['../../runner/src/limits.ts', 'zod', './more.ts', '../line/worker.ts']);
  });

  it('takes the copies of the stages the runtime holds, and not another stage’s', () => {
    const dockerfile = [
      'FROM node AS base',
      'COPY package.json pnpm-lock.yaml ./',
      'FROM base AS web',
      'COPY policy/flag-moves.ts policy/',
      'FROM base AS server',
      'COPY --chown=1000 apps/console/src apps/console/src',
      'COPY --from=web /repo/apps/console/dist apps/console/dist',
      'FROM distroless',
      'COPY --from=server /repo /repo',
    ].join('\n');
    expect(copied(dockerfile, ['base', 'server'])).toEqual(['package.json', 'pnpm-lock.yaml', 'apps/console/src']);
  });

  it('reads a .dockerignore that leaves out everything and lets paths back, and no other', () => {
    expect(letThrough('# Only these.\n*\n!package.json\n!apps/console/src\n')).toEqual([
      'package.json',
      'apps/console/src',
    ]);
    expect(() => letThrough('node_modules\n')).toThrow('leaves out everything');
  });
});
