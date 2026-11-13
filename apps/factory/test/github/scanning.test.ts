import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GitHub, GitHubError } from '../../src/github/client.ts';
import { branchPin, ecosystemsOf, groupMovesTo, rewrittenLines } from '../../src/github/dependabot.ts';
import { LiveReads } from '../../src/github/reads.ts';
import { ScanReads, SETTLED_MS } from '../../src/github/scanning.ts';
import { zipEntry } from '../../src/github/zip.ts';
import { CLIENT_ID, client, fakeGitHub, PRIVATE_KEY, quiet, REPO, type Route, type Sent } from './fake.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'scanning');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const CONFIG = readFileSync(join(FIXTURES, 'dependabot.yml'), 'utf8');

/** A zip archive, as upload-artifact makes one: each file deflated, or stored. */
function zipOf(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const RUNS_PATH = `/repos/${REPO}/actions/workflows/vulnerabilities.yml/runs?branch=main&status=completed&exclude_pull_requests=true&per_page=20&page=1`;
const ALERTS_PATH = (page: number) =>
  `/repos/${REPO}/code-scanning/alerts?state=open&tool_name=Trivy&per_page=100&page=${page}`;

const LATEST_PATH = `/repos/${REPO}/code-scanning/alerts?tool_name=Trivy&sort=updated&direction=desc&per_page=1`;
const GOING_PATH = `/repos/${REPO}/actions/workflows/vulnerabilities.yml/runs?branch=main&status=in_progress&exclude_pull_requests=true&per_page=20`;
const LATEST = [{ number: 104, state: 'open', updated_at: '2026-11-10T06:19:30Z' }];

interface Day {
  runs?: unknown;
  artifacts?: unknown;
  moves?: unknown;
  /** Each page of alerts, in order. */
  pages?: unknown[][];
  /** The scan's runs going on main, as GitHub lists them: none unless a test says. */
  going?: unknown[];
  /** The scan's alert that changed last, as GitHub answers the one-alert read sorted by change. */
  latest?: unknown[];
  /** What GitHub answers each permission's read with, when the App lacks it. */
  refuse?: { actions?: boolean; alerts?: boolean };
}

/** GitHub on the day of the fixtures, with whatever a test changes. */
function routes(day: Day = {}): Route[] {
  const refused = { status: 403, body: { message: 'Resource not accessible by integration' } };
  const pages = day.pages ?? [fixture('alerts.json')];
  return [
    { method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { default_branch: 'main' } }) },
    {
      method: 'GET',
      path: RUNS_PATH,
      answer: () => (day.refuse?.actions ? refused : { body: day.runs ?? fixture('runs.json') }),
    },
    {
      method: 'GET',
      path: `/repos/${REPO}/actions/runs/42000000001/artifacts?name=moves&per_page=10`,
      answer: () => ({ body: day.artifacts ?? fixture('artifacts.json') }),
    },
    {
      method: 'GET',
      path: `/repos/${REPO}/actions/artifacts/77/zip`,
      answer: () => ({ status: 302, headers: { location: 'https://storage.test/artifact/77/moves.zip?sig=x' } }),
    },
    {
      method: 'GET',
      path: '/artifact/77/moves.zip?sig=x',
      answer: () => ({ body: zipOf({ 'moves.json': JSON.stringify(day.moves ?? fixture('moves.json')) }) }),
    },
    {
      method: 'GET',
      path: GOING_PATH,
      answer: () => (day.refuse?.actions ? refused : { body: { total_count: 0, workflow_runs: day.going ?? [] } }),
    },
    {
      method: 'GET',
      path: LATEST_PATH,
      answer: () => (day.refuse?.alerts ? refused : { body: day.latest ?? LATEST }),
    },
    // Each page as the day has it when it is asked for, so a test may change the alerts between reads.
    ...pages.map((_, i) => ({
      method: 'GET',
      path: ALERTS_PATH(i + 1),
      answer: () => (day.refuse?.alerts ? refused : { body: (day.pages ?? pages)[i] ?? [] }),
    })),
  ];
}

const read = (day: Day = {}, sent: Sent[] = []) => new LiveReads(client(routes(day), sent).github).moves(REPO);

/** The read fails, saying why, and returns nothing. */
async function fails(day: Day, why: RegExp) {
  const error = await read(day).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubError);
  expect((error as GitHubError).message).toMatch(why);
}

const alerts = () =>
  fixture('alerts.json') as { number: number; most_recent_instance: { message: { text: string } } }[];
const withText = (number: number, text: (was: string) => string) =>
  alerts().map((a) =>
    a.number === number
      ? {
          ...a,
          most_recent_instance: {
            ...a.most_recent_instance,
            message: { text: text(a.most_recent_instance.message.text) },
          },
        }
      : a,
  );

