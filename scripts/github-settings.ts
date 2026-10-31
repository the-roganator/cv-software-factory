/**
 * Applies the public repositories' GitHub settings, so they are reviewable like code and reproducible. Both get
 * the same ruleset, review environment and security settings; only the checks each requires differ. Safe to run again.
 *
 *     node scripts/github-settings.ts                  # every repository below
 *     node scripts/github-settings.ts <owner/repo>     # one of them
 *     node scripts/github-settings.ts --check          # change nothing: say where the live settings differ
 *     node scripts/github-settings.ts --check --see-bypass   # and fail on what it could not see
 *
 * `--check` reads each repository's rulesets and environments and compares them with the ones here, and names any
 * ruleset it does not know, such as one added in the browser. It exits 1 if anything it can see differs.
 * drift-check.yml runs it weekly. GitHub shows who may bypass a ruleset only to a reader who may change it: with a
 * token that cannot, such as the drift check App's, `--check` warns that it did not compare that list, and compares
 * the rest; with an admin's `gh`, it compares that too, and fails if anyone may bypass. `--see-bypass` fails on what
 * it could not see as on drift: `make guardrails` checks so with Martin's `gh`, so its proof cannot pass unread.
 *
 * It also reads each repository's record of the rulesets' verdicts on pushes (rule suites) for the last week, and
 * fails on any push that bypassed a ruleset: anyone the list once named, or who bypassed before it named nobody,
 * shows there. A reader with Administration read may see it, the drift check App among them; one that cannot is
 * warned, as for the list.
 *
 * Needs the GitHub CLI, signed in as an admin of the repository. `--check` changes nothing, so it needs only a read:
 * `GH_TOKEN` set to an installation token of the drift check App (`APPS.driftCheck`) is enough, and is how the
 * workflow runs it.
 */
import { execFileSync } from 'node:child_process';

/**
 * Each repository, and the jobs that must pass before anything merges into its main. A job in a shared workflow
 * reports as "<calling job> / <job>".
 */
export const REPOSITORIES: Record<string, string[]> = {
  'the-roganator/cv-software-factory': ['lint, types, tests', 'browser tests', 'image builds', 'pull request title'],
  // The app's gates come from this repository (app-gates.yml); tests first is a signal, not a requirement.
  'the-roganator/cv-worlds-worst-website': [
    'lint, types, tests',
    'image builds',
    'title / pull request title',
    'gates / journeys',
    'gates / test integrity',
    'gates / dependency review',
    'gates / image scan',
  ],
};

/** GitHub Actions, as the app that reports check runs. */
export const GITHUB_ACTIONS = 15368;

/**
 * The review App (ADR 0014), as the app that reports the `review` check: Martin opened the pull request, or approved
 * its head. Required from this App alone, so a workflow's job of the same name never stands in for it.
 */
export const REVIEW_APP = 5470762;

/** The check the review App posts, `scripts/review-gate.ts`. */
export const REVIEW_CHECK = 'review';

/** An environment that holds an App's key, which only workflows on `main` may use (ADR 0014). */
export interface KeyEnvironment {
  name: string;
  /** The App's key, as its workflow reads it from the environment. */
  key: string;
}

/** The one branch whose workflows may use an environment that holds a key. */
export const KEY_BRANCH = 'main';

/** The review App's key, which review.yml reads. */
export const REVIEW_ENVIRONMENT: KeyEnvironment = { name: 'review', key: 'REVIEW_APP_PRIVATE_KEY' };

/**
 * The drift check App's key, which drift-check.yml reads, with its Client ID beside it as the variable
 * `DRIFT_CHECK_APP_CLIENT_ID`. Only this repository runs the drift check, for both.
 */
export const DRIFT_CHECK_ENVIRONMENT: KeyEnvironment = { name: 'drift-check', key: 'DRIFT_CHECK_APP_PRIVATE_KEY' };

/**
 * Each repository's environments that hold a key, the only ones its workflows may read a secret from
 * (scripts/workflows.test.ts). `--check` reads these, and not the repository's own secrets or other environments.
 */
export const ENVIRONMENTS: Record<string, KeyEnvironment[]> = {
  'the-roganator/cv-software-factory': [REVIEW_ENVIRONMENT, DRIFT_CHECK_ENVIRONMENT],
  'the-roganator/cv-worlds-worst-website': [REVIEW_ENVIRONMENT],
};

/** An App's permission, as GitHub names it, and its level. */
export type Permissions = Record<string, 'read' | 'write'>;

/**
 * The organisation's GitHub Apps, what each may do, and what holds its key. None may write variables or administer
 * a repository: either would let it change what the gates read (the app's `AUTONOMY` variable) or the ruleset itself.
 * These say what each may hold; nothing here reads the installations.
 */
