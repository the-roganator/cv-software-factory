import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { foldItems } from '../../web/src/projection/items.ts';
import {
  dayView,
  dueSoon,
  dueWords,
  ordered,
  type PatchingRow,
  type PatchingView,
  patchingView,
  targetWords,
} from '../../web/src/projection/patching.ts';
import { END, SAMPLES } from './support.ts';

type Day = PayloadOf<'patching.read'>;
const read = (view: PatchingView) => {
  if (view.state !== 'read') throw new Error('no day read');
  return view;
};
const day = () => SAMPLES.find((e): e is PublicEvent<'patching.read'> => e.type === 'patching.read');
const names = (rows: readonly PatchingRow[]) => rows.map((row) => row.name ?? `(withheld) ${row.key}`);

describe('Patching, projected from the samples', () => {
  const view = read(patchingView(SAMPLES, foldItems(SAMPLES), END));

  it('has a row for each move and each row the sense made, what waits on Martin first, then by deadline', () => {
    expect(view.moves).toBe(11);
    expect(view.running['unlisted-image']).toBe(1);
    expect(view.waiting).toBe(4);
    expect(names(view.rows)).toEqual([
      'example-cd',
      'example-logs',
      'k3s',
      'example/debug-shell:1.4',
      'example/scanner-proxy',
      '(withheld) the-roganator/cv-worlds-worst-website a package in `pnpm-lock.yaml`',
      'example-dashboards',
      'example/sbom-tool',
      'example/sidecar',
      'example/node-base',
      '@example/tokens',
      'example/cluster-proxy',
    ]);
    expect(view.rows.slice(0, 4).every((row) => row.waits)).toBe(true);
    expect(view.rows.slice(4).some((row) => row.waits)).toBe(false);
  });

  it('reads each move’s state from its lane, its pull request where Dependabot opened one, and none it cannot', () => {
    const state = (name: string) => view.rows.find((row) => row.name === name)?.state;
    expect(state('example-logs')).toEqual({ kind: 'waits' });
    expect(state('example/scanner-proxy')).toEqual({ kind: 'lane', lane: 'worker' });
    expect(state('example/sbom-tool')).toEqual({ kind: 'opened' });
    expect(state('example/node-base')).toEqual({ kind: 'lane', lane: 'line' });
    expect(state('example/cluster-proxy')).toEqual({ kind: 'no-route' });
    expect(view.rows.find((row) => row.name === 'example/sbom-tool')?.link).toEqual({
      kind: 'pull',
      number: 1339,
      version: 'v1.55.1',
    });
  });

  it('withholds a lockfile’s package from the public events until its pull request is open', () => {
    const withheld = view.rows.find((row) => row.key.startsWith('the-roganator/cv-worlds-worst-website a package'));
    expect(withheld).toMatchObject({ name: undefined, from: undefined, to: undefined, pins: [] });
    // The factory's, whose Dependabot pull request is open, is named, as its diff names it.
    expect(view.rows.find((row) => row.name === '@example/tokens')).toMatchObject({ from: '3.0.1', to: '3.0.2' });
  });

  it('shortens each target to what a row has room for', () => {
    expect(view.rows.find((row) => row.name === 'example-logs')?.to).toBe('21.1.1, a major');
    expect(view.rows.find((row) => row.name === 'k3s')?.to).toBe('v1.34.5+k3s1');
    expect(view.rows.find((row) => row.name === 'example/sidecar')?.to).toMatch(/^2\.14\.3 [0-9a-f]{8}$/);
    expect(targetWords('versions 1.2.3 and 2.0.1')).toBe('1.2.3, 2.0.1');
    expect(targetWords('tool argocd 3.5.4')).toBe('argocd 3.5.4');
  });

  it('says how the day’s scan went: failed, why, and how many rows below hold each reason', () => {
    expect(view.day).toMatchObject({
      passed: false,
      failed: ['due-within-a-day', 'new-high-or-critical'],
      finished: Date.parse('2026-10-06T04:21:00.000Z'),
      newHighWithFix: 6,
      newHighWithoutFix: 35,
      overdue: 0,
      dueWithinDay: 6,
      movesWithNew: 2,
      movesOverdue: 0,
      movesDueWithinDay: 3,
      unjudged: [],
    });
  });

  it('gives the four figures: no fix yet, cleared by the moves, excepted, past their deadline', () => {
    expect(view.figures).toEqual({ noFix: 15056, cleared: 1732, excepted: 0, overdue: 0, clearingMoves: 10 });
  });

  it('reads only the sense’s own role, and nothing before its first day', () => {
    const forged = SAMPLES.map((e) => (e.type === 'patching.read' ? { ...e, appended_by: 'factory_line' } : e));
    expect(patchingView(forged, [], END)).toEqual({ state: 'unread' });
    expect(patchingView(SAMPLES, [], Date.parse('2026-10-06T05:00:00Z'))).toEqual({ state: 'unread' });
  });
});

