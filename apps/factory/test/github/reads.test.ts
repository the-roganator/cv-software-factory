import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { ownsBranch } from '../../src/github/branches.ts';
import { GitHubError } from '../../src/github/client.ts';
import { DEPLOYS, DeployProposals, DeployRefused } from '../../src/github/deploys.ts';
import { LiveReads, type ReleaseSources } from '../../src/github/reads.ts';
import type { Registry } from '../../src/github/registry.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { pipeline, type Signer, UnsignedError } from '../../src/github/signatures.ts';
import { GitHubWorker, GitHubWorkerError } from '../../src/github/worker-client.ts';
import { calls, client, OTHER_SHA, quiet, REPO, type Route, SHA } from './fake.ts';

const PULL = {
  number: 7,
  state: 'closed',
  merged: true,
  merge_commit_sha: OTHER_SHA,
  merged_by: { login: 'mrogan' },
  head: { ref: 'factory/1001-cart', sha: SHA },
  base: { ref: 'main', sha: OTHER_SHA, repo: { full_name: REPO } },
  draft: false,
  node_id: 'PR_7',
  title: 'ignored',
};

const ROUTES = [
  { method: 'GET', path: `/repos/${REPO}/pulls/7`, answer: () => ({ body: PULL }) },
  {
    method: 'GET',
    path: `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100`,
    answer: () => ({
      body: {
        check_runs: [
          {
            id: 1,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            app: { slug: 'github-actions' },
            started_at: '2026-10-05T10:00:00Z',
            completed_at: '2026-10-05T10:01:30Z',
            output: { title: 'All 40 tests pass' },
          },
          { id: 2, name: 'journeys', status: 'in_progress', conclusion: null, app: null },
        ],
      },
    }),
  },
  {
    method: 'GET',
    path: `/repos/${REPO}/rules/branches/main`,
    answer: () => ({
      body: [
        { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'test' }, { context: 'journeys' }] },
        },
      ],
    }),
  },
  { method: 'GET', path: `/repos/${REPO}/git/ref/heads/main`, answer: () => ({ body: { object: { sha: SHA } } }) },
  {
    method: 'GET',
    path: `/repos/${REPO}/pulls?head=${encodeURIComponent(`${REPO.split('/')[0]}:factory/1001-cart`)}&state=open&per_page=1`,
    answer: () => ({ body: [{ ...PULL, state: 'open', merged: false, merged_by: null }] }),
  },
  {
    method: 'GET',
    path: `/repos/${REPO}/pulls?head=${encodeURIComponent(`${REPO.split('/')[0]}:factory/1002-none`)}&state=open&per_page=1`,
    answer: () => ({ body: [] }),
  },
  {
    method: 'GET',
    path: `/repos/${REPO}/compare/main...${SHA}?per_page=100&page=1`,
    answer: () => ({
      body: {
        merge_base_commit: { sha: OTHER_SHA },
        status: 'ahead',
        files: [
          {
            filename: 'src/money.ts',
            status: 'modified',
            patch: '@@ -1,2 +1,2 @@\n-a\n+b\n c',
            additions: 1,
            deletions: 1,
          },
          { filename: 'public/logo.png', status: 'added', additions: 0, deletions: 0 },
        ],
      },
    }),
  },
];

