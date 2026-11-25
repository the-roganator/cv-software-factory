/**
 * Dependabot's pull request for versions `main` already has, closed by the worker (`duplicates.ts`): the one close of
 * a pull request the App did not open. A fake GitHub holds `main`'s files, one pull request with the patches GitHub
 * would send of it, its comments and its events; each thing that could make the worker close a pull request that is
 * not a stale duplicate is tried alone against one that closes.
 */
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { LiveActions } from '../../src/github/actions.ts';
import { BranchRefused } from '../../src/github/branches.ts';
import { GitHubError } from '../../src/github/client.ts';
import {
  appliedIn,
  changesOf,
  closeDuplicate,
  duplicateComment,
  duplicateWatch,
  MAIN_HAS_IT,
} from '../../src/github/duplicates.ts';
import {
  APP_USER,
  DEPENDABOT_USER,
  type IssueAction,
  IssueGuard,
  IssueRefused,
  MARTIN,
  openedBy,
} from '../../src/github/issues.ts';
import { treeSource } from '../../src/github/pin-guard.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker } from '../../src/github/worker-client.ts';
import { APP_REPOSITORY, FACTORY_REPOSITORY } from '../../src/repositories.ts';
import { doorReads } from './door-reads.ts';
import { calls, client, quiet, type Route, type Sent } from './fake.ts';
import { records } from './issues-harness.ts';

const REPO = FACTORY_REPOSITORY;
const NUMBER = 1158;
const HEAD = 'a'.repeat(40);
const PUSHED = 'b'.repeat(40);
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

const OLD = 'sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe';
const NEW = 'sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579';

/** `main` after the factory's own move of Playwright, and of Node since: the context Dependabot's patch shows has moved on. */
const MAIN: Record<string, string> = {
  'apps/factory/Dockerfile.browser': [
    "# glibc build runs on the Playwright image's Ubuntu.",
    'FROM node:24.22.3-trixie-slim@sha256:4d00 AS node',
    '',
    `FROM mcr.microsoft.com/playwright:v1.65.1-noble@${NEW} AS browsers`,
    '',
    '# Playwright’s browsers on mise.toml’s Node.',
    '',
  ].join('\n'),
  'apps/factory/package.json': [
    '{',
    '  "dependencies": {',
    '    "pixelmatch": "^8.0.0",',
    '    "playwright": "^1.65.1",',
    '    "pngjs": "^7.0.0"',
    '  }',
    '}',
    '',
  ].join('\n'),
};

/** Dependabot's patches of the same move, made before either: each a version rewritten in place. */
const DOCKER_PATCH = [
  '@@ -23,7 +23,7 @@',
  " # glibc build runs on the Playwright image's Ubuntu.",
  ' FROM node:24.22.2-trixie-slim@sha256:0820 AS node',
  ' ',
  `-FROM mcr.microsoft.com/playwright:v1.65.0-noble@${OLD} AS browsers`,
  `+FROM mcr.microsoft.com/playwright:v1.65.1-noble@${NEW} AS browsers`,
  ' ',
  ' # Playwright’s browsers on mise.toml’s Node.',
].join('\n');
const PACKAGE_PATCH = [
  '@@ -39,7 +39,7 @@',
  '     "pixelmatch": "^8.0.0",',
  '-    "playwright": "^1.65.0",',
  '+    "playwright": "^1.65.1",',
  '     "pngjs": "^7.0.0"',
].join('\n');

interface File {
  filename: string;
  status?: string;
  patch?: string;
}

/** GitHub as the close finds it, each part a test may change, and what to do just before a request is answered. */
interface World {
  main: string;
  files: Record<string, string>;
  truncated: boolean;
  pull: {
    state: string;
    /** Who opened it, as the issues API says, and as the pulls API does. */
    by: number;
    pullsBy?: number;
    ref: string;
    sha: string;
    from: string;
    base: string;
    into: string;
    files: File[];
    changedFiles?: number;
  };
  comments: { body: string; by: number }[];
  events: { event: string; by: number }[];
  /** Each line of a file's blame: the pull request that merged it, or a commit with none. */
  blame: Record<string, { from: number; to: number; pull?: number; commit?: string }[]> | 'fails';
  before?: (sent: Sent) => void;
}