describe('Patching’s order', () => {
  const row = (key: string, waits: boolean, deadline?: number) => ({ key, waits, deadline }) as unknown as PatchingRow;

  it('puts what waits first, each part by earliest deadline, those with none last, and keeps ties as they came', () => {
    const rows = [
      row('a', false),
      row('b', false, 5),
      row('c', true),
      row('d', true, 9),
      row('e', false, 5),
      row('f', true, 2),
    ];
    expect(ordered(rows).map((r) => r.key)).toEqual(['f', 'd', 'c', 'b', 'e', 'a']);
  });
});

describe('an empty day', () => {
  const sample = day();
  if (!sample) throw new Error('the samples have no patching.read');
  const empty: Day = {
    ...sample.payload,
    repositories: sample.payload.repositories.map((r) => ({
      ...r,
      run: { ...r.run, conclusion: 'success' },
      failed: [],
      moves: [],
      totals: r.totals && {
        ...r.totals,
        fixed: 0,
        moves: 0,
        dueWithinDay: 0,
        newHighWithFix: 0,
        newHighWithoutFix: 0,
      },
    })),
    rows: [],
  };
  const view = read(dayView(empty, END, [], END));

  it('has no rows, nothing waiting, and a scan that passed, with what has no fix still counted', () => {
    expect(view.rows).toEqual([]);
    expect(view.waiting).toBe(0);
    expect(view.day.passed).toBe(true);
    expect(view.figures).toMatchObject({ noFix: 15056, cleared: 0, clearingMoves: 0 });
  });

  it('says a repository whose run wrote no moves, and does not call the scan passed', () => {
    const failed: Day = {
      ...empty,
      repositories: empty.repositories.map((r, i) =>
        i === 0 ? { ...r, run: { ...r.run, conclusion: 'failure' }, judged: null, failed: ['other'], totals: null } : r,
      ),
      compared: false,
    };
    const shown = read(dayView(failed, END, [], END));
    expect(shown.day.passed).toBe(false);
    expect(shown.day.failed).toEqual(['other']);
    expect(shown.day.unjudged).toEqual([
      {
        repository: 'the-roganator/cv-software-factory',
        url: 'https://github.com/the-roganator/cv-software-factory/actions/runs/1834977',
      },
    ]);
    expect(shown.compared).toBe(false);
  });
});

describe('the line’s move', () => {
  it('reads where the line has the work item that carries it, and links it', () => {
    const sample = day();
    if (!sample) throw new Error('the samples have no patching.read');
    const items = foldItems(SAMPLES).map((item) =>
      item.number === '1262'
        ? {
            ...item,
            closedAt: undefined,
            stage: 'build' as const,
            dependency: { ...item.dependency, name: 'example/node-base' },
          }
        : item,
    ) as ReturnType<typeof foldItems>;
    const view = read(dayView(sample.payload, END, items, END));
    expect(view.rows.find((row) => row.name === 'example/node-base')).toMatchObject({
      state: { kind: 'stage', stage: 'build' },
      link: { kind: 'item', number: '1262' },
    });
  });
});

describe('a deadline in words', () => {
  const t = Date.parse('2026-10-06T12:00:00Z');
  const h = 3_600_000;
  it('counts minutes, hours, a day and hours, then days, and how long past', () => {
    expect(dueWords(undefined, t)).toBe('none');
    expect(dueWords(t + 40 * 60_000, t)).toBe('in 40 min');
    expect(dueWords(t + 21 * h, t)).toBe('in 21 h');
    expect(dueWords(t + 44 * h, t)).toBe('in 1 day 20 h');
    expect(dueWords(t + 117 * h, t)).toBe('in 5 days');
    expect(dueWords(t - 3 * h, t)).toBe('3 h past');
  });
  it('is warm within a day or past, and only then', () => {
    expect(dueSoon(t + 23 * h, t)).toBe(true);
    expect(dueSoon(t - h, t)).toBe(true);
    expect(dueSoon(t + 25 * h, t)).toBe(false);
    expect(dueSoon(undefined, t)).toBe(false);
  });
});
