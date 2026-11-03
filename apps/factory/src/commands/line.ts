/**
 * `factory line`: stopping and starting the line (guardrail 9: stop the line always works).
 *
 *     factory line stop [--reason <why>]
 *     factory line start [--reason <why>]
 *     factory line serve
 *     factory line bench [<agent> [<fixture>]] [--commit <sha>]
 *     factory line soak-check [--since <time>] [--no-spend] [--json]
 *
 * `serve` runs the line's server (`runners/serve.ts`): the handback for runners' agent pods, and the steps it runs in
 * the `runners` namespace. With LINE_MODE set to `live` or `dry-run`, it also runs the line itself (`line/worker.ts`):
 * it takes tickets and carries them through the agents, the gates and review to Martin's merge, acting in GitHub for
 * real or recording what it would have done. LINE_MODE is `off` by default: the line takes no tickets, and only the
 * step API and the smoke run work, and stopping the line still stops their agents.
 *
 * What the line takes is Martin's to set in the console's Controls (every ticket, the next few, or just one), which the
 * line reads at each pass (`policy/line.ts`). LINE_ONLY and LINE_TAKE are its defaults, for a line with no take set (a
 * line on a host, a fresh store), and stop applying once he sets one. LINE_ONLY, a work item, has the line act on that
 * one alone: it takes the work item's ticket onto the line if it is not there, whatever else is in Plan or Build, and
 * starts no step for any other, reads nothing for it and appends nothing. It is unset by default, when the line acts on
 * every work item; a soak sets it to take one ticket end to end, with one step at a time on the local model. LINE_TAKE,
 * a number, is how many work items the line takes in all, by its own rule, counting every one it has ever taken: once
 * it has taken that many it takes no more, and carries those on it to their end. Unset, as by default, the line takes
 * tickets without limit; a first run on Claude sets it to 1, so that no one chooses the ticket and only one goes
 * through. The console's switch for new work stops the line taking tickets and starting agents' steps, as its own.
 *
 * RELEASE_ROLLOUT, the app's Rollout as `<namespace>/<name>`, has the line watch the app's releases: it reads the
 * Rollout and its AnalysisRuns, and each version's figures from Prometheus at PROMETHEUS_URL (required with it), and
 * records each release on the work items it carries. It changes nothing in Kubernetes. With LINE_ONLY, it records a
 * release only when it carries that work item or none, and leaves one that carries another for the whole line. Unset,
 * as by default, the line watches no release. In `dry-run`, the line answers for the release of each merge the dry
 * run made, by its own word, taking LINE_DRY_RUN_RELEASE_SECONDS (60 by default) over each move: to start after the
 * merge, each step, and promotion.
 *
 * Once a release is promoted, Verify asks the sense that saw each defect to look again: a probe's or the crawler's
 * check through the probes worker at PROBES_URL, an alert's expression through Prometheus at PROMETHEUS_URL, the log
 * watcher's pattern through Loki at LOKI_URL, and its agreement check through Prometheus and Loki, with Tempo at
 * TEMPO_URL for the traces. A sense whose address is unset cannot look, and its work items wait at Verify; without
 * TEMPO_URL, a missing log is judged on the metrics and the log alone, and wrong metrics wait. A dry run's release is
 * verified by the dry run's word. A feature flag at the share stage has its two sides compared on the traffic
 * generator's figures, through Prometheus at PROMETHEUS_URL too; unset, it waits.
 *
 * Before it deletes a step's Jobs, however the step ended, the line keeps each pod's log in the artifact store at
 * ARTIFACTS_DIR (`runners/logs.ts`); unset, it keeps none. Its step API serves a work item's, step by step, at
 * `GET /v1/work-items/<id>/logs`, through a person's port-forward (`runners/serve.ts`).
 *
 * Whatever LINE_MODE is, `serve` records what admission control refuses in the guarded namespaces, read from the
 * cluster's Events, and relays what the GitHub worker refuses its requests, signed, verified with REFUSAL_PUBLIC_KEY
 * (the worker's public key, as PEM), as `action.refused` (`line/refusals.ts`). Without the key, nothing the worker
 * refuses is recorded.
 *
 * Whatever LINE_MODE is, `serve` also counts Martin's security events and the holds started, from the store, for the alerts
 * that reach his phone (`line/security.ts`), and compares what the admin service changes with the events that name it
 * (`line/admin-actions.ts`): the sessions in the store, the app's Rollout at RELEASE_ROLLOUT, and the FeatureFlag at
 * FEATURE_FLAGS (`<namespace>/<name>`, `flagd/flags`), each only read, and neither when its setting is unset.
 *
 * Settings: RUNNER_IMAGE, the `factory-runner` image; GITHUB_WORKER_URL (default http://github:8080);
 * RUNNER_GATEWAY_URL and RUNNER_HANDBACK_URL, how an agent pod reaches the gateway and the handback; PORT (8080) and
 * HANDBACK_PORT (8081); ARTIFACTS_DIR; REFUSAL_PUBLIC_KEY; KUBE_API_URL on a host (what `kubectl proxy` serves); LINE_MODE; LINE_ONLY; LINE_TAKE;
 * RELEASE_ROLLOUT, PROMETHEUS_URL and LINE_DRY_RUN_RELEASE_SECONDS; PROBES_URL, LOKI_URL and TEMPO_URL; FEATURE_FLAGS;
 * FACTORY_PROFILE (default local) and ALL_LOCAL, as the gateway's, with Martin's settings within the profile's policy,
 * read at each pass (`settings.ts`): the cap on a work item's spend, which the line holds at, and where each agent's
 * calls go, so a step on a local model is given longer to finish. A step records the effort the gateway sent. The
 * profile also gives whether alerts reach Martin's phone before he switches them, which the line reports
 * (`line/phone.ts`).
 *
 * `bench` runs one agent's step on this machine, on a fixture's invented work (`line/bench/`), against the gateway at
 * GATEWAY_URL (default http://localhost:8180), and prints what the agent handed back, whether its result fits the
 * agent's schema, how many of its calls the cassettes replayed, and how long it took. A coder's patch meets the scope
 * fence, and one it refuses goes back to the coder, as on the line. Without a fixture, it lists them. It works in the
 * bench's own folder (`BENCH_DIR`), the same on every run so that a run replays.
 *
 * `soak-check` reads the store and the cluster the morning after a soak (`line/soak.ts`): leases held past their
 * expiry, runners' Jobs and volumes left for ended work items and volumes for merged ones, events that are not valid,
 * the spend, and the work items taken since `--since` (an ISO time; by default a day ago), by how each ended, with
 * their minutes in each stage. The spend is as it should be when each work item's is within the highest cap on one in force since `--since` (Martin's, within FACTORY_PROFILE's policy), as on Claude;
 * `--no-spend`, for a soak on the local model, allows nothing at all. It prints a few lines, or the report as JSON, and exits 1 if anything is not as a soak should leave it. On
 * a host it reads the cluster through KUBE_API_URL (what `kubectl proxy` serves).
 *
 * Every worker checks the line before it takes work, so a stopped line finishes what is in hand and takes nothing
 * new; signals wait in the inbox until it starts again. `stop` and `start` each record Martin's reason if he gives one
 * (`stop` has its own words if not). The console's header stops and starts the line too, through the admin service
 * (`admin/line.ts`), with the same events; `stop`, which `make stop-the-line` runs before it aborts the canary in flight,
 * works when neither the console nor the admin service does. Connects with DATABASE_URL, or the PG* variables, as Martin's
 * own role (`factory_operator`): only his roles may append his commands, and the workers heed them from no other.
 */
