/**
 * The pin watch in the app's repository, where it keeps issues alone (`ISSUE_REPOS`): one for each move no ticket of
 * the line's is made for, and never a branch, a commit or a pull request, whatever the day lists. And the kind of a
 * refusal of the pin step's, read from the tools' own words.
 */
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { LiveActions } from '../../src/github/actions.ts';
import { IssueGuard, openedBy } from '../../src/github/issues.ts';
import type { MadeGroup } from '../../src/github/made.ts';
import {
  ISSUE_REPOS,
  PASS_MS,
  PIN_LABEL,
  PIN_REPOS,
  type PinScope,
  pinWatch,
  refusalKind,
  resolvedPast,
} from '../../src/github/pins.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { APP_REPOSITORY, FACTORY_REPOSITORY } from '../../src/repositories.ts';
import { calls, client, quiet, type Sent } from './fake.ts';
import { digest, FakeRepo, day as factoryDay, move, writes } from './pins-harness.ts';

const APP = APP_REPOSITORY;
const DOCKERFILE = 'FROM mcr.microsoft.com/devcontainers/base:1.0-bookworm\n';

/** The app's scan's day: the factory's fixture, as the app's repository's. */
function day(scanned: string, moves: ReadMove[], run = 42_000_000_101): Moves {
  const read = factoryDay(
    scanned,
    moves.map((each) => ({ ...each, repository: APP })),
    run,
  );
  return {
    ...read,
    repository: APP,
    run: { ...read.run, url: `https://github.com/${APP}/actions/runs/${run}` },
    file: read.file && { ...read.file, repository: APP },
  };
}

/** The base image of the app's dev container, on a line its publisher no longer builds. */
const unbuilt = (): ReadMove =>
  move({
    name: 'mcr.microsoft.com/devcontainers/base',
    pins: [{ file: '.devcontainer/Dockerfile', line: 1 }],
    from: '1.0-bookworm',
    to: 'another line (this one last built 2026-05-04T08:00:00Z)',
    deadline: undefined,
    lane: 'none',
  });
/** A workflow's pin, which the App cannot write. */
const workflow = (): ReadMove =>
  move({
    name: 'actions/checkout',
    pins: [{ file: '.github/workflows/ci.yml', line: 12 }],
    from: 'v5.0.0',
    to: 'version v5.0.1',
    lane: 'issue',
  });
/** Moves the line makes from tickets, and two in lanes no scan of the app gives: none is the watch's to write. */
const others = (): ReadMove[] => [
  move({
    name: 'node',
    pins: [{ file: 'Dockerfile', line: 1 }],
    from: '24.1.0',
    to: `image 24.1.1@${digest('node')}`,
    lane: 'line',
  }),
  move({
    name: 'example/sidecar',
    pins: [{ file: 'Dockerfile', line: 1 }],
    from: '24.1.0',
    to: `image 24.1.1@${digest('sidecar')}`,
    lane: 'worker',
  }),
  move({
    name: 'a package in `pnpm-lock.yaml`',
    pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
    from: '',
    to: '',
    lockfile: true,
    lane: 'worker',
    mark: 'markapp00000',
    withheld: { package: 'example-a', from: '1.0.0', to: 'version 1.0.1', pins: [{ file: 'pnpm-lock.yaml', line: 5 }] },
  }),
  move({
    name: 'k3s',
    pins: [{ file: 'Dockerfile', line: 1 }],
    from: '24.1.0',
    to: 'k3s v1.35.0+k3s1',
    lane: 'cluster',
  }),
];

function harness(repo: FakeRepo, today: () => Moves, only: PinScope = '*') {
  const sent: Sent[] = [];
  const { github } = client(repo.routes(APP), sent);
  const actions = new LiveActions(github, { guard: new IssueGuard({ openedBy: openedBy(github) }) });
  const lines: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) });
  let clock = Date.parse('2026-11-11T07:00:00Z');
  const watch = pinWatch({ github, reads: { moves: async () => today() }, actions, log, now: () => clock, only }, APP);
  return {
    sent,
    lines,
    pass: async () => {
      clock += PASS_MS;
      await watch();
    },
  };
}

/** Every request about the repository that is not about its issues: none may be made where the watch keeps issues alone. */
const beyondIssues = (sent: Sent[]) => calls(sent).filter((s) => !s.path.startsWith(`/repos/${APP}/issues`));

