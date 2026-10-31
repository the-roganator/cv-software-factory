/**
 * Asks the cluster, as the admin service's service account, to write every stage policy/flags.ts renders to `flags`,
 * and changes outside them, and, as other service accounts, to stage a flag at all; and keeps the answers in
 * deploy/test/flag-stages-refusals.json: what the admin service's Role (deploy/base/flagd/admin-stages-flags.yaml) and
 * the `flagd-flag-stages` admission policy (deploy/base/admission/flagd/flag-stages.yaml) let through.
 * apps/factory/test/flag-fences.test.ts holds each answer to what its case must get, and the flags each admitted case
 * sent to what policy/flags.ts renders now, and the policy the cluster answered with to the one in deploy/, so the
 * shapes, the policy and the record cannot drift apart. The record keeps the hash of the Roles and the policy it was
 * taken against (scripts/policy-hash.ts), which stops the script first unless the cluster runs them as deploy/ renders
 * them here, and which apps/factory/test/refusal-records.test.ts holds to deploy/.
 *
 *     node scripts/flag-stages-refusals.ts
 *
 * Run it with the Role and the policy on the cluster, as the branch that changes either has them, whenever either or
 * policy/flags.ts changes, with credentials that may impersonate a service account (Martin's own), and a few seconds
 * after a change: the API server takes a moment to load a policy. `KUBE_CONTEXT` names the cluster
 * (`k3d-software-factory` by default).
 *
 * Each request is a server-side dry run, sent as the admin service sends its own: the whole of `flags` as it was read,
 * with its flags replaced, conditional on its resourceVersion. It passes through authorisation and admission exactly as
 * a real one does, and nothing is changed. A refusal must be the Role's or the policy's; any other answer that is not a
 * success (no connection, no `flags`, a conflict, a change the schema refuses) stops the script and leaves the record
 * as it was, so it holds only the answers of the two gates it is about.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVERY_STAGE,
  type FlagdFlag,
  flag,
  flagsSpec,
  REVISION_FLAG,
  revisionFlag,
  type Stage,
} from '../policy/flags.ts';

/** The admin service's account, as the API server names its requests. */
export const ADMIN = 'system:serviceaccount:factory:admin';
/** The policy, as Kustomize names it on the cluster (`flagd-` prefix). */
export const POLICY = 'flagd-flag-stages';
/** The revision every case writes, so the test renders the same. */
export const REVISION = 'flag-stages-refusals';
/** The feature each case stages: no flag of the app's. */
export const FLAG = 'flag-stages-refusal';

const PATH = '/apis/core.openfeature.dev/v1beta1/namespaces/flagd/featureflags/flags';

type Flags = Record<string, FlagdFlag | Record<string, unknown>>;
interface FeatureFlag {
  metadata: { labels?: Record<string, string> } & Record<string, unknown>;
  spec: { flagSpec: { flags: Flags } & Record<string, unknown> } & Record<string, unknown>;
}

export interface Case {
  case: string;
  /** Who asks: the admin service's account unless named. */
  as?: string;
  expected: 'admitted' | 'refused';
  /** What refuses it: the Role (RBAC) or the policy. */
  by?: 'role' | 'policy';
  /** For a case that writes stages through policy/flags.ts: each flag's stage. */
  stages?: Record<string, Stage>;
  /** The request: the whole of `flags` as read, changed by `change`, or another verb. */
  verb: 'replace' | 'create' | 'delete' | 'patch' | 'status';
  change?: (read: FeatureFlag) => FeatureFlag;
}

/** `flags` as read, with these flags in place of its own. */
const withFlags = (read: FeatureFlag, flags: Flags): FeatureFlag => ({
  ...read,
  spec: { ...read.spec, flagSpec: { ...read.spec.flagSpec, flags } },
});
const rendered = (stages: Record<string, Stage>) => (read: FeatureFlag) =>
  withFlags(read, flagsSpec(stages, REVISION).flagSpec.flags);
/** A stage's shape, changed: what a faulty admin service, or one holding its token, might send. */
const changed = (stage: Stage, edit: (f: Record<string, unknown>) => Record<string, unknown>) => (read: FeatureFlag) =>
  withFlags(read, {
    [FLAG]: edit(structuredClone(flag(FLAG, stage)) as unknown as Record<string, unknown>),
    [REVISION_FLAG]: revisionFlag(REVISION),
  });
const staged = (stage: Stage): Pick<Case, 'stages' | 'verb' | 'change'> => ({
  stages: { [FLAG]: stage },
  verb: 'replace',
  change: rendered({ [FLAG]: stage }),
});
/** A stage's name in the record: `share-25` for the share stage at 25. */
export const stageName = (stage: Stage) => (stage.stage === 'share' ? `share-${stage.share}` : stage.stage);
const share = (s: number) => ({ stage: 'share', share: s }) as Stage;
const targeting = (f: Record<string, unknown>) => f.targeting as { if: unknown[] };

