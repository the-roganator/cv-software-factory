/**
 * `factory guardrails`, as `commands/guardrails.ts` describes it: run on the Mac alone, with the whole checkout, so the
 * factory's image holds none of it.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs, promisify } from 'node:util';
import { type NewEvent, VERSIONS } from '@software-factory/events';
import { connect, DiskArtifacts, EventWriter } from '@software-factory/store';
import { guardrailsProvedBy, PROOFS, type ProofId } from '../../../../policy/guardrails.ts';
import { type Resource, render } from '../../../../scripts/policy-hash.ts';
import { type Context, ORDER, type Ran, TAKERS, type Taken, text } from './proofs.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const exec = promisify(execFile);

/** Why this checkout may not record a proof, or nothing when it may: `origin/main`'s head, and clean. */
export async function notMain(root = ROOT): Promise<string | undefined> {
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trimEnd();
  await git('fetch', '--quiet', 'origin', 'main');
  return notAt(await git('rev-parse', 'origin/main'), root, "origin/main's head");
}

/**
 * Why this checkout is not the commit given, clean, or nothing when it is. Checked before each append: main may move on
 * meanwhile, as a deploy's pin merges, and the proofs taken are still of the commit the run began at.
 */
export async function notAt(
  commit: string,
  root = ROOT,
  what = 'the commit the run began at',
): Promise<string | undefined> {
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trimEnd();
  const head = await git('rev-parse', 'HEAD');
  if (head !== commit) return `HEAD is ${head}, not ${what} ${commit}: check out main, and pull`;
  const status = await git('status', '--porcelain', '--untracked-files=all');
  if (status) return `the tree is not clean:\n${status}`;
  // A file marked so that git status no longer looks at it (skip-worktree, assume-unchanged) could hide a change.
  const hidden = (await git('ls-files', '-v'))
    .split('\n')
    .filter((line) => /^(S|[a-z]) /.test(line))
    .map((line) => line.slice(2));
  if (hidden.length) return `git status does not look at ${hidden.join(', ')} (skip-worktree or assume-unchanged)`;
  return undefined;
}

/** The proof as an event, from this commit. */
export function proved(proof: ProofId, taken: Taken, commit: string, now = new Date()): NewEvent {
  const guardrails = guardrailsProvedBy(proof);
  const which = guardrails.length === 1 ? `Guardrail ${guardrails[0]}` : `Guardrails ${guardrails.join(', ')}`;
  return {
    id: randomUUID(),
    ts: now.toISOString(),
    work_item: null,
    type: 'guardrail.proved',
    version: VERSIONS['guardrail.proved'],
    actor: 'martin',
    summary: `${which}: ${proof} ${taken.held ? 'held' : 'did not hold'}`,
    payload: {
      guardrails,
      proof,
      mechanism: PROOFS[proof].mechanism,
      held: taken.held,
      output: taken.output,
      commit: taken.commit ?? commit,
      ...(taken.policyHash && { policyHash: taken.policyHash }),
      ...(taken.run && { run: taken.run }),
    },
    artifacts: [],
  } as NewEvent;
}

/** This process's environment but the proofs' credentials for the store, which nothing it runs needs. */
const withoutTheStore = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PG') && name !== 'DATABASE_URL'));

