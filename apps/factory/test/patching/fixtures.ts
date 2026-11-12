/**
 * The GitHub worker's answers to the sense's two reads, and the cluster's pods, as recorded in their shapes with
 * invented content: no package or advisory of a finding open today. Typed against the reads' own types, so a change to
 * the contract below fails here first.
 */
import type { DependencyPull } from '../../src/github/dependabot.ts';
import type { Moves } from '../../src/github/scanning.ts';
import type { ScannedImage } from '../../src/patching/compare.ts';

export const FACTORY = 'the-roganator/cv-software-factory';
export const APP = 'the-roganator/cv-worlds-worst-website';

const zero = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
export const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

/** The factory's image, the overlay's Postgres, a chart's sidecar and k3s's CoreDNS, as the scan read them. */
export const FACTORY_SCANNED: ScannedImage[] = [
  {
    kind: 'ours',
    item: `ghcr.io/the-roganator/cv-software-factory/factory@${digest(1)}`,
    image: `ghcr.io/the-roganator/cv-software-factory/factory@${digest(1)}`,
    digests: [digest(1), digest(2), digest(3)],
    pin: { file: 'deploy/example/images.yaml', line: 17 },
  },
  {
    kind: 'third-party',
    item: `postgres:17.6@${digest(4)}`,
    image: `postgres:17.6@${digest(4)}`,
    digests: [digest(4), digest(5)],
    pin: { file: 'deploy/base/postgres/statefulset.yaml', line: 40 },
  },
  {
    kind: 'chart',
    item: 'grafana',
    image: 'quay.io/example/k8s-sidecar:2.0.0',
    digests: [digest(6), digest(7)],
    pin: { file: 'deploy/base/telemetry/values/grafana.yaml', line: 12 },
  },
  {
    kind: 'k3s-release',
    item: 'k3s v1.37.2+k3s1',
    image: 'rancher/mirrored-coredns-coredns:1.13.1',
    digests: [digest(8)],
    pin: { file: 'deploy/k3d/cluster.yaml', line: 9 },
  },
];

export const APP_SCANNED: ScannedImage[] = [
  {
    kind: 'ours',
    item: `ghcr.io/the-roganator/cv-worlds-worst-website/website@${digest(9)}`,
    image: `ghcr.io/the-roganator/cv-worlds-worst-website/website@${digest(9)}`,
    digests: [digest(9), digest(10)],
    pin: { file: 'deploy/example/website.yaml', line: 5 },
  },
];

/** The scan's own counts beside its moves, as `moves.json`'s totals give them, and the sense copies. */
export const FACTORY_COUNTS = {
  noFix: 412,
  excepted: 1,
  overdue: 0,
  dueWithinDay: 2,
  newHighWithFix: 1,
  newHighWithoutFix: 5,
};
export const APP_COUNTS = {
  noFix: 37,
  excepted: 0,
  overdue: 0,
  dueWithinDay: 0,
  newHighWithFix: 0,
  newHighWithoutFix: 0,
};

const run = (id: number) => ({
  id,
  event: 'schedule',
  conclusion: 'success',
  headSha: 'a'.repeat(40),
  updatedAt: '2026-11-11T04:58:00Z',
  url: `https://github.com/the-roganator/cv-software-factory/actions/runs/${id}`,
});