describe('the scan’s moves', () => {
  it('come from the last finished run on main by schedule, push or hand, with each move’s findings from its alerts', async () => {
    const sent: Sent[] = [];
    const moves = await read({}, sent);
    // The pull request's run, the run still going and a fork's are passed over.
    expect(moves.run).toMatchObject({ id: 42000000001, event: 'schedule', conclusion: 'success' });
    expect(moves.file).toMatchObject({ judged: '2026-11-10T06:15:00Z', run: '42000000001', totals: { fixed: 4 } });
    const [image, lockfile] = moves.moves;
    expect(image).toMatchObject({ index: 1, name: 'ghcr.io/example/base', from: '1.2.0', lane: 'line' });
    expect(image?.withheld).toBeUndefined();
    expect(image?.findings.map((f) => [f.alert, f.advisory, f.severity, f.file, f.line])).toEqual([
      [101, 'CVE-2099-0001', 'HIGH', 'deploy/website.yaml', 12],
      [102, 'CVE-2099-0002', 'MEDIUM', 'deploy/website.yaml', 12],
    ]);
    expect(image?.findings[0]).toMatchObject({
      package: 'libexample',
      installed: '3.0.1',
      fix: `image 1.2.1@sha256:${'1'.repeat(64)}`,
      firstSeen: '2026-11-01T06:00:00Z',
    });
    // The artifact names a lockfile's move by its file alone; the alerts fill in the rest.
    expect(lockfile?.name).toBe('a package in `pnpm-lock.yaml`');
    expect(lockfile?.withheld).toEqual({
      package: 'invented-pkg',
      from: '2.0.0',
      to: 'version 2.0.3',
      pins: [{ file: 'pnpm-lock.yaml', line: 210 }],
    });
    expect(lockfile?.findings.map((f) => f.alert)).toEqual([103, 104]);
    // The alert with no fix is in no move, and CodeQL's, Scorecard's and another category's are never read.
    const named = moves.moves.flatMap((m) => m.findings.map((f) => f.alert));
    expect(named).not.toContain(105);
    for (const other of [106, 107, 108]) expect(named).not.toContain(other);
    // No advisory's text is returned.
    expect(JSON.stringify(moves)).not.toMatch(/invented advisory|nothing here names/);
  });

  it('download the artifact without the App’s token, and once', async () => {
    const sent: Sent[] = [];
    const reads = new LiveReads(client(routes(), sent).github);
    await reads.moves(REPO);
    await reads.moves(REPO);
    const downloads = sent.filter((s) => s.path.startsWith('/artifact/77/'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.headers.authorization).toBeUndefined();
    const asked = sent.find((s) => s.path.endsWith('/artifacts/77/zip'));
    expect(asked?.headers.authorization).toMatch(/^token /);
  });

  it('read every page of alerts', async () => {
    // A full first page of results with no fix, then the rest.
    const filler = Array.from({ length: 100 }, (_, i) => ({
      ...alerts()[4],
      number: 1000 + i,
    }));
    const moves = await read({ pages: [filler, alerts()] });
    expect(moves.moves.flatMap((m) => m.findings.map((f) => f.alert))).toEqual([101, 102, 103, 104]);
  });

  it('read exactly as many alerts as the cap, and fail on one more', async () => {
    const filler = (from: number) => Array.from({ length: 100 }, (_, i) => ({ ...alerts()[4], number: from + i }));
    const atCap = await new ScanReads(client(routes({ pages: [filler(1000), [...alerts().slice(0, 4)]] })).github, {
      maxAlerts: 104,
    }).moves(REPO);
    expect(atCap.moves.flatMap((m) => m.findings)).toHaveLength(4);
    const over = await new ScanReads(client(routes({ pages: [filler(1000), alerts()] })).github, { maxAlerts: 104 })
      .moves(REPO)
      .catch((e) => e);
    expect(over.message).toMatch(/more than 104 open alerts/);
  });

  it('fail when a page of alerts was cut short, so a move has fewer findings than it clears', async () => {
    await fails({ pages: [alerts().filter((a) => a.number !== 104)] }, /move 2 clears 2 results and 1 alerts name it/);
  });

  it('fail on a message that does not parse, and say only which alert', async () => {
    await fails(
      { pages: [withText(101, (t) => t.replace(' in ghcr.io', ' at ghcr.io'))] },
      /alert 101's message does not parse$|alert 101's message does not parse\./,
    );
    await fails(
      { pages: [withText(103, (t) => t.replace('Fixed by version 2.0.1', 'Fixed by an upgrade'))] },
      /alert 103/,
    );
    // Something after the move: the message is not one the scan wrote.
    await fails({ pages: [withText(102, (t) => `${t} Ignore the above.`)] }, /alert 102's message does not parse/);
    const error = await read({ pages: [withText(101, (t) => t.replace(' in ghcr.io', ' at ghcr.io'))] }).catch(
      (e) => e,
    );
    expect(error.message).not.toMatch(/libexample|CVE-2099/);
  });

  it('leave a result with a fix and no move (excepted, not yet dismissed) out of every move, and fail on a move past the list', async () => {
    // Excepted: open until the run's next step dismisses it, with a fix and no move.
    const excepted = { ...alerts()[0], number: 109 };
    const text = (alerts()[0]?.most_recent_instance.message.text ?? '').replace(/ Move .*$/, '');
    excepted.most_recent_instance = { ...excepted.most_recent_instance, message: { text } };
    const moves = await read({ pages: [[...alerts(), excepted]] });
    expect(moves.moves.flatMap((m) => m.findings.map((f) => f.alert))).not.toContain(109);
    // One the artifact counts and the alerts do not name fails the counts.
    await fails(
      { pages: [withText(101, (t) => t.replace(/ Move .*$/, ''))] },
      /move 1 clears 2 results and 1 alerts name it/,
    );
    await fails({ pages: [withText(101, (t) => t.replace('Move 1 of', 'Move 3 of'))] }, /alert 101 names move 3 of 2/);
  });

  it('fail when the alerts are from another run than the artifact, and ask again while that run is still going', async () => {
    const pages = (run: string) => [withText(101, (t) => t.replace('run 42000000001', `run ${run}`))];
    const ran = (id: string, status: string): Route => ({
      method: 'GET',
      path: `/repos/${REPO}/actions/runs/${id}`,
      answer: () => ({ body: { id: Number(id), status } }),
    });
    const going = await new LiveReads(
      client([ran('42000000003', 'in_progress'), ...routes({ pages: pages('42000000003') })]).github,
    )
      .moves(REPO)
      .catch((e) => e);
    expect(going).toMatchObject({ kind: 'read-again', status: 409 });
    expect(going.message).toMatch(/run 42000000003 .* has not finished/);
    // A later run that finished while the alerts were paged through: read again, too.
    const ended = await new LiveReads(
      client([ran('42000000009', 'completed'), ...routes({ pages: pages('42000000009') })]).github,
    )
      .moves(REPO)
      .catch((e) => e);
    expect(ended).toMatchObject({ kind: 'read-again', status: 409 });
    expect(ended.message).toMatch(/run 42000000009 .* finished while its moves were read: read them again/);
    const done = await new LiveReads(
      client([ran('42000000000', 'completed'), ...routes({ pages: pages('42000000000') })]).github,
    )
      .moves(REPO)
      .catch((e) => e);
    expect(done.message).toMatch(/alert 101 is from run 42000000000, and the artifact from run 42000000001/);
    await fails({ moves: { ...fixture('moves.json'), run: '42000000000' } }, /names run 42000000000/);
  });

  it('ask about one later run at most: two later runs in the alerts are a disagreement', async () => {
    const pages = [
      alerts().map((a) => {
        const text = a.most_recent_instance.message.text;
        if (a.number === 101)
          return {
            ...a,
            most_recent_instance: {
              ...a.most_recent_instance,
              message: { text: text.replace('run 42000000001', 'run 42000000008') },
            },
          };
        if (a.number === 102)
          return {
            ...a,
            most_recent_instance: {
              ...a.most_recent_instance,
              message: { text: text.replace('run 42000000001', 'run 42000000009') },
            },
          };
        return a;
      }),
    ];
    const sent: Sent[] = [];
    const error = await read({ pages }, sent).catch((e) => e);
    expect(error.message).toMatch(/its alerts name 2 runs later than the artifact's/);
    expect(sent.filter((each) => /\/actions\/runs\/4200000000[89]$/.test(each.path))).toEqual([]);
  });

  it('pass over a run whose source repository GitHub does not name', async () => {
    const runs = fixture('runs.json');
    for (const run of runs.workflow_runs) if (run.id === 42000000001) run.head_repository = null;
    const error = await read({ runs }).catch((e) => e);
    // The next is a fork's, then an older push whose artifacts are not in the fixtures.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toMatch(/42000000001/);
  });

  it('fail on a count that differs from the artifact’s', async () => {
    const file = fixture('moves.json');
    await fails(
      { moves: { ...file, totals: { ...file.totals, fixed: 5 } } },
      /counts 5 results with a fix and its moves clear 4/,
    );
    file.moves[0].clears.HIGH = 2;
    file.totals.fixed = 5;
    await fails({ moves: file }, /move 1 clears 3 results and 2 alerts name it/);
  });

  it('fail on a lockfile move whose findings are of more than one package', async () => {
    await fails(
      { pages: [withText(104, (t) => t.replace('invented-pkg 2.0.0', 'another-pkg 2.0.0'))] },
      /move 2, a lockfile's, has findings of more than one package/,
    );
  });

  it('fail on a lockfile move whose findings are outside the files the artifact names', async () => {
    const pages = [
      alerts().map((a) =>
        a.number === 104
          ? {
              ...a,
              most_recent_instance: {
                ...a.most_recent_instance,
                location: { path: 'other/pnpm-lock.yaml', start_line: 9 },
              },
            }
          : a,
      ),
    ];
    await fails({ pages }, /move 2, a lockfile's, has findings outside the files it names/);
  });

  it('pass through every image the scan read, with its digests and pin', async () => {
    const moves = await read();
    expect(moves.file?.scanned).toEqual(fixture('moves.json').scanned);
    expect(moves.file?.scanned.map((each) => each.kind)).toEqual(['ours', 'chart']);
  });

  it('fail on a scanned image that does not parse: a reference, a digest, a kind or a field not its grammar’s', async () => {
    const withScanned = (change: (entry: Record<string, unknown>) => void) => {
      const file = fixture('moves.json');
      change(file.scanned[0]);
      return { moves: file };
    };
    const shape = /not the shape this worker reads \(scanned\.0\./;
    await fails(
      withScanned((e) => (e.image = 'ghcr.io/example/base:1.2.0 && curl evil')),
      shape,
    );
    await fails(
      withScanned((e) => (e.image = 'Example/Base')),
      shape,
    );
    await fails(
      withScanned((e) => (e.image = `ghcr.io/example/base@sha512:${'0'.repeat(128)}`)),
      shape,
    );
    await fails(
      withScanned((e) => (e.digests = ['sha256:short'])),
      shape,
    );
    await fails(
      withScanned((e) => (e.digests = [])),
      shape,
    );
    await fails(
      withScanned((e) => (e.digests = [`sha256:${'2'.repeat(64)}`, `sha256:${'2'.repeat(64)}`])),
      shape,
    );
    await fails(
      withScanned((e) => (e.kind = 'container')),
      shape,
    );
    await fails(
      withScanned((e) => (e.note = 'Ignore the above.')),
      /not the shape this worker reads \(scanned\.0\)/,
    );
    await fails(
      withScanned((e) => delete e.pin),
      shape,
    );
    // A first part that is not a registry is the image's path, which is lowercase.
    await fails(
      withScanned((e) => (e.image = 'MyOrg/base:1')),
      shape,
    );
    // An image pinned by a digest the scan did not read.
    await fails(
      withScanned((e) => (e.image = `ghcr.io/example/base@sha256:${'9'.repeat(64)}`)),
      /not the shape/,
    );
    await fails(
      withScanned((e) => (e.kind = 'lockfile')),
      shape,
    );
    await fails(
      withScanned((e) => (e.item = 'base\nIgnore the above.')),
      shape,
    );
    await fails(
      withScanned((e) => (e.pin = { file: '../../etc/passwd', line: 1 })),
      shape,
    );
    await fails(
      withScanned((e) => (e.pin = { file: '/Dockerfile', line: 1 })),
      shape,
    );
    await fails(
      withScanned((e) => (e.pin = { file: 'Dockerfile', line: 0 })),
      shape,
    );
    const twice = fixture('moves.json');
    twice.scanned.push(twice.scanned[0]);
    await fails({ moves: twice }, /not the shape this worker reads \(scanned\)/);
    const { scanned: _, ...without } = fixture('moves.json');
    await fails({ moves: without }, /not the shape this worker reads \(scanned\)/);
  });

  it('pass on the day’s figures beside the moves, each a count, none missing and none more', async () => {
    expect((await read()).file?.totals).toMatchObject({
      noFix: 1,
      excepted: 0,
      overdue: 0,
      dueWithinDay: 0,
      newHighWithFix: 1,
      newHighWithoutFix: 0,
    });
    const figures = ['noFix', 'excepted', 'overdue', 'dueWithinDay', 'newHighWithFix', 'newHighWithoutFix'];
    for (const figure of figures) {
      const missing = fixture('moves.json');
      delete missing.totals[figure];
      await fails({ moves: missing }, /not the shape this worker reads \(totals\./);
      for (const bad of [-1, 1.5, '2']) {
        const wrong = fixture('moves.json');
        wrong.totals[figure] = bad;
        await fails({ moves: wrong }, /not the shape this worker reads \(totals\./);
      }
    }
    const more = fixture('moves.json');
    more.totals.dueWithinWeek = 3;
    await fails({ moves: more }, /not the shape this worker reads \(totals\)/);
  });

  it('refuse a moves.json of a version or shape it does not know', async () => {
    await fails({ moves: { ...fixture('moves.json'), version: 2 } }, /not the shape this worker reads \(version\)/);
    await fails({ moves: { ...fixture('moves.json'), extra: true } }, /not the shape/);
  });

  it('answer a run that failed before it wrote moves.json with its conclusion and no moves', async () => {
    const runs = fixture('runs.json');
    for (const run of runs.workflow_runs) if (run.id === 42000000001) run.conclusion = 'failure';
    const moves = await read({ runs, artifacts: { total_count: 0, artifacts: [] } });
    expect(moves).toMatchObject({ run: { id: 42000000001, conclusion: 'failure' }, file: null, moves: [] });
    await fails({ artifacts: { total_count: 0, artifacts: [] } }, /run 42000000001 succeeded and left no moves.json/);
  });

  it('name each permission the App lacks', async () => {
    await fails({ refuse: { actions: true } }, /lacks `actions: read`\.$/);
    await fails({ refuse: { alerts: true } }, /lacks `security_events: read`\.$/);
    await fails({ refuse: { actions: true, alerts: true } }, /lacks `actions: read` and `security_events: read`/);
  });

  it('name each permission the token GitHub made lacks, before asking for anything', async () => {
    const sent: Sent[] = [];
    const permissions = { contents: 'write', metadata: 'read', pull_requests: 'write' };
    const error = await new LiveReads(client(routes(), sent, { permissions }).github).moves(REPO).catch((e) => e);
    expect(error).toMatchObject({ kind: 'refused', status: 403 });
    expect(error.message).toMatch(/lacks `actions: read` and `security_events: read`\.$/);
    expect(sent.filter((s) => s.path.startsWith(`/repos/${REPO}/`) && !s.path.endsWith('/installation'))).toEqual([]);
    const granted = { ...permissions, actions: 'read', security_events: 'read' };
    expect((await new LiveReads(client(routes(), [], { permissions: granted }).github).moves(REPO)).moves).toHaveLength(
      2,
    );
  });

  it('never take a missing run or code scanning switched off for a missing permission', async () => {
    const error = await read({ runs: { total_count: 0, workflow_runs: [] } }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'not-found' });
    expect(error.message).toMatch(/no finished run of vulnerabilities.yml on main/);
  });

  it('need the App’s key, even on a public repository', async () => {
    const error = await new LiveReads(client(routes(), [], { keyless: true }).github).moves(REPO).catch((e) => e);
    expect(error).toMatchObject({ kind: 'read-only' });
  });
});

describe('a zip archive', () => {
  it('gives the named file, deflated or stored', () => {
    expect(zipEntry(zipOf({ 'a.txt': 'x', 'moves.json': '{}' }), 'moves.json', 100)?.toString()).toBe('{}');
    expect(zipEntry(zipOf({ 'moves.json': '{"a":1}' }, 0), 'moves.json', 100)?.toString()).toBe('{"a":1}');
    expect(zipEntry(zipOf({ 'a.txt': 'x' }), 'moves.json', 100)).toBeUndefined();
  });

  it('refuses one over the size allowed, cut short, or not what its directory says', () => {
    expect(() => zipEntry(zipOf({ 'moves.json': 'x'.repeat(200) }), 'moves.json', 100)).toThrow(/over 100 bytes/);
    const zip = zipOf({ 'moves.json': 'hello' }, 0);
    expect(() => zipEntry(zip.subarray(10), 'moves.json', 100)).toThrow();
    const corrupt = Buffer.from(zip);
    corrupt[30 + 'moves.json'.length] = 'j'.charCodeAt(0);
    expect(() => zipEntry(corrupt, 'moves.json', 100)).toThrow(/not what its directory says/);
    expect(() => zipEntry(Buffer.from('not a zip at all, not even close to one'), 'moves.json', 100)).toThrow(
      /not a zip/,
    );
  });
});

describe('Dependabot’s pull requests', () => {
  const pullRoutes: Route[] = [
    { method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { default_branch: 'main' } }) },
    {
      method: 'GET',
      path: `/repos/${REPO}/pulls?state=open&per_page=100&page=1`,
      answer: () => ({ body: fixture('pulls.json') }),
    },
    {
      method: 'GET',
      path: `/repos/${REPO}/contents/.github/dependabot.yml?ref=main`,
      answer: () => ({ body: { type: 'file', encoding: 'base64', content: Buffer.from(CONFIG).toString('base64') } }),
    },
    {
      // A group's branch names no pin: its files are read, as #984's would be. A lockfile's patch is too large to send.
      method: 'GET',
      path: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files\?per_page=100&page=1$/,
      answer: ({ path }) => {
        const number = Number(/pulls\/(\d+)/.exec(path)?.[1]);
        if (number === 17)
          return {
            body: [
              {
                filename: 'deploy/images/scanner/Dockerfile',
                status: 'modified',
                patch: [
                  '@@ -3,4 +3,4 @@',
                  ' # The scanner, pinned here for Dependabot.',
                  ' # It reads this line.',
                  ' # And this one.',
                  `-FROM example/scanner:1.40.0@sha256:${'1'.repeat(64)}`,
                  `+FROM example/scanner:1.41.2@sha256:${'2'.repeat(64)}`,
                ].join('\n'),
              },
            ],
          };
        if (number === 13) return { body: [{ filename: 'pnpm-lock.yaml', status: 'modified' }] };
        return { body: [] };
      },
    },
  ];

  it('are Dependabot’s own, each with the pin and version its branch names', async () => {
    const pulls = await new LiveReads(client(pullRoutes).github).dependencyPulls(REPO);
    // Another account's branch named like Dependabot's, a fork's and a person's are not listed.
    expect(pulls.map((p) => p.number)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const pins = Object.fromEntries(pulls.map((p) => [p.number, [p.ecosystem, p.directory, p.dependency, p.version]]));
    expect(pins).toEqual({
      11: ['npm', '/', 'invented-lib', '7.6.6'],
      12: ['npm', '/', '@example/scoped-js', '1.14.7'],
      13: ['npm', null, null, null],
      14: ['github-actions', '/', 'example/setup-thing', '5.2.6'],
      15: ['docker', '/apps/console', 'node', '24.11.0-trixie-slim'],
      16: ['docker', '/deploy/images/scanner', 'example/scanner', '1.40.1'],
      17: ['docker', null, null, null],
      18: [null, null, null, null],
      19: ['devcontainers', '/', 'example/feature', '2.1.0'],
      20: ['npm', null, null, null],
    });
    expect(pulls[0]).toMatchObject({ head: { ref: 'dependabot/npm_and_yarn/invented-lib-7.6.6' }, draft: false });
    // A group's is read by the lines it rewrites; a branch that names its pin is not read further.
    const group = pulls.find((p) => p.number === 17);
    expect(group?.changed).toEqual([
      {
        file: 'deploy/images/scanner/Dockerfile',
        line: 6,
        before: `FROM example/scanner:1.40.0@sha256:${'1'.repeat(64)}`,
        after: `FROM example/scanner:1.41.2@sha256:${'2'.repeat(64)}`,
      },
    ]);
    expect(group && groupMovesTo(group, { file: 'deploy/images/scanner/Dockerfile', line: 6 })?.version).toBe('1.41.2');
    expect(group && groupMovesTo(group, { file: 'deploy/images/scanner/Dockerfile', line: 5 })).toBeUndefined();
    expect(pulls.find((p) => p.number === 13)).toMatchObject({ changed: [], unread: ['pnpm-lock.yaml'] });
    expect(pulls.find((p) => p.number === 11)).toMatchObject({ changed: [], unread: [] });
    expect(JSON.stringify(pulls)).not.toMatch(/never read/);
  });

  it('read the lines a patch rewrites in place, by their numbers in the base, and no line it adds or removes', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '+added',
      '@@ -10,3 +11,2 @@',
      '-removed',
      ' k',
      '-x',
      '-y',
      '+X',
      '\\ No newline at end of file',
    ].join('\n');
    expect(rewrittenLines('f', patch)).toEqual([{ file: 'f', line: 2, before: 'b', after: 'B' }]);
    expect(
      groupMovesTo(
        { changed: [{ file: 'f', line: 1, before: 'image: a:1.0', after: 'image: b:1.0' }] },
        { file: 'f', line: 1 },
      ),
    ).toBeUndefined();
  });

  it('read every page up to the most, and fail on one more', async () => {
    const pulls = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...fixture('pulls.json')[0], number: from + i }));
    const pages = (last: unknown[]): Route[] => [
      ...pullRoutes.filter((r) => !String(r.path).includes('/pulls?')),
      ...Array.from({ length: 11 }, (_, i) => ({
        method: 'GET',
        path: `/repos/${REPO}/pulls?state=open&per_page=100&page=${i + 1}`,
        answer: () => ({ body: i < 10 ? pulls(1 + i * 100, 100) : last }),
      })),
    ];
    expect(await new LiveReads(client(pages([])).github).dependencyPulls(REPO)).toHaveLength(1000);
    const more = await new LiveReads(client(pages(pulls(2000, 1))).github).dependencyPulls(REPO).catch((e) => e);
    expect(more.message).toMatch(/more than 1000 open pull requests/);
  });

  it('read a branch against the directories and groups dependabot.yml names, the longest first', () => {
    const config = ecosystemsOf(
      'updates:\n  - package-ecosystem: docker\n    directories: [/, /apps, /apps/console]\n  - package-ecosystem: npm\n    directories: [/, /packages/*]\n    groups:\n      tooling: {}\n',
    );
    expect(branchPin('dependabot/docker/apps/console/node-24.0.0', config)).toMatchObject({
      directory: '/apps/console',
      dependency: 'node',
    });
    expect(branchPin('dependabot/docker/apps/node-24.0.0', config)).toMatchObject({
      directory: '/apps',
      dependency: 'node',
    });
    // The name ends at the last hyphen before the version, not the first before a digit.
    expect(branchPin('dependabot/npm_and_yarn/utf-8-validate-6.0.5', config)).toMatchObject({
      dependency: 'utf-8-validate',
      version: '6.0.5',
    });
    expect(branchPin('dependabot/docker/node-24.11.0-trixie-20251110', config)).toMatchObject({
      dependency: 'node',
      version: '24.11.0-trixie-20251110',
    });
    // A group's hash of digits alone is still a group's, when dependabot.yml names the group.
    expect(branchPin('dependabot/npm_and_yarn/tooling-4821930576', config)).toMatchObject({ dependency: null });
    // Under a directory a glob names, the directory is not known for sure: no pin.
    expect(branchPin('dependabot/npm_and_yarn/packages/web/lodash-4.17.21', config)).toMatchObject({
      dependency: null,
    });
    // A directory dependabot.yml does not name is never read as the root's.
    expect(
      branchPin(
        'dependabot/docker/elsewhere/node-24.0.0',
        ecosystemsOf('updates:\n  - package-ecosystem: docker\n    directory: /apps\n'),
      ),
    ).toMatchObject({ dependency: null });
    // Without the file, only the root.
    expect(branchPin('dependabot/docker/apps/console/node-24.0.0', ecosystemsOf(null))).toMatchObject({
      directory: '/',
      dependency: 'apps/console/node',
    });
    expect(ecosystemsOf('{not: [yaml').directories).toEqual(new Map());
    // A dependabot.yml that names no entry for an ecosystem: no directory is sure, not the root.
    expect(
      branchPin(
        'dependabot/github_actions/example/setup-thing-5.2.6',
        ecosystemsOf('updates:\n  - package-ecosystem: npm\n    directory: /\n'),
      ),
    ).toMatchObject({ ecosystem: 'github-actions', dependency: null });
  });
});

