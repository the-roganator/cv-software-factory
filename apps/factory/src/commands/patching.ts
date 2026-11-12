/**
 * `factory patching`: the dependency sense (apps/factory/src/patching). As it starts, and each day after the scan, it
 * asks the GitHub worker for both repositories' moves and open Dependabot pull requests, compares the images the
 * cluster's pods run with the scan's list, and appends the day as `patching.read` when it differs from the last. It
 * connects to the store as its own role, `factory_patching`, which alone may append that event.
 *
 *     factory patching          the sense, until stopped
 *     factory patching --once   one pass, then out: what it appended, or why not; it exits 0 for a day read, 1 for
 *                               a read that failed, and 75 for a read the worker said to take again
 *
 * Settings come from the environment:
 *
 *     PGHOST, PGDATABASE, PGUSER, PGPASSWORD   the store, as factory_patching
 *     GITHUB_URL                               the GitHub worker's reads door (its PATCHING_PORT), which serves the
 *                                              sense's two reads and nothing else
 *     KUBE_API_URL                             on a host, what `kubectl proxy` serves; in the cluster the pod's account
 *     PATCHING_AT                              the day's read, HH:MM in UTC (05:30, once the scan has finished)
 *     PATCHING_REPOSITORIES                    the repositories, comma-separated (both public ones)
 *     PATCHING_NAMESPACES                      the namespaces it lists pods in, comma-separated; unset, every one,
 *                                              as `kubectl proxy` on a host may
 */
import { REPOSITORIES } from '../github/config.ts';

export const USAGE = '  factory patching [--once]';

export async function run(args: string[]): Promise<number> {
  const once = args[0] === '--once';
  const { GITHUB_URL, PATCHING_AT = '05:30', PATCHING_REPOSITORIES, PATCHING_NAMESPACES } = process.env;
  if (args.length > (once ? 1 : 0) || !GITHUB_URL) {
    console.log(`Usage:\n${USAGE}\n\nSet GITHUB_URL to the GitHub worker's reads door.`);
    return 2;
  }
  const namespaces = PATCHING_NAMESPACES?.trim() ? PATCHING_NAMESPACES.split(',').map((ns) => ns.trim()) : undefined;
  const repositories = PATCHING_REPOSITORIES?.trim()
    ? PATCHING_REPOSITORIES.split(',').map((repo) => repo.trim())
    : [...REPOSITORIES];
  const { timeOfDay, everyDay } = await import('../patching/schedule.ts');
  const at = timeOfDay(PATCHING_AT);
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { connect, DiskArtifacts, EventWriter } = await import('@software-factory/store');
  const { kubeFrom } = await import('../runners/kube.ts');
  const { GitHubWorker } = await import('../github/worker-client.ts');
  const { runningContainers } = await import('../patching/running.ts');
  const { exitCode, nextAfter, PatchingSense } = await import('../patching/sense.ts');

  const sql = connect(process.env.DATABASE_URL);
  // The day carries no artifacts, so the writer never looks in the artifact store.
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });
  const kube = kubeFrom();
  const github = new GitHubWorker(GITHUB_URL);
  const sense = new PatchingSense({
    sql,
    events,
    repositories,
    log,
    senses: {
      moves: (repo) => github.read('moves', repo, {}),
      dependencyPulls: (repo) => github.read('dependencyPulls', repo, {}),
      running: () => runningContainers(kube, namespaces),
    },
  });
  const pass = async () => {
    try {
      const result = await sense.pass();
      if (result.pass === 'appended' || result.pass === 'unchanged') {
        const { day } = result;
        log.info(
          {
            moves: Object.fromEntries(day.repositories.map((r) => [r.repository, r.moves.length])),
            compared: day.compared,
            rows: day.rows.length,
          },
          result.pass === 'appended' ? 'patching: the day appended' : 'patching: nothing changed, nothing appended',
        );
      } else if (result.pass === 'not-real') log.warn('patching: the store holds samples; nothing appended');
      const { next, why } = nextAfter(result, Date.now());
      if (why === 'stale')
        log.info('patching: a scan read is older than today’s, so the day is read again within the hour');
      return { next, code: exitCode(result) };
    } catch (error) {
      log.error({ err: error }, 'patching: the pass failed, so the day is not appended');
      return { next: 'hour' as const, code: 1 };
    }
  };

  try {
    if (once) return (await pass()).code;
    const abort = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log.info({ signal }, 'patching stopping');
        abort.abort();
      });
    }
    log.info({ github: GITHUB_URL, at: PATCHING_AT, repositories }, 'patching: reading now, then each day');
    await everyDay(pass, at, abort.signal);
    return 0;
  } finally {
    await Promise.all([sql.end(), shutdownTelemetry()]);
  }
}