import { parseArgs } from 'node:util';
import { type NewEvent, VERSIONS } from '@software-factory/events';
import { connect, DiskArtifacts, EventWriter } from '@software-factory/store';
import { rolloutRefOf } from '../release/rollout-ref.ts';

export const USAGE = `  factory line stop [--reason <why>]
  factory line start [--reason <why>]
  factory line serve
  factory line bench [<agent> [<fixture>]] [--commit <sha>]
  factory line soak-check [--since <time>] [--no-spend] [--json]`;

export async function run(args: string[]): Promise<number> {
  if (args[0] === 'bench') return bench(args.slice(1));
  if (args[0] === 'soak-check') return soakCheck(args.slice(1));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      reason: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (command === 'serve') return serve();
  if (command !== 'stop' && command !== 'start') {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  const { DATABASE_URL } = process.env;
  const sql = connect(DATABASE_URL);
  // Line events carry no artifacts, so the writer never looks in the artifact store.
  const writer = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });
  const event = (type: 'line.stopped' | 'line.started', summary: string, payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: null,
      type,
      version: VERSIONS[type],
      actor: 'martin',
      summary,
      payload,
      artifacts: [],
    }) as NewEvent;
  try {
    if (command === 'stop') {
      const reason = values.reason?.trim() || 'Martin stopped the line';
      await writer.append(event('line.stopped', `The line stopped: ${reason}`, { reason }));
      console.log('The line is stopped. Workers finish what they hold and take nothing new.');
    } else {
      const reason = values.reason?.trim();
      await writer.append(event('line.started', 'The line started', reason ? { reason } : {}));
      console.log('The line is running. Workers take what waited in the inbox.');
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sql.end();
  }
}

