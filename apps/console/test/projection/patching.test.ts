import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { own } from '../../e2e/full.ts';
import { foldItems } from '../../web/src/projection/items.ts';
import {
  byDeadline,
  dayView,
  dueSoon,
  dueWords,
  nextDue,
  type PatchingRow,
  type PatchingView,
  patchingView,
  readStale,
  staleScans,
  targetWords,
} from '../../web/src/projection/patching.ts';
import { END, SAMPLES } from './support.ts';

type Day = PayloadOf<'patching.read'>;
type Repository = Day['repositories'][number];
type Move = Repository['moves'][number];
type Pull = Repository['pulls'][number];
const read = (view: PatchingView) => {
  if (view.state !== 'read') throw new Error('no day read');
  return view;
};
const days = SAMPLES.filter((e): e is PublicEvent<'patching.read'> => e.type === 'patching.read');
/** The samples' last day, as everyone reads it. */
const last = () => {
  const day = days.at(-1);
  if (!day) throw new Error('the samples have no patching.read');
  return day;
};
/** The samples as Martin's full events carry them: each lockfile move's package, and its pull request's. */
const FULL = SAMPLES.map((e) => own(e as never) as PublicEvent);
const names = (rows: readonly PatchingRow[]) => rows.map((row) => row.name ?? `(withheld) ${row.key}`);
const FACTORY = 'the-roganator/cv-software-factory';