function world(over: Partial<World['pull']> = {}): World {
  return {
    main: 'c'.repeat(40),
    files: { ...MAIN },
    truncated: false,
    pull: {
      state: 'open',
      by: DEPENDABOT_USER,
      ref: 'dependabot/playwright-d631276117',
      sha: HEAD,
      from: REPO,
      base: 'main',
      into: REPO,
      files: [
        { filename: 'apps/factory/Dockerfile.browser', patch: DOCKER_PATCH },
        { filename: 'apps/factory/package.json', patch: PACKAGE_PATCH },
      ],
      ...over,
    },
    comments: [],
    events: [],
    blame: {
      'apps/factory/Dockerfile.browser': [{ from: 1, to: 9, pull: 1210 }],
      'apps/factory/package.json': [
        { from: 1, to: 3, commit: 'e'.repeat(40) },
        { from: 4, to: 4, pull: 1210 },
        { from: 5, to: 9, commit: 'e'.repeat(40) },
      ],
    },
  };
}

function routes(w: World, repo = REPO): Route[] {
  const at = `/repos/${repo}`;
  const pull = () => ({
    number: NUMBER,
    state: w.pull.state,
    user: { id: w.pull.pullsBy ?? w.pull.by },
    changed_files: w.pull.changedFiles ?? w.pull.files.length,
    head: { ref: w.pull.ref, sha: w.pull.sha, repo: { full_name: w.pull.from } },
    base: { ref: w.pull.base, repo: { full_name: w.pull.into } },
  });
  const answer =
    (body: () => unknown, status = 200) =>
    (sent: Sent) => {
      w.before?.(sent);
      return { status, body: body() };
    };
  return [
    {
      method: 'GET',
      path: `${at}/issues/${NUMBER}`,
      answer: answer(() => ({ user: { id: w.pull.by }, pull_request: {} })),
    },
    { method: 'GET', path: `${at}/pulls/${NUMBER}`, answer: answer(pull) },
    { method: 'GET', path: new RegExp(`^${at}/pulls\\?state=open.*page=1$`), answer: answer(() => [pull()]) },
    {
      method: 'GET',
      path: new RegExp(`^${at}/pulls/${NUMBER}/files\\?`),
      answer: answer(() => w.pull.files.map((file) => ({ status: 'modified', ...file }))),
    },
    { method: 'GET', path: `${at}/git/ref/heads/main`, answer: answer(() => ({ object: { sha: w.main } })) },
    {
      method: 'GET',
      path: new RegExp(`^${at}/git/trees/`),
      answer: answer(() => ({
        truncated: w.truncated,
        tree: Object.entries(w.files).map(([path, text]) => ({ path, mode: '100644', type: 'blob', sha: sha1(text) })),
      })),
    },
    {
      method: 'GET',
      path: new RegExp(`^${at}/git/blobs/`),
      answer: (sent) => {
        w.before?.(sent);
        const text = Object.values(w.files).find((each) => sha1(each) === sent.path.split('/').at(-1));
        return { body: { encoding: 'base64', content: Buffer.from(text ?? '').toString('base64') } };
      },
    },
    {
      method: 'GET',
      path: new RegExp(`^${at}/issues/${NUMBER}/comments`),
      answer: answer(() => w.comments.map((each) => ({ body: each.body, user: { id: each.by } }))),
    },
    {
      method: 'GET',
      path: new RegExp(`^${at}/issues/${NUMBER}/events`),
      answer: answer(() => w.events.map((each) => ({ event: each.event, actor: { id: each.by } }))),
    },
    {
      method: 'POST',
      path: '/graphql',
      answer: (sent) => {
        w.before?.(sent);
        if (w.blame === 'fails') return { body: { errors: [{ message: 'blame timed out' }] } };
        const { path } = (sent.body as { variables: { path: string } }).variables;
        const ranges = (w.blame[path] ?? []).map((each) => ({
          startingLine: each.from,
          endingLine: each.to,
          commit: {
            oid: each.commit ?? 'd'.repeat(40),
            associatedPullRequests: {
              nodes: each.pull ? [{ number: each.pull, merged: true, baseRefName: 'main' }] : [],
            },
          },
        }));
        return { body: { data: { repository: { object: { blame: { ranges } } } } } };
      },
    },
    {
      method: 'POST',
      path: `${at}/issues/${NUMBER}/comments`,
      answer: (sent) => {
        w.comments.push({ body: (sent.body as { body: string }).body, by: APP_USER });
        return { status: 201, body: {} };
      },
    },
    {
      method: 'PATCH',
      path: `${at}/pulls/${NUMBER}`,
      answer: (sent) => {
        w.pull.state = (sent.body as { state: string }).state;
        w.events.push({ event: 'closed', by: APP_USER });
        return { body: {} };
      },
    },
  ];
}

