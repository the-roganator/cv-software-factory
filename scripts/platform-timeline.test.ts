import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * Where the platform check's time goes (scripts/platform-timeline.sh): a cluster's kube-system namespace, Applications,
 * pods and events as `kubectl get -o json` gives them, made into tables of times after k3s started.
 */

const SCRIPT = resolve('scripts/platform-timeline.sh');
const START = Date.parse('2026-11-15T19:33:00Z');
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const application = (name: string, made: number, synced: number | undefined, healthy: number, health = 'Healthy') => ({
  metadata: { name, creationTimestamp: at(made) },
  status: {
    health: { status: health, lastTransitionTime: at(healthy) },
    ...(synced === undefined ? {} : { history: [{ deployStartedAt: at(synced - 1), deployedAt: at(synced) }] }),
  },
});
const pod = (namespace: string, name: string, made: number, scheduled: number, ready?: number) => ({
  metadata: { namespace, name, creationTimestamp: at(made) },
  status: {
    conditions: [
      { type: 'PodScheduled', status: 'True', lastTransitionTime: at(scheduled) },
      ...(ready === undefined
        ? [{ type: 'Ready', status: 'False', lastTransitionTime: at(scheduled) }]
        : [{ type: 'Ready', status: 'True', lastTransitionTime: at(ready) }]),
    ],
  },
});
const event = (reason: string, namespace: string, name: string, seconds: number, message: string) => ({
  reason,
  involvedObject: { namespace, name },
  firstTimestamp: at(seconds),
  message,
});
const pulled = (namespace: string, name: string, seconds: number, image: string, pull: string, total: string) =>
  event(
    'Pulled',
    namespace,
    name,
    seconds,
    `Successfully pulled image "${image}" in ${pull}s (${total}s including waiting). Image size: 39123456 bytes.`,
  );

function tables(applications: object[], pods: object[], events: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-timeline-'));
  dirs.push(dir);
  const files = {
    'ns.json': { metadata: { name: 'kube-system', creationTimestamp: at(0) } },
    'apps.json': { items: applications },
    'pods.json': { items: pods },
    'events.json': { items: events },
  };
  for (const [file, value] of Object.entries(files)) writeFileSync(join(dir, file), JSON.stringify(value));
  const run = spawnSync(
    SCRIPT,
    Object.keys(files).map((file) => join(dir, file)),
    { encoding: 'utf-8' },
  );
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return run.stdout.split('\n');
}

describe('platform-timeline.sh', () => {
  const lines = tables(
    [
      application('grafana', 210, 330, 395),
      application('kyverno', 54, 57, 120),
      application('website', 300, undefined, 300, 'Progressing'),
    ],
    [
      pod('argocd', 'argocd-redis-1', 20, 21, 33),
      pod('telemetry', 'grafana-1', 330, 331, 395),
      pod('factory', 'migrate-abc', 400, 401),
    ],
    [
      pulled('argocd', 'argocd-redis-1', 30, 'ecr-public.aws.com/docker/library/redis:8.6.4-alpine', '2.5', '2.5'),
      pulled('telemetry', 'grafana-1', 350, 'docker.io/grafana/grafana:13.2.3', '8.25', '14.75'),
      pulled('telemetry', 'grafana-1', 360, 'quay.io/kiwigrid/k8s-sidecar:2.14.3', '1.5', '20.0'),
      event('Pulled', 'factory', 'migrate-abc', 402, 'Container image "postgres:18" already present on machine'),
      event('Created', 'telemetry', 'grafana-1', 361, 'Created container grafana'),
    ],
  );

  it('gives each Application in the order it first synced, as minutes and seconds after k3s started', () => {
    const apps = lines.slice(lines.indexOf('### Applications'), lines.indexOf('### Pods'));
    expect(apps).toContain('| Application | Made | First synced | Last turned Healthy | Health |');
    expect(apps.filter((line) => /^\| [a-z]/.test(line))).toEqual([
      '| kyverno | +0:54 | +0:57 | +2:00 | Healthy |',
      '| grafana | +3:30 | +5:30 | +6:35 | Healthy |',
      // Never synced: last, with no time.
      '| website | +5:00 | - | +5:00 | Progressing |',
    ]);
  });

  it('gives each pod in the order it turned ready, with the seconds its own images took to pull', () => {
    const pods = lines.slice(lines.indexOf('### Pods'), lines.indexOf('### Pulls'));
    expect(pods.filter((line) => /^\| [a-z]+\//.test(line))).toEqual([
      '| argocd/argocd-redis-1 | +0:20 | +0:21 | +0:33 | 2.5s |',
      '| telemetry/grafana-1 | +5:30 | +5:31 | +6:35 | 9.8s |',
      // Not ready: last, and no pull of its own, the image being on the node already.
      '| factory/migrate-abc | +6:40 | +6:41 | - | 0s |',
    ]);
  });

  it('gives each image pulled, in the order it was, with the wait for the pulls before it, and the totals', () => {
    const pulls = lines.slice(lines.indexOf('### Pulls'));
    expect(pulls).toContain('3 images, 12s of pulling, 117 MB.');
    expect(pulls.filter((line) => line.endsWith(' MB |'))).toEqual([
      '| ecr-public.aws.com/docker/library/redis:8.6.4-alpine | +0:30 | 2.5s | 2.5s | 39.1 MB |',
      '| docker.io/grafana/grafana:13.2.3 | +5:50 | 8.25s | 14.75s | 39.1 MB |',
      '| quay.io/kiwigrid/k8s-sidecar:2.14.3 | +6:00 | 1.5s | 20s | 39.1 MB |',
    ]);
  });

  it('says so when it cannot read the cluster, and never fails the check', () => {
    const run = spawnSync(SCRIPT, [], { encoding: 'utf-8', env: { ...process.env, KUBECTL: 'false' } });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('The cluster could not be read: no timeline.\n');
  });
});
