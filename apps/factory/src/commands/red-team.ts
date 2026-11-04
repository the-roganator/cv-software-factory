/**
 * `factory red-team`: the red-team harness. It makes each of spec 5.3's attacks Martin launches from the console,
 * against the real mechanism, and records how it ended (apps/factory/src/red-team). It connects to the store as its
 * own role, `factory_redteam`, which alone may read his launches and append how an attack ended.
 *
 *     factory red-team
 *
 * Settings come from the environment:
 *
 *     PGHOST, PGDATABASE, PGUSER, PGPASSWORD   the store, as factory_redteam
 *     ARTIFACTS_DIR                            the artifact store the writer checks its events' artifacts against
 *     APP_URL, INGRESS_URL                     the app's front door, for attack 1's report: it connects to the
 *                                              ingress and names the app's host, as a visitor's browser would
 *     RUNNER_IMAGE                             the signed runner image attack 4's egress pod runs (the profile pins it)
 *     GITHUB_ATTACK_URL                        the GitHub worker's attack door, for attacks 2 and 3
 *     KUBE_API_URL                             on a host, what `kubectl proxy` serves; in the cluster the pod's account
 */
import { request } from 'node:http';
import type { Attack } from '@software-factory/events';
import { RED_TEAM_UNSIGNED_IMAGE } from '../../../../policy/attacks.ts';

export const USAGE = '  factory red-team';

export async function run(args: string[]): Promise<number> {
  const { APP_URL, INGRESS_URL, ARTIFACTS_DIR, RUNNER_IMAGE, GITHUB_ATTACK_URL } = process.env;
  if (args.length || !APP_URL || !ARTIFACTS_DIR || !RUNNER_IMAGE || !GITHUB_ATTACK_URL) {
    console.log(
      `Usage:\n${USAGE}\n\nSet APP_URL, ARTIFACTS_DIR, RUNNER_IMAGE and GITHUB_ATTACK_URL (and INGRESS_URL for the app's front door).`,
    );
    return 2;
  }
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { connect, DiskArtifacts, EventWriter } = await import('@software-factory/store');
  const { kubeFrom } = await import('../runners/kube.ts');
  const { RedTeam } = await import('../red-team/worker.ts');
  const { reportAttempt } = await import('../red-team/report.ts');
  const { egressAttempt, imageAttempt } = await import('../red-team/pods.ts');
  const { workflowAttempt, testAttempt } = await import('../red-team/github.ts');
  const { attackDoor } = await import('../red-team/door.ts');

  const sql = connect(process.env.DATABASE_URL);
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(ARTIFACTS_DIR) });
  const kube = kubeFrom();
  const door = attackDoor(GITHUB_ATTACK_URL);
  const report = reportPoster(APP_URL, INGRESS_URL);

  const attempts: Record<Attack, ReturnType<typeof reportAttempt>> = {
    report: reportAttempt({ report }),
    egress: egressAttempt({ kube, runnerImage: RUNNER_IMAGE }),
    image: imageAttempt({ kube, unsignedImage: RED_TEAM_UNSIGNED_IMAGE }),
    workflow: workflowAttempt({ door }),
    test: testAttempt({ door }),
  };

  const harness = new RedTeam({ sql, events, attempts, log });
  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'red-team harness stopping');
      abort.abort();
    });
  }
  log.info({ app: APP_URL, door: GITHUB_ATTACK_URL }, 'red-team harness waiting for an attack to be launched');
  try {
    await harness.run(abort.signal);
    return 0;
  } finally {
    await Promise.all([sql.end(), shutdownTelemetry()]);
  }
}

/**
 * Sends a report as a visitor does: it connects to the ingress and names the app's host, since the app's public name
 * does not resolve in the cluster. With no ingress, it connects to the app's address directly.
 */
function reportPoster(app: string, ingress: string | undefined) {
  const { host } = new URL(app);
  const to = new URL(ingress || app);
  return (report: { page: string; text: string }): Promise<void> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(report);
      const req = request(
        {
          host: to.hostname,
          port: to.port || 80,
          path: '/api/reports',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), host },
          timeout: 10_000,
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            res.statusCode === 202 ? resolve() : reject(new Error(`the app answered ${res.statusCode} to a report`)),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('the app did not answer a report in time')));
      req.on('error', reject);
      req.end(body);
    });
}
