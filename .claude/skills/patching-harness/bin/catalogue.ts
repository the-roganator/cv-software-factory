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
    | { by: 'forged'; forge: string }
    /** No pull request: the test is read from the scan's own run. */
    | { by: 'none' };
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
  /** Lines the pull request's diff of a file must leave as they are: a copy of a package it may not move. */
  keeps?: { file: string; lines: string[] };
  /**
   * A move the pin step refused, which waits as an issue of the App's beside the pull request that merges without it:
   * what the issue names in code (its package, the release refused), what it says, and what it never does.
   */
  refused?: { names: string[]; says: RegExp[]; never: RegExp[] };
  /** For a test that ends out of tries: how long a run watches at least, from the scan, to see nothing comes after. */
  watchMin?: number;
  /** A forgery GitHub must refuse at the push: what its refusal must say. With it, the refusal is the pass. */
  refusedPush?: RegExp;
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
  /**
   * A routine update: a pin merely behind, which the scan lists with nothing to clear. Its pull request is on a branch
   * of routine updates, apart from the moves a finding asks for, and the next scan no longer lists it.
   */
  routine?: boolean;
  /** A move that is Martin's to make: it ends as an issue, with no pull request of the App's, at every level. */
  issue?: boolean;
  /** For one that ends as an issue: the scan's lane for it (`issue` unless said), and what the issue's body must say. */
  lane?: string;
  says?: RegExp;
  /** A move that is the App's to write: an issue opened for it fails the test. */
  noIssue?: boolean;
  /** Who must add its pull request to the merge queue: the scratch App (the worker). */
  queuedBy?: 'app';
  /**
   * Its pull request moves the repository's pins of another's workflows: after the merge every one of the `count`
   * `uses:` lines is at one commit, on the called repository's main and after the one pinned before.
   */
  calls?: { repo: string; count: number };
  /**
   * The scan with one image the registry will not serve: the image as the run's annotation names it, and the file
   * that pins it, whose open alerts must not fall.
   */
  unread?: { image: string; file: string; alerts?: boolean };
  /** Its pull request is Dependabot's own, which the run summons (`./copies.sh summon-dependabot`). */
  summons?: boolean;
  /**
   * A pull request of Dependabot's, by its title, that must be open beside the test's own move as the run starts
   * (baseline.env keeps it): the move is proven with Dependabot's of the same pin there, as the real repository has it.
   */
  beside?: RegExp;
  /**
   * Its pull request is Dependabot's for a pin the App's move makes too, opened afresh for the run, which summons
   * Dependabot on the factory copy after its reset (`./copies.sh summon-dependabot factory`): the worker closes it
   * once the move of test `of` has merged, and leaves open every one of Dependabot's titled as `leaves`, which
   * `main` does not have every line of.
   */
  duplicate?: { of: string; leaves: RegExp };
  /**
   * Its move is put on main before the line takes its ticket (`./copies.sh move-on-main`), as another change would
   * have made it: the ticket must close with this outcome and reason, with no pull request, no hold and no failed
   * step, and its issue as completed.
   */
  made?: { closes: 'no-change'; reason: RegExp };
  /**
   * Its target moves on once its pull request is open: the first scan names `first` for `package`, as the factory
   * copy's main excepts the advisory only the later release fixes (staged/factory-<staged>/); the run lifts the
   * exception (`./copies.sh lift-exception`) and scans again, and the same pull request and issue must take `later`.
   */
  newer?: { package: string; first: string; later: string };
  /** The store restarted under a report left through the app's widget: no scan, no reset, a step of its own. */
  restart?: boolean;
}

const LOCKFILE = 'a package in `deploy/overlays/local/factory-image/kustomization.yaml` and `pnpm-lock.yaml`';
/** The app's lockfile move of a development dependency, which no image holds: W4's semver alone, on the baseline. */
const APP_DEV_LOCKFILE = 'a package in `pnpm-lock.yaml`';
/** The factory's lockfile move of a development dependency, which its image does not install (X2's ejs). */
const FACTORY_DEV_LOCKFILE = 'a package in `pnpm-lock.yaml`';
/**
 * Why two of N8's three are not run: nobody can open a pull request as Dependabot, and the gate holds anyone else's for
 * that before it reads the commit the calls moved to, so a live forgery of each would show the one hold N8a shows.
 */
