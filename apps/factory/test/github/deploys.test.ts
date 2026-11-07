/**
 * The deploy and release watches, through the watch itself: a fake GitHub and GHCR, and what the watch does to them.
 */
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { type Actions, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { ownsBranch } from '../../src/github/branches.ts';
import {
  type Brings,
  brings,
  bringsIn,
  bringsSection,
  carriesIn,
  carriesSection,
  conventional,
  DEPLOYS,
  DeployProposals,
  DeployRefused,
  type DeployTarget,
  deployBody,
  deployCommit,
  deployedImage,
  deployWatch,
  MAX_BROUGHT,
  MAX_RANGE_PAGES,
  newerBuild,
  type Pin,
  PinFileError,
  repin,
  SIGNING_GRACE_MS,
  scratchBranch,
  withCarries,
} from '../../src/github/deploys.ts';
import { APP_USER, IssueRefused } from '../../src/github/issues.ts';
import { type Registry, RegistryError } from '../../src/github/registry.ts';
import { releaseWatch } from '../../src/github/releases.ts';
import { pipeline, type Signatures, type Signer, UnsignedError } from '../../src/github/signatures.ts';
import { calls, client, quiet, type Route, type Sent } from './fake.ts';

const [FACTORY, APP] = DEPLOYS as [DeployTarget, DeployTarget];
const [CONSOLE_PIN, FACTORY_PINS] = FACTORY.pins as [Pin, Pin];
const [APP_PIN] = APP.pins as [Pin];
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
const APP_PIN_FILE = pinFile([['website', digest('1'), 'the-roganator/cv-worlds-worst-website']]);
const BOTH = { [CONSOLE_PIN.file]: CONSOLE_PIN_FILE, [FACTORY_PINS.file]: FACTORY_PIN };
/** The body of a deploy pull request that lists what it brings already. */
const LISTED =
  'Runs `bbbbbbb` on the local cluster.\n\n<!-- factory: brings -->\n### Pull requests\n<!-- factory: /brings -->';
const CONSOLE_TITLE = 'chore(deploy): run console ccccccc on the local cluster';
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
function ghcr(revision: string | ((image: string) => string) = commit('a')): Registry {
  const built: Record<string, string[]> = {
    'the-roganator/cv-software-factory/factory': ['a', 'b', 'c'].map(commit),
    'the-roganator/cv-software-factory/factory-browser': ['a', 'b'].map(commit),
    'the-roganator/cv-software-factory/factory-runner': ['a', 'b', 'c'].map(commit),
    'the-roganator/cv-software-factory/console': ['a', 'c'].map(commit),
    'the-roganator/cv-worlds-worst-website': ['a', 'b'].map(commit),
  };
  return {
    tags: async (image: string) => built[image] ?? [],
    digest: async (image: string) => digest(image.endsWith('browser') ? '8' : image.endsWith('runner') ? '6' : '7'),
    revision: async (image: string) => (typeof revision === 'string' ? revision : revision(image)),
  } as unknown as Registry;
}

const writes = (sent: Sent[]) => calls(sent).filter((s) => s.method !== 'GET');

/** The write that retitled a deploy pull request. */
const retitle = (sent: Sent[]) =>
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

const watch = (
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

describe('the deploy watch', () => {
  it('proposes the newest commit every pinned image was built from, at the head it read, labelled', async () => {
    const gh = github(FACTORY);
    await watch(gh, FACTORY)();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
      'POST pulls',
      'POST issues/70/labels',
      // Then, its title and branch at the build, what it brings.
      'PATCH pulls/70',
    ]);
    // The scratch branch, the commit and the pin file all come from the one head of main.
    expect(writes(gh.sent)[0]?.body).toEqual({ ref: 'refs/heads/factory/deploy/local', sha: HEAD });
    const { branch, expectedHeadOid, message, file } = committed(gh.sent);
    expect(branch.branchName).toBe('factory/deploy/local');
    expect(expectedHeadOid).toBe(HEAD);
    // The deploy branch goes to the commit, and the scratch branch is gone.
    expect(writes(gh.sent)[2]?.body).toEqual({ sha: commit('e'), force: true });
    expect([...gh.branches]).toEqual([['deploy/local', commit('e')]]);
    expect(message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
    // Only the digests change, as text.
    expect(file).toBe(FACTORY_PIN.replace(digest('1'), digest('7')).replace(digest('2'), digest('8')));
    expect(writes(gh.sent)[4]?.body).toMatchObject({
      head: 'deploy/local',
      base: 'main',
      title: message.headline,
    });
    // Opened without the list, which its next write adds.
    expect(bringsIn((writes(gh.sent)[4] as { body: { body: string } }).body.body)).toBe(false);
    const url = 'https://github.com/the-roganator/cv-software-factory';
    expect((writes(gh.sent).at(-1) as { body: { body: string } }).body.body).toBe(
      `Runs [\`bbbbbbb\`](${url}/commit/${commit('b')}) on the local cluster: [the changes since \`aaaaaaa\`](${url}/compare/${commit('a')}...${commit('b')}).

| Image | Digest |
|---|---|
| \`factory\` | \`sha256:777777777777…\` |
| \`factory-browser\` | \`sha256:888888888888…\` |

Argo CD deploys them from \`deploy/overlays/local\` once this merges. A newer build moves this pull request on rather than opening another.

<!-- factory: brings -->
### Pull requests

It brings one pull request merged since the pinned commit, newest first:

| Pull request | Type | Scope | Subject |
|---|---|---|---|
| #12 | feat! | line | take one ticket at a time |
<!-- factory: /brings -->`,
    );
    expect(writes(gh.sent)[5]?.body).toEqual({ labels: ['deploy: local'] });
  });

  it('describes one image, with no changes link when the pinned commit is not known', () => {
    const body = deployBody(APP, [
      {
        pin: APP_PIN,
        proposal: { commit: commit('c'), digests: APP_PIN.images.map((i) => ({ ...i, digest: digest('9') })) },
      },
    ]);
    expect(body).toBe(
      `Runs [\`ccccccc\`](https://github.com/the-roganator/cv-worlds-worst-website/commit/${commit('c')}) on the local cluster.

| Image | Digest |
|---|---|
| \`website\` | \`sha256:999999999999…\` |

Argo CD deploys it from \`deploy/overlays/local\` once this merges. A newer build moves this pull request on rather than opening another.`,
    );
  });

  it('names the console and the app as their titles say', async () => {
    const console = github(FACTORY, { pins: { [CONSOLE_PIN.file]: CONSOLE_PIN_FILE } });
    await watch(console, FACTORY)();
    expect(committed(console.sent).message.headline).toBe('chore(deploy): run console ccccccc on the local cluster');
    expect(Object.keys(committed(console.sent).files)).toEqual([CONSOLE_PIN.file]);
    const app = github(APP, { pins: { [APP_PIN.file]: APP_PIN_FILE } });
    await watch(app, APP)();
    expect(committed(app.sent).message.headline).toBe('chore(deploy): run bbbbbbb on the local cluster');
  });

  it('leaves out an image the pin file does not pin yet: the change that brings it in pins it', async () => {
    const later = {
      ...FACTORY_PINS,
      images: [...FACTORY_PINS.images, { name: 'later', image: 'the-roganator/cv-software-factory/later' }],
    };
    const target = { ...FACTORY, pins: [CONSOLE_PIN, later] };
    const gh = github(target);
    await watch(gh, target)();
    expect(committed(gh.sent).message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
  });

  it('moves both pin files in one commit and one pull request when both have a newer build, each at its own commit', async () => {
    const gh = github(FACTORY, { pins: BOTH });
    await watch(gh, FACTORY)();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
      'POST pulls',
      'POST issues/70/labels',
      'PATCH pulls/70',
    ]);
    const { message, files } = committed(gh.sent);
    expect(message.headline).toBe(BOTH_TITLE);
    expect(files).toEqual({
      [CONSOLE_PIN.file]: CONSOLE_PIN_FILE.replace(digest('3'), digest('7')),
      [FACTORY_PINS.file]: FACTORY_PIN.replace(digest('1'), digest('7')).replace(digest('2'), digest('8')),
    });
    const url = 'https://github.com/the-roganator/cv-software-factory';
    expect((writes(gh.sent).at(-1) as { body: { body: string } }).body.body).toBe(
      `Runs on the local cluster:

- console at [\`ccccccc\`](${url}/commit/${commit('c')}): [the changes since \`aaaaaaa\`](${url}/compare/${commit('a')}...${commit('c')})
- the factory at [\`bbbbbbb\`](${url}/commit/${commit('b')}): [the changes since \`aaaaaaa\`](${url}/compare/${commit('a')}...${commit('b')})

| Image | Digest |
|---|---|
| \`console\` | \`sha256:777777777777…\` |
| \`factory\` | \`sha256:777777777777…\` |
| \`factory-browser\` | \`sha256:888888888888…\` |

Argo CD deploys them from \`deploy/overlays/local\` once this merges. A newer build moves this pull request on rather than opening another.

<!-- factory: brings -->
### Pull requests

It brings 2 pull requests merged since the commits pinned now, newest first:

| Pull request | Reaches | Type | Scope | Subject |
|---|---|---|---|---|
| #13 | console | fix | console | show the take \\| in &lt;b&gt;bold&lt;/b&gt; |
| #12 | console, the factory | feat! | line | take one ticket at a time |
<!-- factory: /brings -->`,
    );
    // Each pin's range is read once, and a pull request both bring is listed once.
    expect(
      calls(gh.sent)
        .filter((s) => s.path.includes('/compare/'))
        .map((s) => s.path.replace(/^.*compare\//, '')),
    ).toEqual([
      `${commit('a')}...${commit('c')}?per_page=100&page=1`,
      `${commit('a')}...${commit('b')}?per_page=100&page=1`,
    ]);
  });

  it('moves the pull request for one pin file on to both when the other’s build lands, keeping its number', async () => {
    const gh = github(FACTORY, {
      pins: BOTH,
      pulls: [
        { number: 69, title: CONSOLE_TITLE, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] },
      ],
    });
    await watch(gh, FACTORY)();
    expect(steps(gh.sent)).not.toContain('POST pulls');
    expect(retitle(gh.sent)).toMatchObject({
      path: `/repos/${FACTORY.repo}/pulls/69`,
      body: { title: BOTH_TITLE },
    });
    expect(Object.keys(committed(gh.sent).files)).toEqual([CONSOLE_PIN.file, FACTORY_PINS.file]);
    expect(gh.pulls[0]?.state).toBe('open');
  });

  it('moves the pull request for both on to the one left when the other’s pin merges by other means', async () => {
    const gh = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 69, title: BOTH_TITLE, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    // The console's pin on main is its newest build already.
    await watch(
      gh,
      FACTORY,
      ghcr((image) => commit(image.endsWith('console') ? 'c' : 'a')),
    )();
    expect(retitle(gh.sent)).toMatchObject({
      path: `/repos/${FACTORY.repo}/pulls/69`,
      body: { title: 'chore(deploy): run the factory bbbbbbb on the local cluster' },
    });
    expect(Object.keys(committed(gh.sent).files)).toEqual([FACTORY_PINS.file]);
  });

  it('does not propose again a build closed beside another, nor alone, but does the other pin file’s', async () => {
    const both = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 68, title: BOTH_TITLE, state: 'closed', merged_at: null, labels: [] }],
    });
    await watch(both, FACTORY)();
    expect(writes(both.sent)).toEqual([]);
    const alone = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 68, title: CONSOLE_TITLE, state: 'closed', merged_at: null, labels: [] }],
    });
    await watch(alone, FACTORY)();
    expect(committed(alone.sent).message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
    // A merged one is no refusal.
    const merged = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 68, title: CONSOLE_TITLE, state: 'closed', merged_at: '2026-10-22T08:00:00Z', labels: [] }],
    });
    await watch(merged, FACTORY)();
    expect(committed(merged.sent).message.headline).toBe(BOTH_TITLE);
  });

  it('moves an open pull request for an older build, with its new title and body', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const label = [{ name: 'deploy: local' }];
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title: older, state: 'open', merged_at: null, labels: label }],
    });
    await watch(gh, FACTORY)();
    const update = retitle(gh.sent);
    expect(update?.path).toBe(`/repos/${FACTORY.repo}/pulls/69`);
    expect(update?.body).toMatchObject({
      title: 'chore(deploy): run the factory bbbbbbb on the local cluster',
      body: expect.stringContaining(`/commit/${commit('b')})`),
    });
    // Retitled at once, without the list, which follows in a write of its own.
    expect(bringsIn((update?.body as { body?: string } | undefined)?.body)).toBe(false);
    const listed = writes(gh.sent).at(-1) as { body: { body: string } };
    expect(Object.keys(listed.body)).toEqual(['body']);
    expect(bringsIn(listed.body.body)).toBe(true);
  });

  it('asks who opened the pull request before it moves it, and moves none the App did not open', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const label = [{ name: 'deploy: local' }];
    const pulls: Pull[] = [{ number: 69, title: older, state: 'open', merged_at: null, labels: label }];
    const own = github(FACTORY, { pulls });
    await watch(own, FACTORY)();
    expect(own.sent.some((s) => s.method === 'GET' && s.path === `/repos/${FACTORY.repo}/issues/69`)).toBe(true);
    // One opened from the deploy branch by anyone else is refused, and never retitled or rewritten.
    const theirs = github(FACTORY, { pulls, openedBy: 6206459 });
    await expect(watch(theirs, FACTORY)()).rejects.toBeInstanceOf(IssueRefused);
    expect(writes(theirs.sent).filter((s) => s.path.endsWith('/pulls/69'))).toEqual([]);
  });

  it('moves the deploy branch from the older build straight to the newer, so GitHub never closes its pull request', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title: older, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    await watch(gh, FACTORY)();
    // At main's head, the branch would have nothing to merge, and GitHub would close the pull request as the App.
    const deployBranch = writes(gh.sent).filter((s) => s.path.endsWith(`/heads/${FACTORY.branch}`));
    expect(deployBranch.map((s) => s.body)).toEqual([{ sha: commit('e'), force: true }]);
    expect(gh.pulls[0]?.state).toBe('open');
    expect(gh.branches.get(FACTORY.branch)).toBe(commit('e'));
    expect(steps(gh.sent)).not.toContain('POST pulls');
  });

  it('commits on a branch the factory owns, which nothing else of the line uses', () => {
    for (const target of DEPLOYS) {
      expect(ownsBranch(scratchBranch(target))).toBe(true);
      expect(scratchBranch(target)).not.toBe(target.branch);
    }
  });

  it('leaves one already current, adding its label if an earlier pass did not get that far', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: [], body: LISTED }],
    });
    await watch(gh, FACTORY)();
    expect(writes(gh.sent).map((s) => [s.path, s.body])).toEqual([
      [`/repos/${FACTORY.repo}/issues/69/labels`, { labels: ['deploy: local'] }],
    ]);
  });

  it('leaves its pull request behind main when main moves on with no newer build: the merge queue takes it as it is', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const label = [{ name: 'deploy: local' }];
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: label, body: LISTED }],
    });
    const pass = watch(gh, FACTORY);
    await pass();
    gh.moveMain();
    await pass();
    expect(writes(gh.sent)).toEqual([]);
    expect(gh.branches.get(FACTORY.branch)).toBe(commit('f'));
  });

  it('makes its commit again on main’s new head when its pull request conflicts with main, keeping its pull request', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const label = [{ name: 'deploy: local' }];
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: label, body: LISTED }],
    });
    const pass = watch(gh, FACTORY);
    await pass();
    gh.moveMain();
    // GitHub still answers from main before it moved, or has yet to say: nothing moves, and each pass asks again.
    await pass();
    gh.setMergeable(null);
    await pass();
    expect(writes(gh.sent)).toEqual([]);
    gh.setMergeable(false);
    await pass();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
    ]);
    const { expectedHeadOid, message } = committed(gh.sent);
    expect(expectedHeadOid).toBe(commit('0'));
    expect(message.headline).toBe(title);
    // Straight from the commit on the old head to the one on the new: the pull request stays open, one commit on main.
    expect(writes(gh.sent)[2]?.body).toEqual({ sha: commit('e'), force: true });
    expect(gh.pulls[0]?.state).toBe('open');
    // Made again at this head of main, so the next pass leaves it.
    await pass();
    expect(writes(gh.sent)).toHaveLength(4);
  });

  it('does not propose again a build whose pull request was closed without merging', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const gh = github(FACTORY, { pulls: [{ number: 68, title, state: 'closed', merged_at: null, labels: [] }] });
    await watch(gh, FACTORY)();
    expect(writes(gh.sent)).toEqual([]);
  });

  it('proposes nothing when the pin is the newest full build, or newer than any', async () => {
    for (const revision of [commit('b'), commit('d')]) {
      const gh = github(FACTORY);
      await watch(gh, FACTORY, ghcr(revision))();
      expect(writes(gh.sent)).toEqual([]);
    }
  });

  it('carries on after a failure partway: the next pass starts the scratch branch again and opens the pull request', async () => {
    const gh = github(FACTORY, { failCommit: true });
    const pass = watch(gh, FACTORY);
    await expect(pass()).rejects.toMatchObject({ kind: 'server' });
    // The deploy branch has not moved.
    expect(gh.branches.get(FACTORY.branch)).toBe(commit('f'));
    gh.recover();
    await pass();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      // The scratch branch the failed pass left is moved back to main's head.
      'PATCH git/refs/heads/factory/deploy/local',
      'POST graphql',
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
      'POST pulls',
      'POST issues/70/labels',
      'PATCH pulls/70',
    ]);
  });

  it('in a dry run, records the proposal once rather than every minute', async () => {
    const gh = github(FACTORY);
    const records: string[] = [];
    const store = {
      put: async (bytes: Uint8Array) => {
        records.push(JSON.parse(new TextDecoder().decode(bytes)).action);
        return String(records.length).padStart(64, 'f');
      },
    };
    const actions = new DryRunActions(store as never, quiet);
    const pass = watch(gh, FACTORY, ghcr(), actions);
    await pass();
    await pass();
    // Nor again as main moves on: GitHub has no pull request of the dry run's to conflict with main.
    gh.moveMain();
    await pass();
    // Opened, then its list written in.
    expect(records).toEqual([
      'setBranch',
      'commit',
      'setBranch',
      'deleteBranch',
      'openPullRequest',
      'updatePullRequest',
    ]);
    expect(writes(gh.sent)).toEqual([]);
    // Its reads find the deploy branch at the commit it would have made on main's head, and no scratch branch.
    const made = actions.branchMade(FACTORY.repo, FACTORY.branch) as string;
    expect(actions.commitMade(made)?.parent).toBe(HEAD);
    expect(actions.branchMade(FACTORY.repo, scratchBranch(FACTORY))).toBeUndefined();
  });
});

