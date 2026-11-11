import { MOVE_LANES } from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { MOST_PINS, PAYLOADS } from '@software-factory/events/schemas';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { DependencyPull } from '../../src/github/dependabot.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { GitHubWorkerError } from '../../src/github/worker-client.ts';
import { dayOf, sameDay } from '../../src/patching/day.ts';
import { runningContainers } from '../../src/patching/running.ts';
import { PatchingSense, type Senses } from '../../src/patching/sense.ts';
import type { Kube } from '../../src/runners/kube.ts';
import { LANES } from '../../src/vulnerabilities/moves.ts';
import { APP, agreeing, appMoves, digest, FACTORY, factoryMoves, PULL, pod } from './fixtures.ts';

let database: Database;
const logged: { level: number; msg: string; failed?: string[] }[] = [];
const log = pino({ level: 'info' }, { write: (line: string) => void logged.push(JSON.parse(line)) });

beforeEach(async () => {
  database = await freshDatabase('patching');
  logged.length = 0;
});
afterEach(() => database?.end());

const kube = (pods: unknown[]): Kube => ({
  get: async (_, schema) => schema.parse({ items: pods }),
  text: async () => undefined,
  create: async () => {},
  remove: async () => {},
});

/** The worker and the cluster as the recorded answers have them, with whatever a test changes. */
function senses(change: Partial<Senses> = {}, pods: unknown[] = agreeing()): Senses {
  return {
    moves: async (repo) => (repo === FACTORY ? factoryMoves() : appMoves()),
    dependencyPulls: async () => [],
    running: () => runningContainers(kube(pods)),
    ...change,
  };
}

const sense = (s: Senses, sql = database.patching) =>
  new PatchingSense({
    sql,
    events: new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
    senses: s,
    repositories: [FACTORY, APP],
    log,
    now: () => new Date('2026-11-11T05:30:00Z'),
  });

const days = () =>
  database.owner<{ payload: unknown; public: { payload: unknown }; appended_by: string; summary: string }[]>`
    select payload, public, appended_by, summary from events where type = 'patching.read' order by seq`;

