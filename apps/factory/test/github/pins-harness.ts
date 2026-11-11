/**
 * A repository behind the fake GitHub, for the pin watch's tests: commits as whole trees of files, branches, the App's
 * pull requests and issues, and Dependabot's pull requests, answered as GitHub answers the calls the watch and its
 * guard make. `createCommitOnBranch` makes a commit as GitHub would, on the branch's head alone.
 *
 * The fixture day (`factoryDay`) is invented: each name is the kind of thing the factory pins, under `example`, and
 * each version, digest, count and date is made up.
 */
import { createHash } from 'node:crypto';
import { APP_LOGIN } from '../../src/github/actions.ts';
import { DEPENDABOT } from '../../src/github/dependabot.ts';
import { APP_USER } from '../../src/github/issues.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import type { Route, Sent } from './fake.ts';

export const FACTORY = 'the-roganator/cv-software-factory';
const OWNER = 'the-roganator';

export const digest = (seed: string) => `sha256:${createHash('sha256').update(seed).digest('hex')}`;

export interface FakeFile {
  mode: string;
  text: string;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  user: string;
  head: string;
  /** A fork's pull request comes from another repository. */
  from?: string;
  labels: string[];
  mergeable: boolean | null;
  /** For Dependabot's: each file's patch, or none where GitHub would not send one. */
  files?: { filename: string; patch?: string }[];
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: string;
  labels: string[];
  comments: string[];
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

export class FakeRepo {
  readonly commits = new Map<string, Map<string, FakeFile>>();
  readonly refs = new Map<string, string>();
  readonly pulls: FakePull[] = [];
  readonly issues: FakeIssue[] = [];
  #next = 100;
  #commits = 0;

  constructor(files: Record<string, string | FakeFile>) {
    const tree = new Map<string, FakeFile>();
    for (const [path, file] of Object.entries(files))
      tree.set(path, typeof file === 'string' ? { mode: '100644', text: file } : file);
    this.refs.set('main', this.#commit(tree));
  }

  #commit(tree: Map<string, FakeFile>): string {
    const sha = sha1(`commit ${++this.#commits}`);
    this.commits.set(sha, tree);
    return sha;
  }

  get main(): string {
    return this.refs.get('main') as string;
  }

  /** A commit on main, changing files: as a merge or a push would. */
  push(files: Record<string, string>): string {
    const tree = new Map(this.commits.get(this.main));
    for (const [path, text] of Object.entries(files)) tree.set(path, { mode: '100644', text });
    const sha = this.#commit(tree);
    this.refs.set('main', sha);
    return sha;
  }

  /** A file as a commit or a branch has it. */
  file(ref: string, path: string): string | undefined {
    return this.commits.get(this.refs.get(ref) ?? ref)?.get(path)?.text;
  }

  number(): number {
    this.#next += 1;
    return this.#next;
  }

  addPull(pull: Partial<FakePull> & { head: string }): FakePull {
    const made: FakePull = {
      number: this.number(),
      title: '',
      body: '',
      state: 'open',
      merged_at: null,
      user: APP_LOGIN,
      labels: [],
      mergeable: true,
      ...pull,
    };
    this.pulls.push(made);
    return made;
  }

  addIssue(issue: Partial<FakeIssue>): FakeIssue {
    const made: FakeIssue = {
      number: this.number(),
      title: '',
      body: '',
      state: 'open',
      user: APP_LOGIN,
      labels: [],
      comments: [],
      ...issue,
    };
    this.issues.push(made);
    return made;
  }

