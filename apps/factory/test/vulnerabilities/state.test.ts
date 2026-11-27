import { describe, expect, it } from 'vitest';
import type { Target } from '../../src/vulnerabilities/fixes.ts';
import {
  contentWaits,
  latest,
  MAX_SEALED_BYTES,
  newKey,
  open,
  openKept,
  readKey,
  type State,
  type StateApi,
  StateError,
  type StateWait,
  seal,
  settle,
  sightings,
  WAITING,
} from '../../src/vulnerabilities/state.ts';
import { zipOf } from './zip-of.ts';

/** The state the scan keeps between runs (state.ts, ADR 0026): its seal, its shape, and how the last one is found. */
const REPOSITORY = 'the-roganator/cv-software-factory';
const KEY = readKey(newKey());

const STATE: State = {
  version: 1,
  repository: REPOSITORY,
  run: '19234567890',
  findings: [
    {
      advisory: 'CVE-2099-20001',
      package: 'example-a',
      installed: '1.0.0',
      file: 'pnpm-lock.yaml',
      line: 120,
      repository: 'pnpm-lock.yaml',
      type: 'pnpm',
      severity: 'HIGH',
      fixed: '1.0.1',
      seen: '2026-10-01T00:00:00Z',
      fix: { target: 'version 1.0.1', day: '2026-11-03T00:00:00Z' },
      move: 1,
    },
    {
      advisory: 'CVE-2099-20002',
      package: 'libexample',
      installed: '1.0-1',
      file: '.devcontainer/Dockerfile',
      line: 2,
      repository: 'node',
      type: 'debian',
      severity: 'LOW',
      seen: '2026-11-10T04:30:00Z',
    },
  ],
};

const sealedWith = (change: (state: Record<string, unknown>) => void) => {
  const state = structuredClone(STATE) as unknown as Record<string, unknown>;
  change(state);
  return seal(state as unknown as State, KEY);
};
const finding = (state: Record<string, unknown>) => (state.findings as Record<string, unknown>[])[0] ?? {};

describe('the seal', () => {
  it('opens to the state it sealed, for its repository and run', () => {
    expect(open(seal(STATE, KEY), KEY, REPOSITORY, STATE.run)).toEqual(STATE);
  });

  it('shows nothing of a finding, and seals the same state differently each time', () => {
    const sealed = seal(STATE, KEY);
    for (const word of ['example-a', 'CVE-2099-20001', 'pnpm-lock.yaml'])
      expect(sealed.includes(Buffer.from(word))).toBe(false);
    expect(seal(STATE, KEY).equals(sealed)).toBe(false);
  });

  it('opens with no other key, for no other run and no other repository', () => {
    const sealed = seal(STATE, KEY);
    expect(() => open(sealed, readKey(newKey()), REPOSITORY, STATE.run)).toThrow(StateError);
    expect(() => open(sealed, KEY, REPOSITORY, '19234567891')).toThrow(StateError);
    expect(() => open(sealed, KEY, 'the-roganator/cv-worlds-worst-website', STATE.run)).toThrow(StateError);
  });

  it('refuses a file changed by a byte, cut short, too large, or that is no state', () => {
    const sealed = seal(STATE, KEY);
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(() => open(changed, KEY, REPOSITORY, STATE.run)).toThrow(StateError);
    expect(() => open(sealed.subarray(0, 20), KEY, REPOSITORY, STATE.run)).toThrow('not a sealed state');
    expect(() => open(Buffer.from(JSON.stringify(STATE)), KEY, REPOSITORY, STATE.run)).toThrow('not a sealed state');
    expect(() => open(Buffer.alloc(MAX_SEALED_BYTES + 1), KEY, REPOSITORY, STATE.run)).toThrow('too large');
  });

  it('never repeats a key it cannot read', () => {
    expect(() => readKey('not-a-key')).toThrow('SCAN_STATE_KEY is not 32 bytes in base64');
    expect(() => readKey('')).toThrow(StateError);
    // Base64 Node would read and never write: unpadded, or with a character it drops.
    expect(() => readKey('A'.repeat(43))).toThrow(StateError);
    expect(() => readKey(`${newKey().slice(0, 20)} ${newKey().slice(20)}`)).toThrow(StateError);
    expect(readKey(`${newKey()}\n`)).toHaveLength(32);
  });
});

