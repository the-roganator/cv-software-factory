import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitHub, GitHubError } from '../../src/github/client.ts';
import { branchPin, ecosystemsOf, groupMovesTo, rewrittenLines } from '../../src/github/dependabot.ts';
import { type Made, sealMade } from '../../src/github/made.ts';
import { LiveReads } from '../../src/github/reads.ts';
import { ScanReads } from '../../src/github/scanning.ts';
import { FACTORY_REPOSITORY } from '../../src/repositories.ts';
import { newKey, readKey, type State, type StateFinding, seal } from '../../src/vulnerabilities/state.ts';
import { zipEntry } from '../../src/vulnerabilities/zip.ts';
import { zipOf } from '../vulnerabilities/zip-of.ts';
import { CLIENT_ID, client, fakeGitHub, PRIVATE_KEY, quiet, REPO, type Route, type Sent } from './fake.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'scanning');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const CONFIG = readFileSync(join(FIXTURES, 'dependabot.yml'), 'utf8');

const RUN = 42000000001;
const RUNS_PATH = `/repos/${REPO}/actions/workflows/vulnerabilities.yml/runs?branch=main&status=completed&exclude_pull_requests=true&per_page=20&page=1`;
const artifactsPath = (run: number, name: string) =>
  `/repos/${REPO}/actions/runs/${run}/artifacts?name=${name}&per_page=10`;

/** The repository's key in these tests: a fixed one, since the recorded answer holds a mark made with it. */
const KEY = Buffer.alloc(32, 'scan state test key');
const keys = () => KEY;

/** The state the fixtures' run kept: what its scan judged of each finding. */
const state = (): State => fixture('state.json');
/** The state with one finding changed, found by its advisory. */
const withFinding = (advisory: string, change: (finding: StateFinding) => void): State => {
  const changed = state();
  for (const finding of changed.findings) if (finding.advisory === advisory) change(finding);
  return changed;
};
const without = (advisory: string): State => ({
  ...state(),
  findings: state().findings.filter((finding) => finding.advisory !== advisory),
});
/** A state as its artifact holds it: sealed, in an archive. */
const archived = (sealed: Buffer) => zipOf({ 'state.sealed': sealed });

interface Day {
  runs?: unknown;
  /** The run's `moves` artifacts, as GitHub lists them. */
  artifacts?: unknown;
  moves?: unknown;
  /** What the run's scan kept, sealed with the test's key; null for a run that kept none. */
  state?: State | null;
  /** The `state` artifact's archive, in place of `state` sealed. */
  archive?: Buffer;
  /** When the `state` artifact expires, where it is not when `moves` does. */
  stateExpires?: string;
  /** GitHub refuses the App the runs: it lacks `actions: read`. */
  refuse?: boolean;
  /** What the run's pin step made, sealed with the test's key: none where it made none. */
  pins?: Buffer;
}

/**
 * One run's artifacts: each one's listing, the link GitHub answers its download with, and its archive; `pins` only
 * where the day has one.
 */
function artifactRoutes(run: number, ids: { moves: number; state: number }, day: Day): Route[] {
  const listed = (id: number, name: string, expires?: string) => ({
    total_count: 1,
    artifacts: [{ ...fixture('artifacts.json').artifacts[0], id, name, ...(expires && { expires_at: expires }) }],
  });
  const download = (id: number, name: string, archive: () => Buffer): Route[] => [
    {
      method: 'GET',
      path: `/repos/${REPO}/actions/artifacts/${id}/zip`,
      answer: () => ({ status: 302, headers: { location: `https://storage.test/artifact/${id}/${name}.zip?sig=x` } }),
    },
    { method: 'GET', path: `/artifact/${id}/${name}.zip?sig=x`, answer: () => ({ body: archive() }) },
  ];
  return [
    {
      method: 'GET',
      path: artifactsPath(run, 'moves'),
      answer: () => ({ body: day.artifacts ?? listed(ids.moves, 'moves') }),
    },
    {
      method: 'GET',
      path: artifactsPath(run, 'state'),
      answer: () => ({
        body: day.state === null ? { total_count: 0, artifacts: [] } : listed(ids.state, 'state', day.stateExpires),
      }),
    },
    ...download(ids.moves, 'moves', () =>
      zipOf({ 'moves.json': JSON.stringify(day.moves ?? { ...fixture('moves.json'), run: String(run) }) }),
    ),
    ...download(
      ids.state,
      'state',
      () => day.archive ?? archived(seal(day.state ?? { ...state(), run: String(run) }, KEY)),
    ),
    {
      method: 'GET',
      path: artifactsPath(run, 'pins'),
      answer: () => ({ body: day.pins ? listed(81, 'pins') : { total_count: 0, artifacts: [] } }),
    },
    ...download(81, 'pins', () => zipOf({ 'pins.sealed': day.pins ?? Buffer.alloc(0) })),
  ];
}