  /** What GitHub answers each call the watch, its guard and the actions make. */
  routes(repo = FACTORY): Route[] {
    const at = `/repos/${repo}`;
    const notFound = { status: 404, body: { message: 'Not Found' } };
    const pullOf = (p: FakePull) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      body: p.body,
      merged_at: p.merged_at,
      draft: false,
      created_at: '2026-11-11T00:00:00Z',
      user: { login: p.user },
      labels: p.labels.map((name) => ({ name })),
      head: { ref: p.head, sha: this.refs.get(p.head) ?? 'c'.repeat(40), repo: { full_name: p.from ?? repo } },
      mergeable: p.mergeable,
    });
    const byNumber = (n: string) =>
      this.pulls.find((p) => p.number === Number(n)) ?? this.issues.find((i) => i.number === Number(n));
    const branchOf = (path: string, prefix: string) =>
      decodeURIComponent(path.slice(prefix.length).split('?')[0] ?? '');
    return [
      {
        method: 'GET',
        path: new RegExp(`^${at}/git/ref/heads/`),
        answer: ({ path }) => {
          const sha = this.refs.get(branchOf(path, `${at}/git/ref/heads/`));
          return sha ? { body: { object: { sha } } } : notFound;
        },
      },
      {
        method: 'POST',
        path: `${at}/git/refs`,
        answer: ({ body }) => {
          const { ref, sha } = body as { ref: string; sha: string };
          this.refs.set(ref.replace(/^refs\/heads\//, ''), sha);
          return { status: 201, body: {} };
        },
      },
      {
        method: 'PATCH',
        path: new RegExp(`^${at}/git/refs/heads/`),
        answer: ({ path, body }) => {
          this.refs.set(branchOf(path, `${at}/git/refs/heads/`), (body as { sha: string }).sha);
          return { body: {} };
        },
      },
      {
        method: 'DELETE',
        path: new RegExp(`^${at}/git/refs/heads/`),
        answer: ({ path }) => {
          this.refs.delete(branchOf(path, `${at}/git/refs/heads/`));
          return { status: 204 };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/git/trees/[0-9a-f]{40}\\?recursive=1$`),
        answer: ({ path }) => {
          const sha = /trees\/([0-9a-f]{40})/.exec(path)?.[1] ?? '';
          const tree = this.commits.get(sha);
          if (!tree) return notFound;
          return {
            body: {
              sha,
              truncated: false,
              tree: [...tree].map(([p, f]) => ({
                path: p,
                mode: f.mode,
                type: f.mode === '160000' ? 'commit' : 'blob',
                sha: sha1(`blob ${f.text}`),
              })),
            },
          };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/git/blobs/`),
        answer: ({ path }) => {
          const sha = path.split('/').at(-1);
          for (const tree of this.commits.values())
            for (const f of tree.values())
              if (sha1(`blob ${f.text}`) === sha)
                return { body: { encoding: 'base64', content: Buffer.from(f.text).toString('base64') } };
          return notFound;
        },
      },
      {
        // The contents API follows a symbolic link to the file it names, as GitHub's does.
        method: 'GET',
        path: new RegExp(`^${at}/contents/`),
        answer: ({ path }) => {
          const [file = '', query = ''] = path.slice(`${at}/contents/`.length).split('?');
          const ref = new URLSearchParams(query).get('ref') ?? 'main';
          const tree = this.commits.get(this.refs.get(ref) ?? ref);
          let found = tree?.get(decodeURIComponent(file));
          if (found?.mode === '120000') found = tree?.get(found.text);
          if (!found) return notFound;
          return { body: { type: 'file', encoding: 'base64', content: Buffer.from(found.text).toString('base64') } };
        },
      },
      {
        method: 'POST',
        path: '/graphql',
        answer: ({ body }) => {
          const { input } = (body as { variables: unknown }).variables as {
            input: {
              branch: { branchName: string };
              expectedHeadOid: string;
              fileChanges: { additions: { path: string; contents: string }[] };
            };
          };
          const branch = input.branch.branchName;
          if (this.refs.get(branch) !== input.expectedHeadOid)
            return {
              body: { errors: [{ type: 'STALE_DATA', message: 'Expected branch to point to another commit' }] },
            };
          const tree = new Map(this.commits.get(input.expectedHeadOid));
          for (const a of input.fileChanges.additions) {
            const was = tree.get(a.path);
            tree.set(a.path, { mode: was?.mode ?? '100644', text: Buffer.from(a.contents, 'base64').toString() });
          }
          const sha = this.#commit(tree);
          this.refs.set(branch, sha);
          return { body: { data: { createCommitOnBranch: { commit: { oid: sha } } } } };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/pulls\\?`),
        answer: ({ path }) => {
          const q = new URLSearchParams(path.split('?')[1]);
          const state = q.get('state');
          const head = q.get('head')?.slice(`${OWNER}:`.length);
          const page = Number(q.get('page') ?? 1);
          const listed = this.pulls.filter(
            (p) => (state === 'all' || p.state === state) && (head === undefined || p.head === head),
          );
          return { body: page === 1 ? listed.map(pullOf) : [] };
        },
      },
      {
        method: 'POST',
        path: `${at}/pulls`,
        answer: ({ body }) => {
          const draft = body as { head: string; title: string; body: string };
          const made = this.addPull({ head: draft.head, title: draft.title, body: draft.body });
          return {
            status: 201,
            body: {
              number: made.number,
              html_url: `https://github.test/pull/${made.number}`,
              node_id: `PR_${made.number}`,
            },
          };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/pulls/\\d+/files\\?`),
        answer: ({ path }) => {
          const pull = this.pulls.find((p) => p.number === Number(/pulls\/(\d+)/.exec(path)?.[1]));
          const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
          return { body: page === 1 ? (pull?.files ?? []).map((f) => ({ status: 'modified', ...f })) : [] };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/pulls/\\d+$`),
        answer: ({ path }) => {
          const pull = this.pulls.find((p) => p.number === Number(path.split('/').at(-1)));
          return pull ? { body: pullOf(pull) } : notFound;
        },
      },
      {
        method: 'PATCH',
        path: new RegExp(`^${at}/pulls/\\d+$`),
        answer: ({ path, body }) => {
          const pull = this.pulls.find((p) => p.number === Number(path.split('/').at(-1)));
          if (!pull) return notFound;
          Object.assign(pull, body);
          return { body: {} };
        },
      },
      {
        method: 'POST',
        path: new RegExp(`^${at}/issues/\\d+/labels$`),
        answer: ({ path, body }) => {
          const made = byNumber(path.split('/').at(-2) ?? '');
          made?.labels.push(...(body as { labels: string[] }).labels);
          return { body: [] };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/issues\\?`),
        answer: ({ path }) => {
          const q = new URLSearchParams(path.split('?')[1]);
          const label = q.get('labels');
          const page = Number(q.get('page') ?? 1);
          const listed = this.issues.filter((i) => !label || i.labels.includes(label));
          return {
            body:
              page === 1
                ? listed.map((i) => ({
                    number: i.number,
                    title: i.title,
                    state: i.state,
                    body: i.body,
                    user: { login: i.user },
                  }))
                : [],
          };
        },
      },
      {
        method: 'POST',
        path: `${at}/issues`,
        answer: ({ body }) => {
          const made = this.addIssue(body as Partial<FakeIssue>);
          return { status: 201, body: { number: made.number } };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/issues/\\d+/(comments|events)`),
        answer: ({ path }) => {
          const made = byNumber(/issues\/(\d+)/.exec(path)?.[1] ?? '');
          if (path.includes('/events')) return { body: [] };
          return { body: (made && 'comments' in made ? made.comments : []).map((body) => ({ body })) };
        },
      },
      {
        method: 'POST',
        path: new RegExp(`^${at}/issues/\\d+/comments$`),
        answer: ({ path, body }) => {
          const made = byNumber(/issues\/(\d+)/.exec(path)?.[1] ?? '');
          if (made && 'comments' in made) made.comments.push((body as { body: string }).body);
          return { status: 201, body: {} };
        },
      },
      {
        method: 'GET',
        path: new RegExp(`^${at}/issues/\\d+$`),
        answer: ({ path }) => {
          const made = byNumber(path.split('/').at(-1) ?? '');
          if (!made) return notFound;
          const pull = 'head' in made;
          return {
            body: {
              number: made.number,
              state: made.state,
              closed_at: null,
              user: { id: made.user === APP_LOGIN ? APP_USER : 49_699_333 },
              ...(pull ? { pull_request: {} } : {}),
            },
          };
        },
      },
      {
        method: 'PATCH',
        path: new RegExp(`^${at}/issues/\\d+$`),
        answer: ({ path, body }) => {
          const made = byNumber(path.split('/').at(-1) ?? '');
          if (!made) return notFound;
          const { state_reason: _, ...change } = body as Record<string, unknown>;
          Object.assign(made, change);
          return { body: {} };
        },
      },
    ];
  }
}