function harness(w: World, repo = REPO) {
  const sent: Sent[] = [];
  const { github } = client(routes(w, repo), sent);
  const guard = new IssueGuard({ openedBy: openedBy(github) });
  const deps = { github, guard, source: treeSource(github) };
  /** What was written to GitHub: a comment's words, or a close. */
  const written = () =>
    calls(sent)
      .filter((s) => s.method !== 'GET' && s.path !== '/graphql')
      .map((s) => `${s.method} ${s.path}`);
  return { sent, github, guard, deps, written, close: () => closeDuplicate(deps, repo, NUMBER) };
}

const COMMENT = `POST /repos/${REPO}/issues/${NUMBER}/comments`;
const CLOSE = `PATCH /repos/${REPO}/pulls/${NUMBER}`;

describe('a patch’s changes, and whether a file has them', () => {
  it('reads each run of removed and added lines between context, and none of a thing that is no patch', () => {
    expect(changesOf(PACKAGE_PATCH)).toEqual([
      { removed: ['    "playwright": "^1.65.0",'], added: ['    "playwright": "^1.65.1",'] },
    ]);
    expect(changesOf('@@ -1,3 +1,4 @@\n a\n+b\n c\n-d\n+e\n\\ No newline at end of file')).toEqual([
      { removed: [], added: ['b'] },
      { removed: ['d'], added: ['e'] },
    ]);
    expect(changesOf('Binary files differ')).toBeUndefined();
    expect(changesOf('@@ -1 +1 @@\n a')).toBeUndefined();
    expect(changesOf('@@ -1 +1 @@\n-a\n+b\n*c')).toBeUndefined();
  });

  it('has a change when its added lines are there together and its removed lines nowhere, whatever is around them', () => {
    const [bump] = changesOf(PACKAGE_PATCH) ?? [];
    const lines = (MAIN['apps/factory/package.json'] ?? '').split('\n');
    expect(appliedIn(lines, bump ? [bump] : [])).toEqual([4]);
    // The version before, still there: not moved.
    expect(appliedIn(['    "playwright": "^1.65.0",'], bump ? [bump] : [])).toMatch(/^it has no /);
    // A later version: main has moved past it, and has not this line.
    expect(appliedIn(['    "playwright": "^1.66.0",'], bump ? [bump] : [])).toMatch(/^it has no /);
    // Two lines added together are there together, in order.
    const two = [{ removed: [], added: ['a', 'b'] }];
    expect(appliedIn(['a', 'b'], two)).toEqual([1, 2]);
    expect(appliedIn(['a', 'x', 'b'], two)).toMatch(/^it has no /);
    // Changes are found one after another: the second not before the first.
    const order = [
      { removed: [], added: ['b'] },
      { removed: [], added: ['a'] },
    ];
    expect(appliedIn(['a', 'b'], order)).toMatch(/^it has no "a"/);
    expect(appliedIn(['b', 'a'], order)).toEqual([1, 2]);
  });

  it('does not take a pin moved at one place for one moved at another like it', () => {
    // Two charts pinned alike in one file; main has moved the second, and the pull request moves the first.
    const patch = '@@ -1,3 +1,3 @@\n   chart: first\n-  targetRevision: 10.19.0\n+  targetRevision: 10.20.0';
    const main = ['  chart: first', '  targetRevision: 10.19.0', '  chart: second', '  targetRevision: 10.20.0'];
    expect(appliedIn(main, changesOf(patch) ?? [])).toBe('it still has "  targetRevision: 10.19.0"');
    main[1] = '  targetRevision: 10.20.0';
    expect(appliedIn(main, changesOf(patch) ?? [])).toEqual([2]);
  });
});