describe('the dependency sense', () => {
  it('appends the day for both repositories as one event, in its shape, as its own role', async () => {
    expect((await sense(senses()).pass()).pass).toBe('appended');
    const [day, ...more] = await days();
    expect(more).toEqual([]);
    expect(day?.appended_by).toBe('factory_patching');
    expect(day?.summary).toBe(
      "The day's moves: 2 in cv-software-factory, 0 in cv-worlds-worst-website; the cluster runs what the list says",
    );
    const payload = PAYLOADS['patching.read'].parse(day?.payload);
    expect(payload.repositories.map((r) => [r.repository, r.moves.length, r.scanned, r.failed])).toEqual([
      [FACTORY, 2, 4, []],
      [APP, 0, 1, []],
    ]);
    expect(payload.compared).toBe(true);
    expect(payload.containers).toBe(5);
    expect(payload.rows).toEqual([]);
    expect(payload.repositories[0]?.moves[0]).toEqual({
      name: 'quay.io/example/k8s-sidecar',
      pins: [{ file: 'deploy/base/telemetry/values/grafana.yaml', line: 12 }],
      from: '2.0.0',
      to: `image 2.0.1@${digest(11)}`,
      major: false,
      clears: { critical: 0, high: 1, medium: 1, low: 0, unknown: 0 },
      leaves: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      deadline: '2026-11-18T04:57:00Z',
      newToday: 0,
      lane: 'worker',
      lockfile: false,
    });
  });

  it('keeps a lockfile move’s package out of the public view until a pull request moving it is open', async () => {
    await sense(senses()).pass();
    await sense(senses({ dependencyPulls: async (repo) => (repo === FACTORY ? [PULL] : []) })).pass();
    const [before, after] = await days();
    const moveOf = (payload: unknown) =>
      PAYLOADS['patching.read'].parse(payload).repositories[0]?.moves.find((m) => m.lockfile);
    expect(moveOf(before?.payload)?.package?.name).toBe('example-parser');
    expect(moveOf(before?.public.payload)).not.toHaveProperty('package');
    expect(moveOf(before?.public.payload)?.name).toBe('a package in `pnpm-lock.yaml`');
    expect(moveOf(after?.payload)?.pullRequest).toEqual({ number: 77, version: '1.0.1' });
    expect(moveOf(after?.public.payload)?.package).toEqual({
      name: 'example-parser',
      from: '1.0.0',
      to: '1.0.1',
      pins: [{ file: 'pnpm-lock.yaml', line: 120 }],
    });
    // The view of a view is the view.
    const view = { summary: 's', payload: PAYLOADS['patching.read'].parse(before?.payload), artifacts: [] };
    expect(publicView('patching.read', publicView('patching.read', view))).toEqual(publicView('patching.read', view));
  });

  it('appends nothing when nothing changed, a pod made again and a scale included', async () => {
    expect((await sense(senses()).pass()).pass).toBe('appended');
    const remade = [
      ...agreeing().map((p) =>
        p.metadata.name === 'line-7d9f-abcde' ? { ...p, metadata: { ...p.metadata, name: 'line-7d9f-zzzzz' } } : p,
      ),
    ];
    expect((await sense(senses({}, remade)).pass()).pass).toBe('unchanged');
    expect((await sense(senses({}, [...agreeing(), agreeing()[0]])).pass()).pass).toBe('unchanged');
    expect(await days()).toHaveLength(1);
  });

  it('appends a new day when a row comes, and another when it goes', async () => {
    const stray = pod('default', 'try', [
      { name: 'c', image: 'nginx:1.29', imageID: `docker.io/library/nginx@${digest(13)}` },
    ]);
    await sense(senses()).pass();
    await sense(senses({}, [...agreeing(), stray])).pass();
    await sense(senses({}, [...agreeing(), stray])).pass();
    await sense(senses()).pass();
    const rows = (await days()).map((d) => PAYLOADS['patching.read'].parse(d.payload).rows.map((r) => r.row));
    expect(rows).toEqual([[], ['unlisted-image'], []]);
  });

  it('appends nothing from a read that fails, and says which failed', async () => {
    const refused = new GitHubWorkerError(
      403,
      'refused',
      "The factory's App cannot read the scan's moves: it lacks `security_events: read`.",
    );
    for (const change of [
      { moves: async () => Promise.reject(refused) },
      { dependencyPulls: async () => Promise.reject(new Error('GitHub failed')) },
      { running: async () => Promise.reject(new Error('GET /api/v1/pods answered 403: forbidden')) },
    ] satisfies Partial<Senses>[]) {
      const result = await sense(senses(change)).pass();
      expect(result.pass).toBe('failed');
    }
    expect(await days()).toEqual([]);
    const said = logged.filter((l) => l.level === 50);
    expect(said).toHaveLength(3);
    expect(said[0]?.msg).toBe('patching: 2 of the reads failed, so the day is not appended');
    expect(said[0]?.failed?.[0]).toBe(
      "the moves of the-roganator/cv-software-factory: The factory's App cannot read the scan's moves: it lacks `security_events: read`.",
    );
    expect(said[2]?.failed).toEqual(["the cluster's pods: GET /api/v1/pods answered 403: forbidden"]);
  });

  it('does not compare the cluster with a list a scan did not write, and says the scan failed', async () => {
    const failed = { ...appMoves([]), run: { ...appMoves().run, conclusion: 'failure' }, file: null };
    await sense(senses({ moves: async (repo) => (repo === FACTORY ? factoryMoves() : failed) })).pass();
    const [day] = await days();
    const payload = PAYLOADS['patching.read'].parse(day?.payload);
    expect(payload.compared).toBe(false);
    expect(payload.rows).toEqual([]);
    expect(payload.repositories[1]).toMatchObject({ judged: null, totals: null, failed: ['other'], scanned: 0 });
  });

  it('says why a scan failed, as its moves show it', async () => {
    const moves = factoryMoves();
    const overdue = {
      ...moves,
      run: { ...moves.run, conclusion: 'failure' },
      moves: moves.moves.map((m, i) => (i === 0 ? { ...m, deadline: '2026-11-10T00:00:00Z', newToday: 1 } : m)),
    };
    await sense(senses({ moves: async (repo) => (repo === FACTORY ? overdue : appMoves()) })).pass();
    const payload = PAYLOADS['patching.read'].parse((await days())[0]?.payload);
    expect(payload.repositories[0]?.failed).toEqual(['overdue', 'new-high-or-critical']);
  });

  it('acts on no sample store', async () => {
    await database.operator`insert into store (sample) values (true)`;
    expect((await sense(senses()).pass()).pass).toBe('not-real');
    expect(await days()).toEqual([]);
  });
});

