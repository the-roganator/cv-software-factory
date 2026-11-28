import { createServer } from 'node:http';
import { type InboxSignal, MOVE_LANES } from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { MOST_MOVES, MOST_PINS, MOST_PULLS, MOST_ROWS, PAYLOADS } from '@software-factory/events/schemas';
import { connect, DiskArtifacts, EventWriter } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { GitHubWorker, GitHubWorkerError } from '../../src/github/worker-client.ts';
import { inbox } from '../../src/outbox.ts';
import { dayOf, type PatchPull, sameDay } from '../../src/patching/day.ts';
import { runningContainers } from '../../src/patching/running.ts';
import { waitAfter } from '../../src/patching/schedule.ts';
import {
  exitCode,
  MOST_REFUSED,
  nextAfter,
  type Pass,
  PatchingSense,
  refused,
  type Senses,
} from '../../src/patching/sense.ts';
import type { Kube } from '../../src/runners/kube.ts';
import { LANES } from '../../src/vulnerabilities/moves.ts';
import {
  APP,
  APP_COUNTS,
  agreeing,
  appMoves,
  appPulls,
  digest,
  FACTORY,
  FACTORY_COUNTS,
  factoryMoves,
  factoryPulls,
  pod,
} from './fixtures.ts';

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
    pulls: async (repo) => (repo === FACTORY ? factoryPulls() : appPulls()),
    running: () => runningContainers(kube(pods)),
    ...change,
  };
}

const READ = '2026-11-11T05:30:00.000Z';

const sense = (s: Senses, sql = database.patching, at = READ) =>
  new PatchingSense({
    sql,
    events: new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
    senses: s,
    repositories: [FACTORY, APP],
    log,
    now: () => new Date(at),
  });