describe('Patching, as a visitor reads the samples', () => {
  const view = read(patchingView(SAMPLES, foldItems(SAMPLES), END));
  const groups = Object.fromEntries(view.groups.map(({ group, rows }) => [group, names(rows)]));

  it('groups what waits on Martin by what he does, each group by earliest deadline, in the sheet’s order', () => {
    expect(view.groups.map(({ group }) => group)).toEqual(['approve', 'held', 'stuck', 'hand', 'martin']);
    expect(groups).toEqual({
      approve: ['example-logs', 'example/setup-tool'],
      held: ['example-metrics', 'example-traces'],
      stuck: ['example/store-cache', 'example/sidecar', 'example/ingress'],
      hand: ['example-cd', 'k3s', 'example/scan-action', 'example/devcontainer-base', 'example/debug-shell:1.4'],
      // The factory's lockfile moves whose pull requests the public view withholds: nothing of why they wait.
      martin: [1, 2, 3, 4].map((n) => `(withheld) ${FACTORY} lockfile ${n}`),
    });
    expect(view.waiting).toBe(16);
  });

  it('then what moves by itself, by earliest deadline', () => {
    expect(names(view.moving)).toEqual([
      'example/scanner-proxy',
      '(withheld) the-roganator/cv-worlds-worst-website lockfile 1',
      'example-dashboards',
      'example/sbom-tool',
      'example/cache',
      'example/node-base',
      'example/cluster-proxy',
    ]);
    const state = (name: string) => view.moving.find((row) => row.name === name)?.state.kind;
    expect(state('example/scanner-proxy')).toBe('checks');
    expect(state('example-dashboards')).toBe('queue');
    expect(state('example/sbom-tool')).toBe('opened');
    expect(state('example/cache')).toBe('day');
    expect(state('example/node-base')).toBe('lane');
    expect(state('example/cluster-proxy')).toBe('none');
    // Within its major, it leaves what only the next major clears.
    expect(view.moving.find((row) => row.name === 'example-dashboards')?.leaves?.high).toBe(2);
  });

  it('withholds a visitor’s lockfile moves: no package, no versions, no pins, and no pull request to name', () => {
    for (const row of view.groups.find(({ group }) => group === 'martin')?.rows ?? []) {
      expect(row).toMatchObject({ name: undefined, from: undefined, to: undefined, pins: [], waits: true });
      expect(row.pull).toMatchObject({ withheld: true });
      expect(row.pull?.number).toBeUndefined();
      // Its deadline is kept, as the day gives it to everyone.
      expect(row.deadline === undefined || row.deadline > END).toBe(true);
    }
  });

  it('joins each move to its pull request or issue: its number, rule, checks and hold', () => {
    const row = (name: string) => view.rows.find((r) => r.name === name);
    expect(row('example-logs')?.pull).toMatchObject({ number: 1344, rule: 'major', hold: 'level' });
    expect(row('example/sidecar')?.pull?.checks).toEqual({
      state: 'failed',
      try: 3,
      of: 3,
      failed: [{ name: 'database tests', run: 19220481337 }],
    });
    expect(row('example/setup-tool')?.pull).toMatchObject({ kind: 'dependabot', number: 1350, hold: 'martin' });
    expect(row('example/devcontainer-base')?.pull).toMatchObject({ kind: 'issue', number: 81, issue: 'none' });
  });

  it('says when the pull requests were read, and the one fix that waits its day', () => {
    expect(view.read).toBe(Date.parse('2026-10-06T05:12:00.000Z'));
    expect(view.waitDay).toEqual({ count: 1, name: 'example/cache' });
    expect(view.scans.map((scan) => scan.repository)).toEqual([FACTORY, 'the-roganator/cv-worlds-worst-website']);
  });

  it('lists what was done in the last 28 days, newest first: merged, closed for a newer target, no longer listed', () => {
    expect(view.done.map((row) => [row.name ?? '(withheld)', row.state.kind, row.pull?.number])).toEqual([
      ['example/runtime', 'gone', undefined],
      ['example-dashboards', 'gone', 1180],
      ['example/old-sidecar', 'merged', 1336],
      ['(withheld)', 'merged', 1327],
    ]);
    const closed = view.done.find((row) => row.pull?.number === 1180);
    // As the day before listed it, and the target it goes on under.
    expect(closed).toMatchObject({ to: '13.5.0', goesOn: '13.7.2' });
    expect(view.done.find((row) => row.name === 'example/old-sidecar')?.clears).toMatchObject({
      critical: 2,
      high: 30,
    });
    // A visitor's lockfile move is joined to nothing it cleared, which another of its file's might have.
    expect(view.done.find((row) => row.pull?.number === 1327)).toMatchObject({ clears: undefined, name: undefined });
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
      movesWithNew: 2,
      movesOverdue: 0,
      movesDueWithinDay: 3,
      unjudged: [],
    });
  });

  it('counts every open finding by severity, both repositories’ together, and what the rows still to move clear', () => {
    expect(view.open).toEqual({ critical: 12, high: 1392, medium: 11141, low: 4178, unknown: 0 });
    const { critical, high, medium, low, unknown } = view.clears;
    expect(critical + high + medium + low + unknown).toBe(view.figures.cleared);
  });

  it('names the row due first as next due', () => {
    const next = nextDue(view.rows);
    const deadlines = view.rows.flatMap((row) => (row.deadline === undefined ? [] : [row.deadline]));
    expect(next?.deadline).toBe(Math.min(...deadlines));
  });

  it('reads only the sense’s own role, and nothing before its first day', () => {
    const forged = SAMPLES.map((e) => (e.type === 'patching.read' ? { ...e, appended_by: 'factory_line' } : e));
    expect(patchingView(forged, [], END)).toEqual({ state: 'unread' });
    expect(patchingView(SAMPLES, [], Date.parse('2026-10-05T05:00:00Z'))).toEqual({ state: 'unread' });
  });
});