describe('the pull requests a deploy brings', () => {
  const label = [{ name: 'deploy: local' }];
  const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
  const updates = (sent: Sent[]) =>
    writes(sent).filter((s) => s.method === 'PATCH' && /\/pulls\/\d+$/.test(s.path)) as { body: { body: string } }[];

  it('opens the pull request without them when GitHub cannot compare, rather than hold the deploy back', async () => {
    const gh = github(FACTORY, { failCompare: true });
    await watch(gh, FACTORY)();
    const opened = writes(gh.sent).find((s) => s.path.endsWith('/pulls')) as { body: { body: string } };
    expect(opened.body.body).toContain('Argo CD deploys them');
    expect(bringsIn(opened.body.body)).toBe(false);
  });

  it('fills them in on an open pull request that lacks them, keeping what the line said, and then leaves it', async () => {
    const section = carriesSection([{ workItem: '1001', title: 'A ticket', issue: 16, pullRequest: 17 }]);
    const gh = github(FACTORY, {
      failCompare: true,
      pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: label, body: `Runs it.\n\n${section}` }],
    });
    const pass = watch(gh, FACTORY);
    await pass();
    expect(updates(gh.sent)).toEqual([]);
    // Read again at the same head of main, though whether it conflicts was settled.
    gh.compares();
    await pass();
    const [update] = updates(gh.sent);
    expect(Object.keys(update?.body ?? {})).toEqual(['body']);
    expect(bringsIn(update?.body.body)).toBe(true);
    expect(update?.body.body).toContain('| #12 | feat! | line | take one ticket at a time |');
    expect(carriesIn(update?.body.body)).toBe(section);
    // Listed, it is not written again.
    await pass();
    expect(updates(gh.sent)).toHaveLength(1);
  });

  it('reads nothing for a pin whose pinned commit is not known, and says its changes are not listed', async () => {
    const gh = github(APP, { pins: { [APP_PIN.file]: APP_PIN_FILE } });
    await watch(
      gh,
      APP,
      ghcr(() => undefined as unknown as string),
    )();
    expect(calls(gh.sent).filter((s) => s.path.includes('/compare/'))).toEqual([]);
    const listed = writes(gh.sent).at(-1) as { body: { body: string } };
    expect(listed.body.body).not.toContain('the changes since');
    expect(listed.body.body).toContain(
      `### Pull requests\n\nWhat the deploy brings is not listed: no commit is pinned for it to compare with.\n<!-- factory: /brings -->`,
    );
  });

  it('lists them in a dry run’s body as in a live one', async () => {
    const gh = github(FACTORY);
    const bodies: string[] = [];
    const store = {
      put: async (bytes: Uint8Array) => {
        const record = JSON.parse(new TextDecoder().decode(bytes));
        if (record.action === 'updatePullRequest') bodies.push(JSON.stringify(record));
        return '0'.repeat(64);
      },
    };
    await watch(gh, FACTORY, ghcr(), new DryRunActions(store as never, quiet))();
    const live = github(FACTORY);
    await watch(live, FACTORY)();
    const listed = writes(live.sent).at(-1) as { body: { body: string } };
    expect(bringsIn(listed.body.body)).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(JSON.stringify(listed.body.body));
  });

  it('reads the first page of a long range and then its newest, one at a time, and lists each once, newest first', async () => {
    const shas = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(40, '0'));
    const sent: Sent[] = [];
    const { github: client_ } = client(
      [
        {
          method: 'GET',
          path: /\/compare\//,
          answer: ({ path }) => {
            const page = Number(/page=(\d+)$/.exec(path)?.[1]);
            const commits = shas.slice((page - 1) * 100, page * 100).map((sha, i) => ({
              sha,
              commit: { message: `fix: number ${(page - 1) * 100 + i} (#${(page - 1) * 100 + i + 1})` },
            }));
            return { body: { total_commits: shas.length, commits } };
          },
        },
      ],
      sent,
    );
    const move = { pin: APP_PIN, proposal: { commit: commit('b'), pinned: commit('a'), digests: [] } };
    const read = await brings(client_, APP.repo, APP, [move], []);
    expect(calls(sent).map((s) => /page=(\d+)$/.exec(s.path)?.[1])).toEqual(['1', '3', '2']);
    expect(read.count).toBe(250);
    expect(read.whole).toBe(true);
    expect(read.commits.map((c) => c.sha)).toEqual([...shas].reverse());
    expect(read.commits[0]?.reaches).toEqual([APP_PIN]);
  });

  it('counts a range too long to read whole as at least the commits read', async () => {
    const total = (MAX_RANGE_PAGES + 5) * 100;
    const sent: Sent[] = [];
    const { github: client_ } = client(
      [
        {
          method: 'GET',
          path: /\/compare\//,
          answer: ({ path }) => {
            const page = Number(/page=(\d+)$/.exec(path)?.[1]);
            const commits = Array.from({ length: 100 }, (_, i) => ({
              sha: ((page - 1) * 100 + i).toString(16).padStart(40, '0'),
              commit: { message: 'fix: one' },
            }));
            return { body: { total_commits: total, commits } };
          },
        },
      ],
      sent,
    );
    const move = { pin: APP_PIN, proposal: { commit: commit('b'), pinned: commit('a'), digests: [] } };
    const read = await brings(client_, APP.repo, APP, [move], []);
    expect(calls(sent)).toHaveLength(MAX_RANGE_PAGES);
    // The commits not read may be deploy pull requests, so they are not counted.
    const listed = MAX_RANGE_PAGES * 100;
    expect(read).toMatchObject({ count: listed, whole: false });
    expect(read.commits[0]?.sha).toBe((total - 1).toString(16).padStart(40, '0'));
    expect(bringsSection(APP, read)).toContain(`It brings at least ${listed} pull requests`);
    expect(bringsSection(APP, read)).toContain(`| | | | and at least ${listed - MAX_BROUGHT} more |`);
  });

  it('orders commits from several ranges by their place on main, then by when they were committed', async () => {
    const at = (c: string, date: string) => ({ sha: commit(c), commit: { message: `fix: ${c}`, committer: { date } } });
    const ranges: Record<string, unknown[]> = {
      [commit('a')]: [
        at('1', '2026-11-01T00:00:00Z'),
        at('2', '2026-11-02T00:00:00Z'),
        at('5', '2026-11-05T00:00:00Z'),
      ],
      [commit('b')]: [
        at('3', '2026-11-03T00:00:00Z'),
        at('4', '2026-11-03T00:00:00Z'),
        at('5', '2026-11-05T00:00:00Z'),
      ],
    };
    const { github: client_ } = client([
      {
        method: 'GET',
        path: /\/compare\//,
        answer: ({ path }) => {
          const base = /compare\/(\w+)\.\.\./.exec(path)?.[1] as string;
          return { body: { total_commits: ranges[base]?.length, commits: ranges[base] } };
        },
      },
    ]);
    const moves = [
      { pin: CONSOLE_PIN, proposal: { commit: commit('5'), pinned: commit('a'), digests: [] } },
      { pin: FACTORY_PINS, proposal: { commit: commit('5'), pinned: commit('b'), digests: [] } },
    ];
    // Main's newest commits know 5 and 3 only.
    const read = await brings(client_, FACTORY.repo, FACTORY, moves, [{ sha: commit('5') }, { sha: commit('3') }]);
    expect(read.commits.map((c) => c.sha[0])).toEqual(['5', '3', '4', '2', '1']);
    expect(read.commits[0]?.reaches).toEqual([CONSOLE_PIN, FACTORY_PINS]);
    expect(read).toMatchObject({ count: 5, whole: true });
  });

  it('leaves out the deploy pull requests in its ranges, and counts them apart', async () => {
    const at = (c: string, message: string) => ({ sha: commit(c), commit: { message } });
    const { github: client_ } = client([
      {
        method: 'GET',
        path: /\/compare\//,
        answer: () => {
          const commits = [
            at('1', 'fix(github): read a polled answer through each schema (#886)'),
            at('2', 'chore(deploy): run console 1f14f44 and the factory 9e0b2d1 on the local cluster (#883)'),
            at('3', 'chore(deploy): pin flagd by digest (#887)'),
            at('4', 'chore(deploy): run the factory 2d87504 on the local cluster (#888)'),
          ];
          return { body: { total_commits: commits.length, commits } };
        },
      },
    ]);
    const moves = [{ pin: CONSOLE_PIN, proposal: { commit: commit('5'), pinned: commit('a'), digests: [] } }];
    const read = await brings(client_, FACTORY.repo, FACTORY, moves, []);
    // A person's chore(deploy) change is listed: it may change more than a pin.
    expect(read.commits.map((c) => c.sha[0])).toEqual(['3', '1']);
    expect(read).toMatchObject({ count: 2, deploys: 2, whole: true });
    const section = bringsSection(FACTORY, read);
    expect(section).toContain('It brings 2 pull requests merged since the pinned commit, newest first:');
    expect(section).not.toMatch(/#88[34]/);
  });

  it('reads a range once for the pins moved from the same commit to the same commit', async () => {
    const sent: Sent[] = [];
    const { github: client_ } = client(
      [
        {
          method: 'GET',
          path: /\/compare\//,
          answer: () => ({
            body: { total_commits: 1, commits: [{ sha: commit('5'), commit: { message: 'fix: x (#5)' } }] },
          }),
        },
      ],
      sent,
    );
    const moves = [
      { pin: CONSOLE_PIN, proposal: { commit: commit('5'), pinned: commit('a'), digests: [] } },
      { pin: FACTORY_PINS, proposal: { commit: commit('5'), pinned: commit('a'), digests: [] } },
    ];
    const read = await brings(client_, FACTORY.repo, FACTORY, moves, []);
    expect(calls(sent)).toHaveLength(1);
    expect(read.commits.map((c) => c.reaches)).toEqual([[CONSOLE_PIN, FACTORY_PINS]]);
  });

  it('says which pins it moves from no known commit, so a list of the others does not read as the whole', async () => {
    const { github: client_ } = client([
      {
        method: 'GET',
        path: /\/compare\//,
        answer: () => ({
          body: { total_commits: 1, commits: [{ sha: commit('5'), commit: { message: 'fix: x (#5)' } }] },
        }),
      },
    ]);
    const moves = [
      { pin: CONSOLE_PIN, proposal: { commit: commit('5'), pinned: commit('a'), digests: [] } },
      { pin: FACTORY_PINS, proposal: { commit: commit('5'), pinned: undefined, digests: [] } },
    ];
    const read = await brings(client_, FACTORY.repo, FACTORY, moves, []);
    expect(read.unranged).toEqual([FACTORY_PINS]);
    expect(bringsSection(FACTORY, read)).toContain(
      'What the factory brings is not listed: no commit is pinned for it to compare with.',
    );
    // Its rows still say which of the deploy's pins they reach.
    expect(bringsSection(FACTORY, read)).toContain('| #5 | console | fix | – | x |');
    expect(bringsSection(FACTORY, read)).toContain(
      'Console brings one pull request merged since the commit pinned for console, newest first:',
    );
  });

  it('reads them only once the pull request is opened at its build, so nothing slow comes between branch and title', async () => {
    const gh = github(FACTORY);
    await watch(gh, FACTORY)();
    const order = calls(gh.sent).map((s) => (s.path.includes('/compare/') ? 'compare' : `${s.method} ${s.path}`));
    const opened = order.indexOf(`POST /repos/${FACTORY.repo}/pulls`);
    expect(opened).toBeGreaterThan(order.indexOf(`PATCH /repos/${FACTORY.repo}/git/refs/heads/deploy/local`));
    expect(order.indexOf('compare')).toBeGreaterThan(opened);
  });

  it('moves the pull request at once when the read fails, and lists them on a later pass', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const gh = github(FACTORY, {
      failCompare: true,
      pulls: [{ number: 69, title: older, state: 'open', merged_at: null, labels: label }],
    });
    const pass = watch(gh, FACTORY);
    await pass();
    expect(updates(gh.sent)).toHaveLength(1);
    expect(retitle(gh.sent)?.body).toMatchObject({ title });
    gh.compares();
    const commits = () => calls(gh.sent).filter((s) => s.path === '/graphql').length;
    const before = commits();
    await pass();
    // Only the list was left: it is not moved again.
    expect(commits()).toBe(before);
    expect(bringsIn(updates(gh.sent).at(-1)?.body.body)).toBe(true);
  });

  it('says what the others bring by name when a pin has no range, and nothing for the deploy as a whole', () => {
    const read: Brings = {
      pins: [CONSOLE_PIN],
      unranged: [FACTORY_PINS],
      commits: [],
      count: 0,
      deploys: 0,
      whole: true,
    };
    expect(bringsSection(FACTORY, read)).toContain(
      'Console brings no pull request: nothing merged since the commit pinned for console.\n\nWhat the factory brings is not listed',
    );
    expect(bringsSection(FACTORY, read)).not.toContain('It brings');
  });
});

