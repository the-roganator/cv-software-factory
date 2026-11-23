/**
 * The patching tests (../TESTS.md), one entry each: what the harness looks for and what "deployed" means
 * for it. The list is Martin's; an entry here says only how the outcome is read from GitHub and the scratch cluster.
 */

export const FACTORY = 'the-roganator/cv-software-factory-scratch';
export const APP = 'the-roganator/cv-worlds-worst-website-scratch';

/** How a merged move is seen running. */
export type Deployed =
  /** Each chart's Applications name the move's version, Synced and Healthy. */
  | { kind: 'chart'; apps: string[] }
  /** A Ready pod runs each move's digest (but those of `hooks`, images no pod keeps running); `apps` Synced and Healthy. */
  | { kind: 'image'; apps?: string[]; hooks?: string[] }
  /** An image of ours: the App's deploy pull request for a build at or after the merge has merged, and root is past it. */
  | { kind: 'deploy-pr' }
  /** The app: its deploy pull request for a build of the merge has merged, Argo CD is past it, and the canary is done. */
  | { kind: 'app-deploy' }
  /** Nothing in the cluster runs it (a tool's pin, a development dependency, k3s, which `make upgrade-cluster` applies). */
  | { kind: 'none' };

export interface Test {
  id: string;
  title: string;
  repo: string;
  campaign: 'factory' | 'app' | 'refusal';
  /** The scan's moves it stands on, by the name moves.json gives. One pull request must carry them all. */
  moves: string[];
  /** Files its pull request may write beyond its moves' pins: what a move brings with it, by the pin step's rule. */
  brings?: RegExp[];
  /** For moves several share a name (a lockfile's, which names no package): the one that clears just this. */
  clears?: { CRITICAL?: boolean; HIGH?: boolean; MEDIUM?: number };
  /** `forged`: one forge.ts makes after the scan, as the scratch App, on a branch of its own; the gate must hold it. */
  /** Whose pull request: the App's by its pin title, the App's that writes the lockfile, or Dependabot's by title. */
  pr:
    | { by: 'pin' }
    | { by: 'lockfile' }
    | { by: 'dependabot'; title: RegExp }
    | { by: 'line' }
    | { by: 'forged'; forge: string };
  /** The app's move as its work item names it (`dependency.name`): the ticket the line is told to take. */
  dependency?: string;
  /** Among an app's lockfile moves, which file names none of: the one that clears a Critical, or the one that clears none. */
  lockfile?: 'critical' | 'no-critical';
  /** A move that must not merge: the test passes when it is refused, held or never opened. */
  mustNot?: boolean;
  /** A major that clears no Critical: held at Guarded, merged at Lights-out (a run's `--lights-out`). */
  major?: boolean;
  deployed: Deployed;
  /** Why the harness does not run it yet. */
  notRun?: string;
  /**
   * The test repository's variables the run needs, exactly: the switches of the title check that fails on purpose
   * (staged/factory/15-checks-red-on-purpose.patch). The harness only reads them, and refuses a run whose copy has any
   * `SCRATCH_RED_*` set otherwise, so one left set never spoils another test. confirm.sh sets and clears them.
   */
  variables?: Record<string, string>;
  /**
   * The pull request's head is written again with a `Checks-run: <n>` line for a failed required check. `runs`
   * is the run its last head must be (2: one flake, then it merges; 3: out of runs), `spent` that it ends out of runs,
   * never merged, with one comment and no commit after it.
   */
  checksRun?: { runs: number; spent?: boolean };
  /** How many times the line adds its pull request to the merge queue, each removal but the last for failed checks. */
  queueRuns?: number;
  /**
   * A second ticket, for another move the first's pull request makes too. The harness takes it once the first
   * has merged and before its deploy, then gives the line back the first: it must close with this outcome and its
   * reason, with no pull request of its own, no hold and no failed step.
   */
  then?: { dependency: string; closes: 'no-change'; reason: RegExp };
  /** Lines the pull request's diff of a file must take out: each copy of a package it moves. */
  removes?: { file: string; lines: string[] };
  /** For a test that ends out of tries: how long a run watches at least, from the scan, to see nothing comes after. */
  watchMin?: number;
  /** A forgery's: the gate's words must say this, so it was held for what it forged and not for another reason. */
  heldFor?: RegExp;
  /** The rule the gate must pass its pull request by (X2: `move`, never `major`). */
  rule?: string;
  /** Exactly the files its pull request may write (X4: the Dockerfile alone). */
  files?: string[];
  /** Moves the pin watch must take beside the test's own, as one group with them (`harness.ts only`), not judged. */
  alsoTakes?: string[];
  /**
   * The folder of staged patches its baseline adds (`staged/<side>-<name>/`, copies.sh's `STAGED_EXTRA`): a set-up
   * that would change other tests, so a baseline of its own.
   */
  staged?: string;
}

