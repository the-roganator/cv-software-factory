import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No model decides a merge (spec 6, guardrail 5): the code that decides whether a change may merge, the app's gates,
 * the line's reading of the checks and the review gate, cannot reach a model. Walked through their static imports,
 * none reaches the gateway, a model client, Jev or the agents, and none imports a package outside the few named
 * here, so a model provider's SDK cannot arrive unseen. A type-only import runs nothing, and is not followed; a module
 * loaded any way a walk cannot follow (`import()`, `require`, `createRequire`, `getBuiltinModule`) fails the test.
 *
 * This proves what the code imports, not where it sends a request: a `fetch` to the gateway's address would not be
 * seen here. The line, which runs line/gates.ts, has no route to the gateway (its fence, NETWORK-POLICIES.md), and the
 * app's gates and the review gate run in GitHub Actions, given no model's key.
 */
const ROOT = resolve(import.meta.dirname, '..');

/** Where the walk starts: everything that decides a merge. */
const DECIDES = [
  ...readdirSync(join(ROOT, 'apps/factory/src/gates')).map((f) => `apps/factory/src/gates/${f}`),
  'apps/factory/src/line/gates.ts',
  'scripts/review-gate.ts',
  // The review gate's pin moves, which review.yml's pin move job works out for it.
  'scripts/pin-moves.ts',
];

/** What it must never reach, each with why. A path ending in `/` is everything under it. */
const MODEL_CODE: Record<string, string> = {
  'apps/factory/src/gateway/': 'the LLM gateway: the model client, Jev’s client and the providers’',
  'apps/factory/src/commands/': 'where each worker’s clients are made, the gateway’s among them',
  'apps/factory/src/line/agents/': 'the agents’ prompts and results',
  'apps/runner/': 'the runner, where the agents run',
  'packages/triage/src/judge.ts': 'triage’s judge, which asks Jev',
  'packages/triage/src/questions.ts': 'the questions triage asks Jev',
  'packages/triage/src/reports.ts': 'triage’s judging of a report, by Jev',
  'packages/triage/src/worker.ts': 'the triage worker, which asks Jev',
};

/** The packages it may import, each a library that calls no model. Node's own modules are allowed too. */
const PACKAGES = [
  '@opentelemetry/api',
  '@sigstore/bundle',
  '@sigstore/tuf',
  '@sigstore/verify',
  'diff',
  'postgres',
  'yaml',
  'zod',
];

/** Each workspace package's entry points, by the name they are imported by. */
function workspace(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const parent of ['apps', 'packages']) {
    for (const name of readdirSync(join(ROOT, parent))) {
      const file = join(ROOT, parent, name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf-8')) as { name: string; exports?: Record<string, string> };
      for (const [path, target] of Object.entries(pkg.exports ?? {})) {
        entries.set(path === '.' ? pkg.name : `${pkg.name}${path.slice(1)}`, join(ROOT, parent, name, target));
      }
    }
  }
  return entries;
}

/** The modules a source file imports at run time: every static import and re-export but type-only ones. */
function importsOf(source: string): { specifiers: string[]; dynamic: boolean } {
  // Anywhere on a line, so a second statement after a first is read; one in a comment or a string is read too, which
  // can only add to what the walk must allow.
  const statements = source.matchAll(/\b(?:import|export)\s+(type\s+)?[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g);
  const sideEffects = source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g);
  return {
    specifiers: [
      ...[...statements].filter((m) => !m[1]).map((m) => m[2] ?? ''),
      ...[...sideEffects].map((m) => m[1] ?? ''),
    ],
    dynamic: /(?<![\w.])import\s*\(|\brequire\s*\(|\bcreateRequire\b|\bgetBuiltinModule\b/.test(
      source.replace(/typeof import\(/g, ''),
    ),
  };
}

/** Every file and package reachable from the starts, each file with the one that first imported it. */
function walk(starts: string[]) {
  const packages = workspace();
  const files = new Map<string, string>();
  const bare = new Map<string, string>();
  const dynamic: string[] = [];
  const queue = starts.map((start) => ({ file: join(ROOT, start), from: '' }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    const file = relative(ROOT, next.file);
    if (files.has(file)) continue;
    files.set(file, next.from);
    const found = importsOf(readFileSync(next.file, 'utf-8'));
    if (found.dynamic) dynamic.push(file);
    for (const specifier of found.specifiers) {
      const local = specifier.startsWith('.') ? resolve(dirname(next.file), specifier) : packages.get(specifier);
      if (local) queue.push({ file: local, from: file });
      else if (!bare.has(specifier)) bare.set(specifier, file);
    }
  }
  return { files, bare, dynamic };
}

const reaches = (files: Map<string, string>) =>
  [...files.keys()].filter((file) =>
    Object.keys(MODEL_CODE).some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)),
  );

/** How a file was reached, from where the walk started. */
const chain = (files: Map<string, string>, file: string): string[] => {
  const from = files.get(file);
  return from ? [...chain(files, from), file] : [file];
};

describe('the code that decides a merge', () => {
  const { files, bare, dynamic } = walk(DECIDES);

  it('starts from every gate, the line’s reading of the checks, and the review gate', () => {
    expect(DECIDES).toContain('apps/factory/src/gates/journeys.ts');
    for (const start of DECIDES) expect(files.has(start), start).toBe(true);
  });

  it('reaches no model: not the gateway, Jev, the agents or the runner', () => {
    expect(reaches(files).map((file) => chain(files, file).join(' → '))).toEqual([]);
  });

  it('imports no package but the few named here, so no model provider’s SDK', () => {
    const outside = [...bare].filter(([name]) => !name.startsWith('node:') && !PACKAGES.includes(name));
    expect(outside.map(([name, file]) => `${name}, from ${chain(files, file).join(' → ')}`)).toEqual([]);
  });

  it('imports nothing at run time that a walk of its imports cannot follow', () => {
    expect(dynamic).toEqual([]);
  });
});

describe('the walk', () => {
  it('finds what the triage worker and the runner reach: Jev, the gateway’s client it imports when it runs, and Claude’s SDK', () => {
    const triage = walk(['apps/factory/src/commands/triage.ts']);
    expect(reaches(triage.files)).toEqual(expect.arrayContaining(['packages/triage/src/judge.ts']));
    expect(triage.dynamic).toContain('apps/factory/src/commands/triage.ts');
    expect([...walk(['apps/runner/src/agent.ts']).bare.keys()]).toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('follows imports and re-exports, of values, but not of types alone', () => {
    const source = [
      "import { a } from './a.ts';",
      "import type { B } from './b.ts';",
      'import {\n  type C,\n  d,\n} from "./d.ts";',
      "export * from './e.ts';",
      "export type { F } from './f.ts';",
      "import './g.ts';",
      "const x = 'from y';",
    ].join('\n');
    expect(importsOf(source)).toEqual({ specifiers: ['./a.ts', './d.ts', './e.ts', './g.ts'], dynamic: false });
    expect(importsOf("const m = await import('openai');").dynamic).toBe(true);
    expect(importsOf("const sdk = createRequire(import.meta.url)('openai');").dynamic).toBe(true);
    expect(importsOf("const sdk = require('openai');").dynamic).toBe(true);
    expect(importsOf("const x = process.getBuiltinModule('node:http');").dynamic).toBe(true);
    expect(importsOf("import { a } from './a.ts'; import { b } from 'openai';").specifiers).toEqual([
      './a.ts',
      'openai',
    ]);
    expect(importsOf('type T = typeof import("./t.ts");').dynamic).toBe(false);
  });
});
