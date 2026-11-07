import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * `make stop-the-line`'s second half, against a kubectl that answers as the cluster would and writes down what it was
 * asked. The real thing was tried on the local cluster mid-canary (the pull request says how).
 */
const SCRIPT = fileURLToPath(new URL('./abort-canaries.sh', import.meta.url));

interface Cluster {
  /** What `get crd rollouts.argoproj.io` says: installed, not installed, or no answer. */
  crd: 'installed' | 'missing' | 'unreachable';
  /** The Rollouts, as the script's jsonpath prints them: namespace|name|stable|current|abort. */
  rollouts?: string[];
  /** Whether the controller acts on an abort (the Rollout turns Degraded) before the wait ends. */
  acts?: boolean;
  /**
   * What each stable ReplicaSet (`<rollout>-<stable hash>`) says of its available pods, by name: a count (`''` for
   * none, as Kubernetes leaves out a zero), `missing`, or `unreachable`. One not named has one available.
   */
  stable?: Record<string, string>;
}

/** The fake kubectl's answers for the stable ReplicaSets named, as `case` arms matched on its arguments. */
function replicaSets(stable: Record<string, string>): string {
  const said = (rs: string, what: string) =>
    what === 'missing'
      ? `echo 'Error from server (NotFound): replicasets.apps "${rs}" not found' >&2; exit 1`
      : what === 'unreachable'
        ? "echo 'The connection to the server 0.0.0.0:6443 was refused' >&2; exit 1"
        : `printf '%s' '${what}'`;
  return Object.entries(stable)
    .map(([rs, what]) => `      *"get replicaset ${rs} "*) ${said(rs, what)} ;;`)
    .join('\n');
}

async function stop(cluster: Cluster) {
  const dir = await mkdtemp(join(tmpdir(), 'abort-canaries-'));
  const calls = join(dir, 'calls');
  const kubectl = join(dir, 'kubectl');
  await writeFile(calls, '');
  await writeFile(
    kubectl,
    `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *"get crd"*)
    case ${JSON.stringify(cluster.crd)} in
      installed) echo customresourcedefinition.apiextensions.k8s.io/rollouts.argoproj.io ;;
      missing) echo 'Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "rollouts.argoproj.io" not found' >&2; exit 1 ;;
      *) echo 'The connection to the server 0.0.0.0:6443 was refused' >&2; exit 1 ;;
    esac ;;
  *"get rollouts --all-namespaces"*) printf '%b' ${JSON.stringify((cluster.rollouts ?? []).map((r) => `${r}\n`).join(''))} ;;
  *patch*) echo patched ;;
  *"get replicaset"*)
    case "$*" in
${replicaSets(cluster.stable ?? {})}
      *) printf 1 ;;
    esac ;;
  *wait*) ${cluster.acts === false ? 'exit 1' : 'exit 0'} ;;
  *"get rollout"*) printf '100/0' ;;
esac
`,
  );
  await chmod(kubectl, 0o755);
  const result = await promisify(execFile)(SCRIPT, [], { env: { ...process.env, KUBECTL: kubectl, WAIT: '1' } }).then(
    ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );
  return { ...result, calls: (await readFile(calls, 'utf-8')).trim().split('\n') };
}

const patches = (calls: string[]) => calls.filter((c) => c.includes('patch'));

describe('aborting a canary in flight (make stop-the-line)', () => {
  it('aborts a Rollout mid-canary through its status, as Argo Rollouts’ own abort does, and says where traffic went', async () => {
    const { code, out, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|', 'website|quiet|1a2b|1a2b|'],
    });
    expect(code).toBe(0);
    expect(patches(calls)).toEqual([
      '-n website patch rollout website --subresource=status --type=merge -p {"status":{"abort":true}}',
    ]);
    expect(out).toContain(
      'Aborted the release of website/website: the stable version takes all traffic (stable/canary 100/0).',
    );
    expect(out).toContain('{"status":{"abort":false}}');
    expect(out).not.toContain('quiet');
  });

  it('leaves a canary whose stable version has no pod available, says so, and gives the abort to make by hand', async () => {
    const { code, out, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|', 'shop|front|1a2b|3c4d|', 'shop|back|6e7f|9a0b|'],
      stable: { 'website-5f7c': '', 'front-1a2b': 'missing', 'back-6e7f': '0' },
    });
    expect(code).toBe(0);
    expect(calls).toContain('-n website get replicaset website-5f7c -o jsonpath={.status.availableReplicas}');
    expect(patches(calls)).toEqual([]);
    for (const rollout of ['website/website', 'shop/front', 'shop/back']) {
      expect(out).toContain(
        `Didn't abort the release of ${rollout}: its stable version has no pod ready to serve, so aborting it`,
      );
    }
    expect(out).toContain('It stays at its first step until promoted fully, which is yours:');
    expect(out).toContain(
      `-n website patch rollout website --subresource=status --type=merge -p '{"status":{"promoteFull":true}}'`,
    );
    expect(out).toContain('Or to abort it all the same:');
    expect(out).toContain(
      `-n website patch rollout website --subresource=status --type=merge -p '{"status":{"abort":true}}'`,
    );
    expect(out).not.toContain('No release is in flight');
  });

  it('aborts no canary whose stable version it cannot read, and fails, still aborting the rest', async () => {
    const { code, out, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|', 'shop|front|1a2b|3c4d|'],
      stable: { 'website-5f7c': 'unreachable' },
    });
    expect(code).toBe(1);
    expect(out).toContain("Couldn't read the stable version of website/website, so its release wasn't aborted");
    expect(patches(calls)).toEqual([
      '-n shop patch rollout front --subresource=status --type=merge -p {"status":{"abort":true}}',
    ]);
  });

  it('sends every abort before it waits for any, so a slow controller holds up no other release', async () => {
    const { code, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|', 'shop|front|1a2b|3c4d|'],
    });
    expect(code).toBe(0);
    const steps = calls.filter((c) => c.includes('patch') || c.includes('wait')).map((c) => c.split(' ')[2]);
    expect(steps).toEqual(['patch', 'patch', 'wait', 'wait']);
  });

  it('does nothing, and says so, when no release is in flight', async () => {
    const { code, out, calls } = await stop({ crd: 'installed', rollouts: ['website|website|5f7c|5f7c|'] });
    expect(code).toBe(0);
    expect(patches(calls)).toEqual([]);
    expect(out.trim()).toBe('No release is in flight, so there is no canary to abort.');
  });

  it('leaves a release that was aborted already, and a Rollout on its first version', async () => {
    const { code, out, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|true', 'website|new|||'],
    });
    expect(code).toBe(0);
    expect(patches(calls)).toEqual([]);
    expect(out.trim()).toBe('The release of website/website was aborted already.');
  });

  it('says so when Argo Rollouts is not installed, and succeeds', async () => {
    const { code, out } = await stop({ crd: 'missing' });
    expect(code).toBe(0);
    expect(out.trim()).toBe("Argo Rollouts isn't installed, so no release is in flight.");
  });

  it('fails when the cluster cannot be asked, rather than saying nothing is in flight', async () => {
    const { code, out } = await stop({ crd: 'unreachable' });
    expect(code).toBe(1);
    expect(out).toContain("Couldn't ask the cluster about releases");
  });

  it('fails when Argo Rollouts does not act on the abort in time', async () => {
    const { code, out } = await stop({ crd: 'installed', rollouts: ['website|website|5f7c|8d9e|'], acts: false });
    expect(code).toBe(1);
    expect(out).toContain("hasn't acted on it within 1s");
  });
});