describe('Patching, as Martin reads the samples', () => {
  const view = read(patchingView(FULL, foldItems(FULL), END));
  const group = (name: string) => view.groups.find(({ rows }) => rows.some((row) => row.name === name))?.group;

  it('names each lockfile package, and groups it by what its pull request or issue asks of him', () => {
    expect(view.groups.map(({ group }) => group)).toEqual(['approve', 'bench', 'held', 'stuck', 'hand']);
    expect(group('@example/agent-sdk')).toBe('bench');
    expect(group('@example/tokens')).toBe('held');
    expect(group('@example/hooks')).toBe('stuck');
    expect(view.rows.find((row) => row.name === '@example/hooks')?.pull).toMatchObject({ refusal: 'provenance' });
  });

  it('holds a move made with one undone on main in that one’s row, not a row of its own', () => {
    const tokens = view.rows.find((row) => row.name === '@example/tokens');
    expect(tokens?.held.map((row) => row.name)).toEqual(['@example/ws']);
    expect(view.rows.find((row) => row.name === '@example/ws')).toBeUndefined();
    // Counted once among what waits, as the card counts it.
    expect(view.waiting).toBe(15);
  });

  it('lists a line move’s scan findings from its work item’s newest signal, by package and severity, never an advisory', () => {
    const parser = view.moving.find((row) => row.name === '@example/parser');
    expect(parser).toMatchObject({ state: { kind: 'stage', stage: 'review' }, link: { number: '1335' } });
    expect(parser?.findings).toEqual({
      listed: [
        { package: '@example/parser', severity: 'critical', deadline: Date.parse('2026-10-08T00:20:00.000Z') },
        { package: '@example/parser', severity: 'low', deadline: Date.parse('2026-11-05T04:20:00.000Z') },
      ],
      count: 2,
    });
    expect(JSON.stringify(parser?.findings)).not.toMatch(/GHSA/);
  });

  it('names a lockfile’s merged move in Done, with what it cleared', () => {
    expect(view.done.find((row) => row.pull?.number === 1327)).toMatchObject({
      name: '@example/ws-lib',
      from: '1.6.0',
      to: '1.6.2',
      clears: { high: 1 },
    });
  });
});

/** A day of one factory move, and the pull requests and issues given. */
function oneMove(move: Partial<Move>, pulls: Pull[], fields: Partial<Repository> = {}): Day {
  const factory = last().payload.repositories[0] as Repository;
  const base = factory.moves.find((m) => m.name === 'example-traces') as Move;
  return {
    ...last().payload,
    rows: [],
    repositories: [{ ...factory, moves: [{ ...base, ...move }], waiting: [], pulls, ...fields }],
  };
}
const pin = (fields: Partial<Pull>): Pull => ({
  kind: 'pin',
  number: 1400,
  moves: [{ name: 'example-traces' }],
  opened: '2026-10-06T04:30:00.000Z',
  state: 'open',
  ...fields,
});
const issue = (why: NonNullable<Pull['issue']>, fields: Partial<Pull> = {}): Pull =>
  pin({ kind: 'issue', issue: why, ...fields });
const only = (day: Day) => {
  const view = read(dayView(day, END, []));
  return { row: view.rows[0], view };
};

