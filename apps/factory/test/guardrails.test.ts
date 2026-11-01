/**
 * The guardrail catalogue (`policy/guardrails.ts`) is spec 6's eleven, in its words, each proof in it once, and each
 * attack against one guardrail.
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { matchesGlob, posix } from 'node:path';
import { GUARDRAIL_COUNT } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ATTACKS,
  CI_PROOFS,
  GUARDRAILS,
  guardrailAttacked,
  guardrailsProvedBy,
  PROOFS,
  type ProofId,
} from '../../../policy/guardrails.ts';
import { RECORDS } from '../../../scripts/policy-hash.ts';
import vitest from '../../../vitest.config.ts';
import { inScope, ownedPaths } from '../src/github/paths.ts';
import { jobNames } from '../src/guardrails/ci.ts';
import { type Context, ORDER, PRODUCTION_WRITES, TAKERS } from '../src/guardrails/proofs.ts';

const SPEC = new URL('../../../docs/SPECIFICATION.md', import.meta.url);
const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf-8');

/**
 * CODEOWNERS' entries, each its path and its owners. As GitHub reads it, the last entry that matches a path names its
 * owners; each is read as the scope fence reads it, which is GitHub's reading of an entry from the root with no `?`, as
 * a test below holds every entry to.
 */
const CODEOWNERS = read('.github/CODEOWNERS')
  .split('\n')
  .map((line) => line.replace(/#.*/, '').trim().split(/\s+/))
  .filter(([pattern]) => pattern);
const ownersOf = (file: string) =>
  CODEOWNERS.findLast(([pattern]) => inScope(file, ownedPaths(pattern ?? '')))?.slice(1) ?? [];

/** The folders whose files only the tests run: what a proof's tests reach there could make a proof hold of itself. */
const TEST_FOLDERS = [/^apps\/[^/]+\/test\//, /^packages\/[^/]+\/test\//, /^scripts\/.*\.test\.ts$/];

const readIfThere = (file: string) => (existsSync(new URL(file, ROOT)) ? read(file) : undefined);

/**
 * The files a proof's tests reach in the test folders, by their imports and re-exports of values, their imports for
 * effect alone and their dynamic imports of a path written out, from the root: the starts, then each file found, in
 * the order found. A type-only import runs nothing, and the code under test, outside those folders, is what the proof
 * is of.
 */
function reachedFrom(starts: readonly string[], source: (file: string) => string | undefined): string[] {
  const reached = new Set<string>();
  const queue = [...starts];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const text = reached.has(file) ? undefined : source(file);
    if (text === undefined) continue;
    reached.add(file);
    for (const [, type, from, bare] of text.matchAll(
      /\b(?:import|export)\s+(type\s+)?[^'";]*?\bfrom\s+['"](\.[^'"]+)['"]|\bimport\s*\(?\s*['"](\.[^'"]+)['"]/g,
    )) {
      const next = posix.normalize(posix.join(posix.dirname(file), from ?? bare ?? ''));
      if (!type && TEST_FOLDERS.some((folder) => folder.test(next))) queue.push(next);
    }
  }
  return [...reached];
}

/** Spec 6's guardrails, by number, as its list writes each. */
function specified(): Map<number, string> {
  const text = readFileSync(SPEC, 'utf-8');
  const section = text.slice(text.indexOf('\n## 6. Guardrails\n'), text.indexOf('\n## 7.'));
  return new Map([...section.matchAll(/^(\d+)\. (.+)$/gm)].map(([, n, line]) => [Number(n), line as string]));
}

describe('the guardrail catalogue', () => {
  it('is spec 6’s eleven, in order, each in spec 6’s words', () => {
    const spec = specified();
    expect(spec.size).toBe(GUARDRAIL_COUNT);
    expect(GUARDRAILS.map(({ n }) => n)).toEqual([...spec.keys()]);
    for (const guardrail of GUARDRAILS) {
      const line = spec.get(guardrail.n) ?? '';
      // Its name in bold, with the punctuation that follows it, then the rest.
      const [, name, rest] = /^\*\*(.+?)[.,:]?\*\*\s*(.*)$/.exec(line) ?? [];
      expect(name, `guardrail ${guardrail.n}`).toBe(guardrail.name);
      expect(rest, `guardrail ${guardrail.n}`).toBe(guardrail.rule);
      expect(guardrail.mechanism, `guardrail ${guardrail.n}`).toMatch(/^[A-Z].+\.$/);
    }
  });

  it('lists each proof under one guardrail, once, and only proofs it knows', () => {
    const listed = GUARDRAILS.flatMap(({ proofs }) => proofs as readonly string[]);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.keys(PROOFS).sort());
    for (const proof of Object.keys(PROOFS) as ProofId[]) expect(guardrailsProvedBy(proof), proof).toHaveLength(1);
    expect(guardrailsProvedBy('stop-the-line')).toEqual([9]);
    expect(guardrailsProvedBy('ci:stopped-line')).toEqual([9]);
    expect(guardrailsProvedBy('ci:scope-fence')).toEqual([11]);
  });

  it('names a proof read from CI by its tests, and every other by a mechanism of its own', () => {
    for (const [id, proof] of Object.entries(PROOFS)) {
      // The shapes `guardrail.proved` takes.
      expect(id, id).toMatch(/^(ci:)?[a-z][a-z0-9-]{0,62}$/);
      expect(proof.mechanism, id).toMatch(/^[a-z][a-z0-9_-]{0,62}$/);
      expect(proof.mechanism === 'ci-tests', id).toBe(id.startsWith('ci:'));
    }
    expect(
      Object.keys(PROOFS)
        .filter((id) => id.startsWith('ci:'))
        .sort(),
    ).toEqual([
      'ci:gates-deterministic',
      'ci:one-gateway',
      'ci:public-hostile',
      'ci:scope-fence',
      'ci:spend-caps',
      'ci:stopped-line',
    ]);
  });

  it('makes each of spec 5.3’s five attacks against one guardrail, and proves every guardrail somehow', () => {
    const attacked = GUARDRAILS.flatMap((guardrail) => ('attack' in guardrail ? [guardrail.attack] : []));
    expect([...attacked].sort()).toEqual([...ATTACKS].sort());
    expect(Object.fromEntries(ATTACKS.map((attack) => [attack, guardrailAttacked(attack)]))).toEqual({
      report: 8,
      workflow: 1,
      test: 2,
      egress: 5,
      image: 3,
    });
    for (const guardrail of GUARDRAILS) {
      expect(guardrail.proofs.length > 0 || 'attack' in guardrail, `guardrail ${guardrail.n}`).toBe(true);
    }
  });
});