describe("the event's lanes", () => {
  it('are the scan’s, in its order', () => {
    expect([...MOVE_LANES]).toEqual(LANES);
  });
});

describe('the day, made from the reads', () => {
  const read = (moves = factoryMoves(), pulls: DependencyPull[] = []) => [
    { moves, pulls },
    { moves: appMoves(), pulls: [] },
  ];
  const withMove = (change: Partial<ReadMove>) => {
    const moves = factoryMoves();
    return { ...moves, moves: [{ ...(moves.moves[0] as ReadMove), ...change }] };
  };

  it('is the same day when only the order of pods made again changes its rows', () => {
    const row = (namespace: string, pod: string, image: string) =>
      ({ row: 'unlisted-image', namespace, pod, container: 'c', image, digest: digest(13) }) as const;
    const before = dayOf(read(), 2, [row('factory', 'a-1', 'nginx:1'), row('factory', 'b-2', 'redis:7')]);
    const after = dayOf(read(), 2, [row('factory', 'b-2', 'redis:7'), row('factory', 'c-3', 'nginx:1')]);
    expect(sameDay(after, before)).toBe(true);
    expect(sameDay(dayOf(read(), 2, [row('factory', 'c-3', 'nginx:2')]), before)).toBe(false);
  });

  it('holds a move pinned in more places than the day keeps, and a lockfile move with no version to move to', () => {
    const pins = Array.from({ length: MOST_PINS + 5 }, (_, i) => ({ file: `.github/workflows/w${i}.yml`, line: 3 }));
    const many = dayOf(read(withMove({ pins })), 0, []);
    expect(PAYLOADS['patching.read'].parse(many).repositories[0]?.moves[0]?.pins).toHaveLength(MOST_PINS);
    const moves = factoryMoves();
    const lockfile = moves.moves[1] as ReadMove;
    const none = {
      ...moves,
      moves: [{ ...lockfile, withheld: { ...(lockfile.withheld as NonNullable<ReadMove['withheld']>), to: '' } }],
    };
    expect(PAYLOADS['patching.read'].safeParse(dayOf(read(none), 0, [])).success).toBe(true);
  });

  it('names the Dependabot pull request of the same ecosystem, dependency and directory, with a version', () => {
    const pull = (change: Partial<DependencyPull>): DependencyPull => ({ ...PULL, ...change });
    const workflow = withMove({
      name: 'actions/checkout',
      pins: [{ file: '.github/workflows/check.yml', line: 20 }],
    });
    const of = (moves: Moves, pulls: DependencyPull[]) =>
      dayOf(read(moves, pulls), 0, []).repositories[0]?.moves[0]?.pullRequest;
    const actions = pull({
      number: 81,
      ecosystem: 'github-actions',
      directory: '/',
      dependency: 'actions/checkout',
      version: '5',
    });
    expect(of(workflow, [actions])).toEqual({ number: 81, version: '5' });
    const image = withMove({ name: 'node', pins: [{ file: 'apps/x/Dockerfile', line: 1 }] });
    const npmNode = pull({ number: 82, ecosystem: 'npm', directory: '/apps/x', dependency: 'node', version: '24.1.0' });
    const dockerNode = pull({
      number: 83,
      ecosystem: 'docker',
      directory: '/apps/x',
      dependency: 'node',
      version: '24.2.0',
    });
    const unversioned = pull({
      number: 84,
      ecosystem: 'docker',
      directory: '/apps/x',
      dependency: 'node',
      version: null,
    });
    expect(of(image, [npmNode, unversioned, dockerNode])).toEqual({ number: 83, version: '24.2.0' });
    expect(of(image, [npmNode])).toBeUndefined();
  });
});