describe('where a move stands, from its pull request or issue', () => {
  it.each([
    ['level', 'approve'],
    ['held', 'approve'],
    ['martin', 'approve'],
    ['changes-requested', 'held'],
    ['dequeued', 'held'],
    ['label', 'held'],
    ['checks-spent', 'stuck'],
    ['queue-spent', 'stuck'],
    ['conflict', 'stuck'],
  ] as const)('a pull request held for %s waits in %s', (hold, group) => {
    const { row } = only(oneMove({}, [pin({ hold })]));
    expect(row).toMatchObject({ waits: true, group, state: { kind: 'waits', why: hold, group } });
  });

  it.each([
    ['bench', 'bench'],
    ['reverted', 'held'],
    ['with-reverted', 'held'],
    ['refused', 'stuck'],
    ['branch-held', 'stuck'],
    ['open-refused', 'stuck'],
    ['history-unread', 'stuck'],
    ['workflow', 'hand'],
    ['none', 'hand'],
    ['other', 'hand'],
    ['cluster', 'hand'],
  ] as const)('an issue that asks for %s waits in %s', (why, group) => {
    const { row } = only(oneMove({}, [issue(why, why === 'refused' ? { refusal: 'young' } : {})]));
    expect(row).toMatchObject({ waits: true, group });
  });

  it('moves by itself while the gate has not judged it, its checks run, or it is in the merge queue', () => {
    expect(only(oneMove({}, [pin({ hold: 'verdict' })])).row?.state).toEqual({ kind: 'opened' });
    const running = { state: 'running' as const, try: 2, of: 3, failed: [] };
    expect(only(oneMove({}, [pin({ hold: 'checks', checks: running })])).row?.state).toEqual({ kind: 'checks' });
    expect(only(oneMove({}, [pin({ queued: true, rule: 'move' })])).row?.state).toEqual({ kind: 'queue' });
    expect(only(oneMove({}, [pin({ rule: 'move' })])).row?.waits).toBe(false);
  });

  it('says it would queue but waits while the line is stopped, and moves by itself still', () => {
    const { row } = only(oneMove({}, [pin({ hold: 'stopped', rule: 'move' })]));
    expect(row).toMatchObject({ waits: false, stopped: true, state: { kind: 'opened' } });
  });

  it('is the cluster’s whatever its pull request’s checks say: only its own command applies k3s', () => {
    expect(only(oneMove({ lane: 'cluster' }, [pin({ rule: 'move', queued: true })])).row).toMatchObject({
      group: 'hand',
      state: { why: 'cluster' },
    });
  });

  it('is held by Martin once a person closed its pull request, and by nothing once the App closed it', () => {
    const closed = (closedByPerson: boolean) =>
      pin({ state: 'closed', settled: '2026-10-06T04:50:00.000Z', closedByPerson });
    expect(only(oneMove({}, [closed(true)])).row).toMatchObject({ group: 'held', state: { why: 'closed' } });
    expect(only(oneMove({}, [closed(false)])).row?.state).toEqual({ kind: 'lane', lane: 'worker' });
  });

  it('is done once its pull request merged after its scan judged it, and listed again by a scan judged after', () => {
    const merged = pin({ state: 'merged', settled: '2026-10-06T05:00:00.000Z' });
    const after = only(oneMove({}, [merged]));
    expect(after.view.rows).toEqual([]);
    expect(after.view.done.map((row) => [row.name, row.state.kind])).toEqual([['example-traces', 'merged']]);
    const before = only(oneMove({}, [merged], { judged: '2026-10-06T06:00:00.000Z' }));
    expect(before.row?.state).toEqual({ kind: 'lane', lane: 'worker' });
  });

  it('stands by an open one over a settled one, and an issue over a pull request', () => {
    const settled = pin({ number: 1390, state: 'merged', settled: '2026-10-06T05:00:00.000Z' });
    const { row } = only(oneMove({}, [settled, pin({ hold: 'level' }), issue('workflow', { number: 1401 })]));
    expect(row?.pull?.number).toBe(1401);
  });

  it('waits on Martin by its lane where nothing carries it yet: the cluster, an issue, a line no longer built', () => {
    expect(only(oneMove({ lane: 'cluster' }, [])).row?.group).toBe('hand');
    expect(only(oneMove({ lane: 'issue' }, [])).row?.state).toMatchObject({ why: 'issue' });
    const unbuilt = only(oneMove({ lane: 'none', to: 'another line (this one last built 2026-03-02T00:00:00Z)' }, []));
    expect(unbuilt.row?.state).toMatchObject({ why: 'none' });
    expect(only(oneMove({ lane: 'none', to: '' }, [])).row?.state).toEqual({ kind: 'none' });
  });

  it('joins a lockfile’s move by its package where the day names one, and every pull of its file where it does not', () => {
    const lockfile: Partial<Move> = {
      name: 'a package in `pnpm-lock.yaml`',
      lockfile: true,
      package: { name: '@example/a', from: '1.0.0', to: '1.0.1', pins: [{ file: 'pnpm-lock.yaml', line: 9 }] },
    };
    const other = issue('bench', { moves: [{ name: 'a package in `pnpm-lock.yaml`', package: '@example/b' }] });
    expect(only(oneMove(lockfile, [other])).row?.waits).toBe(false);
    const { package: _withheld, ...publicMove } = lockfile;
    const withheld = { kind: 'issue', moves: other.moves, opened: other.opened, state: 'open', withheld: true } as Pull;
    expect(only(oneMove(publicMove, [withheld])).row).toMatchObject({ group: 'martin', name: undefined });
  });
});