describe('what takes each proof', () => {
  it('is named for every proof in the catalogue, and the command takes each, once', () => {
    expect(Object.keys(TAKERS).sort()).toEqual(Object.keys(PROOFS).sort());
    expect([...ORDER].sort()).toEqual(Object.keys(PROOFS).sort());
    expect(new Set(ORDER).size).toBe(ORDER.length);
    // The drill, which asks Martin and stops the line, comes last, after every read and script.
    expect(ORDER.at(-1)).toBe('stop-the-line');
  });

  it('takes a proof read from CI as not taken when GitHub cannot be read, since its record must name a run', async () => {
    const context = {
      root: new URL('.', ROOT).pathname,
      firstParent: async () => ['a'.repeat(40)],
      gh: async () => {
        throw new Error('HTTP 502');
      },
    } as unknown as Context;
    for (const id of Object.keys(CI_PROOFS) as (keyof typeof CI_PROOFS)[]) {
      expect(await TAKERS[id](context), id).toEqual({
        notTaken: expect.stringMatching(/CI could not be read: HTTP 502/),
      });
    }
  });

  it('takes the workflow refusal from GitHub itself, and the drill on the cluster the command was given', async () => {
    const ran: { command: string; args: string[]; env?: Record<string, string> }[] = [];
    // A store that answers its clock, and nothing else.
    const sql = (async (strings: TemplateStringsArray) =>
      strings.join('').includes('clock_timestamp') ? [{ now: '2026-10-31T00:00:00.000000Z' }] : []) as unknown;
    const context = {
      root: new URL('.', ROOT).pathname,
      tmp: '/nonexistent',
      kubeContext: 'k3d-elsewhere',
      sql,
      appKey: async () => 'key',
      run: async (command: string, args: string[], env?: Record<string, string>) => {
        ran.push({ command, args, ...(env && { env }) });
        return { status: 0, stdout: '', stderr: '' };
      },
      runnerPods: async () => [],
      ask: async () => true,
      now: () => new Date(),
      sleep: async () => undefined,
      say: () => undefined,
    } as unknown as Context;
    await TAKERS['workflow-refusal'](context);
    expect(ran[0]?.env).toMatchObject({ GITHUB_DRY_RUN: 'false', GITHUB_API_URL: '' });
    await TAKERS['stop-the-line'](context);
    const made = ran.filter((r) => r.command === 'make');
    expect(made.map((r) => r.args.slice(1, 3))).toEqual([
      ['stop-the-line', 'CONTEXT=k3d-elsewhere'],
      ['start-the-line', 'CONTEXT=k3d-elsewhere'],
    ]);
  });

  it('takes again every refusal record the hash names, each in a proof: admission, production-writes or egress', () => {
    expect([...PRODUCTION_WRITES, 'admission-refusals', 'egress'].sort()).toEqual(Object.keys(RECORDS).sort());
    for (const record of Object.keys(RECORDS)) {
      const script = record === 'flag-stages-refusals' ? `scripts/${record}.ts` : `scripts/${record}.sh`;
      expect(existsSync(new URL(script, ROOT)), script).toBe(true);
      // Each writes where REFUSALS_OUT says (egress.sh where its argument says), so deploy/test/ is left as it is.
      if (record !== 'egress') expect(read(script), script).toMatch(/REFUSALS_OUT/);
      if (script.endsWith('.sh')) accessSync(new URL(script, ROOT), constants.X_OK);
    }
  });

  it('reads each proof from CI from a job that runs its tests, every part of it', () => {
    expect(Object.keys(CI_PROOFS).sort()).toEqual(
      Object.keys(PROOFS)
        .filter((id) => id.startsWith('ci:'))
        .sort(),
    );
    // The projects `make check-tests` runs, and the test files each takes.
    const recipe = /^check-tests:.*\n\t(.+)$/m.exec(read('Makefile'))?.[1] ?? '';
    const projects = [...recipe.matchAll(/--project (\w+)/g)].map(([, name]) => name);
    expect(projects.sort()).toEqual(['database', 'unit']);
    const ran = (vitest.test?.projects ?? []).flatMap((project) => {
      const { test } = project as { test: { name: string; include: string[]; exclude?: string[] } };
      return projects.includes(test.name) ? [test] : [];
    });
    expect(ran).toHaveLength(2);
    const runs = (file: string) =>
      ran.some(
        (t) => t.include.some((g) => matchesGlob(file, g)) && !(t.exclude ?? []).some((g) => matchesGlob(file, g)),
      );

    for (const [id, proof] of Object.entries(CI_PROOFS)) {
      const workflow = read(proof.workflow);
      const job = (parse(workflow) as { jobs: Record<string, { steps: { run?: string }[]; strategy?: unknown }> }).jobs[
        proof.job
      ];
      // The job runs the tests in parts, every part named: 1/N to N/N.
      expect(
        job?.steps.some((s) => s.run === 'make check-tests SHARD="$SHARD"'),
        id,
      ).toBe(true);
      const parts = jobNames(workflow, proof.job);
      expect(parts, id).toEqual(parts.map((_, i) => `tests (${i + 1}/${parts.length})`));
      for (const test of proof.tests) {
        expect(existsSync(new URL(test, ROOT)), `${id}: ${test}`).toBe(true);
        expect(runs(test), `${id}: ${test} is run by make check-tests`).toBe(true);
      }
    }
  });

  it('reads each proof from CI from tests CODEOWNERS gives Martin, and every helper they reach, so a change to one is put to him', () => {
    for (const [pattern] of CODEOWNERS) expect(pattern, pattern).toMatch(/^\/[^?]*$/);
    const starts = Object.values(CI_PROOFS).flatMap((proof) => proof.tests);
    const reached = reachedFrom(starts, readIfThere);
    for (const file of reached) expect(ownersOf(file), file).toEqual(['@mrogan']);
    // The proofs' harnesses and fakes are among them, though no proof names them.
    expect(reached).toEqual(
      expect.arrayContaining(['apps/factory/test/runners-harness.ts', 'apps/factory/test/line/fakes.ts']),
    );
    // And this test, which holds them to it; but not a file no entry names.
    expect(ownersOf('apps/factory/test/guardrails.test.ts')).toEqual(['@mrogan']);
    expect(ownersOf('apps/factory/test/no-entry-names-this.test.ts')).toEqual([]);
  });

  it('follows a proof’s imports through the test folders, and no further', () => {
    const files: Record<string, string> = {
      'apps/factory/test/proofs/made-up.test.ts': [
        "import { helper } from '../made-up-helper.ts';",
        "import { fence } from '../../src/runners/scope.ts';",
        "import { listenLocal } from '@software-factory/testing';",
        "import '../made-up-setup.ts';",
        "const { later } = await import('../line/made-up-later.ts');",
      ].join('\n'),
      'apps/factory/test/made-up-helper.ts': [
        "import type { Shape } from './made-up-types.ts';",
        "export { database } from '../../../packages/store/test/made-up-store.ts';",
      ].join('\n'),
      'packages/store/test/made-up-store.ts': "import { migrate } from '../src/migrate.ts';",
      'apps/factory/test/made-up-types.ts': '',
      'apps/factory/test/made-up-setup.ts': '',
      'apps/factory/test/line/made-up-later.ts': '',
    };
    const reached = reachedFrom(['apps/factory/test/proofs/made-up.test.ts'], (file) => files[file]);
    // A helper, one imported for its effect alone or later, and what a helper re-exports from another test folder,
    // but not a type-only import, the code under test or a package.
    expect(reached).toEqual([
      'apps/factory/test/proofs/made-up.test.ts',
      'apps/factory/test/made-up-helper.ts',
      'apps/factory/test/made-up-setup.ts',
      'apps/factory/test/line/made-up-later.ts',
      'packages/store/test/made-up-store.ts',
    ]);
    // A helper no entry names fails the test above.
    expect(ownersOf('apps/factory/test/made-up-helper.ts')).toEqual([]);
  });
});