const LOCKFILE = 'a package in `deploy/overlays/local/factory-image/kustomization.yaml` and `pnpm-lock.yaml`';
/** The app's lockfile move of a development dependency, which no image holds: W4's semver alone, on the baseline. */
const APP_DEV_LOCKFILE = 'a package in `pnpm-lock.yaml`';
/** The factory's lockfile move of a development dependency, which its image does not install (X2's ejs). */
const FACTORY_DEV_LOCKFILE = 'a package in `pnpm-lock.yaml`';
export const TESTS: Test[] = [
  {
    id: '1',
    title: 'postgres image',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['postgres'],
    pr: { by: 'pin' },
    deployed: { kind: 'image' },
  },
  {
    id: '2',
    title: 'prometheus chart',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['prometheus'],
    pr: { by: 'pin' },
    deployed: { kind: 'chart', apps: ['prometheus'] },
  },
  {
    id: '3',
    title: 'otel-collector, two Applications',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['opentelemetry-collector'],
    pr: { by: 'pin' },
    deployed: { kind: 'chart', apps: ['otel-collector', 'pod-logs'] },
  },
  {
    id: '4a',
    title: 'loki chart, a major',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['loki'],
    major: true,
    pr: { by: 'pin' },
    deployed: { kind: 'chart', apps: ['loki'] },
  },
  {
    id: '4b',
    title: 'grafana chart, a major',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['grafana'],
    major: true,
    pr: { by: 'pin' },
    deployed: { kind: 'chart', apps: ['grafana'] },
  },
  {
    id: '5',
    title: "Kyverno's four images",
    repo: FACTORY,
    campaign: 'factory',
    moves: [
      'kyverno: ghcr.io/kyverno/readiness-checker',
      'kyverno: reg.kyverno.io/kyverno/kyverno',
      'kyverno: reg.kyverno.io/kyverno/kyvernopre',
      'kyverno: reg.kyverno.io/kyverno/reports-controller',
    ],
    pr: { by: 'pin' },
    deployed: { kind: 'image', apps: ['kyverno'], hooks: ['kyverno: ghcr.io/kyverno/readiness-checker'] },
  },
  {
    id: '6',
    title: 'Playwright image and library',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['mcr.microsoft.com/playwright'],
    pr: { by: 'pin' },
    // Its library in the lockfile and the manifests, and the day's lockfile moves, whose pull request it shares.
    brings: [/^pnpm-lock\.yaml$/, /(^|\/)package\.json$/],
    deployed: { kind: 'deploy-pr' },
  },
  {
    id: '7a',
    title: 'lockfile package in our image (8 Medium)',
    repo: FACTORY,
    campaign: 'factory',
    moves: [LOCKFILE],
    clears: { MEDIUM: 8 },
    pr: { by: 'lockfile' },
    deployed: { kind: 'deploy-pr' },
  },
  {
    id: '7b',
    title: 'lockfile package in our image (4 Medium)',
    repo: FACTORY,
    campaign: 'factory',
    moves: [LOCKFILE],
    clears: { MEDIUM: 4 },
    pr: { by: 'lockfile' },
    deployed: { kind: 'deploy-pr' },
  },
  {
    id: '8a',
    title: 'app lockfile package, direct (@grpc/grpc-js)',
    repo: APP,
    campaign: 'app',
    moves: [],
    lockfile: 'no-critical',
    pr: { by: 'line' },
    dependency: '@grpc/grpc-js',
    deployed: { kind: 'app-deploy' },
  },
  {
    id: '9',
    title: 'factory lockfile package at two versions (semver)',
    repo: FACTORY,
    campaign: 'factory',
    moves: [LOCKFILE],
    clears: { HIGH: true },
    pr: { by: 'lockfile' },
    deployed: { kind: 'none' },
  },
  {
    id: '10',
    title: 'app runtime image that brings another Node',
    repo: APP,
    campaign: 'app',
    moves: ['gcr.io/distroless/nodejs24-debian13'],
    pr: { by: 'line' },
    dependency: 'gcr.io/distroless/nodejs24-debian13',
    deployed: { kind: 'app-deploy' },
  },
  {
    id: '11',
    title: "app build image, Node's own advisory",
    repo: APP,
    campaign: 'app',
    moves: ['node'],
    pr: { by: 'line' },
    dependency: 'node',
    deployed: { kind: 'app-deploy' },
  },
  {
    id: '12',
    title: 'app image under deploy/ (Syft)',
    repo: APP,
    campaign: 'app',
    moves: ['ghcr.io/anchore/syft'],
    pr: { by: 'line' },
    dependency: 'ghcr.io/anchore/syft',
    deployed: { kind: 'app-deploy' },
  },
  {
    id: '13',
    title: 'app Critical fix (protobufjs)',
    repo: APP,
    campaign: 'app',
    moves: [],
    lockfile: 'critical',
    pr: { by: 'line' },
    dependency: 'protobufjs',
    deployed: { kind: 'app-deploy' },
  },
  {
    id: '14a',
    title: 'k3s',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['k3s'],
    pr: { by: 'pin' },
    deployed: { kind: 'none' },
  },
  {
    id: '14b',
    title: "k3d in mise.lock (one pin, the scan's two moves)",
    repo: FACTORY,
    campaign: 'factory',
    moves: ['ghcr.io/k3d-io/k3d-tools', 'ghcr.io/k3d-io/k3d-proxy'],
    pr: { by: 'pin' },
    deployed: { kind: 'none' },
  },
  // The recovery tests, W1 to W4 (the names N1 to N5 are the refusals').
  {
    // Prometheus's move, as test 2, with its title check red until the worker writes its head again.
    id: 'W1a',
    title: 'a flaky check on a pin move, run again once',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['prometheus'],
    pr: { by: 'pin' },
    deployed: { kind: 'chart', apps: ['prometheus'] },
    variables: { SCRATCH_RED_UNTIL_CHECKS_RUN: '^chore\\(pin\\): move prometheus to' },
    checksRun: { runs: 2 },
  },
  {
    // The otel-collector's move, as test 3, with its title check red every time: three runs, one comment.
    id: 'W1b',
    title: 'a check that always fails on a pin move',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['opentelemetry-collector'],
    pr: { by: 'pin' },
    deployed: { kind: 'none' },
    variables: { SCRATCH_RED_ALWAYS: '^chore\\(pin\\): move opentelemetry-collector to' },
    checksRun: { runs: 3, spent: true },
    // Three runs of a chart's checks, each with a cluster, then long enough to see no fourth.
    watchMin: 100,
  },
  {
    // Test 13's move, with its title check red the first time the merge queue tests its head.
    id: 'W2',
    title: "the line's own pull request queued again",
    repo: APP,
    campaign: 'app',
    moves: [],
    lockfile: 'critical',
    pr: { by: 'line' },
    dependency: 'protobufjs',
    deployed: { kind: 'app-deploy' },
    variables: { SCRATCH_RED_FIRST_QUEUE: '^fix\\(deps\\): move protobufjs to' },
    queueRuns: 2,
  },
  {
    // Tests 11 and 10 in turn: Node's move writes the runtime image's digest too, so the second has nothing left.
    id: 'W3',
    title: 'a move already made closes its ticket as done',
    repo: APP,
    campaign: 'app',
    moves: ['node', 'gcr.io/distroless/nodejs24-debian13'],
    pr: { by: 'line' },
    dependency: 'node',
    // biome-ignore lint/suspicious/noThenProperty: a test's second ticket, never awaited
    then: {
      dependency: 'gcr.io/distroless/nodejs24-debian13',
      closes: 'no-change',
      reason: /^Main already has its move/,
    },
    deployed: { kind: 'app-deploy' },
  },
  {
    // semver at 5.7.1 and 7.5.1 under one advisory (staged/app/15-semver-two-versions.patch), as test 9 in the
    // factory: one move, one pull request that moves both copies.
    id: 'W4',
    title: 'app lockfile package at two versions (semver)',
    repo: APP,
    campaign: 'app',
    moves: [APP_DEV_LOCKFILE],
    pr: { by: 'line' },
    dependency: 'semver',
    removes: { file: 'pnpm-lock.yaml', lines: ['  semver@5.7.1:', '  semver@7.5.1:'] },
    deployed: { kind: 'app-deploy' },
  },
  {
    id: 'N1',
    title: "breaks a test (Dependabot's node, one FROM alone)",
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'dependabot', title: /bump node from/i },
    deployed: { kind: 'app-deploy' },
    mustNot: true,
  },
  // The security tests, X1 to X4.
  {
    // After the app's scan, as the scratch App: the scan's runtime-image move, made by the copy's own
    // pin step, with the Node build stage it brings at an older real digest of node, and `Pins-made-at`/`Pins-asked`
    // lines claiming it, which the gate must not make the move from.
    id: 'X1a',
    title: 'forged: an app move with a tag it brings re-pinned',
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'forged', forge: 'X1a' },
    heldFor: /not a move: Dockerfile:\d+ /,
    deployed: { kind: 'none' },
    mustNot: true,
  },
  {
    // The same, its `Pins-made-at` in 2020: a time the gate must not make the move as of.
    id: 'X1b',
    title: 'forged: the same, claiming a pin step years before',
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'forged', forge: 'X1b' },
    heldFor: /not a move: Dockerfile:\d+ /,
    deployed: { kind: 'none' },
    mustNot: true,
  },
  {
    // ejs at 2.7.4 (staged/factory-x2/), a Critical by Trivy's own rating fixed only on the next major: the
    // major rides with the day's lockfile moves, passed as `move`, and merges at Guarded.
    id: 'X2',
    title: 'a major that clears a Trivy Critical merges (ejs)',
    repo: FACTORY,
    campaign: 'factory',
    moves: [FACTORY_DEV_LOCKFILE],
    clears: { CRITICAL: true },
    alsoTakes: [LOCKFILE],
    pr: { by: 'lockfile' },
    rule: 'move',
    removes: { file: 'package.json', lines: ['    "ejs": "2.7.4"'] },
    staged: 'x2',
    deployed: { kind: 'deploy-pr' },
  },
  {
    // mise at the scan's target Node, the Dockerfile behind (staged/app-x4/): the Node ticket ends in
    // a pull request of the Dockerfile's pins alone, passed as `move`.
    id: 'X4',
    title: 'app Node move half made: the Dockerfile alone',
    repo: APP,
    campaign: 'app',
    moves: ['node'],
    pr: { by: 'line' },
    dependency: 'node',
    rule: 'move',
    files: ['Dockerfile'],
    staged: 'x4',
    deployed: { kind: 'app-deploy' },
  },
  {
    id: 'N3a',
    title: 'forged: postgres moved backward',
    repo: FACTORY,
    campaign: 'factory',
    moves: [],
    pr: { by: 'forged', forge: 'N3a' },
    deployed: { kind: 'none' },
    mustNot: true,
  },
  {
    id: 'N3b',
    title: 'forged: a digest the registry does not serve',
    repo: FACTORY,
    campaign: 'factory',
    moves: [],
    pr: { by: 'forged', forge: 'N3b' },
    deployed: { kind: 'none' },
    mustNot: true,
  },
  {
    id: 'N4',
    title: 'forged: the real move and a line beyond its pins',
    repo: FACTORY,
    campaign: 'factory',
    moves: [],
    pr: { by: 'forged', forge: 'N4' },
    deployed: { kind: 'none' },
    mustNot: true,
  },
  {
    id: 'N5',
    title: 'forged: a deploy of an image of ours not signed on main',
    repo: FACTORY,
    campaign: 'factory',
    moves: [],
    pr: { by: 'forged', forge: 'N5' },
    deployed: { kind: 'none' },
    mustNot: true,
  },
];
