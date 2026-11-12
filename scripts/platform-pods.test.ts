import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The platform check's end (scripts/platform-pods.sh): every pod of the cluster running and ready, none restarting.
 * Each case is a cluster's pods and Jobs as `kubectl get -o json` gives them, in the shapes a healthy end, a crash
 * loop, a pod that never becomes ready and a completed Job leave, judged as of a moment.
 */

const SCRIPT = resolve('scripts/platform-pods.sh');
const NOW = Date.parse('2026-11-12T01:04:06Z') / 1000;
const ago = (seconds: number) => new Date((NOW - seconds) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Container = Record<string, unknown> & { name: string };
function pod(namespace: string, name: string, phase: string, containers: Container[], extra: object = {}) {
  return { metadata: { namespace, name }, status: { phase, containerStatuses: containers }, ...extra };
}
const running = (name: string, restarts = 0, lastEnded?: number): Container => ({
  name,
  ready: true,
  restartCount: restarts,
  state: { running: { startedAt: ago(600) } },
  ...(lastEnded === undefined
    ? {}
    : { lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: ago(lastEnded) } } }),
});
const ownedBy = (job: string) => ({ ownerReferences: [{ kind: 'Job', name: job }] });
const job = (namespace: string, name: string, complete: boolean) => ({
  metadata: { namespace, name },
  status: complete ? { conditions: [{ type: 'Complete', status: 'True' }] } : { active: 1 },
});

/** A healthy end, as the check's green runs leave it: the migrations' failed attempts beside the one that ran. */
const healthy = {
  pods: [
    pod('factory', 'line-5d988558bb-swlnd', 'Running', [running('line')]),
    pod('telemetry', 'query-6bd47d9ddc-5nsll', 'Running', [running('query', 2, 233)]),
    pod('factory', 'migrate-5bt72', 'Succeeded', [], {
      metadata: { namespace: 'factory', name: 'migrate-5bt72', ...ownedBy('migrate') },
    }),
    pod('factory', 'migrate-n9fnz', 'Failed', [], {
      metadata: { namespace: 'factory', name: 'migrate-n9fnz', ...ownedBy('migrate') },
    }),
    pod('kube-system', 'helm-install-traefik-jjt2s', 'Succeeded', []),
  ],
  jobs: [job('factory', 'migrate', true)],
};

function judge(pods: object[], jobs: object[] = [], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-pods-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'pods.json'), JSON.stringify({ items: pods }));
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ items: jobs }));
  const result = spawnSync(SCRIPT, [join(dir, 'pods.json'), join(dir, 'jobs.json')], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, NOW: String(NOW), ...env },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe('the platform check’s end', () => {
  it('passes a healthy end: restarts long settled, and a completed Job’s failed attempts', () => {
    expect(judge(healthy.pods, healthy.jobs)).toEqual({ status: 0, out: '', err: '' });
  });

  it('fails a crash loop, by name, with its reason', () => {
    const crashing = pod('factory', 'patching-6f8c8cc59f-ftlsd', 'Running', [
      {
        name: 'patching',
        ready: false,
        restartCount: 4,
        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 1m20s restarting failed container' } },
        lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: ago(33) } },
      },
    ]);
    const { status, out } = judge([...healthy.pods, crashing], healthy.jobs);
    expect(status).toBe(1);
    expect(out).toBe(
      'factory/patching-6f8c8cc59f-ftlsd: container patching waiting: CrashLoopBackOff: back-off 1m20s restarting ' +
        'failed container; container patching restarted 33s ago (4 restarts; last exit 1, Error)\n',
    );
  });

  it('fails a pod that runs and never becomes ready', () => {
    const unready = pod('factory', 'unready-7d9f', 'Running', [{ ...running('unready'), ready: false }]);
    expect(judge([unready]).out).toBe('factory/unready-7d9f: container unready running, not ready\n');
  });

  it('fails a pod that cannot start: an image it cannot pull, or one never scheduled', () => {
    const pulling = pod('factory', 'pull-1', 'Pending', [
      { name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } },
    ]);
    const unscheduled = {
      metadata: { namespace: 'factory', name: 'pending-2' },
      status: {
        phase: 'Pending',
        conditions: [
          { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/1 nodes are available' },
        ],
      },
    };
    expect(judge([pulling, unscheduled]).out).toBe(
      'factory/pull-1: container app waiting: ImagePullBackOff\n' +
        'factory/pending-2: Pending: PodScheduled Unschedulable 0/1 nodes are available\n',
    );
  });

  it('fails a container that restarted within the last two minutes, and passes one that settled before', () => {
    expect(judge([pod('factory', 'gateway-1', 'Running', [running('gateway', 1, 90)])]).out).toMatch(
      /^factory\/gateway-1: container gateway restarted 90s ago \(1 restarts; last exit 1, Error\)\n$/,
    );
    expect(judge([pod('factory', 'gateway-1', 'Running', [running('gateway', 1, 130)])]).status).toBe(0);
    expect(
      judge([pod('factory', 'gateway-1', 'Running', [running('gateway', 1, 130)])], [], { RECENT: '180' }).status,
    ).toBe(1);
  });

  it('judges the pods of a Job not yet complete as any other', () => {
    const attempt = {
      metadata: { namespace: 'factory', name: 'migrate-x', ...ownedBy('migrate') },
      status: { phase: 'Failed', reason: 'Error' },
    };
    expect(judge([attempt], [job('factory', 'migrate', false)]).out).toBe('factory/migrate-x: Failed: Error\n');
    expect(judge([attempt], [job('factory', 'migrate', true)]).status).toBe(0);
    // A Job of the same name in another namespace is another Job.
    expect(judge([attempt], [job('website', 'migrate', true)]).status).toBe(1);
  });
});