export const APPS = {
  /** The factory's (ADR 0005): it opens pull requests, and posts the reviewer's check run, which no ruleset requires. */
  factory: {
    slug: 'mrogan-software-factory',
    id: 5187559,
    clientId: 'Iv23liE1Dj3iYkwWX59z',
    holder: 'the GitHub worker (deploy/base/factory/github.yaml), alone',
    permissions: { checks: 'write', contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' },
  },
  /** The review gate's (ADR 0014): it posts `review`, and reads the pull request it judges. */
  review: {
    slug: 'the-roganator-review-gate',
    id: REVIEW_APP,
    clientId: 'Iv23liFNqAvApddT27zU',
    holder: `review.yml, from the "${REVIEW_ENVIRONMENT.name}" environment`,
    permissions: { checks: 'write', metadata: 'read', pull_requests: 'read' },
  },
  /**
   * The drift check's: it reads the rulesets (administration), the environments and their branch policies (actions,
   * as GitHub files them) and the names of their secrets (environments), and changes nothing. Martin makes it, so its
   * id and Client ID are not written here; its Client ID is in its environment.
   */
  driftCheck: {
    slug: 'the-roganator-drift-check',
    holder: `drift-check.yml, from the "${DRIFT_CHECK_ENVIRONMENT.name}" environment`,
    permissions: { actions: 'read', administration: 'read', environments: 'read', metadata: 'read' },
  },
} satisfies Record<string, { slug: string; id?: number; clientId?: string; holder: string; permissions: Permissions }>;

/**
 * The one ruleset on main (ADR 0014), which nobody bypasses: every change is a pull request, squash-merged, signed
 * and linear, through the merge queue, once its required checks pass, `review` among them. GitHub's own review rule
 * is not here: the queue admits only a pull request that meets every rule, so review is a check it can wait for.
 *
 * No rule that a branch be up to date with main: the queue tests each pull request on main as it will be, with the
 * pull requests ahead of it, so one behind main merges without being brought up to date first.
 */
export const rules = (requiredChecks: string[]) => ({
  name: 'main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  // Nobody bypasses it, including the owner.
  bypass_actors: [],
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_linear_history' },
    { type: 'required_signatures' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        require_code_owner_review: false,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [
          ...requiredChecks.map((context) => ({ context, integration_id: GITHUB_ACTIONS })),
          { context: REVIEW_CHECK, integration_id: REVIEW_APP },
        ],
      },
    },
    { type: 'merge_queue', parameters: MERGE_QUEUE },
  ],
});

/**
 * The merge queue: each pull request squashed, as the repository merges, and every one of a group must pass, so each
 * commit on main is one whose checks passed. A run of the checks takes about five minutes, and a chain of their jobs
 * at most about forty, so a group whose checks say nothing within the hour is taken out of the queue. Up to five are
 * tested at once, each on main with the ones ahead of it, and a pull request merges as soon as its checks pass, with
 * no wait for others to group with: there are seldom more than a few, and each run is a full one but the factory's
 * App's deploy's. That run's tests stand on the run of the entry ahead of it, or of main (check.yml's `kind` job), which
 * holds because each entry is one pull request's squashed change on the one ahead, and each must pass its own checks.
 */
export const MERGE_QUEUE = {
  merge_method: 'SQUASH',
  grouping_strategy: 'ALLGREEN',
  max_entries_to_build: 5,
  min_entries_to_merge: 1,
  max_entries_to_merge: 5,
  min_entries_to_merge_wait_minutes: 0,
  check_response_timeout_minutes: 60,
};

/** Rulesets that were here once, and are deleted where they are found: GitHub's review rule (ADR 0009), now `review`. */
export const RETIRED = ['main: review'];

/**
 * Each environment that holds a key: only workflows on main may use it, so a pull request into another branch, which
 * runs that branch's copy of the workflow, never reads the key (ADR 0014).
 */