describe('reading GitHub for the line', () => {
  it('reads a pull request, the check runs on a commit, the checks main requires, a branch’s head and its pull request', async () => {
    const { github } = client(ROUTES);
    const reads = new LiveReads(github);
    expect(await reads.pullRequest(REPO, 7)).toEqual({
      number: 7,
      state: 'closed',
      merged: true,
      mergeCommit: OTHER_SHA,
      mergedBy: 'mrogan',
      head: { ref: 'factory/1001-cart', sha: SHA },
      base: { ref: 'main', sha: OTHER_SHA },
      draft: false,
      nodeId: 'PR_7',
    });
    expect(await reads.checkRuns(REPO, SHA)).toEqual([
      {
        id: 1,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        app: 'github-actions',
        startedAt: '2026-10-05T10:00:00Z',
        completedAt: '2026-10-05T10:01:30Z',
        title: 'All 40 tests pass',
      },
      {
        id: 2,
        name: 'journeys',
        status: 'in_progress',
        conclusion: null,
        app: null,
        startedAt: null,
        completedAt: null,
        title: null,
      },
    ]);
    expect(await reads.requiredChecks(REPO, 'main')).toEqual(['test', 'journeys']);
    expect(await reads.head(REPO, 'main')).toBe(SHA);
    expect(await reads.pullRequestFrom(REPO, 'factory/1001-cart')).toMatchObject({ number: 7, state: 'open' });
    expect(await reads.pullRequestFrom(REPO, 'factory/1002-none')).toBeNull();
  });

  it('reads what each latest failed check said was wrong, without Actions’ exit-code line, and asks nothing of the rest', async () => {
    const completed = { status: 'completed', app: { slug: 'github-actions' }, output: { title: null } };
    const runs = [
      { ...completed, id: 1, name: 'gates / test integrity', conclusion: 'failure' },
      { ...completed, id: 2, name: 'gates / types', conclusion: 'timed_out' },
      { ...completed, id: 3, name: 'gates / tests', conclusion: 'success' },
      { ...completed, id: 4, name: 'gates / gone', conclusion: 'failure' },
      { id: 5, name: 'gates / journeys', status: 'in_progress', conclusion: null },
      { ...completed, id: 6, name: 'gates / refused', conclusion: 'failure' },
      // An earlier attempt of a check run again: the gates never record it, so nothing is read of it.
      { ...completed, id: 0, name: 'gates / tests', conclusion: 'failure' },
    ];
    const annotations = (id: number, body: unknown) => ({
      method: 'GET',
      path: `/repos/${REPO}/check-runs/${id}/annotations?per_page=50`,
      answer: () => ({ body }),
    });
    const sent: Parameters<typeof calls>[0] = [];
    const { github } = client(
      [
        {
          method: 'GET',
          path: `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100`,
          answer: () => ({ body: { check_runs: runs } }),
        },
        annotations(1, [
          { path: '.github', annotation_level: 'failure', message: 'Process completed with exit code 1.' },
          {
            path: 'test/app.test.ts',
            annotation_level: 'failure',
            message: '"files > keeps nothing of the other files" was deleted',
          },
          { path: 'test/app.test.ts', annotation_level: 'warning', message: 'A warning says nothing of the failure' },
          { path: '.github', annotation_level: 'notice', message: 'Node 20 is deprecated' },
        ]),
        annotations(2, [
          { path: '.github', annotation_level: 'failure', message: 'Process completed with exit code 2.' },
        ]),
        { method: 'GET', path: `/repos/${REPO}/check-runs/4/annotations?per_page=50`, answer: () => ({ status: 404 }) },
        { method: 'GET', path: `/repos/${REPO}/check-runs/6/annotations?per_page=50`, answer: () => ({ status: 403 }) },
      ],
      sent,
    );
    const read = await new LiveReads(github).checkRuns(REPO, SHA);
    expect(read.map((run) => [run.name, run.annotations])).toEqual([
      [
        'gates / test integrity',
        [{ path: 'test/app.test.ts', message: '"files > keeps nothing of the other files" was deleted' }],
      ],
      ['gates / types', []],
      ['gates / tests', undefined],
      ['gates / gone', []],
      ['gates / journeys', undefined],
      // Refused, the reasons are left out, and the runs still read.
      ['gates / refused', []],
      ['gates / tests', undefined],
    ]);
    // One read of the runs, and one more for each that failed.
    expect(
      calls(sent)
        .map((s) => s.path.split('?')[0])
        .sort(),
    ).toEqual([
      `/repos/${REPO}/check-runs/1/annotations`,
      `/repos/${REPO}/check-runs/2/annotations`,
      `/repos/${REPO}/check-runs/4/annotations`,
      `/repos/${REPO}/check-runs/6/annotations`,
      `/repos/${REPO}/commits/${SHA}/check-runs`,
    ]);
  });

  it('fails the read of the runs while GitHub rate-limits or fails what a run said, so the line asks again', async () => {
    const failed = { id: 1, name: 'gates / test integrity', status: 'completed', conclusion: 'failure', app: null };
    for (const status of [429, 502]) {
      const { github } = client([
        {
          method: 'GET',
          path: `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100`,
          answer: () => ({ body: { check_runs: [failed] } }),
        },
        {
          method: 'GET',
          path: `/repos/${REPO}/check-runs/1/annotations?per_page=50`,
          answer: () => ({ status, headers: { 'retry-after': '3600' } }),
        },
      ]);
      await expect(new LiveReads(github).checkRuns(REPO, SHA)).rejects.toBeInstanceOf(GitHubError);
    }
  });

  it('compares a commit with a branch: where it left it, and each file it changes since, with its patch and lines', async () => {
    const { github } = client(ROUTES);
    expect(await new LiveReads(github).comparison(REPO, 'main', SHA)).toEqual({
      mergeBase: OTHER_SHA,
      files: [
        { path: 'src/money.ts', patch: '@@ -1,2 +1,2 @@\n-a\n+b\n c', added: 1, removed: 1 },
        { path: 'public/logo.png', patch: null, added: 0, removed: 0 },
      ],
    });
  });

  it('reads every page of a comparison’s files, up to the most GitHub compares', async () => {
    const file = (n: number) => ({ filename: `src/f${n}.ts`, status: 'modified', additions: 1, deletions: 0 });
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => file(from + i));
    const compare = (n: number, files: unknown[]) => ({
      method: 'GET',
      path: `/repos/${REPO}/compare/main...${SHA}?per_page=100&page=${n}`,
      answer: () => ({ body: { merge_base_commit: { sha: OTHER_SHA }, files } }),
    });
    // 250 files: two whole pages and a part one, which is the last.
    const paged = client([compare(1, page(0, 100)), compare(2, page(100, 100)), compare(3, page(200, 50))]);
    const all = await new LiveReads(paged.github).comparison(REPO, 'main', SHA);
    expect(all.mergeBase).toBe(OTHER_SHA);
    expect(all.files.map((f) => f.path)).toEqual(page(0, 250).map((f) => f.filename));
    // At GitHub's 300 it asks no further; and a page that repeats the files before it ends the reading.
    const sentFull: Parameters<typeof calls>[0] = [];
    const full = client(
      [1, 2, 3, 4].map((n) => compare(n, page((n - 1) * 100, 100))),
      sentFull,
    );
    expect((await new LiveReads(full.github).comparison(REPO, 'main', SHA)).files).toHaveLength(300);
    expect(calls(sentFull)).toHaveLength(3);
    const sentRepeated: Parameters<typeof calls>[0] = [];
    const repeated = client(
      [1, 2, 3].map((n) => compare(n, page(0, 100))),
      sentRepeated,
    );
    expect((await new LiveReads(repeated.github).comparison(REPO, 'main', SHA)).files).toHaveLength(100);
    expect(calls(sentRepeated)).toHaveLength(2);
  });
});

