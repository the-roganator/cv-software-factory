/**
 * The deploy watch's record of its commit (`WatchedHeads`) across a restart, and wherever its pull request stays as it
 * is. The helpers down to `watch` are deploys.test.ts's, as they stand (they are not exported).
 */
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { type Actions, LiveActions } from '../../src/github/actions.ts';
import { WatchedHeads } from '../../src/github/branches.ts';
import { headWait, type QueuePull } from '../../src/github/deploy-queue.ts';
import { DEPLOYS, type DeployProposals, type DeployTarget, deployWatch, type Pin } from '../../src/github/deploys.ts';
import { APP_USER } from '../../src/github/issues.ts';
import type { Registry } from '../../src/github/registry.ts';
import { type Signatures, type Signer, UnsignedError } from '../../src/github/signatures.ts';
import { calls, client, quiet, type Route, type Sent } from './fake.ts';

const [FACTORY, APP] = DEPLOYS as [DeployTarget, DeployTarget];
const [CONSOLE_PIN, FACTORY_PINS] = FACTORY.pins as [Pin, Pin];
const [_APP_PIN] = APP.pins as [Pin];
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const commit = (c: string) => c.repeat(40);
const HEAD = commit('d');

/** A pin file as `kustomize edit` writes one. */
const pinFile = (
  images: [name: string, digest: string, image: string][],
) => `apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
images:
${images.map(([name, d, image]) => `- digest: ${d}\n  name: ${name}\n  newName: ghcr.io/${image}`).join('\n')}
`;
const FACTORY_PIN = pinFile([
  ['factory', digest('1'), 'the-roganator/cv-software-factory/factory'],
  ['factory-browser', digest('2'), 'the-roganator/cv-software-factory/factory-browser'],
]);
const CONSOLE_PIN_FILE = pinFile([['console', digest('3'), 'the-roganator/cv-software-factory/console']]);
const _APP_PIN_FILE = pinFile([['website', digest('1'), 'the-roganator/cv-worlds-worst-website']]);
const BOTH = { [CONSOLE_PIN.file]: CONSOLE_PIN_FILE, [FACTORY_PINS.file]: FACTORY_PIN };
/** The body of a deploy pull request that lists what it brings already. */
const _LISTED =
  'Runs `bbbbbbb` on the local cluster.\n\n<!-- factory: brings -->\n### Pull requests\n<!-- factory: /brings -->';
const _CONSOLE_TITLE = 'chore(deploy): run console ccccccc on the local cluster';
const BOTH_TITLE = 'chore(deploy): run console ccccccc and the factory bbbbbbb on the local cluster';
/** A pin file that pins nothing yet, so it has no newer build. */
const NO_PINS = 'apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\n';

/** Main's history, oldest first, and each commit's message: main moves on to 0 with a merge that built no image. */
const HISTORY = ['a', 'b', 'c', 'd', '0'];
const MESSAGES: Record<string, string> = {
  a: 'chore(deploy): run the factory 1111111 on the local cluster (#10)',
  b: 'feat(line)!: take one ticket at a time (#12)\n\nBREAKING CHANGE: the take is a number.',
  c: 'fix(console): show the take | in <b>bold</b> (#13)',
  d: 'Tidy the docs',
  '0': 'docs: say so (#15)',
};

/** GitHub's comparison of two of main's commits: those after the first up to the second, oldest first, paged. */
const compareRoute = (repo: string, fail: () => boolean): Route => ({
  method: 'GET',
  path: new RegExp(`^/repos/${repo}/compare/`),
  answer: ({ path }) => {
    if (fail()) return { status: 502, body: { message: 'Server Error' } };
    const [, base, head, page] = /compare\/(\w+)\.\.\.(\w+)\?per_page=100&page=(\d+)$/.exec(path) ?? [];
    const of = (sha?: string) => HISTORY.findIndex((c) => commit(c) === sha);
    const range = HISTORY.slice(of(base) + 1, of(head) + 1);
    const commits = Number(page) === 1 ? range : [];
    return {
      body: {
        total_commits: range.length,
        commits: commits.map((c) => ({
          sha: commit(c),
          commit: { message: MESSAGES[c], committer: { date: `2026-11-0${HISTORY.indexOf(c) + 1}T12:00:00Z` } },
        })),
      },
    };
  },
});

interface Pull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  labels: { name: string }[];
  body?: string | null;
}

/**
 * GitHub with main at d, then c, b, a; the pin files at main's head (the factory's alone, unless it is told others); and the deploy branch's pull requests, each with its
 * head at the deploy branch, and merging cleanly unless told otherwise (null: GitHub has yet to work it out). It keeps
 * the branches and the commit each was made on, and closes an open pull request whose branch is moved to main's head,
 * with nothing left to merge, as GitHub does. Main can move on to a commit no image was built from.
 */
