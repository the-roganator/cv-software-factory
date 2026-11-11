/**
 * The dependency sense's day, `patching.read`: its shape, on one invented sample day in the shape `packages/samples`
 * will hold, and its public view, which leaves out a lockfile move's package until a pull request moving it is open.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicView } from '../src/public.ts';
import { PAYLOADS } from '../src/schemas.ts';
import { LINE_TYPES, PATCHING_ONLY_TYPES, VERSIONS } from '../src/versions.ts';
import { RUNNING_ROWS } from '../src/vocabulary.ts';

const DAY = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'patching-day.json'), 'utf8'));
const schema = PAYLOADS['patching.read'];
const view = (payload: unknown) =>
  publicView('patching.read', { summary: 'The day', payload: schema.parse(payload), artifacts: [] }).payload;

describe("the day's moves", () => {
  it('is a line event at version 1, appended by the sense alone', () => {
    expect(VERSIONS['patching.read']).toBe(1);
    expect(LINE_TYPES).toContain('patching.read');
    expect(PATCHING_ONLY_TYPES).toEqual(['patching.read']);
  });

  it('has a row of each kind the vocabulary names, and no other', () => {
    const rows = schema.parse(DAY).rows.map((r) => r.row);
    expect(rows).toEqual([...RUNNING_ROWS]);
    const other = { ...DAY, rows: [{ ...DAY.rows[1], row: 'something-else' }] };
    expect(schema.safeParse(other).success).toBe(false);
  });

  it('reads the sample day, with a row of each kind', () => {
    const day = schema.parse(DAY);
    expect(day.repositories.map((r) => r.repository)).toEqual([
      'the-roganator/cv-software-factory',
      'the-roganator/cv-worlds-worst-website',
    ]);
    expect(day.rows.map((r) => r.row)).toEqual(['unscanned-digest', 'unlisted-image', 'not-running']);
  });

  it('refuses a repository twice, a package on a move that is not a lockfile’s, and rows with no comparison', () => {
    const [factory] = DAY.repositories;
    expect(schema.safeParse({ ...DAY, repositories: [factory, factory] }).success).toBe(false);
    const image = { ...factory.moves[0], package: factory.moves[2].package };
    expect(schema.safeParse({ ...DAY, repositories: [{ ...factory, moves: [image] }] }).success).toBe(false);
    expect(schema.safeParse({ ...DAY, compared: false }).success).toBe(false);
    expect(schema.safeParse({ ...DAY, compared: false, rows: [] }).success).toBe(true);
    const pullRequestRun = { ...factory, run: { ...factory.run, event: 'pull_request' } };
    expect(schema.safeParse({ ...DAY, repositories: [pullRequestRun] }).success).toBe(false);
  });

  it('shows a lockfile move’s package only once a pull request moving it is open', () => {
    const lockfile = (payload: unknown) =>
      (payload as typeof DAY).repositories[0].moves.find((m: { lockfile: boolean }) => m.lockfile);
    expect(lockfile(view(DAY))).not.toHaveProperty('package');
    expect(lockfile(view(DAY)).name).toBe('a package in `pnpm-lock.yaml`');
    const opened = structuredClone(DAY);
    lockfile(opened).pullRequest = { number: 77, version: '1.0.1' };
    expect(lockfile(view(opened)).package.name).toBe('example-parser');
    // Everything else is as the scan's log has it.
    expect(view(DAY).rows).toEqual(DAY.rows);
    expect((view(DAY) as typeof DAY).repositories[1]).toEqual(DAY.repositories[1]);
  });
});
