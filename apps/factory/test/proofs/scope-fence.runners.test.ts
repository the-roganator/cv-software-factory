/**
 * Proves `ci:scope-fence` (policy/guardrails.ts, spec 6 guardrail 11), with the coder's and the line's tests beside it:
 * the fence lets through only what the spec's scope names, and never the workflows, the deployment or a path CODEOWNERS
 * gives a person. Martin's (CODEOWNERS), as every file here is: a change to what they assert is a change to the proof.
 */
import { describe, expect, it } from 'vitest';
import { fence, ownedPaths } from '../../src/runners/scope.ts';
import { PATCH } from '../runners-harness.ts';

describe('the scope fence', () => {
  it('lets through only the files, folders and patterns the scope names', () => {
    const scope = ['src/money.ts', 'test/', 'src/pages/*.ts'];
    expect(
      fence(PATCH('src/money.ts') + PATCH('test/money.test.ts') + PATCH('src/pages/home.ts'), scope),
    ).toMatchObject({ ok: true });
    expect(fence(PATCH('src/pages/deep/home.ts') + PATCH('src/app.ts'), scope)).toMatchObject({
      ok: false,
      outside: ['src/pages/deep/home.ts', 'src/app.ts'],
    });
  });

  it('never lets through the workflows, the deployment or a code-owned path, whatever the scope says', () => {
    const owned = ownedPaths('# The rules\n/Dockerfile  @mrogan\n/deploy/ @mrogan\npackage.json @mrogan\n');
    expect(owned).toEqual(['Dockerfile', 'Dockerfile/', 'deploy/', '**/package.json', '**/package.json/']);
    const result = fence(
      PATCH('.github/workflows/check.yml') + PATCH('Dockerfile') + PATCH('apps/package.json'),
      ['**'],
      owned,
    );
    expect(result.outside).toEqual(['.github/workflows/check.yml', 'Dockerfile', 'apps/package.json']);
  });

  it('prints the scope, then each file it allowed or refused, with its lines', () => {
    const patch = PATCH('src/money.ts') + PATCH('src/pages/cards.ts');
    const scope = ['src/money.ts', 'test/money.test.ts'];
    expect(fence(patch, scope)).toEqual({
      ok: false,
      paths: ['src/money.ts', 'src/pages/cards.ts'],
      outside: ['src/pages/cards.ts'],
      files: [
        { path: 'src/money.ts', added: 1, removed: 1, allowed: true },
        { path: 'src/pages/cards.ts', added: 1, removed: 1, allowed: false },
      ],
      output: [
        'scope: src/money.ts, test/money.test.ts',
        'allowed src/money.ts +1 −1',
        'refused src/pages/cards.ts +1 −1',
      ].join('\n'),
    });
  });

  it('cuts its output at a whole line, and says how many more there were', () => {
    const patch = Array.from({ length: 300 }, (_, i) => PATCH(`src/pages/page-${i}.ts`)).join('');
    const { output } = fence(patch, ['src/money.ts']);
    expect(output.length).toBeLessThanOrEqual(4000);
    const lines = output.split('\n');
    expect(lines.slice(1, -1).every((line) => /^refused src\/pages\/page-\d+\.ts \+1 −1$/.test(line))).toBe(true);
    expect(lines.at(-1)).toBe(`… and ${300 - (lines.length - 2)} more`);
  });
});

describe('the scope fence, against a path that climbs out', () => {
  it('refuses it before it can match a folder', () => {
    const climbing = PATCH('src/../.github/workflows/x.yml');
    expect(() => fence(climbing, ['src/'])).toThrow('not a plain path');
  });
});