const N8_UNIT =
  "the gate holds any but Dependabot's for its opener, as N8a shows; what it does with this change under Dependabot's name is its unit tests' (scripts/review-routing.test.ts)";
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
    // One pull request for the file's four moves: the pin watch opens one for each set of files, its description
    // marking every move it carries (`pinMoves`), and the test's verdict wants exactly one.
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
    beside: /anchore\/syft/i,
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
  // The routine updates and the rest of 15 to 20.
  {
    // pino, which the factory's and the console's images carry, staged at 10.3.1 (staged/factory/20-…) with 10.4.0
    // out since 2 October 2026. npm's publish time is the registry's own, so the wait is over on a copy just reset;
    // a chart's or an image's routine update counts from the day the scan first saw it, which a reset forgets. It
    // rides with the day's other routine lockfile updates, in their one pull request, and the factory's deploy pin
    // that follows the merge is its deploy. Every routine lockfile move has the one public name, in an image or not.
    id: '15',
    title: 'a routine update of a package in our images (pino)',
    repo: FACTORY,
    campaign: 'factory',
    moves: [FACTORY_DEV_LOCKFILE],
    routine: true,
    pr: { by: 'lockfile' },
    removes: { file: 'pnpm-lock.yaml', lines: ['  pino@10.3.1:'] },
    deployed: { kind: 'deploy-pr' },
  },
  {
    // vitest, 5.1.0 in the app's lockfile with 5.1.1 out since 18 November, inside `package.json`'s range: the scan
    // lists it as a package in the lockfile, the sense sends it, and the line is told its ticket by the package's name.
    id: '16',
    title: 'app routine update, made by the line (vitest)',
    repo: APP,
    campaign: 'app',
    moves: [APP_DEV_LOCKFILE],
    routine: true,
    pr: { by: 'line' },
    dependency: 'vitest',
    removes: { file: 'pnpm-lock.yaml', lines: ['  vitest@5.1.0:'] },
    deployed: { kind: 'app-deploy' },
  },
  {
    // Argo CD's chart in the Makefile, 10.15.0 (Argo CD v3.6.1) with findings a later 10.x clears on the same 3.6
    // line as mise's CLI: the App's pull request of that one line, and no issue.
    id: '17',
    title: "the Makefile's pin of Argo CD's chart",
    repo: FACTORY,
    campaign: 'factory',
    moves: ['argo-cd'],
    pr: { by: 'pin' },
    files: ['Makefile'],
    noIssue: true,
    deployed: { kind: 'none' },
  },
  {
    // The console's WebAuthn browser library, a development dependency staged at 13.3.0, the last release of its
    // major (staged/factory/18-…), with 14.0.0 out since 2 September 2026, no advisory, and provenance on both, so
    // pnpm takes the move: the lockfile's routine update across a major, on a branch of its own, which writes the
    // manifest's range too. Vite builds the library into the console, whose deploy follows the merge unjudged.
    id: '18',
    title: 'a routine update across a major (@simplewebauthn/browser)',
    repo: FACTORY,
    campaign: 'factory',
    moves: [FACTORY_DEV_LOCKFILE],
    routine: true,
    major: true,
    pr: { by: 'lockfile' },
    removes: { file: 'apps/console/package.json', lines: ['    "@simplewebauthn/browser": "^13.3.0"'] },
    deployed: { kind: 'none' },
  },
  {
    id: '19',
    title: 'the scan, with one image the registry will not serve',
    repo: FACTORY,
    campaign: 'factory',
    moves: [],
    pr: { by: 'none' },
    // The pin of staged/factory/19-…: a real, public repository at a tag and a digest it never had, which the
    // registry answers at once. `image` is what the run's annotation must name; change it here if the scan words
    // its line otherwise. With `alerts: true` the open alerts at `file` are counted before and after, for an image
    // the scan read before.
    unread: { image: 'ghcr.io/anchore/grype', file: 'scripts/unread/Dockerfile' },
    deployed: { kind: 'none' },
  },
  {
    // Dependabot's pull request for the group `factory` of the app's dependabot.yml (staged/app/20-…): the six
    // `uses:` lines of the factory copy's workflows, moved to the factory copy's main.
    id: '20',
    title: "Dependabot's move of the app's pins of the factory's workflows",
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'dependabot', title: /bump the factory group/i },
    rule: 'exact-pin',
    queuedBy: 'app',
    files: [
      '.github/workflows/codeql.yml',
      '.github/workflows/gates.yml',
      '.github/workflows/pull-request.yml',
      '.github/workflows/review.yml',
      '.github/workflows/scorecard.yml',
      '.github/workflows/vulnerabilities.yml',
    ],
    calls: { repo: FACTORY, count: 6 },
    summons: true,
    deployed: { kind: 'none' },
  },
  {
    // follow-redirects, a development dependency staged at exactly 1.14.8 (staged/app-21/), so pnpm resolves exactly
    // the scan's target. The factory copy excepts, for the app, the advisory only 1.16.0 fixes (staged/factory-21/),
    // so the first scan names 1.15.6; with the exception lifted the next names 1.16.0.
    id: '21',
    title: 'app move whose target moves on (follow-redirects)',
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'line' },
    dependency: 'follow-redirects',
    newer: { package: 'follow-redirects', first: '1.15.6', later: '1.16.0' },
    staged: '21',
    deployed: { kind: 'app-deploy' },
  },
  {
    // Dependabot's pull request for Postgres's image, one line of the StatefulSet, which is test 1's pin: Dependabot
    // opens it afresh within minutes of being summoned, whatever a reset closed. Beside it, its pull request for the
    // group `playwright`, kept as it is on a base from before every baseline (baseline.env's
    // DEPENDABOT_AS_IS_FACTORY): some two hundred files, so `main` never has every line of it, whatever test 6 moves.
    id: '22',
    title: "Dependabot's pull request for a pin the App moved",
    repo: FACTORY,
    campaign: 'factory',
    moves: [],
    pr: { by: 'dependabot', title: /bump postgres in \/deploy\/base\/postgres/i },
    duplicate: { of: '1', leaves: /"playwright" group/i },
    deployed: { kind: 'none' },
  },
  {
    // lefthook, 2.2.1 on every baseline with 2.2.2 out, which was published without the provenance its earlier
    // releases had: pnpm refuses it, the pin step leaves it out, and the day's other routine lockfile updates ride
    // without it in the pull request test 15 stands on too.
    id: '23',
    title: 'a routine update pnpm refuses (lefthook)',
    repo: FACTORY,
    campaign: 'factory',
    moves: [FACTORY_DEV_LOCKFILE],
    routine: true,
    pr: { by: 'lockfile' },
    keeps: { file: 'pnpm-lock.yaml', lines: ['  lefthook@2.2.1:'] },
    refused: { names: ['lefthook', '2.2.2'], says: [/weaker provenance/], never: [/log says which/] },
    deployed: { kind: 'none' },
  },
  {
    // The devcontainer's base image on a line its publisher no longer builds: the scan lists it with no lane, and the
    // worker opens an issue for it in the app's repository.
    id: '24',
    title: "a move nobody can make (the devcontainer's base)",
    repo: APP,
    campaign: 'app',
    moves: ['mcr.microsoft.com/devcontainers/base'],
    issue: true,
    lane: 'none',
    says: /no longer built/,
    pr: { by: 'pin' },
    deployed: { kind: 'none' },
  },
  {
    // The Postgres exporter one release back, as a service of a workflow run only by hand
    // (staged/factory/16-a-workflow-pin.patch), with findings its next release clears.
    id: 'N6',
    title: 'a workflow pin stays an issue for Martin',
    repo: FACTORY,
    campaign: 'factory',
    moves: ['quay.io/prometheuscommunity/postgres-exporter'],
    issue: true,
    pr: { by: 'pin' },
    deployed: { kind: 'none' },
  },
  {
    // The pin watch's title and label on a commit that moves a third-party action's pin in a workflow, pushed as the
    // scratch App: GitHub refuses it, as the App has no `workflows` permission, and that refusal is the fence. Its
    // words for an installation's token are "Resource not accessible by integration" (a 403), which the same token
    // does not get for the other forgeries' files. Had the push landed, the gate must hold its pull request.
    id: 'N7',
    title: 'forged: a workflow pin moved by the App, which GitHub refuses',
    repo: FACTORY,
    campaign: 'factory',
    moves: [],
    pr: { by: 'forged', forge: 'N7' },
    refusedPush: /Resource not accessible by integration|workflows?[`'" ]+permission|without `?workflows`?/i,
    deployed: { kind: 'none' },
    mustNot: true,
  },
  {
    // Test 20's change with one third-party action's line moved too, on a branch Martin's login pushed and a pull
    // request the scratch App opened: held as the App's own change to a code-owned path, which the gate judges before
    // it would ask who opened an exact pin of the factory's workflows.
    id: 'N8a',
    title: "forged: the factory's workflows and a third-party action's line",
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'forged', forge: 'N8a' },
    heldFor: /Held for its risk tags \(code-owned\)|Dependabot did not open it/,
    deployed: { kind: 'none' },
    mustNot: true,
  },
  {
    // The same six lines, at a commit on another branch of the factory copy than main.
    id: 'N8b',
    title: "forged: the factory's workflows at a commit not on its main",
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'forged', forge: 'N8b' },
    heldFor: /Held for its risk tags \(code-owned\)|Dependabot did not open it/,
    deployed: { kind: 'none' },
    mustNot: true,
    notRun: N8_UNIT,
  },
  {
    // The same six lines, at a commit of the factory copy's main before the one pinned.
    id: 'N8c',
    title: "forged: the factory's workflows at a commit behind the pinned one",
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'forged', forge: 'N8c' },
    heldFor: /Held for its risk tags \(code-owned\)|Dependabot did not open it/,
    deployed: { kind: 'none' },
    mustNot: true,
    notRun: N8_UNIT,
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
    // Syft's move, as test 12, its tag and digest put on main before the line takes the ticket.
    id: 'W3b',
    title: 'an image move main already has closes its ticket as done',
    repo: APP,
    campaign: 'app',
    moves: ['ghcr.io/anchore/syft'],
    pr: { by: 'line' },
    dependency: 'ghcr.io/anchore/syft',
    made: { closes: 'no-change', reason: /^Main already has its move/ },
    deployed: { kind: 'none' },
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
    // A report through the app's widget, and the store's pod deleted at once: Argo CD puts it back, and the log
    // watcher, which was about to leave the report in the inbox, must ride it out.
    id: 'W5',
    title: "the store restarting under the log watcher's send",
    repo: APP,
    campaign: 'app',
    moves: [],
    pr: { by: 'none' },
    restart: true,
    deployed: { kind: 'none' },
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
