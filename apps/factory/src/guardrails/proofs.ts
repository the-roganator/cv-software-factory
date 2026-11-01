/**
 * What takes each proof in the catalogue (`policy/guardrails.ts`), and how it is judged. Each takes its proof now,
 * from this checkout and the world as it is, and says whether it held, in the words of what it ran; the command
 * records each as `guardrail.proved` (`commands/guardrails.ts`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cutTo } from '@software-factory/events';
import type { Sql } from 'postgres';
import { CI_PROOFS, type CiProofId, type ProofId } from '../../../../policy/guardrails.ts';
import { APPS, REPOSITORIES as SETTINGS } from '../../../../scripts/github-settings.ts';
import { named, nameOf, policyHash, type RecordName, type Resource } from '../../../../scripts/policy-hash.ts';
import { REPOSITORIES } from '../github/config.ts';
import type { Refusal } from '../github/refusal.ts';
import { readCiProof } from './ci.ts';
import { type Installation, judgeInstallations } from './github.ts';
import { type DrillTaken, rollback, stopTheLine } from './line.ts';
import { type EgressRecord, judgeEgress, judgeRecord, otherIdentityProblems, type RefusalRecord } from './records.ts';

/** What a command run printed, and how it exited. */
export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** What the proofs need of the world. */
export interface Context {
  /** The checkout's root. */
  root: string;
  /** A folder of the run's own, for the records the scripts take. */
  tmp: string;
  /** Runs a command in the checkout, showing what it prints as it goes, and gives what it printed. */
  run(command: string, args: string[], env?: Record<string, string>): Promise<Ran>;
  /** A read of GitHub's API with Martin's `gh`. */
  gh<T>(path: string): Promise<T>;
  /** `main`'s first-parent history from this checkout's head, the head first. */
  firstParent(): Promise<string[]>;
  /** The factory's App key, from the Keychain. */
  appKey(): Promise<string>;
  /** Every manifest the cluster's profile renders from this checkout. */
  rendered(): Resource[];
  /** The store, as the proofs' role. */
  sql: Sql;
  /** The cluster's kubeconfig context, which the drill's `make` targets are given as `CONTEXT`. */
  kubeContext: string;
  /** The drill's needs of the cluster and of Martin. */
  runnerPods(): Promise<{ name: string; part?: string }[]>;
  ask(question: string): Promise<boolean>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  say(line: string): void;
}

/** A proof taken: held or not, with its output and what it was taken against. */
export interface Taken {
  held: boolean;
  output: string;
  /** The CI run's commit, for a proof read from CI; otherwise the checkout's. */
  commit?: string;
  policyHash?: string;
  run?: { url: string; at: string };
}

/** A proof that was not taken (Martin said no, or CI has no run to read), and why: nothing is recorded for it. */
export interface NotTaken {
  notTaken: string;
}

export type Proof = (context: Context) => Promise<Taken | NotTaken>;

/** The most of a proof's output an event keeps. */
const OUTPUT = 4000;
export const text = (...parts: string[]) =>
  cutTo(parts.filter(Boolean).join('\n').trim() || '(nothing printed)', OUTPUT);

/** The repository the CI proofs are read from: this one. */
export const REPOSITORY = 'the-roganator/cv-software-factory';
const ORGANISATION = REPOSITORY.split('/')[0] as string;

/** A refusal script, taken again to a file of the run's own, and judged against the record kept in deploy/test/. */
async function retaken(
  context: Context,
  record: Exclude<RecordName, 'egress'>,
): Promise<{ held: boolean; lines: string[]; fresh?: RefusalRecord }> {
  const out = join(context.tmp, `${record}.json`);
  const script = record === 'flag-stages-refusals' ? ['node', [`scripts/${record}.ts`]] : [`scripts/${record}.sh`, []];
  const ran = await context.run(script[0] as string, script[1] as string[], { REFUSALS_OUT: out });
  const kept = JSON.parse(await readFile(join(context.root, 'deploy', 'test', `${record}.json`), 'utf-8'));
  if (ran.status !== 0) {
    return { held: false, lines: [`✗ ${record} exited ${ran.status}:`, ran.stderr.trim(), ran.stdout.trim()] };
  }
  const fresh = JSON.parse(await readFile(out, 'utf-8')) as RefusalRecord;
  const judged = judgeRecord(kept, fresh);
  return { ...judged, fresh };
}