export const environment = {
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
export const branchPolicies = [{ name: KEY_BRANCH, type: 'branch' }];

let repo = '';

function gh(method: string, path: string, body?: unknown): string {
  const args = ['api', '--method', method, `repos/${repo}${path}`, '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (body !== undefined) args.push('--input', '-');
  return execFileSync('gh', args, { input: body === undefined ? '' : JSON.stringify(body), encoding: 'utf-8' });
}

function step(what: string, apply: () => unknown): void {
  apply();
  console.log(`  ✓ ${what}`);
}

/**
 * Whether what GitHub holds says everything this script set. GitHub adds defaults of its own (such as
 * `required_reviewers: []`), so an object matches when each key this script set matches; a list must be as long, and
 * match item by item, so a bypass actor or a rule added elsewhere is drift.
 */
export function matches(live: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    return Array.isArray(live) && live.length === wanted.length && wanted.every((w, i) => matches(live[i], w));
  }
  if (wanted && typeof wanted === 'object') {
    if (!live || typeof live !== 'object') return false;
    return Object.entries(wanted).every(([key, value]) => matches((live as Record<string, unknown>)[key], value));
  }
  return live === wanted;
}

/** What a check found: drift, which fails it, and what it could not see, which it says and does not fail on. */
export interface Findings {
  problems: string[];
  unseen: string[];
}

/** Compares a repository's live rulesets and environments with these, and says what differs. */
function check(requiredChecks: string[]): Findings {
  const wanted = [rules(requiredChecks)];
  const live = JSON.parse(gh('GET', '/rulesets?per_page=100')) as { id: number; name: string }[];
  const problems = live
    .filter((r) => !wanted.some((w) => w.name === r.name))
    .map((r) => `ruleset "${r.name}" is not one of these`);
  const unseen: string[] = [];
  for (const ruleset of wanted) {
    const found = live.find((r) => r.name === ruleset.name);
    if (!found) {
      problems.push(`ruleset "${ruleset.name}" is missing`);
      continue;
    }
    const findings = rulesetProblems(JSON.parse(gh('GET', `/rulesets/${found.id}`)), ruleset);
    problems.push(...findings.problems);
    unseen.push(...findings.unseen);
  }
  const used = bypassesUsed(readable(() => JSON.parse(gh('GET', `/rulesets/rule-suites?${BYPASSES_USED}`))));
  problems.push(...used.problems);
  unseen.push(...used.unseen);
  return { problems: [...problems, ...(ENVIRONMENTS[repo] ?? []).flatMap(checkEnvironment)], unseen };
}

/**
 * What differs between a live ruleset and this script's. GitHub shows who may bypass a ruleset only to those who may
 * change it, so a reader that cannot change it gets no `bypass_actors` key at all. Whether the key is there decides,
 * not whose token read it: with it, the list is compared like the rest, and anyone it names is drift; without it, the
 * list is unseen, never read as nobody, and the rest is still compared.
 */
export function rulesetProblems(live: unknown, wanted: ReturnType<typeof rules>): Findings {
  const seesBypass = !!live && typeof live === 'object' && 'bypass_actors' in live;
  const { bypass_actors: _, ...rest } = wanted;
  const problems: string[] = [];
  if (seesBypass && !matches((live as { bypass_actors: unknown }).bypass_actors, wanted.bypass_actors)) {
    problems.push(`ruleset "${wanted.name}" lets someone bypass it`);
  }
  if (!matches(live, rest)) problems.push(`ruleset "${wanted.name}" differs from this script's`);
  const unseen = seesBypass
    ? []
    : [
        `ruleset "${wanted.name}": this token cannot see who may bypass it, which GitHub shows only to those who may change it, so that was not compared; an admin's \`--check\` compares it, as \`make guardrails\` does`,
      ];
  return { problems, unseen };
}

/** The rule suites asked for: the last week's pushes that bypassed a ruleset, as many as one page holds. */
const PAGE = 100;
const BYPASSES_USED = `time_period=week&rule_suite_result=bypass&per_page=${PAGE}`;

/**
 * What the record of the rulesets' verdicts says of bypasses: each push that bypassed a ruleset is drift. A reader
 * that may not read the record (undefined) has not seen it, and is never read as no bypass at all.
 */
export function bypassesUsed(suites: unknown): Findings {
  if (suites === undefined) {
    return {
      problems: [],
      unseen: [
        "this token cannot read the rulesets' record of pushes (rule suites), so no bypass used in the last week was looked for",
      ],
    };
  }
  if (!Array.isArray(suites)) return { problems: ["the rulesets' record of pushes is not a list"], unseen: [] };
  const bypassed = suites.filter((suite) => suite?.result === 'bypass') as Record<string, unknown>[];
  const latest = bypassed
    .map((suite) => ({ suite, at: Date.parse(String(suite.pushed_at)) }))
    .sort((a, b) => b.at - a.at)[0]?.suite;
  if (!latest) return { problems: [], unseen: [] };
  const { actor_name: who, ref, pushed_at: at, after_sha: to } = latest;
  // One page is read: a full one says "at least", and its latest is the latest on the page GitHub sends first.
  const count =
    bypassed.length === 1 ? 'a push' : `${suites.length >= PAGE ? 'at least ' : ''}${bypassed.length} pushes`;
  const problems = [
    `${count} bypassed a ruleset in the last week, the latest ${JSON.stringify(String(who ?? 'someone'))} pushing ${String(to ?? '').slice(0, 12)} to ${String(ref)} at ${String(at)}`,
  ];
  return { problems, unseen: [] };
}

/**
 * The lines `--check` prints for a repository. In GitHub Actions, drift is an `::error::` annotation and what it
 * could not see a `::warning::`, so both show on the run's summary, and the warning never stands alone beside a
 * failure.
 */
export function reportLines(name: string, { problems, unseen }: Findings, actions: boolean): string[] {
  const title = annotationProperty(name);
  const lines = problems.map((p) => (actions ? `::error title=${title}::${annotationData(p)}` : `  ✗ ${name}: ${p}`));
  lines.push(...unseen.map((u) => (actions ? `::warning title=${title}::${annotationData(u)}` : `  ! ${name}: ${u}`)));
  if (!problems.length) {
    lines.push(
      unseen.length
        ? `  ✓ ${name}: the rulesets are as this script makes them, as far as this token can see`
        : `  ✓ ${name}: the rulesets are as this script makes them`,
    );
  }
  return lines;
}

/**
 * A workflow command's message, escaped as GitHub reads it back, so a name from a live read (a ruleset added in the
 * browser) can neither end the annotation nor start a command of its own on the next line.
 */
export const annotationData = (text: string): string =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/** A workflow command's property, such as its title, where `:` and `,` would also end it. */
const annotationProperty = (text: string): string => annotationData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');

/** Compares a live environment with this script's: present, usable from main alone, and holding its key. */
function checkEnvironment(wanted: KeyEnvironment): string[] {
  const path = `/environments/${wanted.name}`;
  const live = found(() => JSON.parse(gh('GET', path)));
  if (live === undefined) return [`environment "${wanted.name}" is missing`];
  const policies = JSON.parse(gh('GET', `${path}/deployment-branch-policies`)) as { branch_policies: unknown[] };
  const problems = environmentProblems(wanted.name, live, policies.branch_policies);
  if (!hasKey(wanted)) problems.push(`environment "${wanted.name}" holds no ${wanted.key}`);
  return problems;
}

/** What a read answers, or undefined when GitHub says there is no such thing; any other failure is thrown. */
function found<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (/HTTP 404/.test(String((error as { stderr?: unknown }).stderr ?? error))) return undefined;
    throw error;
  }
}