export const CASES: Case[] = [
  // Every stage, alone, and all at once.
  ...EVERY_STAGE.map((stage): Case => ({ case: stageName(stage), expected: 'admitted', ...staged(stage) })),
  (() => {
    const stages: Record<string, Stage> = {
      [`${FLAG}-a`]: { stage: 'off' },
      [`${FLAG}-b`]: { stage: 'checks' },
      [`${FLAG}-c`]: { stage: 'preview' },
      [`${FLAG}-d`]: share(25),
      [`${FLAG}-e`]: { stage: 'everyone' },
    };
    return { case: 'every-stage', expected: 'admitted', stages, verb: 'replace', change: rendered(stages) } as const;
  })(),
  // A stage's shape changed, by the admin service: refused by the policy.
  {
    case: 'unknown-key',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: changed({ stage: 'checks' }, (f) => ({ ...f, metadata: { owner: 'refusal' } })),
  },
  {
    case: 'share-30',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: changed(share(10), (f) => {
      targeting(f).if[5] = {
        fractional: [
          ['on', 30],
          ['off', 70],
        ],
      };
      return f;
    }),
  },
  {
    case: 'other-variable',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: changed({ stage: 'checks' }, (f) => ({
      ...f,
      targeting: { if: [{ '==': [{ var: 'email' }, 'martin@example.com'] }, 'on', 'off'] },
    })),
  },
  {
    case: 'other-flag-previewed',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: changed({ stage: 'preview' }, (f) => {
      targeting(f).if[2] = { in: ['another-flag', { var: 'preview' }] };
      return f;
    }),
  },
  {
    case: 'unsigned-share',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: changed(share(50), (f) => {
      targeting(f).if[4] = true;
      return f;
    }),
  },
  {
    case: 'other-value',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: changed({ stage: 'everyone' }, (f) => ({ ...f, variants: { on: 'yes', off: false } })),
  },
  {
    case: 'disabled',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: changed({ stage: 'off' }, (f) => ({ ...f, state: 'DISABLED' })),
  },
  {
    case: 'bad-name',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: (read) =>
      withFlags(read, { Big_Buttons: flag(FLAG, { stage: 'off' }), [REVISION_FLAG]: revisionFlag(REVISION) }),
  },
  // The revision: required, in its one shape, and never a word the app keeps for no revision.
  {
    case: 'no-revision',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: (read) => withFlags(read, { [FLAG]: flag(FLAG, { stage: 'off' }) }),
  },
  ...(['none', 'stale', 'invalid'] as const).map(
    (word): Case => ({
      case: `revision-${word}`,
      expected: 'refused',
      by: 'policy',
      verb: 'replace',
      change: (read) =>
        withFlags(read, {
          [FLAG]: flag(FLAG, { stage: 'off' }),
          [REVISION_FLAG]: { state: 'ENABLED', variants: { revision: word }, defaultVariant: 'revision' },
        }),
    }),
  ),
  {
    case: 'revision-targeted',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: (read) =>
      withFlags(read, {
        [REVISION_FLAG]: {
          ...revisionFlag(REVISION),
          variants: { revision: REVISION, mark: `${REVISION}-mark` },
          targeting: { if: [{ '==': [{ var: 'marked' }, true] }, 'mark', 'revision'] },
        },
      }),
  },
  {
    case: 'revision-staged',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: (read) => withFlags(read, { [REVISION_FLAG]: { ...flag(FLAG, { stage: 'everyone' }) } }),
  },
  // Nothing else of flags.
  {
    case: 'flag-set-metadata',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: (read) => {
      const next = rendered({ [FLAG]: { stage: 'off' } })(read);
      return { ...next, spec: { ...next.spec, flagSpec: { ...next.spec.flagSpec, metadata: { refusal: true } } } };
    },
  },
  {
    case: 'evaluators',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: (read) => {
      const next = rendered({ [FLAG]: { stage: 'off' } })(read);
      return { ...next, spec: { ...next.spec, flagSpec: { ...next.spec.flagSpec, $evaluators: { refusal: true } } } };
    },
  },
  {
    case: 'label',
    expected: 'refused',
    by: 'policy',
    verb: 'replace',
    change: (read) => {
      const next = rendered({ [FLAG]: { stage: 'off' } })(read);
      return {
        ...next,
        metadata: { ...next.metadata, labels: { ...next.metadata.labels, 'flag-stages-refusal': 'x' } },
      };
    },
  },
  // What its Role does not grant.
  { case: 'second', expected: 'refused', by: 'role', verb: 'create' },
  { case: 'patch', expected: 'refused', by: 'role', verb: 'patch' },
  { case: 'status', expected: 'refused', by: 'role', verb: 'status', change: (read) => read },
  { case: 'delete', expected: 'refused', by: 'role', verb: 'delete' },
  // And nobody else of ours, staging a flag as the admin service would.
  {
    case: 'as-line',
    as: 'system:serviceaccount:factory:line',
    expected: 'refused',
    by: 'role',
    ...staged({ stage: 'checks' }),
  },
  {
    case: 'as-flagd',
    as: 'system:serviceaccount:flagd:flagd',
    expected: 'refused',
    by: 'role',
    ...staged({ stage: 'checks' }),
  },
];