describe('the deploy watch and signatures', () => {
  it('asks that every image carry the signature of build.yml on main of the repository that built it', async () => {
    const signed = signatures();
    const gh = github(FACTORY);
    await watch(gh, FACTORY, ghcr(), undefined, signed)();
    expect(signed.asked).toEqual([
      ['the-roganator/cv-software-factory/factory', digest('7'), pipeline('the-roganator/cv-software-factory')],
      ['the-roganator/cv-software-factory/factory-browser', digest('8'), pipeline('the-roganator/cv-software-factory')],
    ]);
    expect(steps(gh.sent)).toContain('POST pulls');
    const app = github(APP, { pins: { [APP_PIN.file]: APP_PIN_FILE } });
    await watch(app, APP, ghcr(), undefined, signed)();
    expect(signed.asked.at(-1)?.[2]).toEqual(pipeline('the-roganator/cv-worlds-worst-website'));
  });

  /** A log that keeps what it was told, at info and above. */
  const kept = () => {
    const lines: { level: number; msg: string; digest?: string; reason?: string }[] = [];
    return { lines, log: pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) }) };
  };

  it('waits for a build its pipeline has not signed yet, and proposes it once it has', async () => {
    const signed = signatures([digest('8')]);
    const { lines, log } = kept();
    const gh = github(FACTORY);
    const pass = watch(gh, FACTORY, ghcr(), undefined, signed, log);
    await pass();
    await pass();
    expect(writes(gh.sent)).toEqual([]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'waiting for a build to be signed before proposing it',
        digest: digest('8'),
        reason: `the-roganator/cv-software-factory/factory-browser@${digest('8')} has no signature`,
      }),
    ]);
    signed.unsigned.length = 0;
    await pass();
    expect(steps(gh.sent)).toContain('POST pulls');
  });

  it('warns, once, of a build still unsigned when its signing should long have finished, and never proposes it', async () => {
    let clock = 0;
    const { lines, log } = kept();
    const gh = github(FACTORY);
    const pass = watch(gh, FACTORY, ghcr(), undefined, signatures([digest('8')]), log, () => clock);
    await pass();
    clock = SIGNING_GRACE_MS - 1;
    await pass();
    expect(lines.map((l) => l.level)).toEqual([30]);
    clock = SIGNING_GRACE_MS;
    await pass();
    await pass();
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      [30, 'waiting for a build to be signed before proposing it'],
      [40, 'did not propose a build its pipeline did not sign'],
    ]);
    expect(writes(gh.sent)).toEqual([]);
  });

  it('waits for one pin file’s build to be signed before proposing the other’s, and goes without it once it is late', async () => {
    let clock = 0;
    const gh = github(FACTORY, { pins: BOTH });
    const pass = watch(gh, FACTORY, ghcr(), undefined, signatures([digest('8')]), quiet, () => clock);
    await pass();
    expect(writes(gh.sent)).toEqual([]);
    clock = SIGNING_GRACE_MS;
    await pass();
    expect(committed(gh.sent).message.headline).toBe(CONSOLE_TITLE);
  });

  it('leaves the pull request as it is while it runs an older build of a pin file whose newest was refused', async () => {
    const gh = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 69, title: BOTH_TITLE, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    // The factory's newest build, b, is signed by someone else: the pull request keeps the factory at the one it runs.
    await watch(gh, FACTORY, ghcr(), undefined, signatures([], [digest('8')]))();
    expect(writes(gh.sent)).toEqual([]);
  });

  it('reads main’s commits once a pass, however many pin files it reads', async () => {
    const gh = github(FACTORY, { pins: BOTH });
    await watch(gh, FACTORY)();
    expect(calls(gh.sent).filter((c) => c.path.includes('/commits?'))).toHaveLength(1);
  });

  it('warns at once, and once, of a build signed by anyone but its pipeline', async () => {
    const { lines, log } = kept();
    const gh = github(FACTORY);
    const pass = watch(gh, FACTORY, ghcr(), undefined, signatures([], [digest('7')]), log);
    await pass();
    await pass();
    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'did not propose a build its pipeline did not sign',
        digest: digest('7'),
        reason: `the-roganator/cv-software-factory/factory@${digest('7')} has no signature by them`,
      }),
    ]);
    expect(writes(gh.sent)).toEqual([]);
  });

  it('fails the pass when a signature cannot be checked: that is not the same as unsigned', async () => {
    const gh = github(FACTORY);
    const unreachable: Pick<Signatures, 'verify'> = {
      verify: async () => {
        throw new RegistryError('ghcr.io answered 503', 503);
      },
    };
    await expect(watch(gh, FACTORY, ghcr(), undefined, { check: unreachable })()).rejects.toBeInstanceOf(RegistryError);
    expect(writes(gh.sent)).toEqual([]);
  });
});