/** `hours` after the day's first read. */
const later = (hours: number) => new Date(Date.parse(READ) + hours * 3_600_000).toISOString();

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
    // The scan's own counts, copied as the read gives them.
    expect(payload.repositories.map((r) => r.totals)).toEqual([
      { ...factoryMoves().file?.totals, ...FACTORY_COUNTS },
      { ...appMoves().file?.totals, ...APP_COUNTS },
    ]);
    expect(payload.repositories[0]?.totals).toMatchObject({ noFix: 412, dueWithinDay: 2, newHighWithoutFix: 5 });
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

  it('carries each repository’s waiting pins and the pull requests and issues of its moves, and when it read', async () => {
    expect((await sense(senses()).pass()).pass).toBe('appended');
    const [day] = await days();
    const payload = PAYLOADS['patching.read'].parse(day?.payload);
    expect(payload.read).toBe(READ);
    const [factory, app] = payload.repositories;
    expect(factory?.waiting).toEqual([
      {
        name: 'docker.io/example/cache',
        pins: [{ file: 'deploy/base/cache/statefulset.yaml', line: 21 }],
        from: '8.2.1',
        why: 'no-better',
        clears: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 },
        deadline: '2026-11-25T04:57:00Z',
      },
      {
        name: 'docker.io/example/queue',
        pins: [{ file: 'deploy/base/queue/deployment.yaml', line: 9 }],
        from: '7.4.0',
        why: 'content',
        to: `image 7.4.1@${digest(12)}`,
        until: '2026-11-12T04:57:00Z',
        clears: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        routine: true,
      },
    ]);
    expect(factory?.pulls).toEqual(factoryPulls().pulls);
    expect(app).toMatchObject({ waiting: [], pulls: [] });
    // The public view keeps the lockfile's package, and what its issue waits for, out.
    expect(JSON.stringify(day?.public.payload)).not.toContain('example-parser');
    expect(JSON.stringify(day?.public.payload)).not.toContain('1211');
  });

  it('appends nothing when only the time it read changes, and the day again once the last is 12 hours old', async () => {
    expect((await sense(senses()).pass()).pass).toBe('appended');
    expect((await sense(senses(), database.patching, later(1)).pass()).pass).toBe('unchanged');
    expect((await sense(senses(), database.patching, later(11.99)).pass()).pass).toBe('unchanged');
    expect((await sense(senses(), database.patching, later(12)).pass()).pass).toBe('appended');
    expect((await sense(senses(), database.patching, later(13)).pass()).pass).toBe('unchanged');
    const reads = (await days()).map((d) => PAYLOADS['patching.read'].parse(d.payload).read);
    expect(reads).toEqual([READ, later(12)]);
  });

  it('appends a new day when a pull request’s state changes, though the scan’s moves do not', async () => {
    await sense(senses()).pass();
    const { repository, pulls } = factoryPulls();
    const passed = pulls.map((p) =>
      p.number === 1224
        ? { ...p, checks: { state: 'passed' as const, try: 1, of: 3, failed: [] }, hold: undefined, queued: true }
        : p,
    );
    const changed = senses({ pulls: async (repo) => (repo === FACTORY ? { repository, pulls: passed } : appPulls()) });
    expect((await sense(changed, database.patching, later(1)).pass()).pass).toBe('appended');
    expect((await sense(changed, database.patching, later(2)).pass()).pass).toBe('unchanged');
    expect(await days()).toHaveLength(2);
  });

  it('appends nothing when the pull requests’ read fails, or answers for another repository', async () => {
    for (const change of [
      { pulls: async () => Promise.reject(new GitHubWorkerError(500, 'failed', 'GitHub answered 502')) },
      { pulls: async (repo: string) => (repo === APP ? factoryPulls() : factoryPulls()) },
    ] satisfies Partial<Senses>[])
      expect(await sense(senses(change)).pass()).toMatchObject({ pass: 'failed' });
    expect(await days()).toEqual([]);
    const said = logged.filter((l) => l.level === 50);
    expect(said[0]?.failed).toEqual([
      `the pull requests of ${FACTORY}: GitHub answered 502`,
      `the pull requests of ${APP}: GitHub answered 502`,
    ]);
    expect(said[1]?.failed).toEqual([`the pull requests of ${APP}: the worker answered for ${FACTORY}`]);
  });

  it("reads again shortly when the worker's door refused only the pull requests' read", async () => {
    const door = Object.assign(new Error('connect ECONNREFUSED 10.43.117.70:8083'), { code: 'ECONNREFUSED' });
    const s = sense(senses({ pulls: async () => Promise.reject(door) }));
    expect(await s.pass()).toEqual({
      pass: 'refused',
      why: [
        `the pull requests of ${FACTORY}: connect ECONNREFUSED 10.43.117.70:8083`,
        `the pull requests of ${APP}: connect ECONNREFUSED 10.43.117.70:8083`,
      ],
    });
    expect(await days()).toEqual([]);
  });

  it('reads again shortly while the worker has not read the pull requests since it started', async () => {
    const unread = Object.assign(new Error('The pin watch has not made a pass yet'), {
      status: 503,
      kind: 'not-read-yet',
    });
    const s = sense(senses({ pulls: async () => Promise.reject(unread) }));
    expect((await s.pass()).pass).toBe('refused');
    expect(await days()).toEqual([]);
    // A worker from before the read was served, still answering while a deploy replaces it.
    const old = Object.assign(new Error('No such read.'), { status: 404, kind: 'not-found' });
    expect((await sense(senses({ pulls: async () => Promise.reject(old) })).pass()).pass).toBe('refused');
  });

  it('keeps a lockfile move’s package out of the public view', async () => {
    await sense(senses()).pass();
    const [before] = await days();
    const moveOf = (payload: unknown) =>
      PAYLOADS['patching.read'].parse(payload).repositories[0]?.moves.find((m) => m.lockfile);
    expect(moveOf(before?.payload)?.package?.name).toBe('example-parser');
    expect(moveOf(before?.public.payload)).not.toHaveProperty('package');
    expect(moveOf(before?.public.payload)?.name).toBe('a package in `pnpm-lock.yaml`');
    // The view of a view is the view.
    const view = { summary: 's', payload: PAYLOADS['patching.read'].parse(before?.payload), artifacts: [] };
    expect(publicView('patching.read', publicView('patching.read', view))).toEqual(publicView('patching.read', view));
  });

  it('appends a new day when only the scan’s counts change', async () => {
    await sense(senses()).pass();
    const moves = factoryMoves();
    const later = { ...moves, file: moves.file && { ...moves.file, totals: { ...moves.file.totals, noFix: 413 } } };
    expect((await sense(senses({ moves: async (repo) => (repo === FACTORY ? later : appMoves()) })).pass()).pass).toBe(
      'appended',
    );
    expect(await days()).toHaveLength(2);
  });

  it('copies every open finding by severity where the scan counted it, and leaves it out where it did not', async () => {
    const moves = factoryMoves();
    const open = { CRITICAL: 2, HIGH: 1363, MEDIUM: 3321, LOW: 2727, UNKNOWN: 0 };
    const counted = { ...moves, file: moves.file && { ...moves.file, totals: { ...moves.file.totals, open } } };
    await sense(senses({ moves: async (repo) => (repo === FACTORY ? counted : appMoves()) })).pass();
    const [day] = await days();
    const payload = PAYLOADS['patching.read'].parse(day?.payload);
    expect(payload.repositories[0]?.totals?.open).toEqual({
      critical: 2,
      high: 1363,
      medium: 3321,
      low: 2727,
      unknown: 0,
    });
    expect(payload.repositories[1]?.totals).not.toHaveProperty('open');
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
      "The factory's App cannot read the scan's moves: it lacks `actions: read`.",
    );
    for (const change of [
      { moves: async () => Promise.reject(refused) },
      { moves: async (repo: string) => (repo === APP ? Promise.reject(new Error('GitHub failed')) : factoryMoves()) },
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
      "the moves of the-roganator/cv-software-factory: The factory's App cannot read the scan's moves: it lacks `actions: read`.",
    );
    expect(said[2]?.failed).toEqual(["the cluster's pods: GET /api/v1/pods answered 403: forbidden"]);
  });

  it("is a failed pass when GitHub's own 409 comes from the moves read", async () => {
    const conflict = new GitHubWorkerError(409, 'conflict', 'GitHub answered 409');
    const result = await sense(senses({ moves: async () => Promise.reject(conflict) })).pass();
    expect(result).toEqual({
      pass: 'failed',
      failed: [`the moves of ${FACTORY}: GitHub answered 409`, `the moves of ${APP}: GitHub answered 409`],
    });
    expect(await days()).toEqual([]);
  });

  it('says when to read next and what --once exits with, for each pass', () => {
    const day = { pass: 'appended', day: { repositories: [] } } as unknown as Pass;
    expect(nextAfter({ pass: 'refused', why: [] })).toEqual({ next: 'shortly' });
    expect(nextAfter({ pass: 'failed', failed: [] })).toEqual({ next: 'hour' });
    expect(nextAfter({ pass: 'not-real' })).toEqual({ next: 'hour' });
    expect(nextAfter(day)).toEqual({ next: 'hour' });
    expect(nextAfter({ pass: 'unchanged', day: day.pass === 'appended' ? day.day : (null as never) })).toEqual({
      next: 'hour',
    });
    expect([
      exitCode(day),
      exitCode({ pass: 'not-real' }),
      exitCode({ pass: 'failed', failed: [] }),
      exitCode({ pass: 'refused', why: [] }),
    ]).toEqual([0, 0, 1, 75]);
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

  it('says why a scan failed from the scan’s own totals, not from its moves', async () => {
    const moves = factoryMoves();
    const totals = moves.file?.totals as NonNullable<Moves['file']>['totals'];
    // An overdue finding with no fix is in no move; a move with a new Low that also clears an old High is no new High.
    const failed = {
      ...moves,
      run: { ...moves.run, conclusion: 'failure' },
      file: {
        ...(moves.file as NonNullable<Moves['file']>),
        totals: { ...totals, overdue: 1, dueWithinDay: 0, newHighWithFix: 0 },
      },
      moves: moves.moves.map((m, i) => (i === 0 ? { ...m, newToday: 1, clears: { ...m.clears, HIGH: 1 } } : m)),
    };
    await sense(senses({ moves: async (repo) => (repo === FACTORY ? failed : appMoves()) })).pass();
    const payload = PAYLOADS['patching.read'].parse((await days())[0]?.payload);
    expect(payload.repositories[0]?.failed).toEqual(['overdue']);
  });

  it('refuses to read more repositories than a day holds', () => {
    expect(
      () =>
        new PatchingSense({
          sql: database.patching,
          events: new EventWriter(database.patching, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
          senses: senses(),
          repositories: [FACTORY, APP, 'the-roganator/a-third'],
          log,
        }),
    ).toThrow('one or two repositories');
  });

  it("reads again shortly when the worker's door refused every read that failed, a few times in a row", async () => {
    const door = Object.assign(new Error('connect ECONNREFUSED 10.43.117.70:8083'), { code: 'ECONNREFUSED' });
    // As `fetch` gives it: its own error, the refusal its cause.
    const fetched = new TypeError('fetch failed', { cause: door });
    const s = sense(senses({ moves: async (repo) => Promise.reject(repo === FACTORY ? door : fetched) }));
    const passes: Pass[] = [];
    for (let i = 0; i < MOST_REFUSED; i++) passes.push(await s.pass());
    expect(passes.map((p) => p.pass)).toEqual([...Array(MOST_REFUSED - 1).fill('refused'), 'failed']);
    expect(passes[0]).toEqual({
      pass: 'refused',
      why: [`the moves of ${FACTORY}: connect ECONNREFUSED 10.43.117.70:8083`, `the moves of ${APP}: fetch failed`],
    });
    expect(await days()).toEqual([]);
    expect(logged.filter((l) => l.level === 50).map((l) => l.msg)).toEqual([
      `patching: 2 of the reads failed, refused by the GitHub worker's door ${MOST_REFUSED} times in a row, so the day is not appended`,
    ]);
  });

  it("is a failed pass when a refusal comes beside another failure, or from the cluster's read", async () => {
    const door = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6443'), { code: 'ECONNREFUSED' });
    for (const change of [
      {
        moves: async (repo: string) => Promise.reject(repo === FACTORY ? door : new Error('GitHub failed')),
      },
      { running: async () => Promise.reject(door) },
    ] satisfies Partial<Senses>[])
      expect((await sense(senses(change)).pass()).pass).toBe('failed');
    expect([refused(new Error('reset')), refused(Object.assign(new Error('x'), { code: 'ECONNRESET' }))]).toEqual([
      false,
      false,
    ]);
  });

  it('reads again shortly when the store refused the connection, and fails once the refusals reach the bound', async () => {
    const reserved = createServer();
    const { port } = await listenLocal(reserved);
    await new Promise((resolve) => reserved.close(resolve));
    const nowhere = connect(`postgres://factory_patching:x@127.0.0.1:${port}/factory`, { max: 1, connect_timeout: 1 });
    try {
      const s = sense(senses(), nowhere);
      const first = await s.pass();
      expect(first.pass).toBe('refused');
      expect((first as { why: string[] }).why[0]).toMatch(/^the store: .*ECONNREFUSED/);
      for (let i = 1; i < MOST_REFUSED - 1; i++) expect((await s.pass()).pass).toBe('refused');
      await expect(s.pass()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await nowhere.end({ timeout: 0 });
    }
  });

  it('starts the count of refused passes anew after any other pass, on the same sense', async () => {
    const door = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    let listening = false;
    const s = sense(
      senses({
        moves: async (repo) => (listening ? (repo === FACTORY ? factoryMoves() : appMoves()) : Promise.reject(door)),
      }),
    );
    for (let i = 0; i < MOST_REFUSED - 1; i++) expect((await s.pass()).pass).toBe('refused');
    listening = true;
    expect((await s.pass()).pass).toBe('appended');
    listening = false;
    for (let i = 0; i < MOST_REFUSED - 1; i++) expect((await s.pass()).pass).toBe('refused');
  });

  it('reads the day from a worker whose door listens after the sense first reads', async () => {
    // The worker as a deploy restarts it: its door refuses until it listens. The refusal is a port the OS gave and took
    // back a moment before, which nothing here listens on again; the door listens on a port the OS gives then.
    const reserved = createServer();
    let { url } = await listenLocal(reserved);
    await new Promise((resolve) => reserved.close(resolve));
    const worker = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { repo } = JSON.parse(body) as { repo: string };
        const result = req.url?.endsWith('/moves')
          ? repo === FACTORY
            ? factoryMoves()
            : appMoves()
          : req.url?.endsWith('/pulls')
            ? repo === FACTORY
              ? factoryPulls()
              : appPulls()
            : [];
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
      });
    });
    const s = sense(
      senses({
        moves: (repo) => new GitHubWorker(url).read('moves', repo, {}),
        pulls: (repo) => new GitHubWorker(url).read('pulls', repo, {}),
      }),
    );
    try {
      // Listening only once the first pass is over, however long it took, so that pass is always refused.
      const first = await s.pass();
      expect(first.pass).toBe('refused');
      // Taken again within the minute, not the hour a failed pass waits.
      expect(waitAfter(nextAfter(first).next)).toBeLessThanOrEqual(60_000);
      ({ url } = await listenLocal(worker));
      expect((await s.pass()).pass).toBe('appended');
      expect(await days()).toHaveLength(1);
    } finally {
      if (worker.listening) await new Promise((resolve) => worker.close(resolve));
    }
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
  const read = (moves = factoryMoves()) => [
    { moves, pulls: factoryPulls().pulls },
    { moves: appMoves(), pulls: appPulls().pulls },
  ];
  const at = new Date(READ);
  const withMove = (change: Partial<ReadMove>) => {
    const moves = factoryMoves();
    return { ...moves, moves: [{ ...(moves.moves[0] as ReadMove), ...change }] };
  };

  it('is the same day when only the order of pods made again changes its rows', () => {
    const row = (namespace: string, pod: string, image: string) =>
      ({ row: 'unlisted-image', namespace, pod, container: 'c', image, digest: digest(13) }) as const;
    const before = dayOf(read(), 2, [row('factory', 'a-1', 'nginx:1'), row('factory', 'b-2', 'redis:7')], at);
    const after = dayOf(read(), 2, [row('factory', 'b-2', 'redis:7'), row('factory', 'c-3', 'nginx:1')], at);
    expect(sameDay(after, before)).toBe(true);
    expect(sameDay(dayOf(read(), 2, [row('factory', 'c-3', 'nginx:2')], at), before)).toBe(false);
  });

  it('holds a move pinned in more places than the day keeps, and a lockfile move with no version to move to', () => {
    const pins = Array.from({ length: MOST_PINS + 5 }, (_, i) => ({ file: `.github/workflows/w${i}.yml`, line: 3 }));
    const many = dayOf(read(withMove({ pins })), 0, [], at);
    expect(PAYLOADS['patching.read'].parse(many).repositories[0]?.moves[0]?.pins).toHaveLength(MOST_PINS);
    const moves = factoryMoves();
    const lockfile = moves.moves[1] as ReadMove;
    const none = {
      ...moves,
      moves: [{ ...lockfile, withheld: { ...(lockfile.withheld as NonNullable<ReadMove['withheld']>), to: '' } }],
    };
    expect(PAYLOADS['patching.read'].safeParse(dayOf(read(none), 0, [], at)).success).toBe(true);
  });

  it('holds a routine update, which clears nothing and has no deadline, and a lockfile’s with its package apart', () => {
    const none = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
    const moves = factoryMoves();
    const [image, lockfile] = moves.moves as [ReadMove, ReadMove];
    const { deadline: _, ...undated } = { ...lockfile, clears: none, leaves: none, findings: [] };
    const routine = {
      ...moves,
      moves: [{ ...image, clears: none, leaves: none, deadline: undefined, newToday: 0, findings: [] }, undated],
    };
    const day = dayOf(read(routine), 0, [], at);
    const parsed = PAYLOADS['patching.read'].parse(day).repositories.find((each) => each.repository === FACTORY);
    expect(parsed?.moves.map((move) => [move.clears, move.deadline])).toEqual([
      [{ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, undefined],
      [{ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, undefined],
    ]);
    expect(parsed?.moves[1]?.package).toEqual({
      name: lockfile.withheld?.package,
      from: lockfile.withheld?.from,
      to: lockfile.withheld?.to,
      pins: lockfile.withheld?.pins,
    });
    // The public view withholds a routine lockfile move's package as it does a finding's.
    const view = publicView('patching.read', {
      summary: 's',
      payload: PAYLOADS['patching.read'].parse(day),
      artifacts: [],
    });
    expect(JSON.stringify(view)).not.toContain(lockfile.withheld?.package);
    // A move that is a fix one day and merely behind the next is another day.
    expect(sameDay(day, dayOf(read(), 0, [], at))).toBe(false);
  });

  it('is the same day whatever copies of a row run: a Deployment scaled appends nothing', () => {
    const row = (pod: string) =>
      ({
        row: 'unlisted-image',
        namespace: 'default',
        pod,
        container: 'c',
        image: 'nginx:1',
        digest: digest(13),
      }) as const;
    const two = dayOf(read(), 2, [row('try-a'), row('try-b')], at);
    const three = dayOf(read(), 3, [row('try-a'), row('try-b'), row('try-c')], at);
    expect(sameDay(three, two)).toBe(true);
  });

  it('never builds a day that fails validation, whatever the reads hold', () => {
    const moves = factoryMoves();
    const lockfile = moves.moves[1] as ReadMove;
    const many = {
      ...moves,
      moves: [
        ...Array.from({ length: MOST_MOVES + 10 }, (_, i) => ({
          ...(moves.moves[0] as ReadMove),
          index: i + 1,
          name: `m${i}`,
        })),
        { ...lockfile, withheld: { ...(lockfile.withheld as NonNullable<ReadMove['withheld']>), from: '', to: '' } },
      ],
    };
    const rows = Array.from({ length: MOST_ROWS + 50 }, (_, i) => ({
      row: 'unlisted-image' as const,
      namespace: 'default',
      pod: `p${i}`,
      container: 'c',
      image: `nginx:1.${i}`,
      digest: digest(13),
    }));
    const day = dayOf(read(many), rows.length, rows, at);
    expect(PAYLOADS['patching.read'].safeParse(day).success).toBe(true);
    expect(day.repositories[0]?.moves).toHaveLength(MOST_MOVES);
    expect(day.rows).toHaveLength(MOST_ROWS);
    const empty = {
      ...moves,
      moves: [{ ...lockfile, withheld: { ...(lockfile.withheld as NonNullable<ReadMove['withheld']>), from: '' } }],
    };
    expect(PAYLOADS['patching.read'].safeParse(dayOf(read(empty), 0, [], at)).success).toBe(true);
  });

  it('holds the open pull requests and those settled in the last 28 days, the open first past its cap', () => {
    const [pin, , merged] = factoryPulls().pulls as [PatchPull, PatchPull, PatchPull];
    const old = { ...merged, number: 900, settled: '2026-10-13T05:29:00Z' };
    const recent = { ...merged, number: 901, settled: '2026-10-14T05:31:00Z' };
    const day = dayOf(
      [
        { moves: factoryMoves(), pulls: [pin, old, recent] },
        { moves: appMoves(), pulls: [] },
      ],
      0,
      [],
      at,
    );
    expect(day.repositories[0]?.pulls.map((p) => p.number)).toEqual([1224, 901]);
    const many = Array.from({ length: MOST_PULLS + 5 }, (_, i) => ({
      ...merged,
      number: 2000 + i,
      settled: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 60_000).toISOString(),
    }));
    const full = dayOf(
      [
        { moves: factoryMoves(), pulls: [...many, pin] },
        { moves: appMoves(), pulls: [] },
      ],
      0,
      [],
      at,
    );
    const kept = full.repositories[0]?.pulls ?? [];
    expect(kept).toHaveLength(MOST_PULLS);
    expect(kept[0]?.number).toBe(1224);
    expect(kept[1]?.number).toBe(2000 + MOST_PULLS + 4);
    expect(PAYLOADS['patching.read'].safeParse(full).success).toBe(true);
  });

  it('says a cancelled or unfinished scan did not fail', () => {
    for (const conclusion of ['cancelled', 'skipped', null]) {
      const moves = factoryMoves();
      const day = dayOf(read({ ...moves, run: { ...moves.run, conclusion } }), 0, [], at);
      expect(day.repositories[0]?.failed, String(conclusion)).toEqual([]);
    }
  });

  it('keeps the same rows past its cap whatever the pods are called', () => {
    const rows = (prefix: string) =>
      Array.from({ length: MOST_ROWS + 40 }, (_, i) => ({
        row: 'unlisted-image' as const,
        namespace: 'default',
        pod: `${prefix}-${String((i * 7919) % (MOST_ROWS + 40)).padStart(5, '0')}`,
        container: 'c',
        image: `nginx:1.${i}`,
        digest: digest(13),
      }));
    const a = dayOf(read(), 0, rows('a'), at);
    const b = dayOf(read(), 0, rows('z'), at);
    expect(sameDay(b, a)).toBe(true);
    expect(a.rows).toHaveLength(MOST_ROWS);
  });
});

describe("the sense's sends to triage", () => {
  const line: ReadMove = {
    index: 1,
    repository: APP,
    name: 'a package in `pnpm-lock.yaml`',
    pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
    from: '',
    to: '',
    major: false,
    clears: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
    leaves: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
    newToday: 1,
    lane: 'line',
    lockfile: true,
    withheld: {
      package: 'left-pad',
      from: '1.2.3',
      to: 'version 1.2.4',
      pins: [{ file: 'pnpm-lock.yaml', line: 812 }],
    },
    findings: [
      {
        advisory: 'CVE-2026-1001',
        severity: 'HIGH',
        type: 'pnpm',
        package: 'left-pad',
        installed: '1.2.3',
        file: 'pnpm-lock.yaml',
        line: 812,
        fix: 'version 1.2.4',
        firstSeen: '2026-11-10T04:59:00Z',
      },
    ],
  };
  const withLine = senses({
    moves: async (repo) => (repo === FACTORY ? factoryMoves() : { ...appMoves(), moves: [line] }),
  });
  const sending = (sql = database.patching) =>
    new PatchingSense({
      sql,
      events: new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
      outbox: inbox(sql, 'dependency'),
      senses: withLine,
      repositories: [FACTORY, APP],
      log,
    });
  const signals = () =>
    database.owner<{ sense: string; fingerprint: string }[]>`select sense, fingerprint from inbox order by received_at`;

  it('sends the app’s move for the line as its own role, and a restart sends it again under the same id, kept once', async () => {
    expect((await sending().pass()).pass).toBe('appended');
    expect(await signals()).toEqual([{ sense: 'dependency', fingerprint: 'move npm left-pad' }]);
    // Restarted, as every deploy restarts it: the day is unchanged and the send the same.
    expect((await sending().pass()).pass).toBe('unchanged');
    expect(await signals()).toHaveLength(1);
  });

  it('may send only its own sense’s signals, and read none', async () => {
    const probe: InboxSignal = {
      sense: 'probe',
      check: 'pages load',
      route: '/',
      version: 'v0.9.4',
      symptom: 'server-error',
      observedAt: '2026-11-11T05:30:00Z',
      artifacts: [],
    };
    await expect(inbox(database.patching, 'probe').send(probe)).rejects.toThrow(/row-level security/);
    await expect(database.patching`select 1 from inbox`).rejects.toThrow(/permission denied/);
  });

  it('takes a send the store refused the connection to again shortly, the day appended', async () => {
    const refusing = new PatchingSense({
      sql: database.patching,
      events: new EventWriter(database.patching, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
      outbox: {
        send: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
      },
      senses: withLine,
      repositories: [FACTORY, APP],
      log,
    });
    expect(await refusing.pass()).toMatchObject({ pass: 'refused' });
    expect(await days()).toHaveLength(1);
  });

  it('fails the pass, the day appended, when a send is refused, and sends again at the next', async () => {
    const refusing = new PatchingSense({
      sql: database.patching,
      events: new EventWriter(database.patching, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
      outbox: { send: async () => Promise.reject(new Error('the inbox is closed')) },
      senses: withLine,
      repositories: [FACTORY, APP],
      log,
    });
    const result = await refusing.pass();
    expect(result).toEqual({ pass: 'failed', failed: [`a move of ${APP} to triage: the inbox is closed`] });
    expect(await days()).toHaveLength(1);
    expect((await sending().pass()).pass).toBe('unchanged');
    expect(await signals()).toHaveLength(1);
  });
});