describe('a pin that waits', () => {
  const waiting = (why: 'content' | 'no-better', leaves?: Move['leaves']) =>
    oneMove({}, [], {
      moves: [],
      waiting: [
        {
          name: 'example/cache',
          pins: [{ file: 'deploy/base/cache/cache.yaml', line: 17 }],
          from: '8.2.2',
          why,
          ...(why === 'content' && { to: 'image 8.2.3', until: '2026-10-07T04:00:00.000Z' }),
          clears: { critical: 0, high: 1, medium: 2, low: 0, unknown: 0 },
          ...(leaves && { leaves }),
          deadline: '2026-10-12T04:16:00.000Z',
        },
      ],
    });

  it('waits its day by itself, with when it comes due; no release better than the pin is tried and stopped', () => {
    expect(only(waiting('content')).row).toMatchObject({
      waits: false,
      state: { kind: 'day' },
      until: Date.parse('2026-10-07T04:00:00.000Z'),
      to: '8.2.3',
    });
    expect(only(waiting('no-better')).row).toMatchObject({ waits: true, group: 'stuck', to: undefined });
  });

  it('says a major clears the rest where it leaves anything', () => {
    const leaves = { critical: 0, high: 2, medium: 0, low: 0, unknown: 0 };
    expect(only(waiting('content', leaves)).row?.leaves).toEqual(leaves);
    expect(only(waiting('content')).row?.leaves).toBeUndefined();
  });
});

describe('a move undone on main', () => {
  const lockfile = (pkg: string): Move => ({
    name: 'a package in `pnpm-lock.yaml`',
    pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
    from: '',
    to: '',
    major: false,
    clears: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 },
    leaves: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    deadline: '2026-10-09T04:16:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: true,
    package: { name: pkg, from: '1.0.0', to: '1.0.1', pins: [{ file: 'pnpm-lock.yaml', line: 9 }] },
  });
  const moves = [lockfile('@example/a'), lockfile('@example/b'), lockfile('@example/c')];
  const carries = (...pkgs: string[]) => pkgs.map((p) => ({ name: 'a package in `pnpm-lock.yaml`', package: p }));

  it('holds what its issue carries with it, in one row', () => {
    const day = oneMove({}, [issue('reverted', { moves: carries('@example/a', '@example/b') })], { moves });
    const view = read(dayView(day, END, []));
    expect(names(view.rows)).toEqual(['@example/a', '@example/c']);
    expect(view.rows[0]?.held.map((row) => row.name)).toEqual(['@example/b']);
  });

  it('holds a move made with it whose issue is its own, where it writes the same file', () => {
    const day = oneMove(
      {},
      [
        issue('reverted', { moves: carries('@example/a') }),
        issue('with-reverted', { number: 1402, moves: carries('@example/c') }),
      ],
      { moves },
    );
    const view = read(dayView(day, END, []));
    expect(names(view.rows)).toEqual(['@example/a', '@example/b']);
    expect(view.rows[0]?.held.map((row) => row.name)).toEqual(['@example/c']);
  });
});