describe('reading what a release is made of', () => {
  const IMAGE = 'the-roganator/cv-worlds-worst-website';
  const DIGEST = `sha256:${'1'.repeat(64)}`;
  const UNSIGNED = `sha256:${'2'.repeat(64)}`;
  const sha = (n: number) => n.toString(16).padStart(40, '0');

  /** GHCR, Sigstore and the deploy watch: each digest built from SHA, and only DIGEST signed by the app's pipeline. */
  function sources(): ReleaseSources & { asked: unknown[] } {
    const asked: unknown[] = [];
    const proposals = new DeployProposals();
    const app = DEPLOYS.find((t) => t.repo === REPO) as (typeof DEPLOYS)[number];
    proposals.set(app, { number: 30, commit: SHA, pinned: OTHER_SHA, digests: [] });
    return {
      asked,
      proposals,
      registry: {
        revision: async (image: string, digest: string) => {
          asked.push(['revision', image, digest]);
          return digest === DIGEST ? SHA : undefined;
        },
      } as Pick<Registry, 'revision'>,
      signatures: {
        verify: async (image, digest, signer) => {
          asked.push(['verify', image, digest, signer]);
          if (digest !== DIGEST) throw new UnsignedError('unsigned', `${image}@${digest} has no signature`);
        },
      },
    };
  }

  it('lists every commit one has that the other has not, a page at a time, and says how the two stand', async () => {
    const all = Array.from({ length: 230 }, (_, i) => sha(i + 1));
    const { github } = client([
      {
        method: 'GET',
        path: /\/compare\//,
        answer: ({ path }) => {
          const page = Number(new URL(path, 'https://x').searchParams.get('page'));
          expect(path.startsWith(`/repos/${REPO}/compare/${OTHER_SHA}...${SHA}?per_page=100&page=`)).toBe(true);
          return {
            body: {
              status: 'ahead',
              total_commits: all.length,
              commits: all.slice((page - 1) * 100, page * 100).map((s) => ({ sha: s })),
            },
          };
        },
      },
    ]);
    expect(await new LiveReads(github).commits(REPO, OTHER_SHA, SHA)).toEqual({
      status: 'ahead',
      total: 230,
      commits: all,
    });
  });

  it('says when one commit is not an ancestor of the other', async () => {
    const { github } = client([
      {
        method: 'GET',
        path: /\/compare\//,
        answer: () => ({ body: { status: 'behind', total_commits: 0, commits: [] } }),
      },
    ]);
    expect(await new LiveReads(github).commits(REPO, SHA, OTHER_SHA)).toEqual({
      status: 'behind',
      total: 0,
      commits: [],
    });
  });

  it('reads the commit an image was built from, and whether its pipeline signed it', async () => {
    const { github } = client([]);
    const given = sources();
    const reads = new LiveReads(github, given);
    expect(await reads.imageRevision(REPO, IMAGE, DIGEST)).toBe(SHA);
    expect(await reads.imageRevision(REPO, IMAGE, UNSIGNED)).toBeNull();
    expect(await reads.imageSigned(REPO, IMAGE, DIGEST)).toEqual({ signed: true, reason: null });
    expect(await reads.imageSigned(REPO, IMAGE, UNSIGNED)).toEqual({
      signed: false,
      reason: `${IMAGE}@${UNSIGNED} has no signature`,
    });
    expect(given.asked).toContainEqual(['verify', IMAGE, DIGEST, pipeline(REPO)]);
  });

  it('reads only the images a repository deploys', async () => {
    const { github } = client([]);
    const given = sources();
    const reads = new LiveReads(github, given);
    for (const image of ['the-roganator/cv-software-factory/factory', 'someone/else']) {
      await expect(reads.imageRevision(REPO, image, DIGEST)).rejects.toBeInstanceOf(DeployRefused);
      await expect(reads.imageSigned(REPO, image, DIGEST)).rejects.toBeInstanceOf(DeployRefused);
    }
    expect(given.asked).toEqual([]);
  });

  it('reads the open deploy pull request as the watch last saw it', async () => {
    const { github } = client([]);
    const reads = new LiveReads(github, sources());
    expect(await reads.deployProposal(REPO, 'deploy/local')).toEqual({
      number: 30,
      commit: SHA,
      pinned: OTHER_SHA,
      digests: [],
    });
    expect(await reads.deployProposal(REPO, 'deploy/staging')).toBeNull();
    await expect(new LiveReads(github).deployProposal(REPO, 'deploy/local')).rejects.toThrow(/watches no deploys/);
  });
});