/** What a read answers, or undefined when GitHub says this reader may not see it, or there is no such thing. */
function readable<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (/HTTP 40[34]/.test(String((error as { stderr?: unknown }).stderr ?? error))) return undefined;
    throw error;
  }
}

/** Whether an environment holds its App's key, by name: GitHub never shows a secret's value. */
function hasKey(wanted: KeyEnvironment): boolean {
  const secrets = found(
    () =>
      JSON.parse(gh('GET', `/environments/${wanted.name}/secrets?per_page=100`)) as {
        secrets: { name: string }[];
      },
  );
  return secrets?.secrets.some((s) => s.name === wanted.key) ?? false;
}

/** What differs between a live environment and its branch policies and this script's. */
export function environmentProblems(name: string, live: unknown, policies: unknown[]): string[] {
  const problems: string[] = [];
  if (!matches(live, environment)) {
    problems.push(`environment "${name}" is not limited to the branches it names`);
  }
  if (!matches(policies, branchPolicies)) {
    problems.push(`environment "${name}" may be used from other branches than ${KEY_BRANCH} alone`);
  }
  return problems;
}

function main(args: string[]): number {
  const checking = args.includes('--check');
  const seeBypass = args.includes('--see-bypass');
  const only = args.find((a) => !a.startsWith('--'));
  if (only && !REPOSITORIES[only]) {
    console.error(`${only} is not one of ours. Choose from: ${Object.keys(REPOSITORIES).join(', ')}`);
    return 1;
  }
  let drift = false;
  for (const [name, requiredChecks] of Object.entries(REPOSITORIES)) {
    if (only && name !== only) continue;
    repo = name;
    if (checking) {
      const seen = check(requiredChecks);
      // What it could not see fails it too, when asked to see everything.
      const findings = seeBypass ? { problems: [...seen.problems, ...seen.unseen], unseen: [] } : seen;
      for (const line of reportLines(repo, findings, process.env.GITHUB_ACTIONS === 'true')) console.log(line);
      drift ||= findings.problems.length > 0;
      continue;
    }
    apply(name, requiredChecks);
  }
  return drift ? 1 : 0;
}