const MODES = ['off', 'dry-run', 'live'] as const;

async function serve(): Promise<number> {
  const { RUNNER_IMAGE, DATABASE_URL } = process.env;
  if (!RUNNER_IMAGE) {
    console.error('Set RUNNER_IMAGE to the factory-runner image, by digest.');
    return 2;
  }
  // The setting that lets the line act fails closed: anything but one of its values stops it starting.
  const mode = (process.env.LINE_MODE || 'off').trim() as (typeof MODES)[number];
  if (!MODES.includes(mode)) {
    console.error(`LINE_MODE is ${JSON.stringify(process.env.LINE_MODE)}; it must be one of ${MODES.join(', ')}.`);
    return 2;
  }
  // One work item, by its number, or none: anything else stops it starting, rather than the line acting on them all.
  const only = (process.env.LINE_ONLY ?? '').trim() || null;
  if (only !== null && !/^\d{1,12}$/.test(only)) {
    console.error(`LINE_ONLY is ${JSON.stringify(process.env.LINE_ONLY)}; it must be a work item's number, or unset.`);
    return 2;
  }
  // How many work items in all, or no limit: anything but a whole number from 0 stops it starting.
  const takeSetting = (process.env.LINE_TAKE ?? '').trim();
  if (takeSetting !== '' && !/^\d{1,6}$/.test(takeSetting)) {
    console.error(`LINE_TAKE is ${JSON.stringify(process.env.LINE_TAKE)}; it must be a whole number, or unset.`);
    return 2;
  }
  const take = takeSetting === '' ? null : Number(takeSetting);
  // The Rollout to watch, or none: a name of another shape stops it starting, rather than the line watching nothing.
  const rolloutSetting = (process.env.RELEASE_ROLLOUT ?? '').trim();
  const rollout = rolloutRefOf(rolloutSetting);
  if (rollout === undefined) {
    console.error(`RELEASE_ROLLOUT is ${JSON.stringify(rolloutSetting)}; it must be <namespace>/<name>, or unset.`);
    return 2;
  }
  // The flags the admin service stages, compared with Martin's moves, or none: a name of another shape stops it starting.
  const flagsSetting = (process.env.FEATURE_FLAGS ?? '').trim();
  const flags = rolloutRefOf(flagsSetting);
  if (flags === undefined) {
    console.error(`FEATURE_FLAGS is ${JSON.stringify(flagsSetting)}; it must be <namespace>/<name>, or unset.`);
    return 2;
  }
  // Without Prometheus every step would be recorded without its figures, and every rollback without its series.
  if (rollout && !(process.env.PROMETHEUS_URL ?? '').trim()) {
    console.error('RELEASE_ROLLOUT is set, and PROMETHEUS_URL is not: set it to where the line reads the figures.');
    return 2;
  }
  const releaseSeconds = Number((process.env.LINE_DRY_RUN_RELEASE_SECONDS ?? '').trim() || 60);
  if (!Number.isInteger(releaseSeconds) || releaseSeconds < 0) {
    console.error('LINE_DRY_RUN_RELEASE_SECONDS must be a whole number of seconds, or unset.');
    return 2;
  }
  // The work item's cap the gateway keeps, from the same profile and Martin's settings within it, so the line holds a
  // work item that reached it.
  const { PROFILES } = await import('../../../../policy/spend.ts');
  const profile = (process.env.FACTORY_PROFILE || 'local').trim() as (typeof PROFILES)[number];
  if (!PROFILES.includes(profile)) {
    console.error(`FACTORY_PROFILE is ${JSON.stringify(profile)}; it must be one of ${PROFILES.join(', ')}.`);
    return 2;
  }
  // Where the gateway sends each agent's calls, from the same settings: Martin's within policy, or every agent to the
  // local model under ALL_LOCAL, as the gateway's. The line only reads them.
  const { MODELS } = await import('../../../../policy/models.ts');
  const { inForce } = await import('../../../../policy/settings.ts');
  const allLocal = process.env.ALL_LOCAL === 'true';
  if (allLocal && !MODELS[profile].local) {
    console.error(`ALL_LOCAL sends every agent to the local model, and the ${profile} profile has none.`);
    return 2;
  }
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { kubeFrom } = await import('../runners/kube.ts');
  const { Runners } = await import('../runners/steps.ts');
  const { telemetryFrom } = await import('../clients/env.ts');
  const { lineServers } = await import('../runners/serve.ts');
  const { listenOn } = await import('../listen.ts');
  const { GitHubWorker } = await import('../github/worker-client.ts');
  const sql = connect(DATABASE_URL);
  const env = process.env;
  const kube = kubeFrom(env);
  const { SettingsReader } = await import('../settings.ts');
  const { lineSettings, providerUnder } = await import('../line/settings.ts');
  const defaults = inForce(profile);
  const { StepLogs } = await import('../runners/logs.ts');
  const artifactsDir = env.ARTIFACTS_DIR?.trim();
  if (!artifactsDir) log.warn('ARTIFACTS_DIR is unset: no step’s pod logs are kept');
  const stepLogs = artifactsDir ? new StepLogs(sql, new DiskArtifacts(artifactsDir)) : undefined;
  const runners = new Runners({
    sql,
    kube,
    image: RUNNER_IMAGE,
    gatewayUrl: env.RUNNER_GATEWAY_URL ?? 'http://gateway.factory.svc:8080',
    handbackUrl: env.RUNNER_HANDBACK_URL ?? 'http://line.factory.svc:8081/v1/handback',
    log,
    ...(stepLogs ? { logs: stepLogs } : {}),
  });
  // What the GitHub worker refuses the line, relayed, and what admission control refuses in the guarded namespaces,
  // recorded as action.refused (line/refusals.ts). The worker's public key, from the ConfigMap refusal-key: without it,
  // nothing the worker refuses is relayed.
  const { LineRefusals, AdmissionReader } = await import('../line/refusals.ts');
  const { verifyingKey } = await import('../signed-refusals.ts');
  const refusalKey = env.REFUSAL_PUBLIC_KEY?.trim() ? verifyingKey(env.REFUSAL_PUBLIC_KEY) : undefined;
  if (!refusalKey) log.warn('No REFUSAL_PUBLIC_KEY: what the GitHub worker refuses is not recorded');
  // The line's only artifacts are the pictures the probes worker took, which its index vouches for.
  const { IndexedArtifacts, PictureIndex } = await import('../pictures/index.ts');
  const events = new EventWriter(sql, { kind: 'real', artifacts: new IndexedArtifacts(sql) });
  const refusals = new LineRefusals({ events, log, key: refusalKey });
  refusals.start();
  // The smoke run asks for a dry run; the steps Part B runs will say what they want.
  const github = new GitHubWorker(env.GITHUB_WORKER_URL ?? 'http://github:8080', {
    dryRun: true,
    onRefusal: refusals.relay,
  });
  const { api, handback } = lineServers({ runners, github, log, ...(stepLogs ? { logs: stepLogs } : {}) });
  const port = Number(env.PORT ?? 8080);
  const handbackPort = Number(env.HANDBACK_PORT ?? 8081);
  // The step API on loopback only: a port-forward reaches it, and no pod can. Agent pods call the handback.
  await listenOn(api, port, '127.0.0.1');
  await listenOn(handback, handbackPort);
  log.info(
    { port, handbackPort, mode, only, take, rollout: rolloutSetting || null },
    `line listening on :${port}, the handback on :${handbackPort}`,
  );

  // Off, the line takes no work, but still stops what the step API started when the line stops.
  const { Line } = await import('../line/worker.ts');
  const { ProbesClient } = await import('../line/verify.ts');
  // A spend hold is appended by the same writer, under the lock a save of the settings takes too.
  const settings = lineSettings(new SettingsReader(sql, profile, { freshMs: 0 }), allLocal, { sql, events });
  // Verify's probes: a ticket's check run again, and each improvement's flag checked at its stage.
  const probes = env.PROBES_URL?.trim() ? new ProbesClient(env.PROBES_URL.trim()) : null;
  const line = new Line({
    sql,
    events,
    pictures: new PictureIndex(sql),
    steps: runners,
    github: new GitHubWorker(env.GITHUB_WORKER_URL ?? 'http://github:8080', {
      dryRun: mode !== 'live',
      onRefusal: refusals.relay,
    }),
    log,
    takesWork: mode !== 'off',
    workItemLimitUsd: defaults.caps.workItemUsd,
    providerOf: providerUnder(defaults, allLocal),
    settings,
    only,
    take,
    release: rollout
      ? {
          kube,
          rollout,
          prometheus: telemetryFrom(env).prometheus,
        }
      : null,
    dryRun: mode === 'dry-run',
    dryRunReleaseMs: releaseSeconds * 1000,
    verify: {
      probes,
      prometheus: env.PROMETHEUS_URL?.trim() ? telemetryFrom(env).prometheus : null,
      loki: env.LOKI_URL?.trim() ? telemetryFrom(env).loki : null,
      tempo: env.TEMPO_URL?.trim() ? telemetryFrom(env).tempo : null,
    },
    flagChecks: probes,
  });
  // Martin's security events and the holds waiting for him, from the store, whatever LINE_MODE is: the alerts that page
  // him read them (line/security.ts). Its judgement of each red-team attack verifies a relayed refusal with the GitHub
  // worker's key, against the record that worker kept in the artifact store (line/attacks.ts).
  const { observeSecurity } = await import('../line/security.ts');
  const unobserveSecurity = observeSecurity(sql, log, {
    key: refusalKey,
    artifacts: artifactsDir ? new DiskArtifacts(artifactsDir) : undefined,
  });
  // And whether every change the admin service makes is named by an event (line/admin-actions.ts).
  const { observeAdminActions } = await import('../line/admin-actions.ts');
  const unobserveAdminActions = observeAdminActions({ sql, kube, flags, rollout }, log);
  // Any lease held past its expiry, whatever LINE_MODE is: a lease a dead pod left is paged on a line that is off too.
  const { observeLeases } = await import('../line/metrics.ts');
  const unobserveLeases = observeLeases(sql);
  // Whether alerts reach his phone, as the line reads it: `PhoneOff` mutes them only while this and the admin
  // service's both say off (line/phone.ts).
  const { observePhone } = await import('../line/phone.ts');
  const unobservePhone = observePhone(sql, profile, log);
  // Whether auto-rollback is on, as the line reads it: the canary's analysis pauses a bad canary for Martin only while
  // this and the admin service's both say off (line/auto-rollback.ts).
  const { observeAutoRollback } = await import('../line/auto-rollback.ts');
  const unobserveAutoRollback = observeAutoRollback(sql, log);
  const abort = new AbortController();
  const working = line.run(abort.signal);
  // Admission control's denials, from the cluster's Events, whatever LINE_MODE is (line/refusals.ts).
  const admission = new AdmissionReader({ kube, sql, refusals, log }).run(abort.signal);
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => resolve());
  });
  abort.abort();
  await Promise.all([working, admission]);
  unobserveSecurity();
  unobserveAdminActions();
  unobserveLeases();
  unobservePhone();
  unobserveAutoRollback();
  await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => handback.close(r))]);
  // Once nothing more can be relayed: what is still folded is appended now.
  await refusals.stop();
  await Promise.all([sql.end(), shutdownTelemetry()]);
  return 0;
}

