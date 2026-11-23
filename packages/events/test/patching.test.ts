/**
 * The dependency sense's day, `patching.read`: its shape, on one invented sample day in the shape `packages/samples`
 * will hold, and its public view, which leaves out a lockfile move's package.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicView } from '../src/public.ts';
import { PAYLOADS } from '../src/schemas.ts';
import { upcast } from '../src/upcast.ts';
import { LINE_TYPES, PATCHING_ONLY_TYPES, VERSIONS } from '../src/versions.ts';
import { RUNNING_ROWS } from '../src/vocabulary.ts';

const DAY = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'patching-day.json'), 'utf8'));
const schema = PAYLOADS['patching.read'];
const view = (payload: unknown) =>
  publicView('patching.read', { summary: 'The day', payload: schema.parse(payload), artifacts: [] }).payload;

describe("the day's moves", () => {
  it('is a line event at version 4, appended by the sense alone', () => {
    expect(VERSIONS['patching.read']).toBe(4);
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

  it('carries the scan’s own counts beside its totals, all public, and refuses totals without them', () => {
    const [factory] = DAY.repositories;
    expect((view(DAY) as typeof DAY).repositories[0].totals).toEqual(factory.totals);
    const { noFix: _, ...without } = factory.totals;
    expect(schema.safeParse({ ...DAY, repositories: [{ ...factory, totals: without }] }).success).toBe(false);
    expect(
      schema.safeParse({ ...DAY, repositories: [{ ...factory, totals: { ...factory.totals, overdue: -1 } }] }).success,
    ).toBe(false);
  });

  it('carries every open finding by severity when the scan counted them, public, and reads a day without', () => {
    const [factory, app] = DAY.repositories;
    expect(factory.totals.open).toBeDefined();
    // Every open finding has a fix or none, so the sample's figures agree with each other.
    const sum = Object.values(factory.totals.open as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(factory.totals.fixed + factory.totals.noFix);
    expect(app.totals.open).toBeUndefined();
    const day = schema.parse(DAY);
    expect(day.repositories[0]?.totals?.open).toEqual(factory.totals.open);
    expect(day.repositories[1]?.totals).not.toHaveProperty('open');
    expect((view(DAY) as typeof DAY).repositories[0].totals.open).toEqual(factory.totals.open);
    const negative = { ...factory.totals, open: { ...factory.totals.open, high: -1 } };
    expect(schema.safeParse({ ...DAY, repositories: [{ ...factory, totals: negative }] }).success).toBe(false);
    const { unknown: _, ...partial } = factory.totals.open;
    const short = { ...factory.totals, open: partial };
    expect(schema.safeParse({ ...DAY, repositories: [{ ...factory, totals: short }] }).success).toBe(false);
  });

  it('reads a version 1 day as it was, with no open count by severity', () => {
    const { open: _, ...before } = DAY.repositories[0].totals;
    const v1 = { ...DAY, repositories: [{ ...DAY.repositories[0], totals: before }, DAY.repositories[1]] };
    const read = upcast({ type: 'patching.read', version: 1, payload: v1 });
    expect(read.ok && read.event.payload).toEqual(v1);
    expect(schema.safeParse(v1).success).toBe(true);
  });

  it('reads a version 2 day’s `approval` lane as the worker’s, its moves and its count', () => {
    const [factory, app] = DAY.repositories;
    const held = { ...factory.moves[0], lane: 'approval' };
    const lanes = { ...factory.totals.lanes, worker: factory.totals.lanes.worker - 1, approval: 1 };
    const v2 = {
      ...DAY,
      repositories: [
        { ...factory, moves: [held, ...factory.moves.slice(1)], totals: { ...factory.totals, lanes } },
        app,
      ],
    };
    expect(schema.safeParse(v2).success).toBe(false);
    const read = upcast({ type: 'patching.read', version: 2, payload: v2 });
    expect(read.ok && read.event.payload).toEqual(DAY);
    // A day whose scan wrote no totals has none to count.
    const none = { ...DAY, repositories: [{ ...factory, totals: null, judged: null, moves: [] }, app] };
    const kept = upcast({ type: 'patching.read', version: 2, payload: none });
    expect(kept.ok && kept.event.payload).toEqual(none);
  });

  it('reads a version 3 day’s `dependabot` lane as the worker’s, and leaves out the pull request each named', () => {
    const [factory, app] = DAY.repositories;
    const theirs = { ...factory.moves[2], lane: 'dependabot', pullRequest: { number: 77, version: '1.0.1' } };
    const lanes = { ...factory.totals.lanes, worker: factory.totals.lanes.worker - 1, dependabot: 1 };
    const named = { ...factory.moves[0], pullRequest: { number: 78, version: '2.0.1' } };
    const v3 = {
      ...DAY,
      repositories: [
        { ...factory, moves: [named, factory.moves[1], theirs], totals: { ...factory.totals, lanes } },
        { ...app, totals: { ...app.totals, lanes: { ...app.totals.lanes, dependabot: 0 } } },
      ],
    };
    expect(schema.safeParse(v3).success).toBe(false);
    const read = upcast({ type: 'patching.read', version: 3, payload: v3 });
    expect(read.ok && read.event.payload).toEqual(DAY);
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

  it('never shows a lockfile move’s package', () => {
    const lockfile = (payload: unknown) =>
      (payload as typeof DAY).repositories[0].moves.find((m: { lockfile: boolean }) => m.lockfile);
    expect(lockfile(DAY).package.name).toBe('example-parser');
    expect(lockfile(view(DAY))).not.toHaveProperty('package');
    expect(lockfile(view(DAY)).name).toBe('a package in `pnpm-lock.yaml`');
    // Everything else is as the scan's log has it.
    expect(view(DAY).rows).toEqual(DAY.rows);
    expect((view(DAY) as typeof DAY).repositories[1]).toEqual(DAY.repositories[1]);
  });
});