function apply(name: string, requiredChecks: string[]): void {
  repo = name;
  console.log(`Applying settings to ${repo}`);

  step('squash merges only, titled from the pull request; branches deleted after merge', () =>
    gh('PATCH', '', {
      has_wiki: false,
      has_projects: false,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'PR_BODY',
      delete_branch_on_merge: true,
      allow_auto_merge: true,
      allow_update_branch: true,
    }),
  );

  step('secret scanning with push protection', () =>
    gh('PATCH', '', {
      security_and_analysis: {
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'enabled' },
      },
    }),
  );

  step('Dependabot alerts and security updates', () => {
    gh('PUT', '/vulnerability-alerts');
    gh('PUT', '/automated-security-fixes');
  });

  step('private vulnerability reporting', () => gh('PUT', '/private-vulnerability-reporting'));

  step('Actions must be pinned to a full commit SHA', () =>
    gh('PUT', '/actions/permissions', { enabled: true, allowed_actions: 'all', sha_pinning_required: true }),
  );

  // Workflows start read-only and ask for more per job. None may open or approve a pull request: the factory's App
  // opens the deploy and release pull requests (ADR 0005), and a workflow's token never stands in for a reviewer.
  // Apply this only once both repositories' workflows have stopped opening pull requests (their matching pull
  // requests merged), or their build and release workflows fail.
  step('workflow tokens read-only by default; workflows may not open or approve pull requests', () =>
    gh('PUT', '/actions/permissions/workflow', {
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    }),
  );

  step("first-time contributors' workflows wait for approval", () =>
    gh('PUT', '/actions/permissions/fork-pr-contributor-approval', { approval_policy: 'first_time_contributors' }),
  );

  // The release pull request carries release-please's labels; a deploy pull request, which the App opens, this one.
  const deployLabel = {
    name: 'deploy: local',
    color: '0e8a16',
    description: 'Moves an image pin in the local profile',
  };
  step(`label "${deployLabel.name}" for the deploy pull requests`, () => {
    const existing = JSON.parse(gh('GET', '/labels?per_page=100')) as { name: string }[];
    if (existing.some((l) => l.name === deployLabel.name))
      gh('PATCH', `/labels/${encodeURIComponent(deployLabel.name)}`, deployLabel);
    else gh('POST', '/labels', deployLabel);
  });

  // The environments first: the ruleset requires the check the review App's key posts.
  for (const { name: env } of ENVIRONMENTS[repo] ?? []) {
    step(`environment "${env}": used only from ${KEY_BRANCH}`, () => {
      const path = `/environments/${env}`;
      gh('PUT', path, environment);
      const live = JSON.parse(gh('GET', `${path}/deployment-branch-policies`)) as {
        branch_policies: { id: number; name: string; type?: string }[];
      };
      for (const policy of live.branch_policies) {
        if (!branchPolicies.some((p) => p.name === policy.name && p.type === (policy.type ?? 'branch'))) {
          gh('DELETE', `${path}/deployment-branch-policies/${policy.id}`);
        }
      }
      for (const policy of branchPolicies) {
        if (!live.branch_policies.some((p) => p.name === policy.name && (p.type ?? 'branch') === policy.type)) {
          gh('POST', `${path}/deployment-branch-policies`, policy);
        }
      }
    });
  }

  // Without the key, review.yml posts no check, and a ruleset requiring it would hold every pull request, the one that
  // fixes it included: nobody bypasses it. So the ruleset waits for the key (ADR 0014's order: key, a posted check,
  // then these settings).
  if (!hasKey(REVIEW_ENVIRONMENT)) {
    throw new Error(
      `${repo}: environment "${REVIEW_ENVIRONMENT.name}" holds no ${REVIEW_ENVIRONMENT.key}, so nothing would post the review check the ruleset requires. Add the key, see a review check posted, then run this again.`,
    );
  }

  const existing = JSON.parse(gh('GET', '/rulesets')) as { id: number; name: string }[];
  const apply = (ruleset: { name: string }) => {
    const id = existing.find((r) => r.name === ruleset.name)?.id;
    if (id) gh('PUT', `/rulesets/${id}`, ruleset);
    else gh('POST', '/rulesets', ruleset);
  };
  step(
    `ruleset "main": pull requests only, linear and signed, through the merge queue; requires ${[...requiredChecks, REVIEW_CHECK].join('; ')}`,
    () => apply(rules(requiredChecks)),
  );
  for (const name of RETIRED) {
    const id = existing.find((r) => r.name === name)?.id;
    if (id) step(`ruleset "${name}" deleted`, () => gh('DELETE', `/rulesets/${id}`));
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