function github(
  target: DeployTarget,
  options: {
    pins?: Record<string, string>;
    pulls?: Pull[];
    failCommit?: boolean;
    mergeable?: boolean | null;
    /** Who opened its pull requests, by numeric id: the App's bot, unless a test says otherwise. */
    openedBy?: number;
    /** Whether GitHub fails to compare two commits, until told otherwise. */
    failCompare?: boolean;
    /** The check runs on each commit, by its SHA: none, unless a test says otherwise; a status fails the read. */
    checkRuns?: (sha: string) => unknown[] | number;
  } = {},
) {
  const { repo } = target;
  const sent: Sent[] = [];
  let failCommit = options.failCommit ?? false;
  let failCompare = options.failCompare ?? false;
  let main = HEAD;
  let mergeable = options.mergeable === undefined ? true : options.mergeable;
  const pulls = (options.pulls ?? []).map((p) => ({ ...p }));
  // The deploy branch is where the older build's commit left it, on main's head.
  const branches = new Map([[target.branch, commit('f')]]);
  // The commits the pins are made as, in turn.
  const made = ['e', '9', '8'].map(commit);
  const branchOf = (path: string) => decodeURIComponent(path.replace(/^.*\/git\/refs?\/heads\//, ''));
  const move = (branch: string, sha: string) => {
    branches.set(branch, sha);
    if (branch === target.branch && sha === main) {
      for (const p of pulls) if (p.state === 'open') p.state = 'closed';
    }
  };
  const routes: Route[] = [
    { method: 'GET', path: `/repos/${repo}/git/ref/heads/main`, answer: () => ({ body: { object: { sha: main } } }) },
    {
      method: 'GET',
      path: new RegExp(`^/repos/${repo}/commits/[0-9a-f]{40}/check-runs\\?per_page=100$`),
      answer: ({ path }) => {
        const runs = options.checkRuns?.(/commits\/([0-9a-f]{40})\//.exec(path)?.[1] ?? '') ?? [];
        return typeof runs === 'number'
          ? { status: runs, body: { message: 'Server Error' } }
          : { body: { check_runs: runs } };
      },
    },
    {
      method: 'GET',
      path: /\/contents\/.+\?ref=/,
      answer: ({ path }) => {
        expect(path.endsWith(`?ref=${main}`)).toBe(true);
        const file = path.replace(/^.*\/contents\//, '').replace(/\?.*$/, '');
        const pins = options.pins ?? { [FACTORY_PINS.file]: FACTORY_PIN };
        return { body: { content: Buffer.from(pins[file] ?? NO_PINS).toString('base64') } };
      },
    },
    {
      method: 'GET',
      path: `/repos/${repo}/commits?sha=${HEAD}&per_page=100`,
      answer: () => ({ body: ['d', 'c', 'b', 'a'].map((c) => ({ sha: commit(c) })) }),
    },
    {
      method: 'GET',
      path: `/repos/${repo}/commits?sha=${commit('0')}&per_page=100`,
      answer: () => ({ body: ['0', 'd', 'c', 'b', 'a'].map((c) => ({ sha: commit(c) })) }),
    },
    {
      method: 'GET',
      path: /\/pulls\?state=all/,
      answer: () => ({ body: pulls.map((p) => ({ ...p, head: { sha: branches.get(target.branch) } })) }),
    },
    {
      method: 'GET',
      path: /\/pulls\/\d+$/,
      answer: ({ path }) => {
        const pull = pulls.find((p) => path.endsWith(`/pulls/${p.number}`));
        return { body: { mergeable, body: pull?.body ?? null } };
      },
    },
    compareRoute(repo, () => failCompare),
    // Its deploy pull requests are the App's, as the issue guard asks before it labels or moves one.
    {
      method: 'GET',
      path: /\/issues\/\d+$/,
      answer: () => ({ body: { user: { id: options.openedBy ?? APP_USER }, pull_request: {} } }),
    },
    {
      method: 'GET',
      path: /\/git\/ref\/heads\//,
      answer: ({ path }) => {
        const sha = branches.get(branchOf(path));
        return sha ? { body: { object: { sha } } } : { status: 404, body: { message: 'Not Found' } };
      },
    },
    {
      method: 'PATCH',
      path: /\/git\/refs\/heads\//,
      answer: ({ path, body }) => {
        move(branchOf(path), (body as { sha: string }).sha);
        return { body: {} };
      },
    },
    {
      method: 'POST',
      path: `/repos/${repo}/git/refs`,
      answer: ({ body }) => {
        const { ref, sha } = body as { ref: string; sha: string };
        move(ref.replace(/^refs\/heads\//, ''), sha);
        return { status: 201, body: {} };
      },
    },
    {
      method: 'DELETE',
      path: /\/git\/refs\/heads\//,
      answer: ({ path }) => {
        branches.delete(branchOf(path));
        return { status: 204 };
      },
    },
    {
      method: 'POST',
      path: '/graphql',
      answer: ({ body }) => {
        if (failCommit) return { status: 502 };
        const { branch, expectedHeadOid } = (body as { variables: { input: CommitInput } }).variables.input;
        // GitHub commits only on a branch that is where the caller expects it.
        if (branches.get(branch.branchName) !== expectedHeadOid) return { body: { errors: [{ message: 'moved' }] } };
        const oid = made.shift() as string;
        move(branch.branchName, oid);
        return { body: { data: { createCommitOnBranch: { commit: { oid } } } } };
      },
    },
    {
      method: 'POST',
      path: `/repos/${repo}/pulls`,
      answer: () => ({ status: 201, body: { number: 70, html_url: 'u', node_id: 'n' } }),
    },
    { method: 'POST', path: /\/issues\/\d+\/labels$/, answer: () => ({ body: [] }) },
    {
      method: 'PATCH',
      path: /\/pulls\/\d+$/,
      answer: ({ path, body }) => {
        const pull = pulls.find((p) => path.endsWith(`/pulls/${p.number}`));
        if (pull) Object.assign(pull, body);
        return { body: {} };
      },
    },
  ];
  return {
    ...client(routes, sent),
    pulls,
    branches,
    recover: () => (failCommit = false),
    compares: () => (failCompare = false),
    // A merge that built no image.
    moveMain: () => (main = commit('0')),
    setMergeable: (to: boolean | null) => (mergeable = to),
  };
}

/** GHCR: the factory built from c and b, its browser image not yet from c, the console from c, and every pin from a. */
function ghcr(revision: string | ((image: string) => string) = commit('a'), later = false): Registry {
  const built: Record<string, string[]> = {
    'the-roganator/cv-software-factory/factory': ['a', 'b', 'c'].map(commit),
    'the-roganator/cv-software-factory/factory-browser': (later ? ['a', 'b', 'c'] : ['a', 'b']).map(commit),
    'the-roganator/cv-software-factory/factory-runner': ['a', 'b', 'c'].map(commit),
    'the-roganator/cv-software-factory/console': ['a', 'c'].map(commit),
    'the-roganator/cv-worlds-worst-website': ['a', 'b'].map(commit),
  };
  return {
    tags: async (image: string) => built[image] ?? [],
    // With a later build, each build's digests are its own: c's browser image `5`, b's as ever.
    digest: async (image: string, at: string) =>
      digest(
        later && at === commit('c') && image.endsWith('browser')
          ? '5'
          : image.endsWith('browser')
            ? '8'
            : image.endsWith('runner')
              ? '6'
              : '7',
      ),
    revision: async (image: string) => (typeof revision === 'string' ? revision : revision(image)),
  } as unknown as Registry;
}

const writes = (sent: Sent[]) => calls(sent).filter((s) => s.method !== 'GET');

/** The write that retitled a deploy pull request. */
const _retitle = (sent: Sent[]) =>
  writes(sent).find((s) => s.method === 'PATCH' && /\/pulls\/\d+$/.test(s.path) && 'title' in (s.body as object));

/** Each write, as its method and its path within the repository. */
const steps = (sent: Sent[]) =>
  writes(sent).map((s) => `${s.method} ${s.path.replace(/^\/repos\/[^/]+\/[^/]+\//, '').replace(/^\//, '')}`);

interface CommitInput {
  branch: { branchName: string };
  expectedHeadOid: string;
  message: { headline: string };
  fileChanges: { additions: { path: string; contents: string }[] };
}

const committed = (sent: Sent[]) => {
  const graphql = writes(sent).find((s) => s.path === '/graphql') as { body: { variables: { input: CommitInput } } };
  const input = graphql.body.variables.input;
  const files = input.fileChanges.additions.map((a) => [a.path, Buffer.from(a.contents, 'base64').toString()]);
  return { ...input, files: Object.fromEntries(files), file: files[0]?.[1] ?? '' };
};

/** Signature checks that pass for every digest but those named, and keep what they were asked. */
function signatures(unsigned: string[] = [], refused: string[] = []) {
  const asked: [image: string, digest: string, signer: Signer][] = [];
  const check: Pick<Signatures, 'verify'> = {
    verify: async (image, digest, signer) => {
      asked.push([image, digest, signer]);
      if (unsigned.includes(digest)) throw new UnsignedError('unsigned', `${image}@${digest} has no signature`);
      if (refused.includes(digest)) throw new UnsignedError('refused', `${image}@${digest} has no signature by them`);
    },
  };
  return { check, asked, unsigned };
}

const _watch = (
  gh: ReturnType<typeof github>,
  target: DeployTarget,
  registry = ghcr(),
  actions?: Actions,
  { check }: { check: Pick<Signatures, 'verify'> } = signatures(),
  log = quiet,
  now = Date.now,
  proposals?: DeployProposals,
) =>
  deployWatch(
    {
      github: gh.github,
      registry,
      signatures: check,
      actions: actions ?? new LiveActions(gh.github),
      log,
      now,
      ...(proposals ? { proposals } : {}),
    },
    target,
  );

const TITLE = 'chore(deploy): run the factory bbbbbbb on the local cluster';
const open = (title = TITLE): Pull => ({
  number: 69,
  title,
  state: 'open',
  merged_at: null,
  labels: [{ name: 'deploy: local' }],
});
const queuePull = (gh: ReturnType<typeof github>): QueuePull =>
  ({
    head: { ref: 'deploy/local', sha: gh.branches.get('deploy/local'), repo: { full_name: FACTORY.repo } },
  }) as QueuePull;

describe('the deploy watch’s record, after a restart', () => {
  it('never records a branch somebody else moved, and a restart adopts nothing', async () => {
    const gh = github(FACTORY, { pulls: [open()] });
    const heads = new WatchedHeads();
    // Before the watch has written: the branch is where an earlier worker (or anyone) left it, and no head passes.
    expect(headWait(heads, FACTORY.repo, queuePull(gh), 'not-a-deploy')).toBeDefined();
    const pass = deployWatch(
      {
        github: gh.github,
        registry: ghcr(),
        signatures: signatures().check,
        actions: new LiveActions(gh.github),
        heads,
        log: quiet,
      },
      FACTORY,
    );
    await pass();
    expect(heads.get(FACTORY.repo, 'deploy/local')).toBe(commit('e'));
    gh.branches.set('deploy/local', commit('5'));
    expect(headWait(heads, FACTORY.repo, queuePull(gh), 'not-a-deploy')).toBeDefined();
  });

  it('writes again after a restart an open deploy pull request whose pin has a newer build that was refused', async () => {
    const gh = github(FACTORY, { pulls: [open()] });
    const heads = new WatchedHeads();
    // The worker starts again: it knows no commit. The pull request runs the factory's build at b, signed; the newest,
    // at c, is signed by someone else.
    const pass = deployWatch(
      {
        github: gh.github,
        registry: ghcr(commit('a'), true),
        signatures: signatures([], [digest('5')]).check,
        actions: new LiveActions(gh.github),
        heads,
        log: quiet,
      },
      FACTORY,
    );
    for (let i = 0; i < 5; i++) await pass();
    // It writes the pull request's own build once, the build at b, and records it: the queue can add it.
    expect(steps(gh.sent).filter((x) => x.startsWith('PATCH git/refs/heads/deploy/local'))).toHaveLength(1);
    expect(committed(gh.sent).file).toContain(digest('8'));
    expect(heads.get(FACTORY.repo, 'deploy/local')).toBe(gh.branches.get('deploy/local'));
    expect(headWait(heads, FACTORY.repo, queuePull(gh), 'not-a-deploy')).toBeUndefined();
    expect(gh.pulls[0]?.title).toBe(TITLE);
  });

  it('records nothing, and says why once, when the open deploy pull request’s own build is not signed by its pipeline', async () => {
    const gh = github(FACTORY, { pins: BOTH, pulls: [open(BOTH_TITLE)] });
    const heads = new WatchedHeads();
    const said: string[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void said.push(JSON.parse(line).msg) });
    const pass = deployWatch(
      {
        github: gh.github,
        registry: ghcr(),
        signatures: signatures([], [digest('8')]).check,
        actions: new LiveActions(gh.github),
        heads,
        log,
      },
      FACTORY,
    );
    for (let i = 0; i < 5; i++) await pass();
    expect(writes(gh.sent)).toEqual([]);
    expect(heads.get(FACTORY.repo, 'deploy/local')).toBeUndefined();
    expect(said.filter((m) => /it is not queued until the watch writes it/.test(m))).toHaveLength(1);
  });

  it('two workers that both write give the deploy branch a new commit on every pass of either: never run a second', async () => {
    const gh = github(FACTORY, { pulls: [open()] });
    const make = () =>
      deployWatch(
        {
          github: gh.github,
          registry: ghcr(),
          signatures: signatures().check,
          actions: new LiveActions(gh.github),
          heads: new WatchedHeads(),
          log: quiet,
        },
        FACTORY,
      );
    const [one, two] = [make(), make()];
    const seen: (string | undefined)[] = [];
    for (const pass of [one, two, one]) {
      await pass();
      seen.push(gh.branches.get('deploy/local'));
    }
    expect(new Set(seen).size).toBe(3);
  });
});