describe('the paths no patch may change', () => {
  it('are the workflows, the deployment and what CODEOWNERS gives a person, at the commit asked about', async () => {
    const asked: string[] = [];
    const { github } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path }) => {
          asked.push(path);
          return path.startsWith(`/repos/${REPO}/contents/.github/CODEOWNERS?ref=${SHA}`)
            ? {
                body: {
                  type: 'file',
                  encoding: 'base64',
                  content: Buffer.from(
                    '# The rules\n/Dockerfile @mrogan\nAGENTS.md @mrogan\n/deploy/ @mrogan\n',
                  ).toString('base64'),
                },
              }
            : { status: 404, body: { message: 'Not Found' } };
        },
      },
    ]);
    expect(await new LiveReads(github).protectedPaths(REPO, SHA)).toEqual([
      '.github/',
      'deploy/',
      'Dockerfile',
      'Dockerfile/',
      '**/AGENTS.md',
      '**/AGENTS.md/',
    ]);
    expect(asked.every((path) => path.endsWith(`?ref=${SHA}`))).toBe(true);
  });

  it('are the rules of the line alone where every CODEOWNERS path is missing or a folder', async () => {
    const { github } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path }) =>
          path.includes('/contents/CODEOWNERS?')
            ? { body: [{ type: 'file', name: 'README.md' }] }
            : { status: 404, body: { message: 'Not Found' } },
      },
    ]);
    expect(await new LiveReads(github).protectedPaths(REPO, SHA)).toEqual(['.github/', 'deploy/']);
  });
});

