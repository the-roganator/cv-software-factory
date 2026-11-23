/**
 * What a restart costs the deploy pull request. A worker that starts again knows no commit; its deploy watch takes, as
 * its own, a `deploy/local` whose head is already the commit it would write (`own-commit.ts`, as the pin watch does):
 * one commit of the App's, on a commit of main whose pin files are as at main's head, writing each as `repin` writes it
 * for the builds the pull request runs, and nothing else. Such a pull request keeps its head, its checks and its place,
 * however far main has moved elsewhere; any other head is written again, as before, and a newer build moves it on.
 *
 * Over the pin watch's fake repository (`FakeRepo`), which keeps git's trees, each commit's parents and who made it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { WatchedHeads } from '../../src/github/branches.ts';
import { headWait, type QueuePull } from '../../src/github/deploy-queue.ts';
import { DEPLOYS, type DeployTarget, deployWatch, type Pin } from '../../src/github/deploys.ts';
import type { Registry } from '../../src/github/registry.ts';
import { type Signatures, UnsignedError } from '../../src/github/signatures.ts';
import { client, quiet, type Route, type Sent } from './fake.ts';
import { FakeRepo, writes } from './pins-harness.ts';

const [TARGET] = DEPLOYS as [DeployTarget];
const [CONSOLE, FACTORY_PINS] = TARGET.pins as [Pin, Pin];
const BRANCH = TARGET.branch;
const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** A pin file as `kustomize edit` writes one, each image at one digest. */
const pinFile = (pin: Pin, at: string) =>
  [
    'apiVersion: kustomize.config.k8s.io/v1alpha1',
    'kind: Component',
    'images:',
    ...pin.images.flatMap(({ name, image }) => [
      `- digest: ${digest(at)}`,
      `  name: ${name}`,
      `  newName: ghcr.io/${image}`,
    ]),
    '',
  ].join('\n');

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** The repository, main's history newest first, and the builds GHCR has: each image built at the commits named. */
function setup() {
  const repo = new FakeRepo({
    [CONSOLE.file]: pinFile(CONSOLE, '1'),
    [FACTORY_PINS.file]: pinFile(FACTORY_PINS, '1'),
    'README.md': 'The factory.\n',
  });
  const pinned = repo.main;
  // A merge that built every image: the build the deploy runs.
  const built = repo.push({ 'apps/factory/src/main.ts': 'export {};\n' });
  const history = [built, pinned];
  const builds = { at: new Set([built]), digests: new Map([[built, '2']]) };
  const registry = {
    tags: async () => [...builds.at],
    digest: async (_image: string, at: string) => digest(builds.digests.get(at) ?? '0'),
    revision: async () => pinned,
  } as unknown as Registry;
  const signatures: Pick<Signatures, 'verify'> = { verify: async () => {} };
  return { repo, history, builds, registry, signatures, built };
}

/** One worker's deploy watch over the repository, with a record of its own. */
function worker(world: ReturnType<typeof setup>, verify = world.signatures) {
  const { repo, history, registry } = world;
  const sent: Sent[] = [];
  const extra: Route[] = [
    {
      method: 'GET',
      path: /\/commits\?sha=[0-9a-f]{40}&per_page=100$/,
      answer: () => ({ body: history.map((sha) => ({ sha })) }),
    },
    // What a deploy brings: none of the line's pull requests, here.
    {
      method: 'GET',
      path: /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}\?per_page=100&page=\d+$/,
      answer: () => ({ body: { total_commits: 0, commits: [] } }),
    },
  ];
  const { github } = client([...extra, ...repo.routes()], sent, { sleep: async () => {} });
  const heads = new WatchedHeads();
  const watch = deployWatch(
    { github, registry, signatures: verify, actions: new LiveActions(github), heads, log: quiet },
    TARGET,
  );
  return { sent, heads, watch };
}

/** main moves on by a merge that builds no image the deploy pins, as the lockfile's pull request did. */
const mergeElsewhere = (world: ReturnType<typeof setup>, text: string) => {
  world.history.unshift(world.repo.push({ 'pnpm-lock.yaml': text }));
};

const queuePull = (repo: FakeRepo): QueuePull =>
  ({ head: { ref: BRANCH, sha: repo.refs.get(BRANCH), repo: { full_name: TARGET.repo } } }) as QueuePull;

/** The branch commits and moves: a new head. */
const commits = (sent: Sent[]) => writes(sent).filter((s) => s.path === '/graphql' || s.path.includes('/git/refs'));

async function opened() {
  const world = setup();
  const first = worker(world);
  await first.watch();
  const pull = world.repo.pulls.find((p) => p.head === BRANCH && p.state === 'open');
  if (!pull) throw new Error('the deploy watch opened nothing');
  const written = world.repo.refs.get(BRANCH) as string;
  expect(first.heads.get(TARGET.repo, BRANCH)).toBe(written);
  return { world, pull, written };
}