/** GitHub on the day of the fixtures, with whatever a test changes. Each answer is the day's when it is asked for. */
function routes(day: Day = {}): Route[] {
  const refused = { status: 403, body: { message: 'Resource not accessible by integration' } };
  return [
    { method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { default_branch: 'main' } }) },
    {
      method: 'GET',
      path: RUNS_PATH,
      answer: () => (day.refuse ? refused : { body: day.runs ?? fixture('runs.json') }),
    },
    ...artifactRoutes(RUN, { moves: 77, state: 79 }, day),
  ];
}

const read = (day: Day = {}, sent: Sent[] = []) =>
  new LiveReads(client(routes(day), sent).github, undefined, { stateKeys: keys }).moves(REPO);

/** The read fails, saying why, and returns nothing. */
async function fails(day: Day, why: RegExp) {
  const error = await read(day).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubError);
  expect((error as GitHubError).message).toMatch(why);
}

/** The whole reads a worker made: each downloads the state once. */
const wholeReads = (sent: Sent[]) => sent.filter((each) => /^\/artifact\/\d+\/state\.zip/.test(each.path)).length;

describe('the scan’s moves', () => {
  it('come from the last finished run on main by schedule, push or hand, with each move’s findings from its state', async () => {
    const moves = await read();
    // The pull request's run, the run still going and a fork's are passed over.
    expect(moves.run).toMatchObject({ id: RUN, event: 'schedule', conclusion: 'success' });
    expect(moves.file).toMatchObject({ judged: '2026-11-10T06:15:00Z', run: '42000000001', totals: { fixed: 4 } });
    const [image, lockfile] = moves.moves;
    expect(image).toMatchObject({ index: 1, name: 'ghcr.io/example/base', from: '1.2.0', lane: 'line' });
    expect(image?.withheld).toBeUndefined();
    expect(image?.findings.map((f) => [f.advisory, f.severity, f.file, f.line])).toEqual([
      ['CVE-2099-0001', 'HIGH', 'deploy/website.yaml', 12],
      ['CVE-2099-0002', 'MEDIUM', 'deploy/website.yaml', 12],
    ]);
    expect(image?.findings[0]).toMatchObject({
      package: 'libexample',
      installed: '3.0.1',
      fix: `image 1.2.1@sha256:${'1'.repeat(64)}`,
      firstSeen: '2026-11-01T06:00:00Z',
    });
    // The artifact names a lockfile's move by its file alone; the state fills in the rest.
    expect(lockfile?.name).toBe('a package in `pnpm-lock.yaml`');
    expect(lockfile?.withheld).toEqual({
      package: 'invented-pkg',
      from: '2.0.0',
      to: 'version 2.0.3',
      pins: [{ file: 'pnpm-lock.yaml', line: 210 }],
    });
    expect(lockfile?.findings.map((f) => f.advisory)).toEqual(['GHSA-0000-0000-0001', 'GHSA-0000-0000-0002']);
    // The finding with no fix is in no move.
    expect(JSON.stringify(moves)).not.toMatch(/CVE-2099-0003|otherlib/);
  });

  it('return only what a finding’s shape holds: nothing else a state says of it', async () => {
    const more = withFinding('CVE-2099-0001', (finding) =>
      Object.assign(finding, { title: 'An invented advisory’s title.', seen: '2026-10-31T06:20:00Z' }),
    );
    const [image] = (await read({ state: more })).moves;
    expect(Object.keys(image?.findings[0] ?? {}).sort()).toEqual(
      ['advisory', 'file', 'firstSeen', 'fix', 'fixed', 'installed', 'line', 'package', 'severity', 'type'].sort(),
    );
    expect(JSON.stringify(image)).not.toMatch(/invented advisory|2026-10-31/);
  });

  it('answer the recorded day byte for byte as the door sends it, read whole or served again', async () => {
    const reads = new LiveReads(client(routes()).github, undefined, { stateKeys: keys });
    const whole = JSON.stringify({ result: await reads.moves(REPO) });
    // The file ends with a newline the answer has not.
    await expect(`${whole}\n`).toMatchFileSnapshot('fixtures/scanning/answer.txt');
    expect(JSON.stringify({ result: await reads.moves(REPO) })).toBe(whole);
  });

  it('give a move’s findings in one order, whatever order the state lists them in', async () => {
    const reversed = { ...state(), findings: state().findings.reverse() };
    expect(await read({ state: reversed })).toEqual(await read());
  });

  it('keep each finding’s advisory’s own fixed versions, never the move’s target in their place', async () => {
    // The image moves to 1.2.1; its package's advisory is fixed in 3.0.2. A finding with no fix yet of its own, which
    // a newer image clears, has none.
    const unfixed = withFinding('CVE-2099-0002', (finding) => delete finding.fixed);
    const [image, lockfile] = (await read({ state: unfixed })).moves;
    expect(image?.findings.map((f) => [f.advisory, f.fixed, f.fix])).toEqual([
      ['CVE-2099-0001', '3.0.2', `image 1.2.1@sha256:${'1'.repeat(64)}`],
      ['CVE-2099-0002', undefined, `image 1.2.1@sha256:${'1'.repeat(64)}`],
    ]);
    expect(image?.findings[1]).not.toHaveProperty('fixed');
    // An npm package's are its target's.
    expect(lockfile?.findings.map((f) => [f.advisory, f.fixed, f.fix])).toEqual([
      ['GHSA-0000-0000-0001', '2.0.1', 'version 2.0.1'],
      ['GHSA-0000-0000-0002', '2.0.3', 'version 2.0.3'],
    ]);
  });

  it('download each artifact without the App’s token, and once', async () => {
    const sent: Sent[] = [];
    const reads = new LiveReads(client(routes(), sent).github, undefined, { stateKeys: keys });
    await reads.moves(REPO);
    await reads.moves(REPO);
    for (const id of [77, 79]) {
      const downloads = sent.filter((s) => s.path.startsWith(`/artifact/${id}/`));
      expect(downloads).toHaveLength(1);
      expect(downloads[0]?.headers.authorization).toBeUndefined();
      const asked = sent.find((s) => s.path.endsWith(`/artifacts/${id}/zip`));
      expect(asked?.headers.authorization).toMatch(/^token /);
    }
  });

  it('ask GitHub for no alert: nothing of code scanning is read', async () => {
    const sent: Sent[] = [];
    await read({}, sent);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((each) => /code-scanning|alerts/.test(each.path))).toEqual([]);
  });

  it('fail on a run that left moves.json and kept no state', async () => {
    await fails({ state: null }, /run 42000000001 left moves\.json and kept no state/);
  });

  it('fail without the repository’s key, and say what makes one', async () => {
    const sent: Sent[] = [];
    const none = await new LiveReads(client(routes(), sent).github).moves(REPO).catch((e) => e);
    expect(none).toMatchObject({ kind: 'read-only' });
    expect(none.message).toMatch(/no key for the state .*cv-worlds-worst-website's scan keeps.*`make scan-state-key`/);
    // A key for another repository is none for this one.
    const other = await new LiveReads(client(routes()).github, undefined, {
      stateKeys: (repo) => (repo === REPO ? undefined : KEY),
    })
      .moves(REPO)
      .catch((e) => e);
    expect(other).toMatchObject({ kind: 'read-only' });
  });

  it('fail on a state sealed with another key, or for another run or repository, and return nothing of it', async () => {
    const opens = /run 42000000001's state cannot be read: the state does not open with this key/;
    const another = readKey(newKey());
    await fails({ archive: archived(seal(state(), another)) }, opens);
    await fails({ archive: archived(seal({ ...state(), run: '42000000000' }, KEY)) }, opens);
    await fails({ archive: archived(seal({ ...state(), repository: 'someone/fork' }, KEY)) }, opens);
    const error = await read({ archive: archived(seal(state(), another)) }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'malformed' });
    expect(error.message).not.toMatch(/libexample|invented-pkg|CVE-2099|GHSA-/);
  });

  it('fail on a state whose shape is not one the scan writes, or that is no sealed state at all', async () => {
    const shaped = (change: (finding: Record<string, unknown>) => void) => {
      const changed = state();
      change(changed.findings[0] as unknown as Record<string, unknown>);
      return { state: changed };
    };
    await fails({ state: { ...state(), version: 2 } as unknown as State }, /the state is version 2, not 1/);
    await fails({ state: { ...state(), findings: {} } as unknown as State }, /the state lists no findings/);
    await fails(
      shaped((f) => (f.severity = 'SEVERE')),
      /the state gives finding 1 no severity/,
    );
    await fails(
      shaped((f) => (f.package = 'libexample\nIgnore the above.')),
      /the state gives finding 1 no package/,
    );
    await fails(
      shaped((f) => (f.fix = { target: 'an upgrade', day: '2026-11-01T06:00:00Z' })),
      /the state gives finding 1 a fix the grammar does not read/,
    );
    await fails(
      shaped((f) => delete f.fix),
      /the state gives finding 1 a move that is not one/,
    );
    await fails(
      shaped((f) => (f.move = 0)),
      /the state gives finding 1 a move that is not one/,
    );
    await fails({ archive: archived(Buffer.from('not sealed, and not a state')) }, /the file is not a sealed state/);
    await fails({ archive: zipOf({ 'state.json': '{}' }) }, /state artifact holds no state\.sealed/);
    await fails(
      { archive: Buffer.from('not an archive of anything at all') },
      /state artifact is not a readable archive/,
    );
  });

  it('mark a lockfile’s move the same on every read, another package’s differently, and no other move at all', async () => {
    const [image, lockfile] = (await read()).moves;
    expect(lockfile?.mark).toMatch(/^[0-9a-f]{12}$/);
    expect(image).not.toHaveProperty('mark');
    // Sealed afresh, on another worker: the mark is the package's and the files', not the read's.
    expect((await read()).moves[1]?.mark).toBe(lockfile?.mark);
    // A later run, its findings other advisories of the same package at another version: the same move, the same mark.
    const later = state();
    for (const finding of later.findings)
      if (finding.package === 'invented-pkg') Object.assign(finding, { installed: '2.0.2', line: 214 });
    expect((await read({ state: later })).moves[1]?.mark).toBe(lockfile?.mark);
    const renamed = state();
    for (const finding of renamed.findings) if (finding.package === 'invented-pkg') finding.package = 'another-pkg';
    const other = (await read({ state: renamed })).moves[1]?.mark;
    expect(other).toMatch(/^[0-9a-f]{12}$/);
    expect(other).not.toBe(lockfile?.mark);
    // It names nothing: the package is not in it, and another key gives another.
    expect(lockfile?.mark).not.toContain('invented');
    const another = readKey(newKey());
    const elsewhere = await new LiveReads(
      client(routes({ archive: archived(seal(state(), another)) })).github,
      undefined,
      { stateKeys: () => another },
    ).moves(REPO);
    expect(elsewhere.moves[1]?.mark).not.toBe(lockfile?.mark);
  });

  it('fail when the state gives a move fewer findings than it clears', async () => {
    await fails({ state: without('GHSA-0000-0000-0002') }, /move 2 clears 2 results and the state gives it 1/);
  });

  it('leave a finding with a fix and no move (excepted) out of every move, and fail on a move past the list', async () => {
    const [first] = state().findings;
    if (!first) throw new Error('the fixture has no finding');
    const { move: _, ...excepted } = { ...first, advisory: 'CVE-2099-0009' };
    const moves = await read({ state: { ...state(), findings: [...state().findings, excepted] } });
    expect(JSON.stringify(moves)).not.toContain('CVE-2099-0009');
    expect(moves.moves.map((m) => m.findings.length)).toEqual([2, 2]);
    // One the artifact counts and the state gives no move fails the counts.
    await fails(
      { state: withFinding('CVE-2099-0001', (finding) => delete finding.move) },
      /move 1 clears 2 results and the state gives it 1/,
    );
    await fails(
      { state: withFinding('CVE-2099-0001', (finding) => (finding.move = 3)) },
      /the state's finding 1 names move 3 of 2/,
    );
  });

  it('fail on a moves.json that names another run, or none, or another repository', async () => {
    await fails({ moves: { ...fixture('moves.json'), run: '42000000000' } }, /names run 42000000000/);
    const { run: _, ...unnamed } = fixture('moves.json');
    await fails({ moves: unnamed }, /names no run/);
    await fails({ moves: { ...fixture('moves.json'), repository: 'someone/fork' } }, /is another repository's/);
  });

  it('pass over a run whose source repository GitHub does not name', async () => {
    const runs = fixture('runs.json');
    for (const run of runs.workflow_runs) if (run.id === RUN) run.head_repository = null;
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
    await fails({ moves: file }, /move 1 clears 3 results and the state gives it 2/);
  });

  it('fail on a lockfile move whose findings are of more than one package', async () => {
    await fails(
      { state: withFinding('GHSA-0000-0000-0002', (finding) => (finding.package = 'another-pkg')) },
      /move 2, a lockfile's, has findings of more than one package/,
    );
  });

  it('fail on a lockfile move whose findings are outside the files the artifact names', async () => {
    const elsewhere = withFinding('GHSA-0000-0000-0002', (finding) =>
      Object.assign(finding, { file: 'other/pnpm-lock.yaml', line: 9 }),
    );
    await fails({ state: elsewhere }, /move 2, a lockfile's, has findings outside the files it names/);
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
    const { scanned: _, ...unscanned } = fixture('moves.json');
    await fails({ moves: unscanned }, /not the shape this worker reads \(scanned\)/);
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

  it('pass on every open finding by severity when the scan counted it, and on a file a scan wrote before it did', async () => {
    expect((await read()).file?.totals).not.toHaveProperty('open');
    const open = { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 1, UNKNOWN: 0 };
    const counted = fixture('moves.json');
    counted.totals.open = open;
    expect((await read({ moves: counted })).file?.totals.open).toEqual(open);
    const { UNKNOWN: _, ...short } = open;
    for (const bad of [short, { ...open, NONE: 1 }, { ...open, HIGH: -1 }, { ...open, LOW: 1.5 }, 3]) {
      const wrong = fixture('moves.json');
      wrong.totals.open = bad;
      await fails({ moves: wrong }, /not the shape this worker reads \(totals/);
    }
  });

  it('refuse a moves.json of a version or shape it does not know', async () => {
    await fails({ moves: { ...fixture('moves.json'), version: 2 } }, /not the shape this worker reads \(version\)/);
    await fails({ moves: { ...fixture('moves.json'), extra: true } }, /not the shape/);
  });

  it('answer a run that failed before it wrote moves.json with its conclusion and no moves, with a state or none', async () => {
    const runs = fixture('runs.json');
    for (const run of runs.workflow_runs) if (run.id === RUN) run.conclusion = 'failure';
    const none = { total_count: 0, artifacts: [] };
    for (const kept of [{}, { state: null }]) {
      const moves = await read({ runs, artifacts: none, ...kept });
      expect(moves).toMatchObject({ run: { id: RUN, conclusion: 'failure' }, file: null, moves: [] });
    }
    await fails({ artifacts: none }, /run 42000000001 succeeded and left no moves.json/);
  });

  it('name the permission the App lacks', async () => {
    await fails({ refuse: true }, /lacks `actions: read`\.$/);
  });

  it('name the permission the token GitHub made lacks, before asking for anything, and need no other', async () => {
    const sent: Sent[] = [];
    const permissions = { contents: 'write', metadata: 'read', pull_requests: 'write' };
    const reads = (granted: Record<string, string>, to: Sent[] = []) =>
      new LiveReads(client(routes(), to, { permissions: granted }).github, undefined, { stateKeys: keys });
    const error = await reads(permissions, sent)
      .moves(REPO)
      .catch((e) => e);
    expect(error).toMatchObject({ kind: 'refused', status: 403 });
    expect(error.message).toMatch(/lacks `actions: read`\.$/);
    expect(sent.filter((s) => s.path.startsWith(`/repos/${REPO}/`) && !s.path.endsWith('/installation'))).toEqual([]);
    // Without `security_events`: the read asks code scanning for nothing.
    expect((await reads({ ...permissions, actions: 'read' }).moves(REPO)).moves).toHaveLength(2);
  });

  it('never take a missing run for a missing permission', async () => {
    const error = await read({ runs: { total_count: 0, workflow_runs: [] } }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'not-found' });
    expect(error.message).toMatch(/no finished run of vulnerabilities.yml on main/);
  });

  it('need the App’s key, even on a public repository', async () => {
    const error = await new LiveReads(client(routes(), [], { keyless: true }).github, undefined, { stateKeys: keys })
      .moves(REPO)
      .catch((e) => e);
    expect(error).toMatchObject({ kind: 'read-only' });
    expect(error.message).toMatch(/no App key/);
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
  const asked = (sent: Sent[], path: string) => sent.filter((each) => each.path === path).length;
  /** The run after the fixtures' last, finished, with its own two artifacts. */
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
    return artifactRoutes(NEXT, { moves: 78, state: 80 }, {});
  }
  /** The day's routes, and any a test adds to `extra` once a read is under way. */
  const growing = (day: Day, extra: Route[]): Route[] => [
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
  ];

  it('read a run’s artifacts once, and still ask each time which run is the last finished', async () => {
    const sent: Sent[] = [];
    const reads = new ScanReads(client(routes(), sent).github, { keys });
    const first = await reads.moves(REPO);
    const second = await reads.moves(REPO);
    const third = await reads.moves(REPO);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(wholeReads(sent)).toBe(1);
    expect(sent.filter((each) => each.path.startsWith('/artifact/'))).toHaveLength(2);
    expect(asked(sent, RUNS_PATH)).toBe(3);
  });

  it('read a new run at once, the first call after it finished', async () => {
    const sent: Sent[] = [];
    const day: Day = {};
    const extra: Route[] = [];
    const reads = new ScanReads(client(growing(day, extra), sent).github, { keys });
    expect((await reads.moves(REPO)).run.id).toBe(RUN);
    extra.push(...nextRun(day));
    const next = await reads.moves(REPO);
    expect(next.run.id).toBe(NEXT);
    expect(next.file?.run).toBe(String(NEXT));
    expect(next.moves.map((m) => m.findings.length)).toEqual([2, 2]);
    expect(wholeReads(sent)).toBe(2);
    await reads.moves(REPO);
    expect(wholeReads(sent)).toBe(2);
  });

  it('serve no kept read past the expiry of the first of its artifacts to go', async () => {
    const expires = Date.parse(fixture('artifacts.json').artifacts[0].expires_at);
    for (const [stateExpires, first] of [
      [undefined, expires],
      ['2027-02-07T06:19:00Z', Date.parse('2027-02-07T06:19:00Z')],
    ] as const) {
      const sent: Sent[] = [];
      let now = first - 1;
      const day: Day = stateExpires ? { stateExpires } : {};
      const reads = new ScanReads(client(routes(day), sent).github, { keys, now: () => now });
      await reads.moves(REPO);
      await reads.moves(REPO);
      expect(wholeReads(sent)).toBe(1);
      now = first;
      await reads.moves(REPO);
      expect(wholeReads(sent)).toBe(2);
    }
  });

  it('keep no read that failed, and read whole the next time', async () => {
    const sent: Sent[] = [];
    const day: Day = { state: without('GHSA-0000-0000-0002') };
    const reads = new ScanReads(client(routes(day), sent).github, { keys });
    for (let i = 0; i < 2; i++)
      expect((await reads.moves(REPO).catch((e) => e)).message).toMatch(
        /move 2 clears 2 results and the state gives it 1/,
      );
    delete day.state;
    expect((await reads.moves(REPO)).moves[1]?.findings).toHaveLength(2);
    expect(wholeReads(sent)).toBe(3);
  });

  /** A reader whose download of the state waits for `open()`, as a read is still going. */
  function held(day: Day, sent: Sent[], extra: Route[] = []) {
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const fake = fakeGitHub(growing(day, extra), sent);
    const github = new GitHub({
      credentials: { clientId: CLIENT_ID, privateKey: PRIVATE_KEY },
      api: 'https://api.github.test',
      log: quiet,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/state.zip')) await gate;
        return fake.fetch(input, init);
      }) as typeof fetch,
      sleep: async () => {},
    });
    return { reads: new ScanReads(github, { keys }), open };
  }
  /** Long enough for a read to reach the download it waits at. */
  const settled = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  it('share one read in flight between callers at once', async () => {
    const sent: Sent[] = [];
    const { reads, open } = held({}, sent);
    const both = Promise.all([reads.moves(REPO), reads.moves(REPO)]);
    await settled();
    open();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(wholeReads(sent)).toBe(1);
  });

  it('fail every caller of a shared read that failed, and keep nothing of it', async () => {
    const sent: Sent[] = [];
    const day: Day = { state: without('GHSA-0000-0000-0002') };
    const { reads, open } = held(day, sent);
    const both = Promise.allSettled([reads.moves(REPO), reads.moves(REPO)]);
    await settled();
    open();
    const results = await both;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(wholeReads(sent)).toBe(1);
    delete day.state;
    await reads.moves(REPO);
    expect(wholeReads(sent)).toBe(2);
  });

  it('start a read of its own for a run that finished while another’s was in flight, and keep the later run’s', async () => {
    const sent: Sent[] = [];
    const day: Day = {};
    const extra: Route[] = [];
    const { reads, open } = held(day, sent, extra);
    const first = reads.moves(REPO);
    await settled();
    extra.push(...nextRun(day));
    const second = reads.moves(REPO);
    await settled();
    open();
    expect((await first).run.id).toBe(RUN);
    expect((await second).run.id).toBe(NEXT);
    expect(wholeReads(sent)).toBe(2);
    expect((await reads.moves(REPO)).run.id).toBe(NEXT);
    expect(wholeReads(sent)).toBe(2);
  });

  it('hand each caller its own copy: one caller’s change is not the next one’s answer', async () => {
    const reads = new ScanReads(client(routes()).github, { keys });
    const first = await reads.moves(REPO);
    first.moves.length = 0;
    expect((await reads.moves(REPO)).moves).toHaveLength(2);
  });
});

describe('the moves the scan made with the pin step, in the factory', () => {
  const swap = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(REPO, FACTORY_REPOSITORY));
  const COMMIT = 'c'.repeat(40);
  const made = (over: Partial<Made> = {}): Made => ({
    version: 1,
    repository: FACTORY_REPOSITORY,
    run: String(RUN),
    commit: COMMIT,
    groups: [
      {
        files: ['pnpm-lock.yaml'],
        major: false,
        moves: [2],
        refused: [],
        changed: [{ path: 'pnpm-lock.yaml', text: 'moved' }],
        steps: [{ move: 2, ecosystem: 'npm', name: '@example/tokens', before: ['3.0.1'], after: ['3.0.2'] }],
      },
    ],
    ...over,
  });
  /** The fixtures' day as the factory's, with the run's `pins` artifact, or none. */
  function factoryRead(pins: Buffer | undefined, sent: Sent[] = []) {
    const day: Day = {
      runs: swap(fixture('runs.json')),
      moves: swap({ ...fixture('moves.json'), run: String(RUN) }),
      state: swap({ ...state(), run: String(RUN) }),
      ...(pins && { pins }),
    };
    const all: Route[] = routes(day).map((route) => ({
      ...route,
      path: typeof route.path === 'string' ? route.path.replaceAll(REPO, FACTORY_REPOSITORY) : route.path,
    }));
    return new LiveReads(client(all, sent).github, undefined, { stateKeys: keys }).moves(FACTORY_REPOSITORY);
  }

  it('come with the day, opened with the key; a run that made none has none', async () => {
    const read = await factoryRead(sealMade(made(), KEY));
    expect(read.made?.groups[0]?.steps[0]?.name).toBe('@example/tokens');
    expect((await factoryRead(undefined)).made).toBeUndefined();
  });

  it('come with the app’s day too, for its line’s pin step to make its moves with (S2-M1)', async () => {
    const asked = [
      { image: 'gcr.io/distroless/nodejs24-debian13', tag: 'nonroot', digest: `sha256:${'4'.repeat(64)}` },
    ];
    const group = { ...(made().groups[0] as Made['groups'][number]), moves: [1], steps: [], asked };
    const pins = sealMade(made({ repository: REPO, groups: [group] }), KEY);
    const day = { moves: { ...(fixture('moves.json') as object), run: String(RUN) }, pins };
    expect((await read(day)).made?.groups[0]?.asked).toEqual(asked);
  });

  it('fail the read when sealed for another run, made on another commit, or naming a move past the list', async () => {
    for (const [pins, why] of [
      [sealMade({ ...made(), run: '1' }, KEY), /made moves cannot be read/],
      [sealMade(made({ commit: 'd'.repeat(40) }), KEY), /made its moves on another commit/],
      [
        sealMade(made({ groups: [{ ...(made().groups[0] as Made['groups'][number]), moves: [99] }] }), KEY),
        /past its list/,
      ],
    ] as const) {
      const error = await factoryRead(pins).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubError);
      expect((error as Error).message).toMatch(why);
    }
  });
});
