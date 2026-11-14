import { createServer } from 'node:http';
import { type InboxSignal, MOVE_LANES } from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { MOST_MOVES, MOST_PINS, MOST_ROWS, PAYLOADS } from '@software-factory/events/schemas';
import { connect, DiskArtifacts, EventWriter } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { DependencyPull } from '../../src/github/dependabot.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { GitHubWorker, GitHubWorkerError, READ_AGAIN } from '../../src/github/worker-client.ts';
import { inbox } from '../../src/outbox.ts';
import { dayOf, sameDay } from '../../src/patching/day.ts';
import { runningContainers } from '../../src/patching/running.ts';
import { waitAfter } from '../../src/patching/schedule.ts';
import {
  exitCode,
  MOST_AGAIN,
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
  digest,
  FACTORY,
  FACTORY_COUNTS,
  factoryMoves,
  PULL,
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

  it('reads again, as nothing failed, when the worker asks for the moves read again, and appends nothing', async () => {
    const again = new GitHubWorkerError(409, READ_AGAIN, 'A scan finished during the read: read again.');
    const result = await sense(
      senses({ moves: async (repo) => (repo === APP ? Promise.reject(again) : factoryMoves()) }),
    ).pass();
    expect(result).toEqual({
      pass: 'again',
      why: [`the moves of ${APP}: A scan finished during the read: read again.`],
    });
    expect(await days()).toEqual([]);
    expect(logged.filter((l) => l.level >= 50)).toEqual([]);
    expect(
      logged.some(
        (l) => l.level === 30 && l.msg === 'patching: a scan finished during the read, so the day is read again soon',
      ),
    ).toBe(true);
  });

  it('is a failed pass when the Dependabot read is asked for again: only the moves read is read again', async () => {
    const again = new GitHubWorkerError(409, READ_AGAIN, 'read again');
    const result = await sense(senses({ dependencyPulls: async () => Promise.reject(again) })).pass();
    expect(result.pass).toBe('failed');
  });

  it("is a failed pass when GitHub's own 409 comes from the moves read: only the worker's ask is read again", async () => {
    const conflict = new GitHubWorkerError(409, 'conflict', 'GitHub answered 409');
    const result = await sense(senses({ moves: async () => Promise.reject(conflict) })).pass();
    expect(result).toEqual({
      pass: 'failed',
      failed: [`the moves of ${FACTORY}: GitHub answered 409`, `the moves of ${APP}: GitHub answered 409`],
    });
    expect(await days()).toEqual([]);
  });

  it('counts reads to take again as a failure once they have come an hour in a row', async () => {
    const again = new GitHubWorkerError(409, READ_AGAIN, 'read again');
    const s = sense(senses({ moves: async () => Promise.reject(again) }));
    const passes: string[] = [];
    for (let i = 0; i < MOST_AGAIN; i++) passes.push((await s.pass()).pass);
    expect(passes).toEqual([...Array(MOST_AGAIN - 1).fill('again'), 'failed']);
    const errors = logged.filter((l) => l.level === 50);
    expect(errors.map((l) => l.msg)).toEqual([
      `patching: 2 of the reads failed, asked for again ${MOST_AGAIN} times in a row, so the day is not appended`,
    ]);
  });

  it('starts the count of reads to take again anew after any other pass, on the same sense', async () => {
    const again = new GitHubWorkerError(409, READ_AGAIN, 'read again');
    let answer = false;
    const s = sense(
      senses({
        moves: async (repo) => (answer ? (repo === FACTORY ? factoryMoves() : appMoves()) : Promise.reject(again)),
      }),
    );
    for (let i = 0; i < MOST_AGAIN - 1; i++) expect((await s.pass()).pass).toBe('again');
    answer = true;
    expect((await s.pass()).pass).toBe('appended');
    answer = false;
    // Were the count kept, the next would be the sixth in a row, and a failure.
    for (let i = 0; i < MOST_AGAIN - 1; i++) expect((await s.pass()).pass).toBe('again');
  });

  it('says when to read next and what --once exits with, for each pass', () => {
    const now = Date.parse('2026-11-11T06:00:00Z');
    const day = (finished: string) =>
      ({ pass: 'appended', day: { repositories: [{ run: { finished } }] } }) as unknown as Pass;
    expect(nextAfter({ pass: 'again', why: [] }, now)).toEqual({ next: 'soon', why: 'again' });
    expect(nextAfter({ pass: 'refused', why: [] }, now)).toEqual({ next: 'shortly', why: 'refused' });
    expect(nextAfter({ pass: 'failed', failed: [] }, now)).toEqual({ next: 'hour', why: 'failed' });
    expect(nextAfter({ pass: 'not-real' }, now)).toEqual({ next: 'daily' });
    expect(nextAfter(day('2026-11-11T04:58:00Z'), now)).toEqual({ next: 'daily' });
    expect(nextAfter(day('2026-11-10T04:58:00Z'), now)).toEqual({ next: 'hour', why: 'stale' });
    expect([
      exitCode(day('2026-11-11T04:58:00Z')),
      exitCode({ pass: 'not-real' }),
      exitCode({ pass: 'failed', failed: [] }),
      exitCode({ pass: 'again', why: [] }),
      exitCode({ pass: 'refused', why: [] }),
    ]).toEqual([0, 0, 1, 75, 75]);
  });

  it('is a failed pass when a 409 comes beside a read that failed', async () => {
    const again = new GitHubWorkerError(409, READ_AGAIN, 'read again');
    const result = await sense(
      senses({
        moves: async () => Promise.reject(again),
        running: async () => Promise.reject(new Error('GET /api/v1/pods answered 403: forbidden')),
      }),
    ).pass();
    expect(result.pass).toBe('failed');
    expect(await days()).toEqual([]);
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
    const s = sense(
      senses({ moves: async () => Promise.reject(door), dependencyPulls: async () => Promise.reject(fetched) }),
    );
    const passes: Pass[] = [];
    for (let i = 0; i < MOST_REFUSED; i++) passes.push(await s.pass());
    expect(passes.map((p) => p.pass)).toEqual([...Array(MOST_REFUSED - 1).fill('refused'), 'failed']);
    expect(passes[0]).toEqual({
      pass: 'refused',
      why: [
        `the moves of ${FACTORY}: connect ECONNREFUSED 10.43.117.70:8083`,
        `the Dependabot pull requests of ${FACTORY}: fetch failed`,
        `the moves of ${APP}: connect ECONNREFUSED 10.43.117.70:8083`,
        `the Dependabot pull requests of ${APP}: fetch failed`,
      ],
    });
    expect(await days()).toEqual([]);
    expect(logged.filter((l) => l.level === 50).map((l) => l.msg)).toEqual([
      `patching: 4 of the reads failed, refused by the GitHub worker's door ${MOST_REFUSED} times in a row, so the day is not appended`,
    ]);
  });

  it("is a failed pass when a refusal comes beside another failure, or from the cluster's read", async () => {
    const door = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6443'), { code: 'ECONNREFUSED' });
    for (const change of [
      {
        moves: async () => Promise.reject(door),
        dependencyPulls: async () => Promise.reject(new Error('GitHub failed')),
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
    const s = sense(senses({ dependencyPulls: async () => (listening ? [] : Promise.reject(door)) }));
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
        const result = req.url?.endsWith('/moves') ? (repo === FACTORY ? factoryMoves() : appMoves()) : [];
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
      });
    });
    const s = sense(
      senses({
        moves: (repo) => new GitHubWorker(url).read('moves', repo, {}),
        dependencyPulls: (repo) => new GitHubWorker(url).read('dependencyPulls', repo, {}),
      }),
    );
    const started = Date.now();
    try {
      // Listening only once the first pass is over, however long it took, so that pass is always refused.
      const first = await s.pass();
      expect(first.pass).toBe('refused');
      const { next } = nextAfter(first, started);
      // Taken again within the minute, not the hour a failed pass waits.
      expect(waitAfter(started, (5 * 60 + 30) * 60_000, next)).toBeLessThanOrEqual(60_000);
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

  it('names the Dependabot pull request of an image outside Docker Hub, which its branch names without the registry', () => {
    const image = withMove({
      name: 'gcr.io/distroless/nodejs24-debian13',
      pins: [{ file: 'apps/x/Dockerfile', line: 1 }],
    });
    const pull: DependencyPull = {
      ...PULL,
      number: 91,
      ecosystem: 'docker',
      directory: '/apps/x',
      dependency: 'distroless/nodejs24-debian13',
      version: '1.2.3',
    };
    expect(dayOf(read(image, [pull]), 0, []).repositories[0]?.moves[0]?.pullRequest).toEqual({
      number: 91,
      version: '1.2.3',
    });
  });

  it('names the Dependabot pull request of an Action used by a subpath', () => {
    const action = withMove({
      name: 'github/codeql-action/upload-sarif',
      pins: [{ file: '.github/workflows/scan.yml', line: 40 }],
    });
    const pull: DependencyPull = {
      ...PULL,
      number: 92,
      ecosystem: 'github-actions',
      directory: '/',
      dependency: 'github/codeql-action',
      version: '4.31.0',
    };
    expect(dayOf(read(action, [pull]), 0, []).repositories[0]?.moves[0]?.pullRequest).toEqual({
      number: 92,
      version: '4.31.0',
    });
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
    const two = dayOf(read(), 2, [row('try-a'), row('try-b')]);
    const three = dayOf(read(), 3, [row('try-a'), row('try-b'), row('try-c')]);
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
    const day = dayOf(read(many), rows.length, rows);
    expect(PAYLOADS['patching.read'].safeParse(day).success).toBe(true);
    expect(day.repositories[0]?.moves).toHaveLength(MOST_MOVES);
    expect(day.rows).toHaveLength(MOST_ROWS);
    const empty = {
      ...moves,
      moves: [{ ...lockfile, withheld: { ...(lockfile.withheld as NonNullable<ReadMove['withheld']>), from: '' } }],
    };
    expect(PAYLOADS['patching.read'].safeParse(dayOf(read(empty), 0, [])).success).toBe(true);
  });

  it('says a cancelled or unfinished scan did not fail', () => {
    for (const conclusion of ['cancelled', 'skipped', null]) {
      const moves = factoryMoves();
      const day = dayOf(read({ ...moves, run: { ...moves.run, conclusion } }), 0, []);
      expect(day.repositories[0]?.failed, String(conclusion)).toEqual([]);
    }
  });

  it('matches a lockfile move only by its package, and one without its package to nothing', () => {
    const moves = factoryMoves();
    const lockfile = moves.moves[1] as ReadMove;
    const scoped = (dependency: string): DependencyPull => ({ ...PULL, number: 95, dependency });
    const of = (move: ReadMove, pulls: DependencyPull[]) =>
      dayOf(read({ ...moves, moves: [move] }, pulls), 0, []).repositories[0]?.moves[0]?.pullRequest;
    expect(of({ ...lockfile, withheld: undefined }, [scoped('@scope/a'), scoped('@scope/b')])).toBeUndefined();
    const withPackage = {
      ...lockfile,
      withheld: { ...(lockfile.withheld as NonNullable<ReadMove['withheld']>), package: '@scope/b' },
    };
    expect(of(withPackage, [scoped('@scope/a'), scoped('@scope/b')])).toEqual({ number: 95, version: PULL.version });
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
    const a = dayOf(read(), 0, rows('a'));
    const b = dayOf(read(), 0, rows('z'));
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
        alert: 7,
        advisory: 'CVE-2026-1001',
        severity: 'HIGH',
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