/** The writes a pass sent: what it did in GitHub. */
export const writes = (sent: Sent[]) =>
  sent.filter((s) => s.method !== 'GET' && !s.path.startsWith('/app/') && !s.path.endsWith('/installation'));

const counts = (critical: number, high: number, medium = 0, low = 0) => ({
  CRITICAL: critical,
  HIGH: high,
  MEDIUM: medium,
  LOW: low,
  UNKNOWN: 0,
});
const NONE = counts(0, 0);

/** A move as the moves read gives it. */
export function move(over: Partial<ReadMove> & Pick<ReadMove, 'name' | 'pins' | 'from' | 'to' | 'lane'>): ReadMove {
  return {
    repository: FACTORY,
    major: false,
    clears: counts(0, 3, 5),
    leaves: NONE,
    deadline: '2026-11-18T06:00:00Z',
    newToday: 0,
    lockfile: false,
    index: 1,
    findings: [],
    ...over,
  };
}

/** The scan's day as the moves read gives it, at a commit. */
export function day(scanned: string, moves: ReadMove[], run = 42_000_000_101): Moves {
  return {
    repository: FACTORY,
    run: {
      id: run,
      event: 'schedule',
      conclusion: 'success',
      headSha: scanned,
      updatedAt: '2026-11-11T06:20:00Z',
      url: `https://github.com/${FACTORY}/actions/runs/${run}`,
    },
    file: {
      version: 1,
      repository: FACTORY,
      judged: '2026-11-11T06:15:00Z',
      run: String(run),
      totals: {
        fixed: 0,
        moves: moves.length,
        lanes: { line: 0, worker: 0, dependabot: 0, approval: 0, cluster: 0, issue: 0, none: 0 },
        noFix: 0,
        excepted: 0,
        overdue: 0,
        dueWithinDay: 0,
        newHighWithFix: 0,
        newHighWithoutFix: 0,
      },
      scanned: [],
    },
    moves: moves.map((m, i) => ({ ...m, index: i + 1 })),
  };
}