describe('a state’s shape', () => {
  it.each<[string, (state: Record<string, unknown>) => void, string]>([
    ['another version', (s) => Object.assign(s, { version: 2 }), 'is version 2, not 1'],
    ['no findings', (s) => Object.assign(s, { findings: 'none' }), 'lists no findings'],
    ['a finding with no package', (s) => Object.assign(finding(s), { package: '' }), 'gives finding 1 no package'],
    [
      'a control character in a path',
      (s) => Object.assign(finding(s), { file: 'pnpm-lock.yaml\n' }),
      'gives finding 1 no file',
    ],
    ['a finding with no type', (s) => Object.assign(finding(s), { type: undefined }), 'gives finding 1 no type'],
    [
      'a severity that is none',
      (s) => Object.assign(finding(s), { severity: 'SEVERE' }),
      'gives finding 1 no severity',
    ],
    ['a day that is no day', (s) => Object.assign(finding(s), { seen: 'yesterday' }), 'no day it was first seen'],
    [
      'a fix the grammar does not read',
      (s) => Object.assign(finding(s), { fix: { target: 'version 1.0.1; rm -rf', day: '2026-11-03T00:00:00Z' } }),
      'a fix the grammar does not read',
    ],
    ['a move with no fix', (s) => Object.assign(finding(s), { fix: undefined }), 'a move that is not one'],
    ['a move that is no place', (s) => Object.assign(finding(s), { move: 0 }), 'a move that is not one'],
    [
      'a place among those waiting that is none',
      (s) => Object.assign(finding(s), { move: undefined, fix: undefined, waiting: 0 }),
      'a place among those waiting that is not one',
    ],
    [
      'a finding in a move and waiting too',
      (s) => Object.assign(finding(s), { waiting: 1 }),
      'a place among those waiting that is not one',
    ],
    [
      'an item’s key that is not text',
      (s) => Object.assign(finding(s), { item: 7 }),
      'gives finding 1 a value for item that is not text',
    ],
    [
      'a control character in a label',
      (s) => Object.assign(finding(s), { label: 'pnpm-lock.yaml\n' }),
      'gives finding 1 a value for label that is not text',
    ],
    [
      'a title that is not text',
      (s) => Object.assign(finding(s), { title: ['a', 'list'] }),
      'gives finding 1 a value for title that is not text',
    ],
    [
      'a publisher’s rating that is none',
      (s) => Object.assign(finding(s), { publisher: 'SEVERE' }),
      "gives finding 1 a publisher's rating that is not one",
    ],
    ['a score that is no number', (s) => Object.assign(finding(s), { score: '7.5' }), 'a score that is not one'],
  ])('refuses %s, naming the finding by its place alone', (_name, change, message) => {
    expect(() => open(sealedWith(change), KEY, REPOSITORY, STATE.run)).toThrow(message);
  });
});

describe('a state the scan wrote', () => {
  it('opens with a finding Trivy gave no installed version, as the scan writes it', () => {
    const sealed = sealedWith((s) => Object.assign(finding(s), { installed: '' }));
    expect(open(sealed, KEY, REPOSITORY, STATE.run).findings[0]?.installed).toBe('');
  });

  it('opens with what carries a finding, whatever an advisory’s own words hold, and without it, as one written before', () => {
    const carries = {
      item: 'lockfile pnpm-lock.yaml',
      listed: 'pnpm-lock.yaml',
      label: 'pnpm-lock.yaml',
      publisher: 'CRITICAL',
      score: 9.8,
      path: 'opt/pnpm/dist/node_modules/example-a',
      title: 'example-a: a title\twith a tab, and “quotes”',
      url: 'https://example.test/CVE-2099-20001',
    };
    const sealed = sealedWith((s) => Object.assign(finding(s), carries));
    expect(open(sealed, KEY, REPOSITORY, STATE.run).findings[0]).toEqual({ ...STATE.findings[0], ...carries });
    expect(open(seal(STATE, KEY), KEY, REPOSITORY, STATE.run).findings[0]).not.toHaveProperty('item');
  });
});

