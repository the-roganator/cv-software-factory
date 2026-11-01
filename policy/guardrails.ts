/**
 * Spec 6's eleven guardrails, in its words, each with the mechanism that holds it (the designs' words), the proofs
 * `make guardrails` takes of it, and the red-team attack made against it. The Guardrails panel draws its rows from this,
 * the red-team menu takes each attack's guardrail from it, and `make guardrails` runs the proofs it lists, recording each
 * as `guardrail.proved` under its id and the guardrails that list it. A refusal's row comes from the refusal's own
 * guardrails (`policy/refusals.ts`), not from here.
 *
 * A guardrail reads as held while every proof's latest result held, attacks included, and as not held while any
 * proof's latest failed, until that same proof holds again: a later pass of another cannot hide it.
 *
 * Human-owned: see `README.md`.
 */
/** Spec 5.3's red-team attacks, in its order, by their ids. */
export const ATTACKS = ['report', 'workflow', 'test', 'egress', 'image'] as const;
export type Attack = (typeof ATTACKS)[number];

/** What a proof is, and how `make guardrails` takes it. */
export interface Proof {
  /** What it shows, and how. */
  for: string;
  /** What holds the guardrail it proves, as its `guardrail.proved` names it: `ci-tests` for one read from CI. */
  mechanism: string;
}

/**
 * Every proof `make guardrails` takes, by its id: one read from CI is `ci:` and its name, and reads `main`'s last
 * merge-group run of the jobs that prove it.
 */
export const PROOFS = {
  'workflow-refusal': {
    for: "The factory's App asked to commit to a workflow, under the-roganator, and GitHub refusing it.",
    mechanism: 'token-permission',
  },
  'app-permissions': {
    for:
      'Each App installed in the organisation, read live, against the Apps declared in `scripts/github-settings.ts`: ' +
      'only those, each with exactly its declared permissions, and none writing Variables, Administration, Workflows, ' +
      'secrets or environments.',
    mechanism: 'token-permission',
  },
  bypass: {
    for:
      "`scripts/github-settings.ts --check --see-bypass` with Martin's `gh`, which sees each ruleset's bypass list: " +
      'it fails if a list is unseen or names anyone, or a push bypassed a ruleset in the last week.',
    mechanism: 'ruleset',
  },
  'ci:gates-deterministic': {
    for: 'The tests that every required check is posted by GitHub Actions or the review App, and none reaches a model.',
    mechanism: 'ci-tests',
  },
  admission: {
    for:
      '`scripts/admission-refusals.sh`: images not signed by build.yml on main refused, one under our own registry ' +
      'signed by another identity among them.',
    mechanism: 'admission-control',
  },
  'production-writes': {
    for:
      "The refusals of writes to the app's Rollout, flags, flag stages, share key, routes and mark, and the " +
      "telemetry proxy's refusal of anything but reads.",
    mechanism: 'admission-control',
  },
  egress: {
    for: '`scripts/egress.sh`, each check: what each pod may reach, and nothing more.',
    mechanism: 'egress-policy',
  },
  'ci:one-gateway': {
    for:
      "The tests that only the gateway holds a model provider's key, in every profile's manifests, and that an agent's " +
      'pod holds its job token in its place and reaches the gateway and the line alone.',
    mechanism: 'ci-tests',
  },
  'ci:spend-caps': {
    for: "The gateway's tests of its caps: the day's, the month's and a work item's.",
    mechanism: 'ci-tests',
  },
  'ci:public-hostile': {
    for:
      "The workflows' tests and the GitHub worker's guard's: no outside pull request runs with a secret, and the " +
      'factory acts only on what it opened.',
    mechanism: 'ci-tests',
  },
  'ci:scope-fence': {
    for: "The scope fence's tests: a patch outside its spec's scope is refused.",
    mechanism: 'ci-tests',
  },
  'ci:stopped-line': {
    for:
      "The gateway's, the line's and the runners' tests of a stop: an agent's calls refused from the first after the " +
      'gateway hears the line stopped, or within a few seconds when it hears nothing, and the step in hand ended, its ' +
      'jobs and its token with it, and none started, until it starts again.',
    mechanism: 'ci-tests',
  },
  'stop-the-line': {
    for:
      'The drill: the line stopped, no step running and no work item taken; then the line started again. And the ' +
      'last real canary a stop aborted, and how long ago.',
    mechanism: 'stop-the-line',
  },
  rollback: {
    for: "The last real rollback of a canary, with its analysis's verdict verbatim, who rolled it back, and how long ago.",
    mechanism: 'canary-analysis',
  },
} as const satisfies Record<string, Proof>;
export type ProofId = keyof typeof PROOFS;