async function bench(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { commit: { type: 'string' } } });
  const [agent, name] = positionals;
  const { FIXTURES } = await import('../line/bench/fixtures.ts');
  const fixtures = agent && Object.hasOwn(FIXTURES, agent) ? FIXTURES[agent as keyof typeof FIXTURES] : undefined;
  const fixture = fixtures && name && Object.hasOwn(fixtures, name) ? fixtures[name] : undefined;
  if (!agent || !fixtures || !fixture) {
    console.log(`Usage:\n  factory line bench <agent> <fixture> [--commit <sha>]\n\nFixtures:`);
    for (const [each, list] of Object.entries(FIXTURES)) {
      for (const [fixtureName, f] of Object.entries(list)) console.log(`  ${each} ${fixtureName}: ${f.about}`);
    }
    return agent ? 2 : 0;
  }
  // The runner's own steps, which only the bench loads: the factory's image does not hold them.
  const { prepare, commitPatch } = await import('../../../runner/src/prepare.ts');
  const { runAgent } = await import('../../../runner/src/agent.ts');
  const { bench: run, lastStep } = await import('../line/bench/bench.ts');
  const { DATABASE_URL, GATEWAY_URL } = process.env;
  const sql = connect(DATABASE_URL);
  try {
    const benched = await run({
      agent: agent as keyof typeof FIXTURES,
      fixture,
      commit: values.commit,
      sql,
      gateway: GATEWAY_URL ?? 'http://localhost:8180',
      runner: { prepare, runAgent, commitPatch },
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify(benched, null, 2));
    const last = lastStep(benched);
    return last.handback.ending === 'finished' && last.result.fits && last.fence?.ok !== false ? 0 : 1;
  } finally {
    await sql.end();
  }
}