describe('the day’s routine listing, in a state', () => {
  const ROUTINE = [
    {
      move: 2,
      name: 'example-b',
      from: '1.2.0',
      to: 'version 1.4.0',
      pins: [{ file: 'pnpm-lock.yaml', line: 140 }],
      seen: '2026-11-06T04:30:00Z',
    },
    // A release still inside its wait: seen, and no move yet.
    {
      name: 'node',
      from: '24.22.1-trixie-slim',
      to: `image 24.23.0-trixie-slim@sha256:${'b'.repeat(64)}`,
      pins: [{ file: '.devcontainer/Dockerfile', line: 2 }],
      seen: '2026-11-10T04:30:00Z',
    },
  ];
  const routine = (state: Record<string, unknown>) => (state.routine as Record<string, unknown>[])[0] ?? {};
  const withRoutine = (change: (state: Record<string, unknown>) => void = () => {}) =>
    sealedWith((state) => {
      state.routine = structuredClone(ROUTINE);
      change(state);
    });

  it('opens with a move’s major, and the digests an image’s pins held', () => {
    const sealed = withRoutine((s) => {
      const records = s.routine as Record<string, unknown>[];
      Object.assign(records[0] ?? {}, { major: true });
      Object.assign(records[1] ?? {}, { held: [`sha256:${'a'.repeat(64)}`] });
    });
    expect(open(sealed, KEY, REPOSITORY, STATE.run).routine).toEqual([
      { ...ROUTINE[0], major: true },
      { ...ROUTINE[1], held: [`sha256:${'a'.repeat(64)}`] },
    ]);
  });

  it('opens with it and without it', () => {
    expect(open(withRoutine(), KEY, REPOSITORY, STATE.run).routine).toEqual(ROUTINE);
    expect('routine' in open(seal(STATE, KEY), KEY, REPOSITORY, STATE.run)).toBe(false);
    expect(
      open(
        withRoutine((s) => Object.assign(s, { routine: [] })),
        KEY,
        REPOSITORY,
        STATE.run,
      ).routine,
    ).toEqual([]);
  });

  it.each<[string, (state: Record<string, unknown>) => void, string]>([
    ['a listing that is no list', (s) => Object.assign(s, { routine: {} }), 'lists routine moves that are not a list'],
    ['a place that is none', (s) => Object.assign(routine(s), { move: 0 }), 'gives routine move 1 a place'],
    ['no name', (s) => Object.assign(routine(s), { name: '' }), 'gives routine move 1 no name'],
    ['no `from`', (s) => Object.assign(routine(s), { from: undefined }), 'gives routine move 1 no from'],
    [
      'a target the grammar does not read',
      (s) => Object.assign(routine(s), { to: 'version 1.4.0; rm -rf' }),
      'gives routine move 1 a target the grammar does not read',
    ],
    ['no pins', (s) => Object.assign(routine(s), { pins: [] }), 'gives routine move 1 no pins'],
    [
      'a pin with no line',
      (s) => Object.assign(routine(s), { pins: [{ file: 'pnpm-lock.yaml' }] }),
      'gives routine move 1 a pin that is not one',
    ],
    ['no day', (s) => Object.assign(routine(s), { seen: '2026-11-06' }), 'gives routine move 1 no day'],
    [
      'a digest held that is none',
      (s) => Object.assign(routine(s), { held: ['sha256:abc'] }),
      'gives routine move 1 digests that are not ones',
    ],
    ['a major that is no answer', (s) => Object.assign(routine(s), { major: 'yes' }), 'a major that is not one'],
  ])('refuses %s, naming the move by its place alone', (_name, change, message) => {
    expect(() => open(withRoutine(change), KEY, REPOSITORY, STATE.run)).toThrow(message);
  });
});