/** A proof read from CI. */
export type CiProofId = Extract<ProofId, `ci:${string}`>;

/** Where a proof read from CI is found, and what it is of. */
export interface CiProof {
  /** The workflow whose merge-group runs on `main` it reads. */
  workflow: string;
  /** The job that runs its tests: every part of it, when it runs in parts. */
  job: string;
  /**
   * The test files that prove it, each of which the job runs and CODEOWNERS gives Martin (guardrails.test.ts checks
   * both), so a change to one is put to him as a change to the rules.
   */
  tests: readonly string[];
}

const CHECK = '.github/workflows/check.yml';

/**
 * Which job proves each guardrail read from CI, and by which tests. `make guardrails` reads the job in the newest
 * merge-group run of its workflow on `main`'s first-parent history that ran it, and the proof holds only if every part
 * of the job passed there, and that commit reached `main` no more than a day before `main`'s head did. A run from a
 * pull request, or from a fork, never counts.
 */
export const CI_PROOFS = {
  'ci:gates-deterministic': {
    workflow: CHECK,
    job: 'tests',
    tests: ['scripts/github-settings.test.ts', 'scripts/merge-decisions.test.ts', 'scripts/review-gate.test.ts'],
  },
  'ci:one-gateway': {
    workflow: CHECK,
    job: 'tests',
    tests: [
      'apps/factory/test/credentials.test.ts',
      'apps/factory/test/runner-fences.test.ts',
      'apps/factory/test/proofs/one-gateway.runners.test.ts',
    ],
  },
  'ci:spend-caps': {
    workflow: CHECK,
    job: 'tests',
    tests: ['apps/factory/test/proofs/spend-caps.gateway.test.ts'],
  },
  'ci:public-hostile': {
    workflow: CHECK,
    job: 'tests',
    tests: [
      'scripts/workflows.test.ts',
      'apps/factory/test/proofs/public-hostile.issues.test.ts',
      'scripts/review-gate.test.ts',
    ],
  },
  'ci:scope-fence': {
    workflow: CHECK,
    job: 'tests',
    tests: [
      'apps/factory/test/proofs/scope-fence.runners.test.ts',
      'apps/factory/test/proofs/scope-fence.coder.test.ts',
      'apps/factory/test/proofs/scope-fence.line.test.ts',
    ],
  },
  'ci:stopped-line': {
    workflow: CHECK,
    job: 'tests',
    tests: [
      'apps/factory/test/proofs/stopped-line.gateway.test.ts',
      'apps/factory/test/proofs/stopped-line.line.test.ts',
      'apps/factory/test/proofs/stopped-line.runners.test.ts',
    ],
  },
} as const satisfies Record<CiProofId, CiProof>;

export interface Guardrail {
  /** Its number in spec 6. */
  n: number;
  /** Its name, in spec 6's bold words. */
  name: string;
  /** The rest of spec 6's words, as they follow its name: none for a guardrail that is its name alone. */
  rule: string;
  /** What holds it, as the Guardrails panel says. */
  mechanism: string;
  /** The proofs `make guardrails` takes of it: none for one only its attack proves. */
  proofs: readonly ProofId[];
  /** The red-team attack made against it, if one is. */
  attack?: Attack;
}