describe('a file at a commit', () => {
  it('is its text, not there, or there and not text the API sends whole', async () => {
    const { github } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path }) => {
          if (path.includes('/contents/test/app.test.ts?'))
            return {
              body: { type: 'file', encoding: 'base64', content: Buffer.from("it('x', () => {});").toString('base64') },
            };
          if (path.includes('/contents/test/big.test.ts?'))
            return { body: { type: 'file', encoding: 'none', content: '' } };
          if (path.includes('/contents/test/binary.test.ts?'))
            return {
              body: { type: 'file', encoding: 'base64', content: Buffer.from([0xff, 0xfe]).toString('base64') },
            };
          if (path.includes('/contents/test?')) return { body: [{ type: 'file', name: 'app.test.ts' }] };
          return { status: 404, body: { message: 'Not Found' } };
        },
      },
    ]);
    const reads = new LiveReads(github);
    expect(await reads.file(REPO, SHA, 'test/app.test.ts')).toEqual({ found: true, text: "it('x', () => {});" });
    expect(await reads.file(REPO, SHA, 'test/big.test.ts')).toEqual({ found: true, text: null });
    expect(await reads.file(REPO, SHA, 'test/binary.test.ts')).toEqual({ found: true, text: null });
    expect(await reads.file(REPO, SHA, 'test')).toEqual({ found: false });
    expect(await reads.file(REPO, SHA, 'test/gone.test.ts')).toEqual({ found: false });
  });
});

describe('the factory’s branches', () => {
  it('are those under factory/ and the deploy branches, and nothing else', () => {
    expect(ownsBranch('factory/1296-prices')).toBe(true);
    expect(ownsBranch('deploy/local')).toBe(true);
    expect(ownsBranch('main')).toBe(false);
    expect(ownsBranch('factory/')).toBe(false);
    expect(ownsBranch('deploy/martins-experiment')).toBe(false);
    expect(ownsBranch('feat/line')).toBe(false);
  });
});