/** Runs a command in the checkout, its output shown on stderr as it comes, and kept. */
function shown(command: string, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...withoutTheStore(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
      process.stderr.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) => resolve({ status: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { only: { type: 'string', multiple: true }, 'no-record': { type: 'boolean', default: false } },
  });
  const unknown = (values.only ?? []).filter((p) => !(p in PROOFS));
  if (unknown.length) {
    console.error(`No such proof: ${unknown.join(', ')}. The proofs: ${ORDER.join(', ')}`);
    return 2;
  }
  const proofs = ORDER.filter((p) => !values.only || values.only.includes(p));
  const recording = !values['no-record'];
  if (recording) {
    const why = await notMain();
    if (why) {
      console.error(`make guardrails records proofs from a clean checkout of main alone, and ${why}`);
      return 2;
    }
  }
  const commit = (await exec('git', ['-C', ROOT, 'rev-parse', 'HEAD'])).stdout.trim();
  const context_ = (process.env.KUBE_CONTEXT ?? 'k3d-software-factory').trim();
  const sql = connect(process.env.DATABASE_URL);
  const writer = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });
  const tmp = await mkdtemp(join(tmpdir(), 'guardrails-'));
  let manifests: Resource[] | undefined;
  const context: Context = {
    root: ROOT,
    tmp,
    run: shown,
    gh: async <T>(path: string) =>
      JSON.parse(
        (await exec('gh', ['api', '-H', 'X-GitHub-Api-Version: 2022-11-28', path], { maxBuffer: 64 << 20 })).stdout,
      ) as T,
    firstParent: async () =>
      (await exec('git', ['-C', ROOT, 'rev-list', '--first-parent', '-n', '300', 'HEAD'])).stdout.trim().split('\n'),
    appKey: async () => {
      const { stdout } = await exec('security', ['find-generic-password', '-s', 'factory-github-app-key', '-w']);
      return Buffer.from(stdout.trim(), 'base64').toString('utf-8');
    },
    rendered: () => {
      manifests ??= render();
      return manifests;
    },
    sql,
    kubeContext: context_,
    runnerPods: async () => {
      const { stdout } = await exec('kubectl', ['--context', context_, '-n', 'runners', 'get', 'pods', '-o', 'json']);
      const { items } = JSON.parse(stdout) as {
        items: { metadata: { name: string; labels?: Record<string, string> } }[];
      };
      return items.map(({ metadata }) => ({
        name: metadata.name,
        ...(metadata.labels?.['factory.mrogan.dev/runner'] && { part: metadata.labels['factory.mrogan.dev/runner'] }),
      }));
    },
    ask: async (question) => {
      if (!process.stdin.isTTY) {
        console.error(`${question} No one is at a terminal to answer, so no.`);
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    say: (line) => console.error(line),
  };

  const results: { proof: ProofId; held?: boolean; notTaken?: string }[] = [];
  try {
    for (const proof of proofs) {
      console.error(`\n── ${proof}: ${PROOFS[proof].for}`);
      let taken: Awaited<ReturnType<(typeof TAKERS)[ProofId]>>;
      try {
        taken = await TAKERS[proof](context);
      } catch (error) {
        // A proof that could not be taken did not hold: it is never read as held.
        taken = {
          held: false,
          output: text(`It could not be taken: ${error instanceof Error ? error.message : String(error)}`),
        };
      }
      if ('notTaken' in taken) {
        console.error(`${proof}: not taken, and not recorded. ${taken.notTaken}`);
        results.push({ proof, notTaken: taken.notTaken });
        continue;
      }
      console.error(`${proof}: ${taken.held ? 'held' : 'DID NOT HOLD'}\n${taken.output}`);
      if (recording) {
        const why = await notAt(commit);
        if (why) {
          console.error(`The checkout changed while the proofs ran, so nothing more is recorded: ${why}`);
          return 2;
        }
        await writer.append(proved(proof, taken, commit));
      }
      results.push({ proof, held: taken.held });
    }
  } finally {
    await sql.end();
    await rm(tmp, { recursive: true, force: true });
  }

  console.error(`\n${recording ? 'Recorded' : 'Taken, and not recorded'}, from ${commit}:`);
  for (const r of results) {
    console.error(`  ${r.notTaken ? 'not taken ' : r.held ? 'held      ' : 'NOT HELD  '}${r.proof}`);
  }
  const failed = results.filter((r) => !r.held);
  if (failed.length) console.error(`Did not hold, or not taken: ${failed.map((r) => r.proof).join(', ')}`);
  return failed.length ? 1 : 0;
}