describe('closing Dependabot’s duplicate of what main has', () => {
  it('says so once, naming what brought each version to main, and closes it, and writes nothing else', async () => {
    const w = world();
    const h = harness(w);
    expect(await h.close()).toEqual({ closed: true, main: w.main, head: HEAD, brought: ['#1210'] });
    expect(h.written()).toEqual([COMMENT, CLOSE]);
    expect(w.comments).toEqual([
      {
        by: APP_USER,
        body: '`main` already has every version this moves: they came with #1210. Nothing is left for this pull request to move, so the factory closes it. Closing it tells Dependabot not to propose these versions again, which is right while `main` has them.',
      },
    ]);
    expect(w.comments[0]?.body.startsWith(MAIN_HAS_IT)).toBe(true);
    expect(w.pull.state).toBe('closed');
    // Asked again: it is not open, and nothing is said or done.
    expect(await h.close()).toMatchObject({ closed: false, final: true });
    expect(h.written()).toEqual([COMMENT, CLOSE]);
  });

  it('names a commit where no pull request brought the lines, each merge once, and nothing where blame gives none', async () => {
    expect(duplicateComment(['#12', '#15', '0123456789ab'])).toContain(
      `${MAIN_HAS_IT}: they came with #12, #15 and 0123456789ab. `,
    );
    expect(duplicateComment(['#1', '#2', '#3', '#4', '#5', '#6', '#7'])).toContain('#4, #5 and 2 more. ');
    expect(duplicateComment([])).toMatch(/^`main` already has every version this moves\. Nothing is left/);
    const w = world();
    w.blame = { 'apps/factory/package.json': [{ from: 1, to: 9, commit: 'e'.repeat(40) }] };
    const h = harness(w);
    expect(await h.close()).toMatchObject({ closed: true, brought: ['eeeeeeeeeeee'] });
    // Blame that fails holds nothing up: the close says what it knows.
    const unknown = world();
    unknown.blame = 'fails';
    expect(await harness(unknown).close()).toMatchObject({ closed: true, brought: [] });
    expect(unknown.comments[0]?.body).toMatch(/^`main` already has every version this moves\. /);
  });

  it('closes one with no change left at all', async () => {
    const w = world({ files: [] });
    const h = harness(w);
    expect(await h.close()).toMatchObject({ closed: true });
    expect(h.written()).toEqual([COMMENT, CLOSE]);
  });

  it('never closes one that still moves anything: a version main lacks in any file, or one main has moved past or back from', async () => {
    const still: [string, (w: World) => void][] = [
      [
        'one file of two not moved',
        (w) => {
          w.files['apps/factory/package.json'] = (MAIN['apps/factory/package.json'] ?? '').replace('1.65.1', '1.65.0');
        },
      ],
      [
        'main moved past it',
        (w) => {
          w.files['apps/factory/package.json'] = (MAIN['apps/factory/package.json'] ?? '').replace('1.65.1', '1.66.0');
        },
      ],
      [
        'a digest main has not',
        (w) => {
          w.files['apps/factory/Dockerfile.browser'] = (MAIN['apps/factory/Dockerfile.browser'] ?? '').replace(
            NEW,
            OLD,
          );
        },
      ],
      [
        'a file main has not',
        (w) => {
          delete w.files['apps/factory/package.json'];
        },
      ],
      [
        'a file it deletes that main still has',
        (w) => {
          w.pull.files.push({ filename: 'apps/factory/Dockerfile.browser', status: 'removed' });
          w.pull.files.shift();
        },
      ],
      [
        'the old line beside the new',
        (w) => {
          w.files['apps/factory/package.json'] = (MAIN['apps/factory/package.json'] ?? '').replace(
            '    "playwright": "^1.65.1",',
            '    "playwright": "^1.65.1",\n    "playwright": "^1.65.0",',
          );
        },
      ],
    ];
    for (const [what, change] of still) {
      const w = world();
      change(w);
      const h = harness(w);
      const result = await h.close();
      expect(result, what).toMatchObject({ closed: false });
      expect('final' in result, what).toBe(false);
      expect(h.written(), what).toEqual([]);
    }
  });

  it('closes nothing it cannot read whole: no patch, a rename, a list that is not the pull request’s count, a tree cut short', async () => {
    const unread: [string, (w: World) => void][] = [
      ['no patch', (w) => w.pull.files.push({ filename: 'pnpm-lock.yaml' })],
      ['a rename', (w) => w.pull.files.push({ filename: 'b.json', status: 'renamed', patch: PACKAGE_PATCH })],
      ['a patch that does not read', (w) => w.pull.files.push({ filename: 'a.bin', patch: 'Binary files differ' })],
      ['more files than listed', (w) => Object.assign(w.pull, { changedFiles: 3 })],
      ['a list where it says none', (w) => Object.assign(w.pull, { changedFiles: 0 })],
      ['a tree cut short', (w) => Object.assign(w, { truncated: true })],
    ];
    for (const [what, change] of unread) {
      const w = world();
      change(w);
      const h = harness(w);
      expect(await h.close(), what).toMatchObject({ closed: false });
      expect(h.written(), what).toEqual([]);
    }
  });

  it('refuses a pull request of anybody but Dependabot, by numeric id, from a branch named like Dependabot’s or not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'duplicates-'));
    for (const by of [MARTIN, 4242]) {
      const w = world({ by });
      const sent: Sent[] = [];
      const { github } = client(routes(w), sent);
      const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), log: quiet });
      const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
      await expect(closeDuplicate({ github, guard, source: treeSource(github) }, REPO, NUMBER)).rejects.toBeInstanceOf(
        IssueRefused,
      );
      // Refused before the pull request itself is read, and kept.
      expect(calls(sent).map((s) => s.path)).toEqual([`/repos/${REPO}/issues/${NUMBER}`]);
    }
    expect((await records(dir)).map((r) => r.payload.action)).toEqual([
      `Close pull request #${NUMBER} in ${REPO}`,
      `Close pull request #${NUMBER} in ${REPO}`,
    ]);
    // The App's own pull request is not Dependabot's either: its close is the line's and the watches', in their words.
    const own = harness(world({ by: APP_USER }));
    await expect(own.close()).rejects.toBeInstanceOf(BranchRefused);
    expect(own.written()).toEqual([]);
    // Nor one the two APIs disagree about: each must say Dependabot.
    const forged = harness(world({ pullsBy: 4242 }));
    await expect(forged.close()).rejects.toThrow(/is not Dependabot's/);
    expect(forged.written()).toEqual([]);
  });

  it.each([
    ['from a fork’s branch of that name', { from: 'dependabot/cv-software-factory' }, /not from a branch of/],
    ['into another repository', { into: 'someone/else' }, /not from a branch of/],
    ['from a branch that is not Dependabot’s', { ref: 'factory/pin/x' }, /not one of Dependabot's branches/],
    ['from a branch that only ends as its own do', { ref: 'x/dependabot/npm_and_yarn/y-1.0.0' }, /not one of/],
    ['from the prefix alone', { ref: 'dependabot/' }, /not one of Dependabot's branches/],
    ['from a branch whose name is not plain', { ref: 'dependabot/../main' }, /not one of Dependabot's branches/],
    ['into a branch other than main', { base: 'release' }, /is into release, not main/],
  ])('refuses one %s, though main has all it changes', async (_what, over, words) => {
    const h = harness(world(over));
    const refused = await h.close().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BranchRefused);
    expect((refused as Error).message).toMatch(words);
    expect(h.written()).toEqual([]);
  });

  it('closes nothing when the pull request is pushed to while it is judged', async () => {
    const w = world();
    // A push once its files were read: what was judged is no longer what is there.
    w.before = (sent) => {
      if (sent.path.includes('/comments')) w.pull.sha = PUSHED;
    };
    const h = harness(w);
    const moved = await h.close().catch((error: unknown) => error);
    expect(moved).toBeInstanceOf(GitHubError);
    expect(moved).toMatchObject({ kind: 'conflict' });
    expect(h.written()).toEqual([]);
    expect(w.pull.state).toBe('open');
  });

  it('closes nothing when main moves while it is judged, back to where it has not the version among it', async () => {
    const w = world();
    w.before = (sent) => {
      if (sent.path.includes('/comments')) {
        w.main = 'f'.repeat(40);
        w.files['apps/factory/package.json'] = (MAIN['apps/factory/package.json'] ?? '').replace('1.65.1', '1.65.0');
      }
    };
    const h = harness(w);
    await expect(h.close()).rejects.toMatchObject({ kind: 'conflict' });
    expect(h.written()).toEqual([]);
    // Judged again at that main, it stays: main has not the version.
    delete w.before;
    expect(await h.close()).toMatchObject({ closed: false });
    expect(h.written()).toEqual([]);
  });

  it('closes nothing when it is closed, or made another’s, between the judging and the close', async () => {
    const closed = world();
    closed.before = (sent) => {
      if (sent.path.includes('/comments')) closed.pull.state = 'closed';
    };
    const a = harness(closed);
    expect(await a.close()).toMatchObject({ closed: false, final: true });
    expect(a.written()).toEqual([]);
    const rebased = world();
    rebased.before = (sent) => {
      if (sent.path.includes('/comments')) rebased.pull.base = 'release';
    };
    const b = harness(rebased);
    await expect(b.close()).rejects.toBeInstanceOf(BranchRefused);
    expect(b.written()).toEqual([]);
  });

  it('does not close or comment twice: one the App closed and anyone opened again is left as it is', async () => {
    const w = world();
    const h = harness(w);
    await h.close();
    // Martin opens it again.
    w.pull.state = 'open';
    w.events.push({ event: 'reopened', by: MARTIN });
    expect(await h.close()).toEqual({
      closed: false,
      why: 'the factory closed it once, and it was opened again',
      final: true,
    });
    expect(h.written()).toEqual([COMMENT, CLOSE]);
    expect(w.comments).toHaveLength(1);
    expect(w.pull.state).toBe('open');
  });

  it('finishes a close that failed after its comment without saying it again, and takes nobody else’s words for its own', async () => {
    const w = world();
    w.comments.push({ by: APP_USER, body: duplicateComment(['#1210']) });
    const h = harness(w);
    expect(await h.close()).toMatchObject({ closed: true });
    expect(h.written()).toEqual([CLOSE]);
    // The same words from anyone else are not the App's: it says its own, once, and closes.
    const other = world();
    other.comments.push({ by: 4242, body: duplicateComment([]) });
    other.events.push({ event: 'closed', by: MARTIN }, { event: 'reopened', by: MARTIN });
    const o = harness(other);
    expect(await o.close()).toMatchObject({ closed: true });
    expect(o.written()).toEqual([COMMENT, CLOSE]);
  });

  it('is done in the app’s repository as in this one', async () => {
    const w = world({ from: APP_REPOSITORY, into: APP_REPOSITORY });
    const h = harness(w, APP_REPOSITORY);
    expect(await closeDuplicate(h.deps, APP_REPOSITORY, NUMBER)).toMatchObject({ closed: true });
    expect(w.pull.state).toBe('closed');
  });
});