describe('the newest build, as the line reads it', () => {
  const APP_REPO = APP.repo;
  const APP_PINS = { [APP_PIN.file]: APP_PIN_FILE };
  const WEBSITE = 'the-roganator/cv-worlds-worst-website';
  /** A check run GitHub Actions posted for one of the app's build jobs. */
  const job = (id: number, name: string, conclusion: string | null, run = 900) => ({
    id,
    name,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    app: { slug: 'github-actions' },
    html_url: `https://github.com/${APP_REPO}/actions/runs/${run}/job/${id}`,
  });

  it('says the newest build is signing, then signed, with the image it checked', async () => {
    const proposals = new DeployProposals();
    const signed = signatures([digest('7')]);
    const pass = watch(github(APP, { pins: APP_PINS }), APP, ghcr(), undefined, signed, quiet, () => 0, proposals);
    await pass();
    const base = { commit: commit('b'), pinned: commit('a'), image: WEBSITE, digest: digest('7') };
    expect(proposals.build(APP_REPO, APP.branch)).toEqual({ ...base, signature: 'signing' });
    signed.unsigned.length = 0;
    await pass();
    expect(proposals.build(APP_REPO, APP.branch)).toEqual({ ...base, signature: 'signed' });
  });

  it('says a build unsigned past the grace is, with the build job that failed on its commit, read once', async () => {
    let clock = 0;
    const proposals = new DeployProposals();
    const gh = github(APP, {
      pins: APP_PINS,
      checkRuns: (sha) =>
        sha === commit('b')
          ? [
              job(1, 'build and push', 'success'),
              job(2, 'sign and attest', 'failure'),
              // Another workflow's job, and another app's check, are not the build's.
              job(3, 'analyse', 'failure'),
              { ...job(4, 'sign and attest', 'failure'), app: { slug: 'someone-else' } },
            ]
          : [],
    });
    const pass = watch(gh, APP, ghcr(), undefined, signatures([digest('7')]), quiet, () => clock, proposals);
    await pass();
    expect(proposals.build(APP_REPO, APP.branch)?.signature).toBe('signing');
    // Nothing is read of the check runs while signing still has its time.
    expect(calls(gh.sent).filter((c) => c.path.includes('/check-runs'))).toEqual([]);
    clock = SIGNING_GRACE_MS;
    await pass();
    await pass();
    expect(proposals.build(APP_REPO, APP.branch)).toEqual({
      commit: commit('b'),
      pinned: commit('a'),
      image: WEBSITE,
      digest: digest('7'),
      signature: 'unsigned',
      reason: `${WEBSITE}@${digest('7')} has no signature`,
      job: { run: 900, id: 2, name: 'sign and attest' },
    });
    expect(calls(gh.sent).filter((c) => c.path.includes('/check-runs'))).toHaveLength(1);
    expect(writes(gh.sent)).toEqual([]);
  });

  it('says a build whose signatures are refused is, with no job when none of the build’s failed', async () => {
    const proposals = new DeployProposals();
    const gh = github(APP, { pins: APP_PINS, checkRuns: () => [job(1, 'build and push', 'success')] });
    await watch(gh, APP, ghcr(), undefined, signatures([], [digest('7')]), quiet, Date.now, proposals)();
    expect(proposals.build(APP_REPO, APP.branch)).toEqual({
      commit: commit('b'),
      pinned: commit('a'),
      image: WEBSITE,
      digest: digest('7'),
      signature: 'refused',
      reason: `${WEBSITE}@${digest('7')} has no signature by them`,
    });
  });

  it('says an unsigned build without its job while the check runs cannot be read, and reads them again', async () => {
    let fail = true;
    const proposals = new DeployProposals();
    const gh = github(APP, {
      pins: APP_PINS,
      checkRuns: () => (fail ? 502 : [job(2, 'sign and attest', 'cancelled', 901)]),
    });
    const pass = watch(gh, APP, ghcr(), undefined, signatures([], [digest('7')]), quiet, Date.now, proposals);
    await pass();
    expect(proposals.build(APP_REPO, APP.branch)).toMatchObject({ signature: 'refused' });
    expect(proposals.build(APP_REPO, APP.branch)?.job).toBeUndefined();
    fail = false;
    await pass();
    expect(proposals.build(APP_REPO, APP.branch)?.job).toEqual({ run: 901, id: 2, name: 'sign and attest' });
  });

  it('looks again for the job that failed while the build’s jobs are still running, and keeps it once found', async () => {
    let running = true;
    const proposals = new DeployProposals();
    const gh = github(APP, {
      pins: APP_PINS,
      checkRuns: () => [job(2, 'sign and attest', running ? null : 'failure')],
    });
    const pass = watch(gh, APP, ghcr(), undefined, signatures([], [digest('7')]), quiet, Date.now, proposals);
    await pass();
    expect(proposals.build(APP_REPO, APP.branch)?.job).toBeUndefined();
    running = false;
    await pass();
    await pass();
    expect(proposals.build(APP_REPO, APP.branch)?.job).toEqual({ run: 900, id: 2, name: 'sign and attest' });
    // Found, it is not read again.
    expect(calls(gh.sent).filter((c) => c.path.includes('/check-runs'))).toHaveLength(2);
  });

  it('links no job whose address is not one of the repository’s runs', async () => {
    const proposals = new DeployProposals();
    const elsewhere = { ...job(2, 'sign and attest', 'failure'), html_url: 'https://example.com/actions/runs/1/job/2' };
    const gh = github(APP, { pins: APP_PINS, checkRuns: () => [elsewhere] });
    await watch(gh, APP, ghcr(), undefined, signatures([], [digest('7')]), quiet, Date.now, proposals)();
    expect(proposals.build(APP_REPO, APP.branch)?.job).toBeUndefined();
  });

  it('forgets the build once the pin is the newest, and keeps none for a deploy of several pin files', async () => {
    const proposals = new DeployProposals();
    const gh = github(APP, { pins: APP_PINS });
    await watch(gh, APP, ghcr(), undefined, signatures([], [digest('7')]), quiet, Date.now, proposals)();
    expect(proposals.build(APP_REPO, APP.branch)).not.toBeNull();
    await watch(gh, APP, ghcr(commit('b')), undefined, signatures(), quiet, Date.now, proposals)();
    expect(proposals.build(APP_REPO, APP.branch)).toBeNull();
    await watch(
      github(FACTORY),
      FACTORY,
      ghcr(),
      undefined,
      signatures([], [digest('7')]),
      quiet,
      Date.now,
      proposals,
    )();
    expect(proposals.build(FACTORY.repo, FACTORY.branch)).toBeNull();
  });
});