async function soakCheck(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { since: { type: 'string' }, 'no-spend': { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const now = new Date();
  const since = values.since ? new Date(values.since) : new Date(now.getTime() - 24 * 3_600_000);
  if (Number.isNaN(since.getTime())) {
    console.error(`--since is ${JSON.stringify(values.since)}; give a time, such as 2026-10-06T22:00:00Z.`);
    return 2;
  }
  const { PROFILES } = await import('../../../../policy/spend.ts');
  const profile = (process.env.FACTORY_PROFILE || 'local').trim() as (typeof PROFILES)[number];
  if (!PROFILES.includes(profile)) {
    console.error(`FACTORY_PROFILE is ${JSON.stringify(profile)}; it must be one of ${PROFILES.join(', ')}.`);
    return 2;
  }
  const { soakFacts, soakReport, soakText } = await import('../line/soak.ts');
  const { highestWorkItemCap } = await import('../settings.ts');
  const { kubeFrom } = await import('../runners/kube.ts');
  const { DATABASE_URL } = process.env;
  const sql = connect(DATABASE_URL);
  try {
    const report = soakReport(
      await soakFacts({ sql, kube: () => kubeFrom(process.env), now, since }),
      values['no-spend']
        ? { kind: 'none' }
        : { kind: 'capped', profile, workItemUsd: await highestWorkItemCap(sql, profile, since) },
    );
    console.log(values.json ? JSON.stringify(report, null, 2) : soakText(report));
    return report.ok ? 0 : 1;
  } finally {
    await sql.end();
  }
}