/** The fixture day's files: each pin on a line of its own, as the factory writes them. */
export const FILES: Record<string, string> = {
  'apps/console/zap/scan.ts': [
    "// The scanner the browser tests' scan starts.",
    `export const IMAGE = 'ghcr.io/example/scanner-proxy:2.17.0@${digest('scanner-proxy/old')}';`,
    '',
  ].join('\n'),
  'deploy/base/telemetry/values/dashboards.yaml': [
    'sidecar:',
    '  image:',
    '    repository: example/sidecar',
    `    tag: 2.11.2@${digest('sidecar/old')}`,
    '',
  ].join('\n'),
  'deploy/base/telemetry/values/logs.yaml': [
    'sidecar:',
    '  image:',
    '    repository: example/sidecar',
    `    tag: 2.11.2@${digest('sidecar/old')}`,
    '',
  ].join('\n'),
  'deploy/base/telemetry/dashboards.yaml': [
    'spec:',
    '  source:',
    '    chart: example-dashboards',
    '    targetRevision: 13.2.7',
    '',
  ].join('\n'),
  'deploy/base/telemetry/logs.yaml': [
    'spec:',
    '  source:',
    '    chart: example-logs',
    '    targetRevision: 18.13.7 # example-logs 3.4.0',
    '',
  ].join('\n'),
  'deploy/k3d/cluster.yaml': [
    'apiVersion: k3d.io/v1alpha5',
    'kind: Simple',
    'image: example/k3s:v1.34.4-k3s1',
    '',
  ].join('\n'),
  'deploy/images/sbom-tool/Dockerfile': [
    '# The SBOM tool the build attests with.',
    `FROM ghcr.io/example/sbom-tool:v1.54.0@${digest('sbom-tool/old')}`,
    '',
  ].join('\n'),
  'mise.toml': ['[tools]', 'example-cd = "10.9.5"', ''].join('\n'),
  Makefile: ['EXAMPLE_CD_CHART := 10.9.5', ''].join('\n'),
  'deploy/images/old-line/Dockerfile': ['FROM example/old-line:1.0.0', ''].join('\n'),
  'pnpm-lock.yaml': ['lockfileVersion: 9.0', ''].join('\n'),
};

