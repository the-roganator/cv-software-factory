import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * platform.yml's watch of `make up` (scripts/platform-watch.sh): it stops the wait at the ceiling, or sooner on what
 * waiting will not mend, and never on what a cluster coming up goes through. Each case gives it Argo CD's Applications
 * look by look, through a kubectl that answers from a list.
 */

const SCRIPT = resolve('scripts/platform-watch.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type App = { name: string; health: string; error?: string; compared?: string };
const application = ({ name, health, error, compared = 'then' }: App) => ({
  metadata: { name },
  status: {
    health: { status: health },
    sync: { status: 'Synced' },
    reconciledAt: compared,
    resources:
      health === 'Healthy'
        ? []
        : [
            {
              kind: 'StatefulSet',
              namespace: 'telemetry',
              name: name,
              status: 'Synced',
              health: { status: health, message: 'Waiting for 1 pods to be ready...' },
            },
          ],
    conditions: error ? [{ type: 'ComparisonError', message: error }] : [{ type: 'SyncError', message: 'not this' }],
  },
});

/** What the cluster holds beside the Applications: root's own, the Jobs, the pods, and each pod's log. */
interface Cluster {
  root?: unknown;
  jobs?: unknown[];
  pods?: unknown[];
  logs?: Record<string, string>;
}

/**
 * A kubectl that answers each look with the next list of Applications, and the last one from then on, and the rest
 * from `cluster`: nothing it does not hold.
 */
function kubectl(looks: App[][], cluster: Cluster = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-watch-'));
  dirs.push(dir);
  looks.forEach((apps, i) => {
    writeFileSync(join(dir, `look-${i}.json`), JSON.stringify({ items: apps.map(application) }));
  });
  if (cluster.root) writeFileSync(join(dir, 'root.json'), JSON.stringify(cluster.root));
  if (cluster.jobs) writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ items: cluster.jobs }));
  if (cluster.pods) writeFileSync(join(dir, 'pods.json'), JSON.stringify({ items: cluster.pods }));
  for (const [pod, log] of Object.entries(cluster.logs ?? {})) writeFileSync(join(dir, `${pod}.log`), log);
  const last = looks.length - 1;
  writeFileSync(
    join(dir, 'kubectl'),
    `#!/usr/bin/env bash
n=$(cat "${dir}/n" 2>/dev/null || echo 0)
look="${dir}/look-$(( n < ${last} ? n : ${last} )).json"
# An API that does not answer: a read given a request timeout ends when it runs out, and one with none hangs.
if [ -n "$HANG" ]; then case " $* " in *" --request-timeout="*) sleep "$HANG" ;; *) sleep 60 ;; esac; exit 1; fi
case " $* " in *" --request-timeout="*) ;; *) echo "no --request-timeout" >&2; exit 2 ;; esac
case " $* " in
  *" annotate "*) echo "$*" | sed 's/--request-timeout=[^ ]* *//' >> "${dir}/asked" ;;
  *" get applications "*) echo $((n + 1)) > "${dir}/n"; cat "$look" ;;
  *" get application root "*) cat "${dir}/root.json" 2>/dev/null || exit 1 ;;
  *" get jobs "*) cat "${dir}/jobs.json" 2>/dev/null || echo '{"items":[]}' ;;
  *" get pods "*) cat "${dir}/pods.json" 2>/dev/null || echo '{"items":[]}' ;;
  *" logs "*) for arg; do [ -e "${dir}/$arg.log" ] && cat "${dir}/$arg.log"; done; true ;;
esac
`,
  );
  chmodSync(join(dir, 'kubectl'), 0o755);
  return join(dir, 'kubectl');
}

