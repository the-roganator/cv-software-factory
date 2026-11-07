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
   * What the endpoints of each namespace named say, read after read (the last again after that), as the script's
   * jsonpath prints them: a line `kind|pod|ready|terminating` each, or `unreachable`. A namespace not named has a ready
   * pod of each of its Rollouts' stable versions.
   */
  endpoints?: Record<string, (string[] | 'unreachable')[]>;
  /** Whether kubectl warns on stderr as it answers, as it does of a version skew. */
  warns?: boolean;
}

/** A ready endpoint of a pod of Rollout `name`'s version `hash`, as Kubernetes names it. */
const podOf = (name: string, hash: string, ready = 'true', terminating = '') =>
  `Pod|${name}-${hash}-x7k2p|${ready}|${terminating}`;

async function stop(cluster: Cluster) {
  const dir = await mkdtemp(join(tmpdir(), 'abort-canaries-'));
  const calls = join(dir, 'calls');
  const kubectl = join(dir, 'kubectl');
  await writeFile(calls, '');
  // Each namespace's answers, one file a read, the last read again after that.
  const rollouts = (cluster.rollouts ?? []).map((r) => r.split('|'));
  const namespaces = new Set([
    ...rollouts.map(([namespace]) => namespace ?? ''),
    ...Object.keys(cluster.endpoints ?? {}),
  ]);
  for (const namespace of namespaces) {
    const answers = cluster.endpoints?.[namespace] ?? [
      rollouts.filter(([ns]) => ns === namespace).map(([, name, stable]) => podOf(name ?? '', stable ?? '')),
    ];
    for (const [i, answer] of answers.entries()) {
      await writeFile(
        join(dir, `ep-${namespace}-${i + 1}`),
        answer === 'unreachable' ? 'UNREACHABLE' : answer.join('\n'),
      );
    }
  }
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
  *"get endpointslices"*)
    ${cluster.warns ? "echo 'Warning: version difference between client and server exceeds the supported skew' >&2" : ''}
    count=${JSON.stringify(dir)}/count-$2
    n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$count"
    answer=${JSON.stringify(dir)}/ep-$2-$n
    [ -f "$answer" ] || answer=$(ls ${JSON.stringify(dir)}/ep-$2-* 2>/dev/null | sort -V | tail -1)
    if [ "$(cat "$answer")" = UNREACHABLE ]; then echo 'The connection to the server 0.0.0.0:6443 was refused' >&2; exit 1; fi
    cat "$answer" ;;
  *wait*) ${cluster.acts === false ? 'exit 1' : 'exit 0'} ;;
  *"get rollout"*) printf '100/0' ;;
esac
`,
  );
  await chmod(kubectl, 0o755);
  const result = await promisify(execFile)(SCRIPT, [], {
    env: { ...process.env, KUBECTL: kubectl, WAIT: '1', STABLE_TRIES: '2' },
  }).then(
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

  it('leaves a canary whose stable version has no pod ready to serve, says so, and gives both commands', async () => {
    const { code, out, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|', 'shop|front|1a2b|3c4d|', 'shop|back|6e7f|9a0b|'],
      endpoints: {
        // The canary's pod alone; the stable version's not ready, or shutting down.
        website: [[podOf('website', '8d9e')]],
        shop: [[podOf('front', '1a2b', 'false'), podOf('back', '6e7f', 'true', 'true'), podOf('front', '3c4d')]],
      },
      warns: true,
    });
    expect(code).toBe(0);
    expect(calls.filter((c) => c.startsWith('-n website get endpointslices'))).toHaveLength(2);
    expect(patches(calls)).toEqual([]);
    for (const rollout of ['website/website', 'shop/front', 'shop/back']) {
      expect(out).toContain(
        `Didn't abort the release of ${rollout}: its stable version has no pod ready to serve, so aborting it`,
      );
    }
    expect(out).toContain('Whether it goes out is yours. To promote it fully:');
    expect(out).toContain(
      `-n website patch rollout website --subresource=status --type=merge -p '{"status":{"promoteFull":true}}'`,
    );
    expect(out).toContain('Or to abort it all the same:');
    expect(out).toContain(
      `-n website patch rollout website --subresource=status --type=merge -p '{"status":{"abort":true}}'`,
    );
    expect(out).not.toContain('No release is in flight');
  });

  it('aborts a canary whose stable pod is ready again at the next look, and reads a ready it is not told as ready', async () => {
    const { code, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|', 'shop|front|1a2b|3c4d|'],
      endpoints: { website: [[], [podOf('website', '5f7c')]], shop: [[podOf('front', '1a2b', '')]] },
      warns: true,
    });
    expect(code).toBe(0);
    // The one ready at the first look is aborted first: the second look holds up no other release.
    expect(patches(calls)).toEqual([
      '-n shop patch rollout front --subresource=status --type=merge -p {"status":{"abort":true}}',
      '-n website patch rollout website --subresource=status --type=merge -p {"status":{"abort":true}}',
    ]);
  });

  it('aborts as before a Rollout whose name is too long for its pods’ names to say their version', async () => {
    // Kubernetes cuts what comes before a pod's random suffix to 58 characters, which here takes the hash.
    const name = 'a-rollout-whose-name-is-long-enough-to-lose-its-hash';
    const { calls } = await stop({
      crd: 'installed',
      rollouts: [`website|${name}|5f7c8d9e6b|1a2b3c4d5e|`],
      endpoints: { website: [[`Pod|${`${name}-1a2b3c4d5e-`.slice(0, 58)}x7k2p|true|`]] },
    });
    expect(patches(calls)).toHaveLength(1);
    expect(calls.some((c) => c.includes('endpointslices'))).toBe(false);
  });

  it('refuses a number of looks that is not one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'abort-canaries-'));
    const result = await promisify(execFile)(SCRIPT, [], {
      env: { ...process.env, KUBECTL: join(dir, 'none'), STABLE_TRIES: '0' },
    }).then(
      () => ({ code: 0, out: '' }),
      (e: { code: number; stderr: string }) => ({ code: e.code, out: e.stderr }),
    );
    expect(result).toEqual({ code: 1, out: "STABLE_TRIES must be a whole number of looks, 1 or more, not '0'.\n" });
  });

  it('aborts no canary whose stable version it cannot read, and fails, still aborting the rest', async () => {
    const { code, out, calls } = await stop({
      crd: 'installed',
      rollouts: ['website|website|5f7c|8d9e|', 'shop|front|1a2b|3c4d|'],
      endpoints: { website: ['unreachable'] },
    });
    expect(code).toBe(1);
    expect(out).toContain("Couldn't read the endpoints of website, so the release of website/website wasn't aborted");
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