describe('Done in the last 28 days', () => {
  const at = (ts: string, day: Day) => ({ at: Date.parse(ts), day });
  const base = oneMove({}, []);

  it('is each move an earlier day listed and the last does not, from the first day without it', () => {
    const gone = oneMove({}, [], { moves: [] });
    const view = read(
      dayView(gone, END, [], [at('2026-10-04T05:00:00.000Z', base), at('2026-10-05T05:00:00.000Z', base)]),
    );
    expect(view.done.map((row) => [row.name, row.state.kind, row.on])).toEqual([['example-traces', 'gone', END]]);
  });

  it('is not a move the last day still lists, nor one of a repository whose scan the last day did not judge', () => {
    expect(read(dayView(base, END, [], [at('2026-10-05T05:00:00.000Z', base)])).done).toEqual([]);
    const unjudged = oneMove({}, [], { moves: [], judged: null });
    expect(read(dayView(unjudged, END, [], [at('2026-10-05T05:00:00.000Z', base)])).done).toEqual([]);
  });

  it('is no pull request settled more than 28 days before, nor one of Dependabot’s it closed for the factory’s', () => {
    const old = pin({ state: 'merged', settled: '2026-09-01T00:00:00.000Z' });
    const dependabot = pin({ kind: 'dependabot', state: 'closed', settled: '2026-10-06T00:00:00.000Z' });
    expect(read(dayView(oneMove({}, [old, dependabot], { moves: [] }), END, [])).done).toEqual([]);
  });

  it('says a pull request a person closed as closed, and the App’s as no longer listed', () => {
    const closed = (closedByPerson: boolean, number: number) =>
      pin({ number, state: 'closed', settled: '2026-10-06T00:00:00.000Z', closedByPerson });
    const view = read(dayView(oneMove({}, [closed(true, 1), closed(false, 2)], { moves: [] }), END, []));
    expect(view.done.map((row) => [row.pull?.number, row.state.kind])).toEqual([
      [1, 'closed'],
      [2, 'gone'],
    ]);
  });
});

describe('a stale day', () => {
  const h = 3_600_000;
  it('says the sense’s read may be out of date from 26 hours, and a scan too old for its moves past 36', () => {
    expect(readStale(END, END + 26 * h - 1)).toBe(false);
    expect(readStale(END, END + 26 * h)).toBe(true);
    const scans = [{ repository: FACTORY, judged: END, run: '' }];
    expect(staleScans(scans, END + 36 * h)).toEqual([]);
    expect(staleScans(scans, END + 36 * h + 1)).toEqual(scans);
    expect(staleScans([{ ...scans[0], judged: undefined } as never], END + 99 * h)).toEqual([]);
  });

  it('reads a day appended before the sense read pull requests as read when it was appended', () => {
    const { read: _read, ...day } = last().payload;
    const event = { ...last(), payload: day } as PublicEvent<'patching.read'>;
    expect(read(patchingView([event], [], END)).read).toBe(Date.parse(last().ts));
  });
});

describe('a day from a scan that did not count every open finding', () => {
  const sample = last();

  it('has no open count at all when one repository’s day lacks it, rather than one worked out from the rest', () => {
    const older: Day = {
      ...sample.payload,
      repositories: sample.payload.repositories.map((r, i) => {
        if (i !== 1 || !r.totals) return r;
        const { open: _, ...totals } = r.totals;
        return { ...r, totals };
      }),
    };
    const view = read(dayView(older, END, []));
    expect(view.open).toBeUndefined();
    expect(view.clears.high).toBeGreaterThan(0);
  });

  it('has none when a repository’s day has no totals at all', () => {
    const none: Day = {
      ...sample.payload,
      repositories: sample.payload.repositories.map((r, i) => (i === 0 ? { ...r, totals: null } : r)),
    };
    expect(read(dayView(none, END, [])).open).toBeUndefined();
  });
});

describe('Patching’s order', () => {
  const row = (key: string, deadline?: number) => ({ key, deadline }) as unknown as PatchingRow;

  it('puts the earliest deadline first, those with none last, and keeps ties as they came', () => {
    const rows = [row('a'), row('b', 5), row('c'), row('d', 9), row('e', 5), row('f', 2)];
    expect(byDeadline(rows).map((r) => r.key)).toEqual(['f', 'b', 'e', 'd', 'a', 'c']);
  });
});