describe('the day the scan first saw content, in a state', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-11-10T04:30:00Z');
  const day = (days: number) => new Date(NOW + days * DAY).toISOString().replace('.000Z', 'Z');
  const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
  const tagged = (letter: string, tag = '24.23.0-trixie-slim'): Target => ({
    kind: 'image',
    tag,
    digest: digest(letter),
  });
  const text = (letter: string, tag?: string) => `image ${tag ?? '24.23.0-trixie-slim'}@${digest(letter)}`;
  const FROM = '24.22.1-trixie-slim';
  const keyOf = (each: { advisory: string }) => each.advisory;
  /** The state with the second finding's fixes that wait, and a routine record's digests. */
  const kept = (waits: StateWait[] | undefined, routine: State['routine'] = undefined): State => ({
    ...STATE,
    findings: [STATE.findings[0] as State['findings'][0], { ...(STATE.findings[1] as State['findings'][0]), waits }],
    ...(routine ? { routine } : {}),
  });
  /** One run over the image's finding: what the sources found, and what the content's day makes of it. */
  const judged = (
    target: Target | undefined,
    own: number | undefined,
    state: State | undefined,
    now: number,
    days = 1,
  ) => {
    const found = { at: [own], fixes: [target], places: [{ from: FROM }] };
    const waits = contentWaits(found, ['CVE-2099-20002'], state && { state, keyOf }, days, now);
    return { at: found.at[0], fix: found.fixes[0], waits: waits[0] };
  };

  it('round-trips sealed, a finding’s fixes that wait and the digests a waiting tag served', () => {
    const waits = [{ from: FROM, target: text('b'), seen: day(0), day: day(1) }];
    const routine = [
      {
        name: 'node',
        from: FROM,
        to: text('b'),
        pins: [{ file: '.devcontainer/Dockerfile', line: 2 }],
        seen: day(-2),
        content: [
          { target: text('b'), seen: day(-2) },
          { target: text('c'), seen: day(0) },
        ],
      },
    ];
    const state = kept(waits, routine);
    const opened = open(seal(state, KEY), KEY, REPOSITORY, STATE.run);
    expect(opened).toEqual(state);
    // Nothing of them shows in the sealed bytes.
    expect(seal(state, KEY).toString('latin1')).not.toContain('24.23.0');
    // A state written before them opens, and has seen nothing.
    expect(sightings(open(seal(STATE, KEY), KEY, REPOSITORY, STATE.run))).toEqual(new Map());
  });

  it.each<[string, (state: Record<string, unknown>) => void, string]>([
    [
      'a fix that waits with a target the grammar does not read',
      (s) =>
        Object.assign((s.findings as Record<string, unknown>[])[1] ?? {}, {
          waits: [{ from: FROM, target: 'image x', seen: day(0), day: day(1) }],
        }),
      'gives finding 2 waiting fixes that are not ones',
    ],
    [
      'a fix that waits with no day',
      (s) =>
        Object.assign((s.findings as Record<string, unknown>[])[1] ?? {}, {
          waits: [{ from: FROM, target: text('b'), seen: day(0) }],
        }),
      'gives finding 2 waiting fixes that are not ones',
    ],
    [
      'a fix that waits with no pin',
      (s) =>
        Object.assign((s.findings as Record<string, unknown>[])[1] ?? {}, {
          waits: [{ target: text('b'), seen: day(0), day: day(1) }],
        }),
      'gives finding 2 waiting fixes that are not ones',
    ],
    [
      'a digest seen on no day',
      (s) =>
        Object.assign(s, {
          routine: [
            {
              name: 'node',
              from: FROM,
              to: text('b'),
              pins: [{ file: 'Dockerfile', line: 1 }],
              seen: day(0),
              content: [{ target: text('b'), seen: 'today' }],
            },
          ],
        }),
      'gives routine move 1 digests seen that are not ones',
    ],
  ])('refuses %s', (_name, change, message) => {
    expect(() => open(sealedWith(change), KEY, REPOSITORY, STATE.run)).toThrow(message);
  });

  it('is the earliest any record has: a routine record’s digests, a chart’s version, a fix that waits', () => {
    const state = kept(
      [{ from: FROM, target: text('b'), seen: day(-1), day: day(0) }],
      [
        {
          name: 'node',
          from: FROM,
          to: text('b'),
          pins: [{ file: 'Dockerfile', line: 1 }],
          seen: day(-9),
          content: [
            { target: text('b', 'another-tag'), seen: day(-3) },
            { target: text('c'), seen: day(-2) },
          ],
        },
        // A record written before the digests were kept says when the tag was seen, not what it served.
        {
          name: 'redis',
          from: '8.0.1',
          to: `image 8.0.2@${digest('e')}`,
          pins: [{ file: 'x.yaml', line: 1 }],
          seen: day(-9),
        },
        {
          name: 'example',
          from: '13.2.7',
          to: 'chart example 13.7.0',
          pins: [{ file: 'y.yaml', line: 1 }],
          seen: day(-4),
        },
        {
          name: 'example-b',
          from: '1.2.0',
          to: 'version 1.4.0',
          pins: [{ file: 'pnpm-lock.yaml', line: 1 }],
          seen: day(-5),
        },
      ],
    );
    expect(sightings(state)).toEqual(
      new Map([
        [digest('b'), NOW - 3 * DAY],
        [digest('c'), NOW - 2 * DAY],
        ['chart example 13.7.0', NOW - 4 * DAY],
      ]),
    );
  });

  it('lists a fix’s image first seen today tomorrow, and counts its deadline from then', () => {
    const created = NOW - 20 * DAY;
    // No state to read: the wait starts today, whatever day the image says it was made.
    const first = judged(tagged('b'), created, undefined, NOW);
    expect(first).toEqual({
      at: NOW + DAY,
      fix: tagged('b'),
      waits: [{ from: FROM, target: text('b'), seen: day(0), day: day(1) }],
    });
    // An hour short of its day it waits still; a day on it is installable, from the day it had waited.
    expect(judged(tagged('b'), created, kept(first.waits), NOW + DAY - 3_600_000).at).toBe(NOW + DAY);
    const next = judged(tagged('b'), created, kept(first.waits), NOW + DAY);
    expect(next).toEqual({ at: NOW + DAY, fix: tagged('b'), waits: first.waits });
    expect(judged(tagged('b'), created, kept(next.waits), NOW + 9 * DAY).at).toBe(NOW + DAY);
    // Another wait the fix has (the Node it brings, which mise may not install yet) still counts.
    expect(judged(tagged('b'), NOW + 3 * DAY, kept(first.waits), NOW + DAY).at).toBe(NOW + 3 * DAY);
  });

  it('lists a tag pushed again at the newest digest that has waited, so one rebuilt every day comes due', () => {
    const day0 = judged(tagged('b'), NOW, undefined, NOW);
    const day1 = judged(tagged('c'), NOW + DAY, kept(day0.waits), NOW + DAY);
    // Today's is minutes old: the fix is yesterday's digest, which this finding's own record says fixes it.
    expect(day1.fix).toEqual(tagged('b'));
    expect(day1.at).toBe(NOW + DAY);
    expect(day1.waits?.map((each) => each.target)).toEqual([text('b'), text('c')]);
    const day2 = judged(tagged('e'), NOW + 2 * DAY, kept(day1.waits), NOW + 2 * DAY);
    expect(day2.fix).toEqual(tagged('c'));
    expect(day2.waits?.map((each) => each.target)).toEqual([text('c'), text('e')]);
    // The tag left alone, what it serves lists once it has waited, and it alone is kept.
    const day3 = judged(tagged('e'), NOW + 2 * DAY, kept(day2.waits), NOW + 3 * DAY);
    expect(day3.fix).toEqual(tagged('e'));
    expect(day3.waits).toEqual([{ from: FROM, target: text('e'), seen: day(2), day: day(3) }]);
  });

  it('takes a digest’s day from a routine record of it, and no fix from a record of another pin or finding', () => {
    const routine = [
      {
        name: 'node',
        from: FROM,
        to: text('b'),
        pins: [{ file: 'Dockerfile', line: 1 }],
        seen: day(-2),
        content: [{ target: text('b'), seen: day(-2) }],
      },
    ];
    // The routine update has known the digest two days: the fix found today lists today, from the day it had waited.
    expect(judged(tagged('b'), NOW - 5 * DAY, kept(undefined, routine), NOW)).toMatchObject({
      at: NOW - DAY,
      fix: tagged('b'),
    });
    // A record of the pin before it moved, or of another finding's place, stands in for nothing.
    const moved = kept([{ from: '24.21.0-trixie-slim', target: text('b'), seen: day(-3), day: day(-2) }]);
    expect(judged(tagged('c'), NOW, moved, NOW)).toMatchObject({ at: NOW + DAY, fix: tagged('c') });
    const found = { at: [NOW], fixes: [tagged('c')], places: [{ from: FROM }] };
    const other = kept([{ from: FROM, target: text('b'), seen: day(-3), day: day(-2) }]);
    contentWaits(found, ['CVE-2099-29999'], { state: other, keyOf }, 1, NOW);
    expect(found).toMatchObject({ at: [NOW + DAY], fixes: [tagged('c')] });
  });

  it('waits a chart’s fix from the first day its version was seen, and leaves every other kind of fix as it is', () => {
    const chart: Target = { kind: 'chart', chart: 'example', version: '13.7.0', major: false };
    const first = judged(chart, NOW - 30 * DAY, undefined, NOW);
    expect(first.at).toBe(NOW + DAY);
    expect(judged(chart, NOW - 30 * DAY, kept(first.waits), NOW + DAY).at).toBe(NOW + DAY);
    for (const target of [
      { kind: 'version', versions: ['1.0.1'] },
      { kind: 'k3s', release: 'v1.37.2+k3s1' },
      { kind: 'tool', tool: 'pnpm', version: '12.17.0' },
      { kind: 'unbuilt', built: NOW - 200 * DAY },
    ] satisfies Target[])
      expect(judged(target, NOW - 5 * DAY, undefined, NOW)).toEqual({
        at: NOW - 5 * DAY,
        fix: target,
        waits: undefined,
      });
    // No fix, and a policy of no days: nothing waits, and nothing is kept.
    expect(judged(undefined, undefined, undefined, NOW)).toEqual({ at: undefined, fix: undefined, waits: undefined });
    expect(judged(tagged('b'), NOW - 5 * DAY, undefined, NOW, 0)).toEqual({
      at: NOW - 5 * DAY,
      fix: tagged('b'),
      waits: undefined,
    });
  });

  it('keeps few: content pushed faster than it waits takes no newer sighting up until one comes due', () => {
    const seen = (letter: string, hours: number) => ({ target: text(letter), seen: day(hours / 24) });
    const ready = (each: { seen: string }) => Date.parse(each.seen) + DAY <= NOW + DAY;
    const waiting = ['1', '2', '3', '4'].map((letter, i) => seen(letter, i + 1));
    expect(WAITING).toBe(4);
    // Four wait: a fifth is not taken up, and nothing is due.
    expect(settle(waiting, seen('5', 6), ready)).toEqual({ due: undefined, kept: waiting });
    // The oldest has waited: it is due, kept with those that wait, and today's has the room it left.
    const first = [seen('0', 0), ...waiting.slice(0, 3)];
    expect(settle(first, seen('5', 6), ready)).toEqual({ due: first[0], kept: [...first, seen('5', 6)] });
    // Two have waited: the newer is due, and the older is dropped. Today's, once it has waited, is all that is kept.
    const two = [seen('0', -2), seen('9', 0), seen('1', 1)];
    expect(settle(two, seen('5', 6), ready)).toEqual({ due: two[1], kept: [two[1], two[2], seen('5', 6)] });
    expect(settle(two, seen('5', -1), ready)).toEqual({ due: seen('5', -1), kept: [seen('5', -1)] });
  });
});

