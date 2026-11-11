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

/** A kubectl that answers each look with the next list of Applications, and the last one from then on. */
function kubectl(looks: App[][]) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-watch-'));
  dirs.push(dir);
  looks.forEach((apps, i) => {
    writeFileSync(join(dir, `look-${i}.json`), JSON.stringify({ items: apps.map(application) }));
  });
  const last = looks.length - 1;
  writeFileSync(
    join(dir, 'kubectl'),
    `#!/usr/bin/env bash
n=$(cat "${dir}/n" 2>/dev/null || echo 0)
look="${dir}/look-$(( n < ${last} ? n : ${last} )).json"
if [ "$3" = annotate ]; then echo "$*" >> "${dir}/asked"; exit 0; fi
if [ "$4" = applications ]; then echo $((n + 1)) > "${dir}/n"; cat "$look"; fi
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

function watch(looks: App[][], env: Record<string, string> = {}) {
  const fake = kubectl(looks);
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
      'ceiling: the cluster did not come up within 1 seconds. Not yet Synced and Healthy:\n' +
        '  loki Synced Progressing\n    StatefulSet/telemetry/loki Synced Progressing Waiting for 1 pods to be ready...\n',
    );
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

  it('ends quietly when what it watches has ended', () => {
    // Started by a shell that ends at once, so the system reaps it when it ends: a child of this test would wait as a
    // zombie, still there to signal, while spawnSync holds the test's loop.
    const watched = spawnSync('sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf-8' }).stdout.trim();
    const { status, out } = watch([healthy], { WATCHED: watched, DEADLINE: '30', INTERVAL: '1' });
    expect(status).toBe(0);
    expect(out).toBe('');
  }, 15_000);
});