describe('an empty day', () => {
  const sample = last();
  const empty: Day = {
    ...sample.payload,
    repositories: sample.payload.repositories.map((r) => ({
      ...r,
      run: { ...r.run, conclusion: 'success' },
      failed: [],
      moves: [],
      waiting: [],
      pulls: [],
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
  const view = read(dayView(empty, END, []));

  it('has no rows, nothing waiting, and a scan that passed, with what has no fix still counted', () => {
    expect(view.rows).toEqual([]);
    expect(view.waiting).toBe(0);
    expect(view.day.passed).toBe(true);
    expect(view.figures).toMatchObject({ noFix: 15056, cleared: 0, clearingMoves: 0 });
    expect(view.nothing).toBe('cleared');
  });

  it('says a repository whose run wrote no moves, and does not call the scan passed', () => {
    const failed: Day = {
      ...empty,
      repositories: empty.repositories.map((r, i) =>
        i === 0 ? { ...r, run: { ...r.run, conclusion: 'failure' }, judged: null, failed: ['other'], totals: null } : r,
      ),
      compared: false,
    };
    const shown = read(dayView(failed, END, []));
    expect(shown.day.passed).toBe(false);
    expect(shown.day.failed).toEqual(['other']);
    expect(shown.day.unjudged).toEqual([
      { repository: FACTORY, url: 'https://github.com/the-roganator/cv-software-factory/actions/runs/1834977' },
    ]);
    expect(shown.compared).toBe(false);
    expect(shown.day.broken).toEqual([]);
    expect(shown.nothing).toBe('unjudged');
  });

  it('names a run that judged its moves and failed for none of the scan’s reasons, by its page', () => {
    const broken: Day = {
      ...empty,
      repositories: empty.repositories.map((r, i) =>
        i === 1 ? { ...r, run: { ...r.run, conclusion: 'failure', url: 'javascript:alert(1)' }, failed: ['other'] } : r,
      ),
    };
    const shown = read(dayView(broken, END, []));
    expect(shown.day.broken).toEqual([
      {
        repository: 'the-roganator/cv-worlds-worst-website',
        url: 'https://github.com/the-roganator/cv-worlds-worst-website/actions/runs/1834981',
      },
    ]);
    expect(shown.nothing).toBe('failed');
  });
});

describe('row keys', () => {
  it('are one to a row, and the same for Martin and a visitor, for two lockfile moves in one repository', () => {
    const app = own(last()).payload.repositories[1] as Repository;
    const lockfile = app.moves.find((m) => m.lockfile);
    if (!lockfile) throw new Error('the app has no lockfile move');
    const { package: _, ...withheld } = lockfile;
    const twice: Day = {
      ...last().payload,
      repositories: [{ ...app, pulls: [], moves: [withheld, { ...withheld, deadline: '2026-10-09T00:00:00.000Z' }] }],
    };
    const keys = read(dayView(twice, END, [])).rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    const full: Day = {
      ...twice,
      repositories: [{ ...app, pulls: [], moves: [lockfile, { ...lockfile, deadline: '2026-10-09T00:00:00.000Z' }] }],
    };
    expect(read(dayView(full, END, [])).rows.map((row) => row.key)).toEqual(keys);
  });

  it('are one to a row for two moves of one name from two pins, the first keeping its name alone', () => {
    const move = { from: '1.24.1' };
    const day = oneMove(move, []);
    const two: Day = {
      ...day,
      repositories: day.repositories.map((r) => ({
        ...r,
        moves: [...r.moves, { ...(r.moves[0] as Move), from: '1.0' }],
      })),
    };
    const keys = read(dayView(two, END, [])).rows.map((row) => row.key);
    expect(keys).toEqual([`${FACTORY} example-traces`, `${FACTORY} example-traces 2`]);
  });
});

describe('a pin the cluster does not run yet', () => {
  it('is placed at its pin, with what runs instead among its places', () => {
    const pinAt = { file: 'deploy/base/postgres/statefulset.yaml', line: 40 };
    const running = (pod: string) => ({ namespace: 'factory', pod, container: 'postgres', image: 'example/db:17.5' });
    const withRow: Day = {
      ...last().payload,
      rows: [
        {
          row: 'not-running',
          repository: FACTORY,
          item: 'example/db:17.6',
          image: 'example/db:17.6',
          pin: pinAt,
          running: [running('db-0'), running('db-1'), running('db-2')],
        },
      ],
    };
    const row = read(dayView(withRow, END, [])).rows.find((r) => r.source.kind === 'not-running');
    expect(row).toMatchObject({ where: pinAt, from: 'example/db:17.5', to: 'example/db:17.6', waits: true });
    expect(row?.pins.map((p) => p.at)).toEqual([
      'deploy/base/postgres/statefulset.yaml:40',
      'factory/db-0',
      'factory/db-1',
      'factory/db-2',
    ]);
  });
});

describe('the line’s move', () => {
  it('reads where the line has the work item that carries it, and links it', () => {
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
    const view = read(dayView(last().payload, END, items));
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
    expect(dueWords(t + 117 * h, t)).toBe('in 4 days');
    expect(dueWords(t + 61 * h, t)).toBe('in 2 days');
    expect(dueWords(t - 3 * h, t)).toBe('3 h past');
    expect(dueWords(t - 60 * h, t)).toBe('2 days past');
  });
  it('is warm within a day or past, and only then', () => {
    expect(dueSoon(t + 23 * h, t)).toBe(true);
    expect(dueSoon(t - h, t)).toBe(true);
    expect(dueSoon(t + 25 * h, t)).toBe(false);
    expect(dueSoon(undefined, t)).toBe(false);
  });
});

describe('a lockfile’s package whose versions the scan could not read', () => {
  const lockfile = (from: string, to: string): Partial<Move> => ({
    name: 'a package in `pnpm-lock.yaml`',
    pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
    lockfile: true,
    package: { name: '@example/tokens', from, to, pins: [{ file: 'pnpm-lock.yaml', line: 2140 }] },
  });
  const row = (from: string, to: string) => only(oneMove(lockfile(from, to), [])).row;

  it('leaves an empty side unsaid, never drawn as half an arrow', () => {
    expect(row('', '')).toMatchObject({ name: '@example/tokens', from: undefined, to: undefined });
    expect(row('', '')?.pins.map((p) => p.change)).toEqual(['']);
    expect(row('3.0.1', '')).toMatchObject({ from: '3.0.1', to: undefined });
    expect(row('', '3.0.2')?.pins.map((p) => p.change)).toEqual(['→ 3.0.2']);
  });
});

describe('the sense’s rows', () => {
  it('are keyed by what runs and where, not by a pod’s name, and two replicas get two keys', () => {
    const sample = last();
    const unlisted = sample.payload.rows.find((r) => r.row === 'unlisted-image');
    if (unlisted?.row !== 'unlisted-image') throw new Error('the samples have no unlisted image');
    const keysOf = (rows: Day['rows']) =>
      read(dayView({ ...sample.payload, rows }, END, []))
        .rows.filter((r) => r.source.kind === 'unlisted-image')
        .map((r) => r.key);
    const before = keysOf([unlisted]);
    expect(keysOf([{ ...unlisted, pod: 'debug-shell-b81d' }])).toEqual(before);
    const two = keysOf([unlisted, { ...unlisted, pod: 'debug-shell-b81d' }]);
    expect(new Set(two).size).toBe(2);
    expect(two.every((key) => !key.includes('debug-shell-7c9f') && !key.includes('debug-shell-b81d'))).toBe(true);
  });
});