/** The factory's day: an image move, and a lockfile's move whose package the alerts give. */
export function factoryMoves(scanned: ScannedImage[] = FACTORY_SCANNED): Moves {
  return {
    repository: FACTORY,
    run: run(42000000101),
    file: {
      version: 1,
      repository: FACTORY,
      judged: '2026-11-11T04:57:00Z',
      run: '42000000101',
      totals: {
        fixed: 3,
        moves: 2,
        lanes: { line: 0, worker: 1, dependabot: 1, approval: 0, cluster: 0, issue: 0, none: 0 },
        ...FACTORY_COUNTS,
      },
      scanned,
    },
    moves: [
      {
        index: 1,
        repository: FACTORY,
        name: 'quay.io/example/k8s-sidecar',
        pins: [{ file: 'deploy/base/telemetry/values/grafana.yaml', line: 12 }],
        from: '2.0.0',
        to: `image 2.0.1@${digest(11)}`,
        major: false,
        clears: { ...zero, HIGH: 1, MEDIUM: 1 },
        leaves: zero,
        deadline: '2026-11-18T04:57:00Z',
        newToday: 0,
        lane: 'worker',
        lockfile: false,
        findings: [],
      },
      {
        index: 2,
        repository: FACTORY,
        name: 'a package in `pnpm-lock.yaml`',
        pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
        from: '',
        to: '',
        major: false,
        clears: { ...zero, LOW: 1 },
        leaves: zero,
        deadline: '2027-02-09T04:57:00Z',
        newToday: 1,
        lane: 'dependabot',
        lockfile: true,
        withheld: {
          package: 'example-parser',
          from: '1.0.0',
          to: '1.0.1',
          pins: [{ file: 'pnpm-lock.yaml', line: 120 }],
        },
        findings: [],
      },
    ],
  };
}

export function appMoves(scanned: ScannedImage[] = APP_SCANNED): Moves {
  return {
    repository: APP,
    run: { ...run(42000000202), url: 'https://github.com/the-roganator/cv-worlds-worst-website/actions/runs/1' },
    file: {
      version: 1,
      repository: APP,
      judged: '2026-11-11T04:59:00Z',
      run: '42000000202',
      totals: {
        fixed: 0,
        moves: 0,
        lanes: { line: 0, worker: 0, dependabot: 0, approval: 0, cluster: 0, issue: 0, none: 0 },
        ...APP_COUNTS,
      },
      scanned,
    },
    moves: [],
  };
}

/** Dependabot's pull request moving the lockfile's package, as its branch names it. */
export const PULL: DependencyPull = {
  number: 77,
  head: { ref: 'dependabot/npm_and_yarn/example-parser-1.0.1', sha: 'b'.repeat(40) },
  draft: false,
  createdAt: '2026-11-11T05:00:00Z',
  ecosystem: 'npm',
  directory: '/',
  dependency: 'example-parser',
  version: '1.0.1',
};

/** A pod as the API lists it: a container by its spec's image, and the digest its runtime resolved. */
export function pod(
  namespace: string,
  name: string,
  containers: { name: string; image: string; imageID?: string }[],
  phase = 'Running',
) {
  return {
    metadata: { name, namespace },
    spec: { containers: containers.map(({ name, image }) => ({ name, image })) },
    status: {
      phase,
      containerStatuses: containers.map(({ name, image, imageID }) => ({
        name,
        image,
        ...(imageID ? { imageID } : {}),
      })),
    },
  };
}

/** What the cluster runs on a day when it runs what the list says. */
export function agreeing() {
  return [
    pod('factory', 'line-7d9f-abcde', [
      {
        name: 'line',
        image: `ghcr.io/the-roganator/cv-software-factory/factory@${digest(1)}`,
        imageID: `ghcr.io/the-roganator/cv-software-factory/factory@${digest(1)}`,
      },
    ]),
    pod('factory', 'postgres-0', [
      { name: 'postgres', image: `postgres:17.6@${digest(4)}`, imageID: `docker.io/library/postgres@${digest(5)}` },
    ]),
    pod('telemetry', 'grafana-6c-xyz12', [
      {
        name: 'sidecar',
        image: 'quay.io/example/k8s-sidecar:2.0.0',
        imageID: `quay.io/example/k8s-sidecar@${digest(6)}`,
      },
    ]),
    pod('kube-system', 'coredns-5f-qq1', [
      {
        name: 'coredns',
        image: 'rancher/mirrored-coredns-coredns:1.13.1',
        imageID: `docker.io/rancher/mirrored-coredns-coredns@${digest(8)}`,
      },
    ]),
    pod('website', 'website-abc-1', [
      {
        name: 'website',
        image: `ghcr.io/the-roganator/cv-worlds-worst-website/website@${digest(9)}`,
        imageID: `ghcr.io/the-roganator/cv-worlds-worst-website/website@${digest(10)}`,
      },
    ]),
  ];
}