/** One answer, as the record keeps it. */
export interface Answer {
  case: string;
  as: string;
  at: string;
  outcome: 'admitted' | 'refused';
  message: string;
  /** For a case that writes stages: the flags it sent. */
  flags?: Flags;
}

/**
 * The record: the hash of the Roles and the policy it was taken against (scripts/policy-hash.ts), the policy as the
 * cluster answered with it, and each answer.
 */
export interface FlagStagesRecord {
  policyHash: string;
  policies: string[];
  revision: string;
  policy: { matchConditions: unknown; variables: unknown; validations: unknown };
  answers: Answer[];
}

const kubectl = (context: string, as: string, args: string[], input?: string) =>
  spawnSync('kubectl', ['--context', context, '--as', as, ...args], { input, encoding: 'utf-8' });

function ask(context: string, read: FeatureFlag, c: Case): Answer {
  const as = c.as ?? ADMIN;
  const dry = `${PATH}?dryRun=All`;
  const second = {
    apiVersion: 'core.openfeature.dev/v1beta1',
    kind: 'FeatureFlag',
    metadata: { name: FLAG },
    spec: { flagSpec: { flags: {} } },
  };
  const sent = c.verb === 'replace' ? c.change?.(read) : undefined;
  const result =
    c.verb === 'replace'
      ? kubectl(context, as, ['replace', '--raw', dry, '-f', '-'], JSON.stringify(sent))
      : c.verb === 'create'
        ? kubectl(
            context,
            as,
            ['create', '--raw', `${PATH.replace(/\/flags$/, '')}?dryRun=All`, '-f', '-'],
            JSON.stringify(second),
          )
        : c.verb === 'patch'
          ? kubectl(context, as, [
              ...['-n', 'flagd', 'patch', 'featureflag', 'flags', '--type', 'merge', '--dry-run=server'],
              ...['-p', JSON.stringify({ spec: { flagSpec: { flags: flagsSpec({}, REVISION).flagSpec.flags } } })],
            ])
          : c.verb === 'status'
            ? kubectl(context, as, ['replace', '--raw', `${PATH}/status?dryRun=All`, '-f', '-'], JSON.stringify(read))
            : kubectl(context, as, ['delete', '--raw', dry]);
  const answer = (result.stderr || result.stdout).trim();
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const flags = c.stages ? sent?.spec.flagSpec.flags : undefined;
  if (result.status === 0)
    return { case: c.case, as, at, outcome: 'admitted', message: 'admitted', ...(flags && { flags }) };
  const message = answer.replace(/^Error from server \([A-Za-z]+\): /, '');
  if (message.includes(`ValidatingAdmissionPolicy '${POLICY}'`) || message.includes(`User "${as}" cannot`)) {
    return { case: c.case, as, at, outcome: 'refused', message, ...(flags && { flags }) };
  }
  throw new Error(`${c.case}: neither admitted nor refused by the Role or the policy:\n${answer}`);
}

if (import.meta.main) {
  const context = process.env.KUBE_CONTEXT ?? 'k3d-software-factory';
  // The Roles and the policy as the cluster runs them, or nothing asked.
  const taken = JSON.parse(
    execFileSync('node', [join(import.meta.dirname, 'policy-hash.ts'), 'flag-stages-refusals'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  ) as Pick<FlagStagesRecord, 'policyHash' | 'policies' | 'revision'>;
  // Read as the admin service reads it, which its Role must allow.
  const read = JSON.parse(
    execFileSync('kubectl', ['--context', context, '--as', ADMIN, 'get', '--raw', PATH], { encoding: 'utf-8' }),
  ) as FeatureFlag;
  const policy = JSON.parse(
    execFileSync('kubectl', ['--context', context, 'get', 'validatingadmissionpolicy', POLICY, '-o', 'json'], {
      encoding: 'utf-8',
    }),
  ) as { spec: Record<string, unknown> };
  // Every case answers before the record is written, so a script that stops leaves it as it was.
  const record: FlagStagesRecord = {
    ...taken,
    policy: {
      matchConditions: policy.spec.matchConditions,
      variables: policy.spec.variables,
      validations: policy.spec.validations,
    },
    answers: CASES.map((c) => ask(context, read, c)),
  };
  // REFUSALS_OUT writes the record elsewhere, as `make guardrails` takes it, and leaves deploy/test/ as it is.
  const elsewhere = process.env.REFUSALS_OUT;
  const out = elsewhere || join(import.meta.dirname, '..', 'deploy', 'test', 'flag-stages-refusals.json');
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  // As `make check` would have it.
  if (!elsewhere) execFileSync('pnpm', ['exec', 'biome', 'format', '--write', out], { stdio: 'ignore' });
  for (const a of record.answers)
    console.log(`${a.outcome}  ${a.case}${a.as === ADMIN ? '' : ` (as ${a.as})`}: ${a.message}`);
}