describe('the guard’s exception for Dependabot’s duplicates', () => {
  const ACTIONS: IssueAction[] = [
    'comment',
    'addLabels',
    'closeIssue',
    'reopenIssue',
    'updateIssue',
    'updatePullRequest',
    'describeDeploy',
    'readyForReview',
    'convertToDraft',
    'review',
    'resolveThreads',
    'enqueuePullRequest',
  ];

  it('passes the close for the watch of duplicates alone, and no other action for it', async () => {
    const h = harness(world());
    expect(await h.guard.check(REPO, NUMBER, 'closePullRequest', undefined, 'duplicate-watch')).toBe('dependabot');
    for (const asker of [undefined, 'worker', 'workflow-pin-watch'] as const)
      await expect(h.guard.check(REPO, NUMBER, 'closePullRequest', undefined, asker)).rejects.toBeInstanceOf(
        IssueRefused,
      );
    for (const action of ACTIONS)
      await expect(h.guard.check(REPO, NUMBER, action, 'words', 'duplicate-watch'), action).rejects.toBeInstanceOf(
        IssueRefused,
      );
  });

  it('is asked for by no worker: the actions’ own close refuses Dependabot’s, and the door serves no other', async () => {
    const w = world();
    const h = harness(w);
    const actions = new LiveActions(h.github, { guard: h.guard });
    await expect(actions.closePullRequest(REPO, NUMBER, duplicateComment([]))).rejects.toBeInstanceOf(IssueRefused);
    await expect(actions.comment(REPO, NUMBER, duplicateComment([]))).rejects.toBeInstanceOf(IssueRefused);
    const server = createWorkerServer({
      actions,
      reads: doorReads(),
      repositories: [REPO],
      health: () => ({}),
      log: quiet,
    });
    const { url } = await listenLocal(server);
    try {
      const worker = new GitHubWorker(url);
      await expect(
        worker.act('closePullRequest', REPO, { number: NUMBER, comment: duplicateComment([]) }),
      ).rejects.toMatchObject({ status: 403, kind: 'issue-refused' });
      // A request that says it is the watch is not read, and there is no action of the watch's name to ask for.
      const named = await fetch(`${url}/v1/actions/closePullRequest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: REPO, number: NUMBER, comment: 'x', asker: 'duplicate-watch' }),
      });
      expect(named.status).toBe(400);
      for (const action of ['closeDuplicate', 'duplicateWatch']) {
        const asked = await fetch(`${url}/v1/actions/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: REPO, number: NUMBER }),
        });
        expect(asked.status, action).toBe(404);
      }
    } finally {
      server.close();
    }
    expect(h.written()).toEqual([]);
    expect(w.pull.state).toBe('open');
  });
});