/** egress.sh, taken once for a run, its record shared by the two proofs that read it. */
const egressTaken = new WeakMap<Context, Promise<{ ran: Ran; record?: EgressRecord }>>();
function takeEgress(context: Context) {
  let taken = egressTaken.get(context);
  if (!taken) {
    taken = (async () => {
      const out = join(context.tmp, 'egress.json');
      const ran = await context.run('scripts/egress.sh', [out]);
      const record = await readFile(out, 'utf-8').then(
        (t) => JSON.parse(t) as EgressRecord,
        () => undefined,
      );
      return { ran, ...(record && { record }) };
    })();
    egressTaken.set(context, taken);
  }
  return taken;
}

/** The hash of every object the named records were taken against, each once. */
function hashOf(context: Context, records: RecordName[]): string {
  const manifests = context.rendered();
  const objects = new Map(records.flatMap((r) => named(r, manifests)).map((o) => [nameOf(o), o]));
  return policyHash([...objects.values()]);
}

const fromCi =
  (id: CiProofId): Proof =>
  async (context) => {
    const proof = CI_PROOFS[id];
    let taken: Awaited<ReturnType<typeof readCiProof>>;
    try {
      taken = await readCiProof({
        repo: REPOSITORY,
        proof,
        workflow: await readFile(join(context.root, proof.workflow), 'utf-8'),
        firstParent: await context.firstParent(),
        read: context.gh,
      });
    } catch (error) {
      // No run read, so none to name: not taken, as with no run at all, and the command fails.
      return { notTaken: `CI could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    // A proof read from CI names its run: with none to read there is nothing to record, and the command fails.
    if (!taken.run || !taken.commit) return { notTaken: taken.output };
    return { held: taken.held, output: text(taken.output), commit: taken.commit, run: taken.run };
  };

/** The records the production-writes proof takes again, beside egress.sh's readers of telemetry. */
export const PRODUCTION_WRITES = [
  'rollout-refusals',
  'flags-refusals',
  'flag-stages-refusals',
  'share-key-refusals',
  'route-refusals',
  'mark-refusals',
] as const satisfies RecordName[];

/** Every proof in the catalogue, by its id, and what takes it. */
export const TAKERS = {
  'workflow-refusal': async (context) => {
    const out = join(context.tmp, 'workflow-refusals.json');
    const ran = await context.run('node', ['apps/factory/src/cli.ts', 'github', 'workflow-refusal', '--out', out], {
      GITHUB_APP_CLIENT_ID: APPS.factory.clientId,
      GITHUB_APP_PRIVATE_KEY: await context.appKey(),
      // GitHub itself, for real, whatever the shell says: a dry run or another API proves nothing of the fence.
      GITHUB_DRY_RUN: 'false',
      GITHUB_API_URL: '',
    });
    const refusals = await readFile(out, 'utf-8').then(
      (t) => JSON.parse(t) as Refusal[],
      () => [] as Refusal[],
    );
    const asked = refusals.map((r) => r.repo).sort();
    const everywhere = JSON.stringify(asked) === JSON.stringify([...REPOSITORIES].sort());
    const held = ran.status === 0 && everywhere && refusals.every((r) => r.outcome === 'refused');
    return {
      held,
      output: text(
        ran.stderr,
        ...refusals.map(
          (r) =>
            `${r.outcome}  ${r.repo}: ${r.attempted}, after the control commit ${r.control.commit}: ${r.message ?? ''}`,
        ),
        everywhere
          ? ''
          : `✗ asked in ${asked.join(', ') || 'no repository'}, not in each of ${REPOSITORIES.join(', ')}`,
      ),
    };
  },
  'app-permissions': async (context) => {
    const { installations } = await context.gh<{ installations: Installation[] }>(
      `/orgs/${ORGANISATION}/installations?per_page=100`,
    );
    const { held, lines } = judgeInstallations(installations);
    return { held, output: text(...lines) };
  },
  bypass: async (context) => {
    const ran = await context.run('node', ['scripts/github-settings.ts', '--check', '--see-bypass']);
    const repositories = Object.keys(SETTINGS).join(', ');
    return {
      held: ran.status === 0,
      output: text(`github-settings.ts --check --see-bypass, of ${repositories}:`, ran.stdout, ran.stderr),
    };
  },
  'ci:gates-deterministic': fromCi('ci:gates-deterministic'),
  admission: async (context) => {
    const { held, lines, fresh } = await retaken(context, 'admission-refusals');
    const signature = fresh ? otherIdentityProblems(fresh) : [];
    return {
      held: held && signature.length === 0,
      output: text(...lines, ...signature),
      ...(fresh?.policyHash && { policyHash: fresh.policyHash }),
    };
  },
  'production-writes': async (context) => {
    let held = true;
    const lines: string[] = [];
    for (const record of PRODUCTION_WRITES) {
      const judged = await retaken(context, record);
      held &&= judged.held;
      // A record that held in a line; one that did not, in full.
      lines.push(judged.held ? `✓ ${record}: as deploy/test/ keeps it` : `✗ ${record}:\n${judged.lines.join('\n')}`);
    }
    const { ran, record } = await takeEgress(context);
    const telemetry = record ? judgeEgress(record, 'read-only-telemetry') : undefined;
    held &&= telemetry?.held ?? false;
    lines.push(
      telemetry
        ? `${telemetry.held ? '✓' : '✗'} egress.sh, the readers of telemetry:\n${telemetry.lines.join('\n')}`
        : `✗ egress.sh wrote no record (exit ${ran.status}): ${ran.stderr.trim()}`,
    );
    return { held, output: text(...lines), policyHash: hashOf(context, [...PRODUCTION_WRITES, 'egress']) };
  },
  egress: async (context) => {
    const { ran, record } = await takeEgress(context);
    if (!record) return { held: false, output: text(`✗ egress.sh wrote no record (exit ${ran.status}):`, ran.stderr) };
    const { held, lines } = judgeEgress(record);
    const closing = ran.stdout.trim().split('\n').slice(-4);
    return {
      held: held && ran.status === 0,
      output: text(...lines, ...closing),
      ...(record.policyHash && { policyHash: record.policyHash }),
    };
  },
  'ci:one-gateway': fromCi('ci:one-gateway'),
  'ci:spend-caps': fromCi('ci:spend-caps'),
  'ci:public-hostile': fromCi('ci:public-hostile'),
  'ci:scope-fence': fromCi('ci:scope-fence'),
  'ci:stopped-line': fromCi('ci:stopped-line'),
  'stop-the-line': async (context) => {
    const taken: DrillTaken = await stopTheLine({
      sql: context.sql,
      runnerPods: () => context.runnerPods(),
      ask: (q) => context.ask(q),
      make: async (target, reason) =>
        (
          await context.run('make', [
            '--no-print-directory',
            target,
            `CONTEXT=${context.kubeContext}`,
            `REASON=${reason}`,
          ])
        ).status === 0,
      now: () => context.now(),
      sleep: (ms) => context.sleep(ms),
      say: (line) => context.say(line),
    });
    return 'declined' in taken ? { notTaken: taken.declined } : { held: taken.held, output: text(taken.output) };
  },
  rollback: async (context) => {
    const taken = await rollback(context.sql, context.now());
    return { held: taken.held, output: text(taken.output) };
  },
} as const satisfies Record<ProofId, Proof>;

/** The order the command takes them in: the reads first, the scripts against the cluster next, the drill last. */
export const ORDER: readonly ProofId[] = [
  'ci:gates-deterministic',
  'ci:one-gateway',
  'ci:spend-caps',
  'ci:public-hostile',
  'ci:scope-fence',
  'ci:stopped-line',
  'app-permissions',
  'bypass',
  'workflow-refusal',
  'egress',
  'production-writes',
  'admission',
  'rollback',
  'stop-the-line',
];