describe('the pin watch in the app’s repository', () => {
  it('keeps issues there and makes moves here: the two lists share no repository', () => {
    expect(PIN_REPOS).toEqual([FACTORY_REPOSITORY]);
    expect(ISSUE_REPOS).toEqual([APP_REPOSITORY]);
    expect(() =>
      pinWatch(
        {
          github: client([]).github,
          reads: { moves: async () => day('a'.repeat(40), []) },
          actions: {} as never,
          log: quiet,
        },
        'someone/else',
      ),
    ).toThrow(/does not move someone\/else's pins, or keep its issues/);
  });

  it('opens one issue for a move on a line no longer built, in words an ordinary dependency’s issue has', async () => {
    const repo = new FakeRepo({ '.devcontainer/Dockerfile': DOCKERFILE });
    const w = harness(repo, () => day(repo.main, [unbuilt()]));
    await w.pass();
    expect(repo.issues).toHaveLength(1);
    const [issue] = repo.issues;
    expect(issue?.title).toBe('Move mcr.microsoft.com/devcontainers/base off a line no longer built');
    expect(issue?.labels).toEqual([PIN_LABEL]);
    expect(issue?.body).toBe(
      [
        '<!-- factory: pin-issue mcr.microsoft.com-devcontainers-base -->',
        '<!-- factory: pin-target another%20line%20(this%20one%20last%20built%202026-05-04T08%3A00%3A00Z) -->',
        `The scan of run [42000000101](https://github.com/${APP}/actions/runs/42000000101) lists a move the factory cannot make with a pull request of its own: \`mcr.microsoft.com/devcontainers/base\` from \`1.0-bookworm\` to \`another line (this one last built 2026-05-04T08:00:00Z)\`.`,
        '',
        'Its line is no longer built: nothing on this line will bring the fix. Move the pin to a line its publisher builds, and the scan reads it from there.',
        '',
        '**Pins**',
        '',
        '- `.devcontainer/Dockerfile:1`, pinning `1.0-bookworm`',
        '',
        '**Clears** 3 high, 5 medium; leaves nothing on the same pins.',
        '',
        '**Deadline** none.',
        '',
        'The watch keeps this issue to the scan: it updates it as the move changes, and closes it once the scan no longer lists the move.',
        '',
      ].join('\n'),
    );
    // No advisory's id, and nothing but counts of what the scan found.
    expect(issue?.body).not.toMatch(/CVE-|GHSA-/);
    expect(writes(w.sent).map((s) => `${s.method} ${s.path}`)).toEqual([`POST /repos/${APP}/issues`]);
    expect(beyondIssues(w.sent)).toEqual([]);
  });

  it('makes no branch, commit or pull request there, whatever lanes the day lists and whatever the scan made', async () => {
    const repo = new FakeRepo({ Dockerfile: 'FROM node:24.1.0\n', 'pnpm-lock.yaml': 'example-a@1.0.0\n' });
    const group: MadeGroup = {
      files: ['pnpm-lock.yaml'],
      major: false,
      moves: [3],
      refused: [],
      changed: [{ path: 'pnpm-lock.yaml', text: 'example-a@1.0.1\n' }],
      steps: [{ move: 3, ecosystem: 'npm', name: 'example-a', before: ['1.0.0'], after: ['1.0.1'] }],
    };
    const read = day(repo.main, others());
    const made = { version: 1 as const, repository: APP, run: '42000000101', commit: repo.main, groups: [group] };
    const w = harness(repo, () => ({ ...read, made }));
    await w.pass();
    await w.pass();
    expect(writes(w.sent)).toEqual([]);
    expect(beyondIssues(w.sent)).toEqual([]);
    expect(repo.issues).toEqual([]);
    expect(repo.pulls).toEqual([]);
    expect([...repo.refs.keys()]).toEqual(['main']);
  });

  it('keeps each issue to the scan: a workflow’s pin beside it, updated as the day changes, closed when its move is gone', async () => {
    const repo = new FakeRepo({ '.devcontainer/Dockerfile': DOCKERFILE });
    let moves = [unbuilt(), workflow(), ...others()];
    let run = 42_000_000_101;
    const w = harness(repo, () => day(repo.main, moves, run));
    await w.pass();
    expect(repo.issues.map((i) => i.title).sort()).toEqual([
      'Move actions/checkout to version v5.0.1',
      'Move mcr.microsoft.com/devcontainers/base off a line no longer built',
    ]);
    const pin = repo.issues.find((i) => i.title.startsWith('Move actions/checkout'));
    expect(pin?.body).toContain(
      'A workflow pins it, and the App writes no workflow: move it in a pull request of your own.',
    );
    // The next day's scan: the same issues, each naming that run; the workflow's pin moved on main, and its issue closes.
    run = 42_000_000_202;
    moves = [unbuilt()];
    await w.pass();
    expect(repo.issues).toHaveLength(2);
    expect(repo.issues.find((i) => i.title.includes('devcontainers'))).toMatchObject({ state: 'open' });
    expect(repo.issues.find((i) => i.title.includes('devcontainers'))?.body).toContain('runs/42000000202');
    expect(pin?.state).toBe('closed');
    expect(pin?.comments.at(-1)).toContain('no longer lists this move as one the App cannot make');
    expect(beyondIssues(w.sent)).toEqual([]);
    expect(repo.pulls).toEqual([]);
  });

  it('takes only the moves it is told to, as here, and none when told nothing', async () => {
    const repo = new FakeRepo({ '.devcontainer/Dockerfile': DOCKERFILE });
    const none = harness(repo, () => day(repo.main, [unbuilt(), workflow()]), []);
    await none.pass();
    expect(repo.issues).toEqual([]);
    const one = harness(repo, () => day(repo.main, [unbuilt(), workflow()]), ['actions/checkout']);
    await one.pass();
    expect(repo.issues.map((i) => i.title)).toEqual(['Move actions/checkout to version v5.0.1']);
  });
});

describe('the kind of a refusal of the pin step’s', () => {
  it('reads pnpm’s, mise’s and the step’s own words for each kind, as the step says them in one line', () => {
    // pnpm 12's report of `trustPolicy: no-downgrade`, as the step keeps it (apps/runner/test/pins.test.ts).
    expect(refusalKind('pnpm refused lefthook@2.2.2: High-risk trust downgrade (possible package takeover)')).toBe(
      'provenance',
    );
    // pnpm 12's report of a release inside `minimumReleaseAge`, joined to one line as the step joins a report.
    expect(
      refusalKind(
        'pnpm refused is-odd@3.0.1: 1 version does not meet the minimumReleaseAge constraint: is-odd@3.0.1 was published at 2026-11-24T20:04:53.306Z, within the minimumReleaseAge cutoff (2026-11-24T06:15:00.000Z)',
      ),
    ).toBe('young');
    // The step's own, of Node and of a tool mise pins.
    expect(refusalKind("Node 24.11.1 came out on 2026-11-24, within mise.toml's minimum_release_age.")).toBe('young');
    expect(refusalKind("k3d 5.9.0 came out on 2026-11-24T10:00:00Z, within mise.toml's minimum_release_age.")).toBe(
      'young',
    );
    // The step's own, of a copy its parents hold back (`PinsHeld`).
    expect(
      refusalKind(
        'zod stays at 3.25.0: demo-parent@1.0.0 admit no 4.0.0, so it needs an override in pnpm-workspace.yaml',
      ),
    ).toBe('override');
    // pnpm 12's, of a dependency whose build it was not allowed to run.
    expect(refusalKind('pnpm refused esbuild: esbuild@0.27.0 has to be built but the build scripts were ignored')).toBe(
      'script',
    );
    // Anything `mise lock` refused.
    expect(refusalKind('mise refused k3d@9.9.9: mise ERROR no release 9.9.9')).toBe('lock');
    // The step's own, of a routine update pnpm resolved past its target (apps/runner/test/pins-exact.test.ts).
    const past =
      'pnpm resolved lefthook to 2.2.3, past the 2.2.2 asked for: a routine update moves to the release the scan listed, and no further.';
    expect(refusalKind(past)).toBe('resolved');
    expect(resolvedPast(past)).toBe('2.2.3');
    expect(resolvedPast(past.replace('2.2.3', '2.2.3, 3.0.0-rc.1'))).toBe('2.2.3, 3.0.0-rc.1');
    expect(resolvedPast('pnpm refused lefthook@2.2.2: High-risk trust downgrade (possible package takeover)')).toBe(
      undefined,
    );
  });

  it('claims nothing of what it does not know, a package named for a guard among it', () => {
    for (const reason of [
      'the pin step refused it, and said nothing of why',
      'pnpm refused left-pad@1.3.1: it failed, and said nothing of why',
      'The lockfile has example-b at 2.0.1, not at 2.0.0.',
      'No manifest names sonic-boom, and pnpm moves a package to an exact version only where one does: a routine update of it cannot be held to 4.2.2.',
      'pnpm refused minimum_release_age@1.0.0: No matching version found',
      'pnpm refused trust-downgrade@1.0.0: GET https://registry.npmjs.org/trust-downgrade: Not Found - 404',
      'pnpm refused allowbuilds@2.0.0: it failed, and said nothing of why',
      // The step's other refusal of a routine update's copy, and a line that only has the words in it.
      'lefthook resolves to 2.2.0 where a manifest names it, not to 2.2.2: a routine update moves to exactly the release the scan listed.',
      'pnpm refused resolved@1.0.0: pnpm resolved it to 1.0.1, past the 1.0.0 asked for: a routine update',
      'pnpm resolved lefthook to `x` [y](z), past the 2.2.2 asked for: a routine update moves to the release the scan listed, and no further.',
      '',
    ])
      expect(refusalKind(reason), reason).toBe('other');
  });
});