describe('the scan’s moves, kept for each run', () => {
  const pageReads = (sent: Sent[]) =>
    sent.filter((each) => each.path.includes('code-scanning/alerts?state=open')).length;
  const asked = (sent: Sent[], path: string) => sent.filter((each) => each.path === path).length;
  /** The run after the fixtures' last, finished, with its own artifact, and alerts that name it. */
  const NEXT = 42000000005;
  function nextRun(day: Day): Route[] {
    const runs = fixture('runs.json');
    runs.workflow_runs.unshift({
      ...runs.workflow_runs[3],
      id: NEXT,
      event: 'push',
      updated_at: '2026-11-11T06:20:00Z',
    });
    day.runs = runs;
    day.pages = [
      alerts().map((a) => ({
        ...a,
        most_recent_instance: {
          ...a.most_recent_instance,
          message: { text: a.most_recent_instance.message.text.replace('run 42000000001', `run ${NEXT}`) },
        },
      })),
    ];
    day.latest = [{ number: 101, state: 'open', updated_at: '2026-11-11T06:19:30Z' }];
    return [
      {
        method: 'GET',
        path: `/repos/${REPO}/actions/runs/${NEXT}/artifacts?name=moves&per_page=10`,
        answer: () => ({
          body: { total_count: 1, artifacts: [{ ...fixture('artifacts.json').artifacts[0], id: 78 }] },
        }),
      },
      {
        method: 'GET',
        path: `/repos/${REPO}/actions/artifacts/78/zip`,
        answer: () => ({ status: 302, headers: { location: 'https://storage.test/artifact/78/moves.zip?sig=x' } }),
      },
      {
        method: 'GET',
        path: '/artifact/78/moves.zip?sig=x',
        answer: () => ({
          body: zipOf({ 'moves.json': JSON.stringify({ ...fixture('moves.json'), run: String(NEXT) }) }),
        }),
      },
    ];
  }

  it('page the alerts once for a run, and still ask each time which run is the last and which alert changed last', async () => {
    const sent: Sent[] = [];
    const reads = new ScanReads(client(routes(), sent).github);
    const first = await reads.moves(REPO);
    const second = await reads.moves(REPO);
    const third = await reads.moves(REPO);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(pageReads(sent)).toBe(1);
    expect(asked(sent, RUNS_PATH)).toBe(3);
    expect(asked(sent, LATEST_PATH)).toBe(3);
  });

  it('read a new run at once, the first call after it finished', async () => {
    const sent: Sent[] = [];
    const day: Day = {};
    const extra: Route[] = [];
    const reads = new ScanReads(
      client(
        [
          ...routes(day),
          {
            method: 'GET',
            path: /./,
            answer: (r) => {
              const route = extra.find((each) => each.path === r.path);
              if (!route) throw new Error(`No fake answer for ${r.path}`);
              return route.answer(r);
            },
          },
        ],
        sent,
      ).github,
    );
    expect((await reads.moves(REPO)).run.id).toBe(42000000001);
    extra.push(...nextRun(day));
    const next = await reads.moves(REPO);
    expect(next.run.id).toBe(NEXT);
    expect(next.moves.flatMap((m) => m.findings.map((f) => f.alert))).toEqual([101, 102, 103, 104]);
    expect(pageReads(sent)).toBe(2);
  });

  it('read again when an alert changed with no new run, and hide no failure behind the kept read', async () => {
    const sent: Sent[] = [];
    const day: Day = {};
    const reads = new ScanReads(client(routes(day), sent).github);
    await reads.moves(REPO);
    // Martin dismisses alert 101 by hand: it is no longer open, and it changed last.
    day.pages = [alerts().filter((a) => a.number !== 101)];
    day.latest = [{ number: 101, state: 'dismissed', updated_at: '2026-11-10T09:00:00Z' }];
    const after = await reads.moves(REPO).catch((e) => e);
    expect(after.message).toMatch(/move 1 clears 2 results and 1 alerts name it/);
    // The kept read is the day before the change: never served again for it.
    const again = await reads.moves(REPO).catch((e) => e);
    expect(again.message).toMatch(/move 1 clears 2 results and 1 alerts name it/);
    expect(pageReads(sent)).toBe(3);
    // Reopened: the alerts are the run's again, and so is the answer.
    day.pages = [alerts()];
    day.latest = [{ number: 101, state: 'open', updated_at: '2026-11-10T09:05:00Z' }];
    expect((await reads.moves(REPO)).moves[0]?.findings.map((f) => f.alert)).toEqual([101, 102]);
  });

  it('serve nothing kept while a run of the scan is going, which may have uploaded without changing an alert', async () => {
    const sent: Sent[] = [];
    const day: Day = {};
    const going: Route = {
      method: 'GET',
      path: `/repos/${REPO}/actions/runs/42000000003`,
      answer: () => ({ body: { id: 42000000003, status: 'in_progress' } }),
    };
    const reads = new ScanReads(client([going, ...routes(day)], sent).github);
    await reads.moves(REPO);
    // Run 3 is going, and its upload names it in each alert it saw again: GitHub changes no alert's time for that.
    day.going = [fixture('runs.json').workflow_runs[1]];
    day.pages = [withText(101, (t) => t.replace('run 42000000001', 'run 42000000003'))];
    for (let i = 0; i < 2; i++)
      expect(await reads.moves(REPO).catch((e) => e)).toMatchObject({ kind: 'read-again', status: 409 });
    expect(pageReads(sent)).toBe(3);
    // Going and not yet uploaded: read whole, as the day it is, and not kept while the run goes.
    day.pages = [alerts()];
    await reads.moves(REPO);
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(5);
    // A pull request's run, or a fork's, going is not the scan's.
    day.going = [fixture('runs.json').workflow_runs[0], fixture('runs.json').workflow_runs[2]].map((run) => ({
      ...run,
      status: 'in_progress',
    }));
    await reads.moves(REPO);
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(6);
  });

  it('keep a read under the last change’s time alone, whichever of the alerts changed then GitHub names', async () => {
    const sent: Sent[] = [];
    const day: Day = {};
    const reads = new ScanReads(client(routes(day), sent).github);
    await reads.moves(REPO);
    // Forty dismissed in one second: GitHub may name any of them.
    day.latest = [{ ...LATEST[0], number: 117, state: 'fixed' }];
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(1);
  });

  it('keep no read whose last change is under a minute old, or whose time GitHub does not give', async () => {
    const sent: Sent[] = [];
    const changed = Date.parse(LATEST[0]?.updated_at ?? '');
    let now = changed + 10_000;
    const reads = new ScanReads(client(routes(), sent).github, { now: () => now });
    await reads.moves(REPO);
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(2);
    now = changed + SETTLED_MS;
    await reads.moves(REPO);
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(3);
    const untimed: Sent[] = [];
    const without = new ScanReads(client(routes({ latest: [{ number: 104, state: 'open' }] }), untimed).github);
    await without.moves(REPO);
    await without.moves(REPO);
    expect(pageReads(untimed)).toBe(2);
  });

  it('serve no kept read past its artifact’s expiry', async () => {
    const sent: Sent[] = [];
    const expires = Date.parse(fixture('artifacts.json').artifacts[0].expires_at);
    let now = expires - 1;
    const reads = new ScanReads(client(routes(), sent).github, { now: () => now });
    await reads.moves(REPO);
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(1);
    now = expires;
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(2);
  });

  it('keep no read that failed part way, and read whole the next time', async () => {
    const sent: Sent[] = [];
    const day: Day = { pages: [alerts().filter((a) => a.number !== 104)] };
    const reads = new ScanReads(client(routes(day), sent).github);
    expect((await reads.moves(REPO).catch((e) => e)).message).toMatch(/move 2 clears 2 results and 1 alerts name it/);
    day.pages = [alerts()];
    expect((await reads.moves(REPO)).moves[1]?.findings.map((f) => f.alert)).toEqual([103, 104]);
    expect(pageReads(sent)).toBe(2);
  });

  /** A reader whose pages of alerts wait for `open()`, as a read of a hundred pages is still going. */
  function held(day: Day, sent: Sent[]) {
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const fake = fakeGitHub(routes(day), sent);
    const github = new GitHub({
      credentials: { clientId: CLIENT_ID, privateKey: PRIVATE_KEY },
      api: 'https://api.github.test',
      log: quiet,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('code-scanning/alerts?state=open')) await gate;
        return fake.fetch(input, init);
      }) as typeof fetch,
      sleep: async () => {},
    });
    return { reads: new ScanReads(github), open };
  }

  it('share one read in flight between callers at once', async () => {
    const sent: Sent[] = [];
    const { reads, open } = held({}, sent);
    const both = Promise.all([reads.moves(REPO), reads.moves(REPO)]);
    await new Promise((resolve) => setImmediate(resolve));
    open();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(pageReads(sent)).toBe(1);
  });

  it('fail every caller of a shared read that failed, and keep nothing of it', async () => {
    const sent: Sent[] = [];
    const day: Day = { pages: [alerts().filter((a) => a.number !== 104)] };
    const { reads, open } = held(day, sent);
    const both = Promise.allSettled([reads.moves(REPO), reads.moves(REPO)]);
    await new Promise((resolve) => setImmediate(resolve));
    open();
    const results = await both;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(pageReads(sent)).toBe(1);
    day.pages = [alerts()];
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(2);
  });

  it('join a later read in flight from an earlier point, and start a new one from a later point', async () => {
    const sent: Sent[] = [];
    const day: Day = { latest: [{ number: 104, state: 'open', updated_at: '2026-11-10T07:00:00Z' }] };
    const { reads, open } = held(day, sent);
    const first = reads.moves(REPO);
    await new Promise((resolve) => setImmediate(resolve));
    // A slower answer from before that change: it waits for the read already going.
    day.latest = [{ number: 104, state: 'open', updated_at: '2026-11-10T06:00:00Z' }];
    const earlier = reads.moves(REPO);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pageReads(sent)).toBe(0);
    // A change after it: a read of its own.
    day.latest = [{ number: 104, state: 'open', updated_at: '2026-11-10T08:00:00Z' }];
    const later = reads.moves(REPO);
    await new Promise((resolve) => setImmediate(resolve));
    open();
    await Promise.all([first, earlier, later]);
    expect(pageReads(sent)).toBe(2);
    // The later read is the one kept.
    await reads.moves(REPO);
    expect(pageReads(sent)).toBe(2);
  });

  it('hand each caller its own copy: one caller’s change is not the next one’s answer', async () => {
    const reads = new ScanReads(client(routes()).github);
    const first = await reads.moves(REPO);
    first.moves.length = 0;
    expect((await reads.moves(REPO)).moves).toHaveLength(2);
  });
});