/** The fixture day's moves, at the commit the scan read. */
export function factoryMoves(): ReadMove[] {
  return [
    move({
      name: 'ghcr.io/example/scanner-proxy',
      pins: [{ file: 'apps/console/zap/scan.ts', line: 2 }],
      from: `2.17.0@${digest('scanner-proxy/old')}`,
      to: `image 2.17.0@${digest('scanner-proxy/new')}`,
      clears: counts(3, 112, 890, 367),
      deadline: '2026-11-12T10:40:00Z',
      lane: 'worker',
    }),
    move({
      name: 'example/sidecar',
      pins: [
        { file: 'deploy/base/telemetry/values/dashboards.yaml', line: 4 },
        { file: 'deploy/base/telemetry/values/logs.yaml', line: 4 },
      ],
      from: '2.11.2',
      to: `image 2.14.3@${digest('sidecar/new')}`,
      clears: counts(2, 30, 22, 6),
      lane: 'worker',
    }),
    move({
      name: 'example-dashboards',
      pins: [{ file: 'deploy/base/telemetry/dashboards.yaml', line: 4 }],
      from: '13.2.7',
      to: 'chart example-dashboards 13.7.2',
      clears: counts(0, 8, 14, 2),
      lane: 'worker',
    }),
    move({
      name: 'example-logs',
      pins: [{ file: 'deploy/base/telemetry/logs.yaml', line: 4 }],
      from: '18.13.7',
      to: 'chart example-logs 21.1.1 (a major)',
      major: true,
      clears: counts(1, 21, 30, 4),
      lane: 'approval',
    }),
    move({
      name: 'k3s',
      pins: [{ file: 'deploy/k3d/cluster.yaml', line: 3 }],
      from: 'v1.34.4+k3s1',
      to: 'k3s v1.34.5+k3s1',
      clears: counts(0, 21, 44, 9),
      lane: 'cluster',
    }),
    move({
      name: 'example-cd',
      pins: [
        { file: 'Makefile', line: 1 },
        { file: 'mise.toml', line: 2 },
      ],
      from: '10.9.5',
      to: 'chart example-cd 10.15.0',
      clears: counts(2, 45, 60, 12),
      lane: 'issue',
    }),
    move({
      name: 'example/old-line',
      pins: [{ file: 'deploy/images/old-line/Dockerfile', line: 1 }],
      from: '1.0.0',
      to: 'another line (this one last built 2025-10-16T08:00:00Z)',
      clears: counts(0, 2, 5, 1),
      deadline: undefined,
      lane: 'none',
    }),
    move({
      name: 'a package in `pnpm-lock.yaml`',
      pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
      from: '',
      to: '',
      lockfile: true,
      lane: 'issue',
      withheld: {
        package: '@example/tokens',
        from: '3.0.1',
        to: '3.0.2',
        pins: [{ file: 'pnpm-lock.yaml', line: 2140 }],
      },
      findings: [
        {
          alert: 5120,
          advisory: 'GHSA-xxxx-xxxx-xxxx',
          severity: 'MEDIUM',
          package: '@example/tokens',
          installed: '3.0.1',
          file: 'pnpm-lock.yaml',
          line: 2140,
          fix: 'version 3.0.2',
          firstSeen: '2026-11-10T06:00:00Z',
        },
      ],
    }),
    move({
      name: 'ghcr.io/example/sbom-tool',
      pins: [{ file: 'deploy/images/sbom-tool/Dockerfile', line: 2 }],
      from: 'v1.54.0',
      to: `image v1.55.1@${digest('sbom-tool/new')}`,
      lane: 'dependabot',
    }),
  ];
}

/** Dependabot's group pull request moving the SBOM tool, as #984's shape: its branch names a group, not a pin. */
export function dependabotGroup(repo: FakeRepo, tag: string, seed = 'sbom-tool/new'): FakePull {
  return repo.addPull({
    head: 'dependabot/docker/deploy/images/sbom-tool/docker-fa2ab4b861',
    title: 'chore(deps): bump ghcr.io/example/sbom-tool in /deploy/images/sbom-tool',
    user: DEPENDABOT,
    files: [
      {
        filename: 'deploy/images/sbom-tool/Dockerfile',
        patch: [
          '@@ -1,2 +1,2 @@',
          ' # The SBOM tool the build attests with.',
          `-FROM ghcr.io/example/sbom-tool:v1.54.0@${digest('sbom-tool/old')}`,
          `+FROM ghcr.io/example/sbom-tool:${tag}@${digest(seed)}`,
        ].join('\n'),
      },
    ],
  });
}