export const GUARDRAILS = [
  {
    n: 1,
    name: 'Agents cannot change the rules',
    rule: 'Workflows, gate thresholds, policies and this list are human-owned; agent credentials cannot modify them.',
    mechanism:
      'The App’s token has no workflows permission; main’s ruleset, which names nobody who may bypass it; CODEOWNERS ' +
      'and the review gate read from main.',
    proofs: ['workflow-refusal', 'app-permissions', 'bypass'],
    attack: 'workflow',
  },
  {
    n: 2,
    name: 'Gates are deterministic',
    rule: 'A model never decides whether code merges or ships.',
    mechanism:
      'Every required check is posted by GitHub Actions or the review App; no gate’s code reaches the gateway or a model.',
    proofs: ['ci:gates-deterministic'],
    attack: 'test',
  },
  {
    n: 3,
    name: 'Only the pipeline builds releasable artifacts',
    rule: '',
    mechanism:
      'Admission control: Kyverno admits only images build.yml signed on main, and the few third-party images it names ' +
      'by digest.',
    proofs: ['admission'],
    attack: 'image',
  },
  {
    n: 4,
    name: 'No agent writes to production',
    rule: 'Deployment is pull-based from git; telemetry access is read-only.',
    mechanism:
      'Argo CD deploys what is on main; telemetry is read through a read-only proxy; no worker’s Role may write the ' +
      'Rollout.',
    proofs: ['production-writes'],
  },
  {
    n: 5,
    name: 'Agent sandboxes are disposable and fenced',
    rule: 'no production secrets, egress limited to what the task needs.',
    mechanism:
      'A pod for each step in runners, with no Secret and no service-account token; its egress reaches the gateway and ' +
      'the line, and nothing else.',
    proofs: ['egress'],
    attack: 'egress',
  },
  {
    n: 6,
    name: 'All model access goes through one gateway',
    rule: 'which holds credentials, enforces budgets and logs every call.',
    mechanism: 'Only the gateway’s pod holds a model key; it checks each call against the models policy and logs it.',
    proofs: ['ci:one-gateway'],
  },
  {
    n: 7,
    name: 'Hard spend caps',
    rule: '(daily, monthly, per task, visitor). At the cap, agents stop and the console says so.',
    mechanism: 'The gateway refuses every call at a cap: the day’s, the month’s and a work item’s.',
    proofs: ['ci:spend-caps'],
  },
  {
    n: 8,
    name: 'All inputs are untrusted',
    rule: 'reports, logs, issues, web content.',
    mechanism:
      'Triage asks Jev typed questions, so a report’s text never reaches an agent; one that gives orders is ' +
      'quarantined.',
    proofs: [],
    attack: 'report',
  },
  {
    n: 9,
    name: 'Everything is reversible',
    rule: 'automatic rollback; stop the line always works.',
    mechanism:
      'The canary rolls itself back; Stop the line ends every step, takes nothing new and aborts a canary in flight.',
    proofs: ['ci:stopped-line', 'stop-the-line', 'rollback'],
  },
  {
    n: 10,
    name: 'Public means hostile',
    rule:
      'The factory acts only on issues and pull requests it created, and reads no issue as work: Martin asks for work ' +
      'in the console. An issue anyone else opens gets one polite bot reply, and nothing more. Outside PRs are never ' +
      'run with secrets, reviewed with credentials or merged automatically: the review gate passes none Martin has not ' +
      'approved at its head. No self-hosted runners on public repos.',
    mechanism:
      'The factory reads no issue as work, and acts only on what it opened; an outside pull request runs with no ' +
      'secret and is never passed without Martin.',
    proofs: ['ci:public-hostile'],
  },
  {
    n: 11,
    name: 'No fix widens its ticket',
    rule:
      'Each acceptance criterion names the evidence it comes from, and a change tagged out-of-scope waits for a human ' +
      'in every autonomy mode.',
    mechanism: 'The scope fence refuses a patch outside its spec’s scope; out-of-scope waits for Martin in every mode.',
    proofs: ['ci:scope-fence'],
  },
] as const satisfies readonly Guardrail[];

/** The guardrails a proof proves: those that list it. */
export const guardrailsProvedBy = (proof: ProofId): number[] =>
  GUARDRAILS.filter((guardrail) => (guardrail.proofs as readonly ProofId[]).includes(proof)).map(({ n }) => n);

/** The guardrail an attack is made against. */
export const guardrailAttacked = (attack: Attack): number | undefined =>
  GUARDRAILS.find((guardrail) => 'attack' in guardrail && guardrail.attack === attack)?.n;
