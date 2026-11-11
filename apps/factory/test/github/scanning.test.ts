import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GitHubError } from '../../src/github/client.ts';
import { branchPin, directoriesOf } from '../../src/github/dependabot.ts';
import { LiveReads } from '../../src/github/reads.ts';
import { zipEntry } from '../../src/github/zip.ts';
import { client, REPO, type Route, type Sent } from './fake.ts';

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

interface Day {
  runs?: unknown;
  artifacts?: unknown;
  moves?: unknown;
  /** Each page of alerts, in order. */
  pages?: unknown[][];
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
    ...pages.map((body, i) => ({
      method: 'GET',
      path: ALERTS_PATH(i + 1),
      answer: () => (day.refuse?.alerts ? refused : { body }),
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
    expect(image?.lockfile).toBeUndefined();
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
    expect(lockfile?.lockfile).toEqual({
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

  it('fail on a result with a fix that names no move, or a move past the list', async () => {
    await fails({ pages: [withText(101, (t) => t.replace(/ Move .*$/, ''))] }, /alert 101 has a fix and names no move/);
    await fails({ pages: [withText(101, (t) => t.replace('Move 1 of', 'Move 3 of'))] }, /alert 101 names move 3 of 2/);
  });

  it('fail when the alerts are from another run than the artifact', async () => {
    await fails(
      { pages: [withText(101, (t) => t.replace('run 42000000001', 'run 42000000003'))] },
      /alert 101 is from run 42000000003, and the artifact from run 42000000001/,
    );
    await fails({ moves: { ...fixture('moves.json'), run: '42000000000' } }, /names run 42000000000/);
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
    expect(JSON.stringify(pulls)).not.toMatch(/never read/);
  });

  it('read a branch against the directories dependabot.yml names, the longest first', () => {
    const dirs = directoriesOf('updates:\n  - package-ecosystem: docker\n    directories: [/, /apps, /apps/console]\n');
    expect(branchPin('dependabot/docker/apps/console/node-24.0.0', dirs)).toMatchObject({
      directory: '/apps/console',
      dependency: 'node',
    });
    expect(branchPin('dependabot/docker/apps/node-24.0.0', dirs)).toMatchObject({
      directory: '/apps',
      dependency: 'node',
    });
    // Without the file, only the root.
    expect(branchPin('dependabot/docker/apps/console/node-24.0.0', directoriesOf(null))).toMatchObject({
      directory: '/',
      dependency: 'apps/console/node',
    });
    expect(directoriesOf('{not: [yaml')).toEqual(new Map());
  });
});