describe('what a restart costs the deploy pull request', () => {
  it('keeps its head across restarts, main moving elsewhere, and its queue takes the head as the watch’s', async () => {
    const { world, pull, written } = await opened();
    expect(world.repo.file(written, FACTORY_PINS.file)).toContain(digest('2'));
    for (let restart = 1; restart <= 3; restart++) {
      if (restart === 3) mergeElsewhere(world, 'lockfileVersion: 9.0\n');
      const next = worker(world);
      expect(headWait(next.heads, TARGET.repo, queuePull(world.repo), 'not-a-deploy')).toBeDefined();
      for (let pass = 0; pass < 3; pass++) await next.watch();
      expect(commits(next.sent)).toEqual([]);
      expect(world.repo.refs.get(BRANCH)).toBe(written);
      expect(next.heads.get(TARGET.repo, BRANCH)).toBe(written);
      expect(headWait(next.heads, TARGET.repo, queuePull(world.repo), 'not-a-deploy')).toBeUndefined();
      expect(pull.state).toBe('open');
    }
  });

  it('keeps it too where the pull request stays as it is, a newer build still being signed', async () => {
    const { world, written } = await opened();
    // A newer build, at a merge after, not yet signed.
    const newer = world.repo.push({ 'apps/factory/src/other.ts': 'export {};\n' });
    world.history.unshift(newer);
    world.builds.at.add(newer);
    world.builds.digests.set(newer, '3');
    const next = worker(world, {
      verify: async (_image, at) => {
        if (at === digest('3')) throw new UnsignedError('unsigned', 'not yet');
      },
    });
    await next.watch();
    expect(commits(next.sent)).toEqual([]);
    expect(next.heads.get(TARGET.repo, BRANCH)).toBe(written);
  });

  it('writes again a branch whose pin file main has changed since', async () => {
    const { world, written } = await opened();
    world.history.unshift(
      world.repo.push({ [CONSOLE.file]: `# The console's image.\n${world.repo.file('main', CONSOLE.file)}` }),
    );
    const next = worker(world);
    await next.watch();
    const again = world.repo.refs.get(BRANCH) as string;
    expect(again).not.toBe(written);
    expect(world.repo.file(again, CONSOLE.file)).toContain("# The console's image.");
    expect(next.heads.get(TARGET.repo, BRANCH)).toBe(again);
  });

  it('writes again a head that is not one commit of the App’s making exactly the watch’s pin files', async () => {
    const cases: [string, (world: ReturnType<typeof setup>, written: string) => string][] = [
      [
        'the same pin files, committed by someone else',
        (world, written) =>
          world.repo.commitOn('main', {
            [CONSOLE.file]: world.repo.file(written, CONSOLE.file) as string,
            [FACTORY_PINS.file]: world.repo.file(written, FACTORY_PINS.file) as string,
          }),
      ],
      [
        'the App’s commit, with another file changed',
        (world, written) =>
          world.repo.commitOn(
            'main',
            {
              [CONSOLE.file]: world.repo.file(written, CONSOLE.file) as string,
              [FACTORY_PINS.file]: world.repo.file(written, FACTORY_PINS.file) as string,
              'README.md': 'Something else.\n',
            },
            APP_LOGIN,
            'web-flow',
          ),
      ],
      [
        'the App’s commit, pinning another digest',
        (world, written) =>
          world.repo.commitOn(
            'main',
            {
              [CONSOLE.file]: world.repo.file(written, CONSOLE.file) as string,
              [FACTORY_PINS.file]: (world.repo.file(written, FACTORY_PINS.file) as string).replace(
                digest('2'),
                digest('9'),
              ),
            },
            APP_LOGIN,
            'web-flow',
          ),
      ],
      [
        'a second commit on top of the watch’s',
        (world, written) => world.repo.commitOn(written, { 'README.md': 'More.\n' }, APP_LOGIN, 'web-flow'),
      ],
    ];
    for (const [what, make] of cases) {
      const { world, written } = await opened();
      const theirs = make(world, written);
      world.repo.refs.set(BRANCH, theirs);
      const next = worker(world);
      await next.watch();
      const again = world.repo.refs.get(BRANCH) as string;
      expect(again, what).not.toBe(theirs);
      expect(world.repo.file(again, 'README.md'), what).toBe('The factory.\n');
      expect(world.repo.file(again, FACTORY_PINS.file), what).not.toContain(digest('9'));
      expect(next.heads.get(TARGET.repo, BRANCH), what).toBe(again);
    }
  });

  it('moves on to a newer build after a restart, as it always does', async () => {
    const { world, pull, written } = await opened();
    const newer = world.repo.push({ 'apps/factory/src/other.ts': 'export {};\n' });
    world.history.unshift(newer);
    world.builds.at.add(newer);
    world.builds.digests.set(newer, '3');
    const next = worker(world);
    await next.watch();
    const again = world.repo.refs.get(BRANCH) as string;
    expect(again).not.toBe(written);
    expect(world.repo.file(again, FACTORY_PINS.file)).toContain(digest('3'));
    expect(pull.title).toContain(newer.slice(0, 7));
  });

  it('writes again a head this worker wrote and someone moved since, though it is the same pin files', async () => {
    const { world } = await opened();
    const w = worker(world);
    await w.watch();
    const own = world.repo.refs.get(BRANCH) as string;
    expect(w.heads.get(TARGET.repo, BRANCH)).toBe(own);
    const other = world.repo.commitOn(
      'main',
      {
        [CONSOLE.file]: world.repo.file(own, CONSOLE.file) as string,
        [FACTORY_PINS.file]: world.repo.file(own, FACTORY_PINS.file) as string,
      },
      APP_LOGIN,
      'web-flow',
    );
    world.repo.refs.set(BRANCH, other);
    await w.watch();
    expect(world.repo.refs.get(BRANCH)).not.toBe(other);
    expect(w.heads.get(TARGET.repo, BRANCH)).toBe(world.repo.refs.get(BRANCH));
  });
});