describe('the worker over HTTP, for the line', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serve(routes: Route[] = ROUTES, sources?: ReleaseSources) {
    const { github, sent } = client(routes);
    const dryRun = new DryRunActions(new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-'))), quiet);
    const server = createWorkerServer({
      actions: new LiveActions(github),
      reads: new LiveReads(github, sources),
      dryRun,
      repositories: [REPO],
      health: () => ({}),
      log: quiet,
    });
    const { url } = await listenLocal(server);
    close = () => server.close();
    return { worker: new GitHubWorker(url), dryRun: new GitHubWorker(url, { dryRun: true }), sent };
  }

  it('answers reads, checked at the door', async () => {
    const { worker } = await serve();
    expect(await worker.read('pullRequest', REPO, { number: 7 })).toMatchObject({ merged: true, mergedBy: 'mrogan' });
    expect(await worker.read('requiredChecks', REPO, { branch: 'main' })).toEqual(['test', 'journeys']);
    await expect(worker.read('checkRuns', REPO, { sha: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(worker.read('pullRequest', 'someone/else', { number: 7 })).rejects.toBeInstanceOf(GitHubWorkerError);
  });

  it('answers the check runs with what each that failed said', async () => {
    const failed = {
      id: 9,
      name: 'gates / test integrity',
      status: 'completed',
      conclusion: 'failure',
      app: { slug: 'github-actions' },
    };
    const said = { path: 'test/app.test.ts', message: '"files > keeps nothing of the other files" was deleted' };
    const { worker } = await serve([
      ...ROUTES.filter((route) => !route.path.includes('/check-runs')),
      {
        method: 'GET',
        path: `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100`,
        answer: () => ({ body: { check_runs: [failed] } }),
      },
      {
        method: 'GET',
        path: `/repos/${REPO}/check-runs/9/annotations?per_page=50`,
        answer: () => ({ body: [{ ...said, annotation_level: 'failure' }] }),
      },
    ]);
    expect(await worker.read('checkRuns', REPO, { sha: SHA })).toMatchObject([
      { name: 'gates / test integrity', conclusion: 'failure', annotations: [said] },
    ]);
  });

  it('answers the release reads, and refuses an image the repository does not deploy', async () => {
    const proposals = new DeployProposals();
    const registry = { revision: async () => SHA } as unknown as Registry;
    const signers: string[] = [];
    const signatures = { verify: async (_: string, __: string, signer: Signer) => void signers.push(signer.identity) };
    const { worker } = await serve(ROUTES, { registry, signatures, proposals });
    const digest = `sha256:${'1'.repeat(64)}`;
    expect(await worker.read('imageRevision', REPO, { image: 'the-roganator/cv-worlds-worst-website', digest })).toBe(
      SHA,
    );
    expect(await worker.read('imageSigned', REPO, { image: 'the-roganator/cv-worlds-worst-website', digest })).toEqual({
      signed: true,
      reason: null,
    });
    expect(signers).toEqual([
      'https://github.com/the-roganator/cv-worlds-worst-website/.github/workflows/build.yml@refs/heads/main',
    ]);
    // The same image under another owner is not one the repository deploys.
    await expect(
      worker.read('imageSigned', REPO, { image: 'mrogan/cv-worlds-worst-website', digest }),
    ).rejects.toMatchObject({ status: 422, kind: 'deploy-refused' });
    expect(await worker.read('deployProposal', REPO, { branch: 'deploy/local' })).toBeNull();
    await expect(
      worker.read('imageRevision', REPO, { image: 'the-roganator/cv-software-factory/factory', digest }),
    ).rejects.toMatchObject({ status: 422, kind: 'deploy-refused' });
    for (const args of [
      { image: 'ghcr.io/../x', digest },
      { image: 'the-roganator/cv-worlds-worst-website', digest: 'latest' },
    ]) {
      await expect(worker.read('imageRevision', REPO, args)).rejects.toMatchObject({ status: 400 });
    }
    await expect(worker.read('commits', REPO, { base: 'main', head: SHA })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to move, delete or commit to a branch the factory does not own, live or in a dry run', async () => {
    const { worker, dryRun, sent } = await serve();
    for (const client of [worker, dryRun]) {
      await expect(client.act('setBranch', REPO, { branch: 'main', sha: SHA, force: true })).rejects.toMatchObject({
        status: 422,
        kind: 'branch-refused',
      });
      await expect(client.act('deleteBranch', REPO, { branch: 'feat/martins-work' })).rejects.toMatchObject({
        status: 422,
      });
      await expect(
        client.act('applyPatch', REPO, { branch: 'main', expectedHead: SHA, patch: 'diff', message: 'm' }),
      ).rejects.toMatchObject({ status: 422, kind: 'branch-refused' });
    }
    // GitHub was never asked.
    expect(calls(sent)).toEqual([]);
  });
});
