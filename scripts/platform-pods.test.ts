import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(judge(healthy.pods, healthy.jobs)).toEqual({
      status: 0,
      out: '',
      err: 'retry: factory/migrate-n9fnz: a failed attempt of Job factory/migrate, which completed\n',
    });
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

  it('names a completed Job’s errored attempt as a retry, and fails one whose Job never completed', () => {
    // As run 43176216471 ended (#1016, green): one migrate attempt errored beside the retry that completed.
    const errored = {
      metadata: { namespace: 'factory', name: 'migrate-4kq2x', ...ownedBy('migrate') },
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'migrate',
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 1, reason: 'Error', finishedAt: ago(700) } },
          },
        ],
      },
    };
    const retry = {
      metadata: { namespace: 'factory', name: 'migrate-7tzm9', ...ownedBy('migrate') },
      status: { phase: 'Succeeded' },
    };
    expect(judge([errored, retry], [job('factory', 'migrate', true)])).toEqual({
      status: 0,
      out: '',
      err: 'retry: factory/migrate-4kq2x: a failed attempt of Job factory/migrate, which completed\n',
    });
    expect(judge([errored], [job('factory', 'migrate', false)]).out).toBe('factory/migrate-4kq2x: Failed\n');
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

  it('reads a time with fractions of a second, and names each faulty container of a pod', () => {
    const two = pod('factory', 'two-1', 'Running', [
      running('a'),
      {
        ...running('b', 3),
        lastState: { terminated: { exitCode: 2, reason: 'Error', finishedAt: `${ago(40)}`.replace('Z', '.123Z') } },
      },
      { ...running('c'), ready: false },
    ]);
    expect(judge([two]).out).toBe(
      'factory/two-1: container c running, not ready; container b restarted 40s ago (3 restarts; last exit 2, Error)\n',
    );
  });

  it('fails a pod in phase Unknown, and the pods of a Job that is gone', () => {
    const lost = {
      metadata: { namespace: 'factory', name: 'lost-1' },
      status: { phase: 'Unknown', reason: 'NodeLost' },
    };
    const orphan = {
      metadata: { namespace: 'factory', name: 'old-1', ...ownedBy('gone') },
      status: { phase: 'Failed' },
    };
    expect(judge([lost, orphan]).out).toBe('factory/lost-1: Unknown: NodeLost\nfactory/old-1: Failed\n');
  });

  it('leaves the website’s Jobs to its release: a canary analysis that failed is not the cluster’s fault', () => {
    const journeys = {
      metadata: { namespace: 'website', name: 'journeys-1', ...ownedBy('journeys') },
      status: { phase: 'Failed' },
    };
    const website = pod('website', 'website-1', 'Running', [{ ...running('website'), ready: false }]);
    expect(judge([journeys, website], [job('website', 'journeys', false)]).out).toBe(
      'website/website-1: container website running, not ready\n',
    );
  });
});

/*
 * On the cluster it looks again and again, through a kubectl that answers each look with the next of a list of pods
 * (the last from then on), and Jobs that are none.
 */
describe('the platform check’s end, on the cluster', () => {
  function cluster(looks: object[][], env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'platform-pods-cluster-'));
    dirs.push(dir);
    looks.forEach((pods, i) => {
      writeFileSync(join(dir, `look-${i}.json`), JSON.stringify({ items: pods }));
    });
    const last = looks.length - 1;
    writeFileSync(
      join(dir, 'kubectl'),
      `#!/usr/bin/env bash
case " $* " in
  *" get pods "*) n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/n"
    cat "${dir}/look-$(( n < ${last} ? n : ${last} )).json" ;;
  *" get jobs "*) echo '{"items":[]}' ;;
  *" describe "*) echo "described $*" ;;
  *" logs "*) echo "logged $*" ;;
esac
`,
    );
    chmodSync(join(dir, 'kubectl'), 0o755);
    const summary = join(dir, 'summary.md');
    const result = spawnSync(SCRIPT, [], {
      encoding: 'utf-8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        KUBECTL: join(dir, 'kubectl'),
        INTERVAL: '1',
        STEADY: '1',
        SETTLE: '4',
        OUT: join(dir, 'out'),
        GITHUB_STEP_SUMMARY: summary,
        ...env,
      },
    });
    const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf-8') : '');
    return { status: result.status, out: result.stdout, summary: read(summary), out_dir: join(dir, 'out'), read };
  }
  // Settled long before any look: what each look sees of a healthy cluster.
  const settled = (restarts: number) => [
    pod('factory', 'line-1', 'Running', [{ ...running('line'), restartCount: restarts }]),
  ];

  it('passes on two clean looks between which nothing restarted', () => {
    const { status, out } = cluster([settled(0)]);
    expect(status).toBe(0);
    expect(out).toMatch(/^Every pod is running and ready/);
  });

  it('fails clean looks between which a container restarted, as a slow crash loop’s may be', () => {
    const { status, out } = cluster([settled(1), settled(2), settled(3), settled(4), settled(5), settled(6)]);
    expect(status).toBe(1);
    expect(out).toMatch(/no two looks 1 seconds apart found every pod running, ready and not restarting/);
  }, 15_000);

  it('names a crash loop in the log and the summary, and keeps its logs and description', () => {
    const crashing = pod('factory', 'broken-1', 'Running', [
      {
        name: 'broken',
        ready: false,
        restartCount: 3,
        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off `x`' } },
      },
    ]);
    const { status, out, summary, out_dir, read } = cluster([[crashing]]);
    expect(status).toBe(1);
    expect(out).toContain('  factory/broken-1: container broken waiting: CrashLoopBackOff: back-off `x`');
    expect(summary).toBe(
      '### Pods not running and ready\n\n- `factory/broken-1: container broken waiting: CrashLoopBackOff: back-off x`\n',
    );
    expect(read(join(out_dir, 'factory_broken-1.describe.txt'))).toMatch(/describe pod broken-1/);
    expect(read(join(out_dir, 'factory_broken-1.previous.log'))).toMatch(/logs broken-1 --all-containers --previous/);
  }, 15_000);
});