describe('the release watch', () => {
  const REPO = 'the-roganator/cv-software-factory';
  function main() {
    let head = 'a';
    const { github: gh } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/git/ref/heads/main`,
        answer: () => ({ body: { object: { sha: commit(head) } } }),
      },
    ]);
    return {
      gh,
      move: (to: string) => {
        head = to;
      },
    };
  }

  it('runs release-please each time main moves, and not again until it does', async () => {
    const { gh, move } = main();
    let runs = 0;
    const pass = releaseWatch(gh, REPO, quiet, async () => {
      runs += 1;
      return { releases: [], pullRequests: [] };
    });
    await pass();
    await pass();
    move('b');
    await pass();
    expect(runs).toBe(2);
  });

  it('does not run again every minute after a run that failed, but does when main moves', async () => {
    const { gh, move } = main();
    let runs = 0;
    const pass = releaseWatch(gh, REPO, quiet, async () => {
      runs += 1;
      throw new Error('no release-please-config.json');
    });
    await expect(pass()).rejects.toThrow();
    await pass();
    move('b');
    await expect(pass()).rejects.toThrow();
    expect(runs).toBe(2);
  });
});

describe('what a deploy carries', () => {
  const carried = [
    { workItem: '1001', title: 'Redirect loop on /departments/:department', issue: 16, pullRequest: 17 },
    { workItem: '1006', title: 'Prices | totals <b>@mrogan</b> [x](y) `z` & co', issue: null, pullRequest: 25 },
  ];

  it('lists each work item with its ticket, issue and pull request, with nothing in a title read as markup', () => {
    expect(carriesSection(carried).split('\n')).toEqual([
      '<!-- factory: carries -->',
      '### Carries',
      '',
      'It carries 2 work items of the line’s, whose fixes merged since the pinned commit:',
      '',
      '| Ticket | Title | Issue | Pull request |',
      '|---|---|---|---|',
      '| 1001 | Redirect loop on /departments/\\:department | #16 | #17 |',
      '| 1006 | Prices \\| totals &lt;b&gt;&#64;mrogan&lt;/b&gt; \\[x\\](y) \\`z\\` &amp; co | – | #25 |',
      '<!-- factory: /carries -->',
    ]);
    expect(carriesSection([])).toContain('It carries none of the line’s work items');
    const counted = carriesSection(carried.slice(0, 1), 3);
    expect(counted).toContain('It carries 4 work items');
    expect(counted).toContain('| | and 3 more | | |');
  });

  it('replaces the section a body has, or adds one, and finds it again', () => {
    const body = 'Runs `bbbbbbb` on the local cluster.';
    const once = withCarries(body, carriesSection(carried));
    expect(once.startsWith(`${body}\n\n<!-- factory: carries -->`)).toBe(true);
    expect(carriesIn(once)).toBe(carriesSection(carried));
    const twice = withCarries(once, carriesSection([]));
    expect(twice).toBe(`${body}\n\n${carriesSection([])}`);
    expect(carriesIn(body)).toBeUndefined();
    expect(carriesIn(null)).toBeUndefined();
  });

  it('keeps what the line said when the watch moves the pull request to a newer build', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const section = carriesSection(carried);
    const gh = github(FACTORY, {
      pulls: [
        {
          number: 69,
          title: older,
          state: 'open',
          merged_at: null,
          labels: [{ name: 'deploy: local' }],
          body: `Runs \`aaaaaaa\` on the local cluster.\n\n${section}`,
        },
      ],
    });
    await watch(gh, FACTORY)();
    const { body } = (writes(gh.sent).at(-1) as { body: { body: string } }).body;
    expect(body).toContain(`/commit/${commit('b')})`);
    expect(body).not.toContain('Runs `aaaaaaa`');
    // The pull requests it brings come before what the line said, which ends it as it did.
    expect(body).toMatch(/opening another\.\n\n<!-- factory: brings -->\n[\s\S]*<!-- factory: \/brings -->\n\n/);
    expect(body.endsWith(`<!-- factory: /brings -->\n\n${section}`)).toBe(true);
    // The line says again, and only its section changes.
    const again = withCarries(body, carriesSection([]));
    expect(again).toBe(body.replace(section, carriesSection([])));
    expect(bringsIn(again)).toBe(true);
    // One the line never described is moved with no section.
    const bare = github(FACTORY, {
      pulls: [{ number: 69, title: older, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    await watch(bare, FACTORY)();
    expect(carriesIn((writes(bare.sent).at(-1) as { body: { body: string } }).body.body)).toBeUndefined();
  });

  it('remembers the app’s open pull request for the line to read, and forgets it once it merges', async () => {
    const proposals = new DeployProposals();
    const pins = { [APP_PIN.file]: APP_PIN_FILE };
    const gh = github(APP, { pins });
    await watch(gh, APP, ghcr(), undefined, signatures(), quiet, Date.now, proposals)();
    expect(proposals.get(APP.repo, APP.branch)).toEqual({
      number: 70,
      commit: commit('b'),
      pinned: commit('a'),
      digests: [{ name: 'website', image: 'the-roganator/cv-worlds-worst-website', digest: digest('7') }],
    });
    expect(proposals.get(FACTORY.repo, APP.branch)).toBeNull();
    // A worker started again learns of the open one on its first pass.
    const title = 'chore(deploy): run bbbbbbb on the local cluster';
    const again = new DeployProposals();
    const open = github(APP, {
      pins,
      pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    await watch(open, APP, ghcr(), undefined, signatures(), quiet, Date.now, again)();
    expect(again.get(APP.repo, APP.branch)).toMatchObject({ number: 69, commit: commit('b') });
    // Merged: the pin is the newest build.
    await watch(open, APP, ghcr(commit('b')), undefined, signatures(), quiet, Date.now, again)();
    expect(again.get(APP.repo, APP.branch)).toBeNull();
  });

  it('keeps no range for a deploy of several pin files, which has none', async () => {
    const proposals = new DeployProposals();
    await watch(github(FACTORY), FACTORY, ghcr(), undefined, signatures(), quiet, Date.now, proposals)();
    expect(proposals.get(FACTORY.repo, FACTORY.branch)).toBeNull();
  });
});

describe('the list of pull requests', () => {
  const brought = (message: string, reaches: Pin[] = [APP_PIN], sha = commit('b')) => ({ sha, message, reaches });
  const one = (commits: Brings['commits'], extra: Partial<Brings> = {}): Brings => ({
    pins: [APP_PIN],
    unranged: [],
    commits,
    count: commits.length,
    deploys: 0,
    whole: true,
    ...extra,
  });

  it('splits a Conventional Commit subject into its parts, and keeps one that is not whole', () => {
    expect(conventional('perf(console)!: budget what the first view loads (#812)\n\nMore.')).toEqual({
      number: 812,
      type: 'perf',
      scope: 'console',
      breaking: true,
      subject: 'budget what the first view loads',
    });
    expect(conventional('docs: say so')).toEqual({
      number: null,
      type: 'docs',
      scope: null,
      breaking: false,
      subject: 'say so',
    });
    expect(conventional('Revert "fix: a thing (#3)" (#4)')).toEqual({
      number: 4,
      type: null,
      scope: null,
      breaking: false,
      subject: 'Revert "fix: a thing (#3)"',
    });
  });

  it('gives a subject that does not parse a row, with what can be said, and names a commit with no pull request', () => {
    const section = bringsSection(
      APP,
      one([
        brought('Merge branch `x` into main, @someone'),
        brought('fix(a|b): it [works](z)', [APP_PIN], commit('c')),
      ]),
    );
    expect(section.split('\n').slice(5)).toEqual([
      '| Pull request | Type | Scope | Subject |',
      '|---|---|---|---|',
      `| [\`bbbbbbb\`](https://github.com/${APP.repo}/commit/${commit('b')}) | – | – | Merge branch \\\`x\\\` into main, &#64;someone |`,
      `| [\`ccccccc\`](https://github.com/${APP.repo}/commit/${commit('c')}) | fix | a\\|b | it \\[works\\](z) |`,
      '<!-- factory: /brings -->',
    ]);
  });

  it('lists the latest fifty, and counts the rest', () => {
    const commits = Array.from({ length: MAX_BROUGHT + 3 }, (_, i) => brought(`fix: ${i} (#${i + 1})`));
    const lines = bringsSection(APP, one(commits)).split('\n');
    expect(lines).toContain(`It brings ${MAX_BROUGHT + 3} pull requests merged since the pinned commit, newest first:`);
    expect(lines.filter((l) => /^\| #\d+ \|/.test(l))).toHaveLength(MAX_BROUGHT);
    expect(lines.at(-2)).toBe('| | | | and 3 more |');
  });

  it('says when a deploy brings none', () => {
    expect(bringsSection(APP, one([]))).toContain('It brings no pull request: nothing merged since the pinned commit.');
  });

  it('says when a deploy brings only deploy pull requests', () => {
    expect(bringsSection(APP, one([], { deploys: 2 }))).toContain(
      'It brings no pull request: only deploy pull requests merged since the pinned commit.',
    );
    // The commits not read may hold others, so it says only what was read.
    expect(bringsSection(APP, one([], { deploys: 1000, whole: false }))).toContain(
      'It brings no pull request among the commits read since the pinned commit, which were only deploy pull requests; the rest were not read.',
    );
  });

  it("knows the worker's own deploy pull requests by their title, to any profile, in either repository", () => {
    for (const message of [
      'chore(deploy): run the factory 2d87504 on the local cluster (#888)',
      'chore(deploy): run console 1f14f44 and the factory 9e0b2d1 on the local cluster (#883)',
      'chore(deploy): run 1f14f44 on the local cluster (#40)\n\nMore.',
      'chore(deploy): run 1f14f44 on the cloud cluster',
    ]) {
      expect(deployCommit(message), message).toBe(true);
    }
    for (const message of [
      'chore(deploy): pin flagd by digest (#887)',
      'chore(deploy): run the scoreboard migrations on the local cluster (#900)',
      'chore(deploy)!: run the factory 2d87504 on the local cluster (#888)',
      'fix(deploy): run the factory 2d87504 on the local cluster (#888)',
      'Revert "chore(deploy): run the factory 2d87504 on the local cluster (#888)" (#889)',
    ]) {
      expect(deployCommit(message), message).toBe(false);
    }
  });
});

describe('the images a repository deploys', () => {
  it("knows a deployed image only under the repository's owner", () => {
    const repo = 'the-roganator/cv-worlds-worst-website';
    expect(deployedImage(repo, 'the-roganator/cv-worlds-worst-website')).toBe('the-roganator/cv-worlds-worst-website');
    for (const image of [
      'mrogan/cv-worlds-worst-website',
      'someone/cv-worlds-worst-website',
      'the-roganator/cv-software-factory/factory',
      'mrogan/cv-software-factory/factory',
    ]) {
      expect(() => deployedImage(repo, image)).toThrow(DeployRefused);
    }
  });

  it('moves only the digests of a pin file, the layout kept', () => {
    expect(
      repin(FACTORY_PIN, {
        commit: commit('b'),
        digests: [
          { name: 'factory', image: 'the-roganator/cv-software-factory/factory', digest: digest('7') },
          { name: 'factory-browser', image: 'the-roganator/cv-software-factory/factory-browser', digest: digest('8') },
        ],
      }),
    ).toBe(
      pinFile([
        ['factory', digest('7'), 'the-roganator/cv-software-factory/factory'],
        ['factory-browser', digest('8'), 'the-roganator/cv-software-factory/factory-browser'],
      ]),
    );
  });

  it('refuses a pin file that names an image under another owner, rather than look it up or move it there', async () => {
    const elsewhere = pinFile([['console', digest('3'), 'mrogan/cv-software-factory/console']]);
    expect(() =>
      repin(elsewhere, {
        commit: commit('c'),
        digests: [{ name: 'console', image: 'the-roganator/cv-software-factory/console', digest: digest('9') }],
      }),
    ).toThrow(PinFileError);
    await expect(newerBuild({ registry: ghcr() }, CONSOLE_PIN, elsewhere, [{ sha: commit('c') }])).rejects.toThrow(
      PinFileError,
    );
  });
});