describe('the watch of Dependabot’s duplicates', () => {
  function watching(w: World) {
    const h = harness(w);
    const lines: { level: number; msg: string; why?: string }[] = [];
    const log = pino({ level: 'debug' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    return { ...h, lines, pass: duplicateWatch({ ...h.deps, log }, REPO) };
  }
  const judgings = (sent: Sent[]) => sent.filter((s) => s.path.includes(`/pulls/${NUMBER}/files`)).length;

  it('closes one main has all of, and says so in its log', async () => {
    const w = world();
    const h = watching(w);
    await h.pass();
    expect(h.written()).toEqual([COMMENT, CLOSE]);
    expect(h.lines.map((line) => line.msg)).toContain(
      'closed a pull request of Dependabot’s: main already has every version it moves',
    );
  });

  it('judges one that stays once at its head and main’s, and again when either moves', async () => {
    const w = world();
    w.files['apps/factory/package.json'] = (MAIN['apps/factory/package.json'] ?? '').replace('1.65.1', '1.65.0');
    const h = watching(w);
    await h.pass();
    await h.pass();
    expect(judgings(h.sent)).toBe(1);
    expect(h.written()).toEqual([]);
    // main takes the version: judged again, and closed.
    w.main = 'f'.repeat(40);
    w.files['apps/factory/package.json'] = MAIN['apps/factory/package.json'] ?? '';
    await h.pass();
    expect(judgings(h.sent)).toBe(2);
    expect(h.written()).toEqual([COMMENT, CLOSE]);
  });

  it('looks at no pull request but Dependabot’s own from its branch into main, and leaves a refused one alone after', async () => {
    for (const over of [{ by: MARTIN }, { ref: 'factory/pin/x' }, { base: 'release' }, { from: 'fork/repo' }]) {
      const h = watching(world(over));
      await h.pass();
      expect(judgings(h.sent), JSON.stringify(over)).toBe(0);
      expect(h.written()).toEqual([]);
    }
    // One the list calls Dependabot's and the pull request's own read does not: refused once, and not asked again.
    const w = world();
    const h = watching(w);
    w.before = (sent) => {
      if (sent.path.endsWith(`/pulls/${NUMBER}`)) w.pull.base = 'release';
      if (sent.path.includes('/pulls?')) w.pull.base = 'main';
    };
    await h.pass();
    await h.pass();
    expect(h.lines.filter((line) => line.msg.startsWith('refused to close'))).toHaveLength(1);
    expect(h.written()).toEqual([]);
  });
});