describe('the last state kept', () => {
  const runsOf = (event: string) =>
    `/repos/${REPOSITORY}/actions/workflows/vulnerabilities.yml/runs?branch=main&event=${event}&status=completed&per_page=100`;
  const EVENTS = ['schedule', 'push', 'workflow_dispatch'];
  const run = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    event: 'schedule',
    head_branch: 'main',
    head_repository: { full_name: REPOSITORY },
    ...over,
  });
  const archive = zipOf({ 'state.sealed': seal(STATE, KEY) });

  /** GitHub as the runs and their artifacts are: each run's artifacts by its id, and what was asked. */
  function github(runs: unknown[], artifacts: Record<number, unknown[]>, downloads: Record<number, Buffer> = {}) {
    const asked: string[] = [];
    const api: StateApi = {
      async json(path) {
        asked.push(path);
        // GitHub answers each event's runs alone: a pull request's are in none of the three asked for.
        const event = EVENTS.find((each) => path === runsOf(each));
        if (event) return { workflow_runs: (runs as { event?: string }[]).filter((run) => run.event === event) };
        const id = Number(/\/actions\/runs\/(\d+)\/artifacts\?name=state&per_page=10$/.exec(path)?.[1]);
        if (id) return { artifacts: artifacts[id] ?? [] };
        throw new Error(`GET ${path}: 404`);
      },
      async bytes(path) {
        asked.push(path);
        return downloads[Number(/\/actions\/artifacts\/(\d+)\/zip$/.exec(path)?.[1])];
      },
    };
    return { api, asked };
  }

  it('is the newest run’s before this one, on the default branch, by schedule, push or hand', async () => {
    const { api, asked } = github(
      [run(50), run(40, { event: 'pull_request' }), run(30, { event: 'push' }), run(20)],
      { 30: [{ id: 7, name: 'state', expired: false, size_in_bytes: archive.length }] },
      { 7: archive },
    );
    const kept = await latest(api, REPOSITORY, 'main', '50');
    expect(kept?.run).toBe('30');
    expect(asked).toEqual([
      ...EVENTS.map(runsOf),
      `/repos/${REPOSITORY}/actions/runs/30/artifacts?name=state&per_page=10`,
      `/repos/${REPOSITORY}/actions/artifacts/7/zip`,
    ]);
  });

  it('passes over a fork’s run, another branch’s, a run that kept none, and a state that has expired', async () => {
    const { api } = github(
      [
        run(90, { head_repository: { full_name: 'someone/cv-software-factory' } }),
        run(80, { head_branch: 'feat/other' }),
        run(70),
        run(60),
        run(50),
      ],
      {
        70: [{ id: 3, name: 'moves' }],
        60: [{ id: 4, name: 'state', expired: true }],
        50: [{ id: 5, name: 'state', expired: false }],
      },
      { 5: archive },
    );
    expect((await latest(api, REPOSITORY, 'main'))?.run).toBe('50');
  });

  it('is none when no run kept one, or the one kept is gone', async () => {
    expect(await latest(github([run(50)], {}).api, REPOSITORY, 'main')).toBeUndefined();
    const gone = github([run(50)], { 50: [{ id: 5, name: 'state', expired: false }] });
    expect(await latest(gone.api, REPOSITORY, 'main')).toBeUndefined();
  });

  it('fails on an answer of GitHub’s that is not the list it asked for, and never reads one as no state', async () => {
    const answers = (runs: unknown, artifacts: unknown): StateApi => ({
      json: async (path) => (path.includes('/workflows/') ? runs : artifacts),
      bytes: async () => undefined,
    });
    await expect(latest(answers({ message: 'Not Found' }, {}), REPOSITORY, 'main')).rejects.toThrow(
      "GitHub answered the scan's runs with something other than a list",
    );
    await expect(latest(answers(null, {}), REPOSITORY, 'main')).rejects.toThrow('something other than a list');
    await expect(
      latest(answers({ workflow_runs: [run(50)] }, { artifacts: 'none' }), REPOSITORY, 'main'),
    ).rejects.toThrow("GitHub answered the scan's artifacts with something other than a list");
    // A run GitHub gives no id is passed over, as one that is not the scan's is.
    expect(
      await latest(answers({ workflow_runs: [null, { event: 'schedule' }] }, { artifacts: [] }), REPOSITORY, 'main'),
    ).toBeUndefined();
  });

  it('opens the one file of the archive for the run it was on, and refuses any other archive', () => {
    expect(openKept({ run: STATE.run, archive }, KEY, REPOSITORY)).toEqual(STATE);
    expect(() => openKept({ run: '30', archive }, KEY, REPOSITORY)).toThrow(StateError);
    expect(() => openKept({ run: STATE.run, archive: zipOf({ 'moves.json': '{}' }) }, KEY, REPOSITORY)).toThrow(
      'holds no state.sealed',
    );
    expect(() => openKept({ run: STATE.run, archive: Buffer.from('not a zip') }, KEY, REPOSITORY)).toThrow(
      'not a readable archive',
    );
  });
});