/** What the watch asked of Argo CD beyond reading: each annotate, as kubectl got it. */
const asked = (kubectlPath: string) => {
  try {
    return readFileSync(join(dirname(kubectlPath), 'asked'), 'utf-8')
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

function watch(looks: App[][], env: Record<string, string> = {}, cluster: Cluster = {}) {
  const fake = kubectl(looks, cluster);
  const result = spawnSync(SCRIPT, [], {
    encoding: 'utf-8',
    timeout: 20_000,
    env: { PATH: process.env.PATH, KUBECTL: fake, INTERVAL: '0', DEADLINE: '10', ...env },
  });
  return { status: result.status, out: result.stdout, asked: asked(fake) };
}

const healthy = [
  { name: 'root', health: 'Healthy' },
  { name: 'loki', health: 'Healthy' },
];

describe('the watch of make up', () => {
  it('stops at the ceiling a cluster that does not come up, and names what it waited for', () => {
    const { status, out } = watch([[{ name: 'loki', health: 'Progressing' }, ...healthy.slice(0, 1)]], {
      DEADLINE: '1',
      INTERVAL: '1',
    });
    expect(status).toBe(1);
    expect(out).toBe(
      "ceiling: the cluster did not come up within 1 seconds; root's sync: not started\n" +
        'Not yet Synced and Healthy:\n' +
        '  loki Synced Progressing\n    StatefulSet/telemetry/loki Synced Progressing Waiting for 1 pods to be ready...\n',
    );
  });

  it('names the hook root waits on, and each Job’s failed attempts with the last one’s last line, first', () => {
    // As run 43255491870's first attempt was: root's sync held by the migrate hook, six attempts failed.
    const attempt = (n: number, phase: string, finished: string) => ({
      metadata: {
        namespace: 'factory',
        name: `migrate-${n}`,
        creationTimestamp: finished,
        ownerReferences: [{ kind: 'Job', name: 'migrate' }],
      },
      status: { phase, containerStatuses: [{ state: { terminated: { finishedAt: finished } } }] },
    });
    const cluster: Cluster = {
      root: {
        metadata: { name: 'root' },
        status: {
          operationState: { phase: 'Running', message: 'waiting for completion of hook batch/Job/migrate' },
        },
      },
      jobs: [
        { metadata: { namespace: 'factory', name: 'migrate' }, status: { failed: 6, active: 1 } },
        {
          metadata: { namespace: 'telemetry', name: 'done' },
          status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
        },
        {
          metadata: { namespace: 'factory', name: 'retried' },
          status: { failed: 1, succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
        },
      ],
      pods: [
        attempt(6, 'Failed', '2026-11-12T10:20:00Z'),
        attempt(1, 'Failed', '2026-11-12T10:10:00Z'),
        attempt(7, 'Running', '2026-11-12T10:30:00Z'),
      ],
      logs: {
        'migrate-6':
          'Error: connect ECONNREFUSED\n    at x\nThe migration failed: ECONNREFUSED: connect ECONNREFUSED 10.43.0.9:5432\n\n',
        'migrate-1': 'not this one\n',
      },
    };
    const { status, out } = watch([[{ name: 'root', health: 'Progressing' }]], { DEADLINE: '0' }, cluster);
    expect(status).toBe(1);
    expect(out.split('\n').slice(0, 4)).toEqual([
      "ceiling: the cluster did not come up within 0 seconds; root's sync: Running: waiting for completion of hook batch/Job/migrate",
      '  Job factory/migrate: 6 failed attempts, not complete; the last failed, migrate-6, ended: The migration failed: ECONNREFUSED: connect ECONNREFUSED 10.43.0.9:5432',
      // Its failed attempt's pod is gone, so there is no last line to quote.
      '  Job factory/retried: 1 failed attempt, then completed',
      'Not yet Synced and Healthy:',
    ]);
    // On a stop as on the ceiling.
    const degraded = watch([[{ name: 'loki', health: 'Degraded' }]], { DEGRADED: '0', INTERVAL: '1' }, cluster);
    expect(degraded.out.split('\n').slice(1, 3)).toEqual([
      "  root's sync: Running: waiting for completion of hook batch/Job/migrate",
      expect.stringMatching(/^ {2}Job factory\/migrate: 6 failed attempts, not complete; the last failed, migrate-6, /),
    ]);
  });

  it('stops on an Application Argo CD still cannot render after a hard refresh, and says why', () => {
    const broken = { name: 'loki', health: 'Unknown', error: 'values do not render' };
    const { status, out, asked } = watch([[broken], [broken], [{ ...broken, compared: 'later' }]]);
    // Asked for once, on first seeing the error: a refresh renders again now, past the repo server's cached failure.
    expect(asked).toEqual(['-n argocd annotate application loki argocd.argoproj.io/refresh=hard --overwrite']);
    expect(status).toBe(1);
    expect(out).toBe('comparison: Argo CD cannot render loki:\n  values do not render\n');
  });

  it('waits past a ComparisonError from one comparison, however long Argo CD keeps it, and one that clears', () => {
    const once = { name: 'loki', health: 'Unknown', error: 'connection refused' };
    expect(watch([[once]], { DEADLINE: '3', INTERVAL: '1' }).out).toMatch(/^ceiling: /);
    const clears = [[once], healthy, [{ ...once, compared: 'later' }], healthy];
    expect(watch(clears, { DEADLINE: '5', INTERVAL: '1' }).out).toMatch(/^ceiling: /);
  }, 15_000);

  it('stops on an Application that stays Degraded, and waits on one that recovers', () => {
    const degraded = { name: 'loki', health: 'Degraded' };
    const stays = watch([[degraded]], { DEGRADED: '1', INTERVAL: '1' });
    expect(stays.status).toBe(1);
    expect(stays.out).toMatch(/^degraded: loki has been Degraded for \d+ seconds\n$/);
    const recovers = watch([[degraded], healthy, [degraded], healthy], { DEGRADED: '2', DEADLINE: '4', INTERVAL: '1' });
    expect(recovers.out).toMatch(/^ceiling: /);
  }, 15_000);

  it('never judges the website or root by their health, which are its release’s', () => {
    const settled = [
      { name: 'root', health: 'Degraded' },
      { name: 'website', health: 'Degraded' },
    ];
    expect(watch([settled], { DEGRADED: '0', DEADLINE: '2', INTERVAL: '1' }).out).toMatch(/^ceiling: /);
  });

  it('keeps to its ceiling when the API does not answer, each read ending at its request timeout', () => {
    // The fake stands for an API that never answers: a read takes as long as the request timeout the watch gives it,
    // then fails; a read with none would hang for a minute, past this test's bound.
    const started = Date.now();
    const { status, out } = watch([healthy], { HANG: '1', READ_TIMEOUT: '1s', DEADLINE: '2', INTERVAL: '0' });
    expect(status).toBe(1);
    expect(out).toMatch(/^ceiling: the cluster did not come up within 2 seconds/);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it('ends quietly when what it watches has ended', () => {
    // Started by a shell that ends at once, so the system reaps it when it ends: a child of this test would wait as a
    // zombie, still there to signal, while spawnSync holds the test's loop.
    const watched = spawnSync('sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf-8' }).stdout.trim();
    const { status, out } = watch([healthy], { WATCHED: watched, DEADLINE: '30', INTERVAL: '1' });
    expect(status).toBe(0);
    expect(out).toBe('');
  }, 15_000);
});
