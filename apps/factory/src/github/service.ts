/**
 * Starts the GitHub worker: the client with the App's key, the actions (live or a dry run), the poller and the HTTP
 * server, wired from a `GitHubConfig`. `factory github` is the entry point, and loads `telemetry.ts` before this module.
 */

import type { Server } from 'node:http';
import { DiskArtifacts } from '@software-factory/store';
import type { Logger } from 'pino';
import { listenOn } from '../listen.ts';
import { type Actions, contentsReader, DryRunActions, LiveActions, queueCandidate } from './actions.ts';
import { createAttackServer } from './attacks.ts';
import { GitHub } from './client.ts';
import { type GitHubConfig, REPOSITORIES } from './config.ts';
import { deployQueueWatch, QUEUED_DEPLOYS } from './deploy-queue.ts';
import { DEPLOYS, DeployProposals, deployWatch } from './deploys.ts';
import { DryRunReads } from './dry-run-reads.ts';
import { IssueGuard, openedBy, outsideIssuesWatch } from './issues.ts';
import { Poller } from './poller.ts';
import { LiveReads } from './reads.ts';
import { RefusalRecorder } from './refusals.ts';
import { Registry } from './registry.ts';
import { quietReleasePlease, releaseWatch } from './releases.ts';
import { createWorkerServer, PATCHING_READS } from './server.ts';
import { Signatures } from './signatures.ts';

export async function startGitHubWorker(config: GitHubConfig, log: Logger) {
  const github = new GitHub({ credentials: config.credentials, api: config.api, log });
  const registry = new Registry({ base: config.ghcr });
  const signatures = new Signatures({ registry, cachePath: config.tufCacheDir });
  // configFromEnv refuses a dry run with nowhere to record it; this holds even if it is called some other way.
  if (config.dryRun && !config.artifactsDir) throw new Error('A dry run needs ARTIFACTS_DIR to record to.');
  // A worker that can write keeps each refusal, its guard's and GitHub's, so it needs somewhere to keep it.
  if (github.writable && !config.artifactsDir) {
    throw new Error('A worker with the App key keeps its refusals in the artifact store: set ARTIFACTS_DIR.');
  }
  const artifacts = config.artifactsDir ? new DiskArtifacts(config.artifactsDir) : undefined;
  // Each refusal, its guard's or GitHub's, is kept, logged and signed, for the worker that asked to record.
  const recorder = new RefusalRecorder({ artifacts, key: config.refusalKey, log });
  if (!config.refusalKey)
    log.warn('No REFUSAL_SIGNING_KEY: refusals are answered unsigned, and no worker records them.');
  // One guard for both: an issue the App did not open is refused, live or in a dry run, and each refusal is kept.
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  // One dry run, remembered for as long as the worker runs, for a worker in dry-run mode and for any request that asks.
  const dryRun = artifacts
    ? new DryRunActions(artifacts, log, undefined, contentsReader(github), guard, queueCandidate(github))
    : undefined;
  const actions: Actions = config.dryRun && dryRun ? dryRun : new LiveActions(github, { guard });
  // What each deploy watch proposes, which the line reads to say what a deploy carries.
  const proposals = new DeployProposals();
  const liveReads = new LiveReads(github, { registry, signatures, proposals }, { recorder });
  const dryRunReads = dryRun ? new DryRunReads(dryRun, liveReads, config.dryRunTimes) : undefined;
  const poller = new Poller({ intervalMs: config.pollMs, log });

  const mode = config.dryRun ? 'dry-run' : github.writable ? 'live' : 'read-only';
  if (mode === 'read-only') {
    log.warn('No App key (GITHUB_APP_PRIVATE_KEY): the worker reads GitHub and writes nothing.');
  } else {
    // The App opens the deploy pull requests, and keeps the release pull requests, in every repository it acts on.
    for (const target of DEPLOYS.filter((t) => config.repositories.includes(t.repo))) {
      poller.watch(
        `deploy ${target.branch} in ${target.repo}`,
        deployWatch({ github, registry, signatures, actions, log, proposals }, target),
      );
    }
    // This repository's local deploy pull request is added to the merge queue once the gate passes it as an exact pin
    // and its checks are green (ADR 0017), recorded instead in a dry run; the app's is the line's.
    for (const target of QUEUED_DEPLOYS.filter((t) => config.repositories.includes(t.repo))) {
      poller.watch(
        `queue ${target.branch} in ${target.repo}`,
        deployQueueWatch({ github, reads: liveReads, actions, recorder, log }, target),
      );
    }
    // Each issue opened by anyone but Martin or the App gets one reply, recorded instead in a dry run.
    for (const repo of config.repositories)
      poller.watch(`issues in ${repo}`, outsideIssuesWatch(github, repo, actions, log));
    if (mode === 'live') {
      quietReleasePlease(log);
      for (const repo of config.repositories) poller.watch(`releases in ${repo}`, releaseWatch(github, repo, log));
    }
  }
  const server = createWorkerServer({
    actions,
    reads: config.dryRun && dryRunReads ? dryRunReads : liveReads,
    dryRun,
    dryRunReads,
    repositories: config.repositories,
    health: () => ({ mode, watching: poller.watching, signsRefusals: recorder.signs }),
    recorder,
    log,
  });
  // The dependency sense's door (`factory patching`), on a port of its own: the scan's moves and Dependabot's pull
  // requests, read as a live worker reads them, and no action. A NetworkPolicy opens the port to the sense's pod alone,
  // so the sense reaches the worker's reads and cannot act in GitHub.
  let patchingDoor: Server | undefined;
  if (config.patchingPort !== undefined) {
    patchingDoor = createWorkerServer({
      actions,
      reads: liveReads,
      repositories: config.repositories,
      health: () => ({ mode, door: 'patching' }),
      only: PATCHING_READS,
      log,
    });
    // Before the main port and the watches: a port it cannot have leaves nothing running.
    await listenOn(patchingDoor, config.patchingPort, config.host);
    log.info({ port: config.patchingPort }, "the dependency sense's door listening");
  }

  // Nothing runs before it listens, so a port it cannot have leaves nothing to close but the sense's door.
  try {
    await listenOn(server, config.port, config.host);
  } catch (error) {
    patchingDoor?.close();
    throw error;
  }
  poller.start();
  log.info(
    { host: config.host, port: config.port, mode, repositories: config.repositories },
    `github worker listening on ${config.host}:${config.port}`,
  );

  // The red-team harness's attack door (github/attacks.ts), on a port of its own, for attacks 2 and 3. It makes
  // real attempts in GitHub, so it is served only when the worker can write and is not in a dry run, which must touch
  // nothing in GitHub: with the door closed the harness records those two attacks unfinished. A NetworkPolicy opens
  // the port to the harness's pod alone, never the line.
  // Its attacks act in the two public repositories, and only when the worker is configured for both: a worker aimed at
  // a stand-in or a subset (GITHUB_REPOSITORIES) serves no door.
  const [factoryRepo, appRepo] = REPOSITORIES;
  const bothConfigured = config.repositories.includes(factoryRepo) && config.repositories.includes(appRepo);
  let attackDoor: ReturnType<typeof createAttackServer> | undefined;
  if (config.attackPort !== undefined && github.writable && !config.dryRun && bothConfigured) {
    const doorActions = new LiveActions(github, { guard });
    attackDoor = createAttackServer({
      actions: doorActions,
      liveActions: doorActions,
      github,
      reads: liveReads,
      recorder,
      factoryRepo,
      appRepo,
      port: config.attackPort,
      host: config.host,
      log,
    });
    await attackDoor.listening;
    log.info({ port: config.attackPort }, 'red-team attack door listening');
  } else if (config.attackPort !== undefined) {
    const why = config.dryRun
      ? 'the worker is in a dry run, which touches nothing in GitHub'
      : !github.writable
        ? 'the worker cannot write'
        : 'the worker is not configured for both public repositories (GITHUB_REPOSITORIES)';
    log.warn(`ATTACK_PORT is set but ${why}: the attack door is not served.`);
  }

  const stop = async () => {
    await poller.stop();
    if (patchingDoor) {
      const door = patchingDoor;
      await new Promise<void>((resolve) => {
        door.close(() => resolve());
        door.closeIdleConnections();
      });
    }
    if (attackDoor)
      await new Promise<void>((resolve) => {
        attackDoor.server.close(() => resolve());
        attackDoor.server.closeIdleConnections();
      });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  };
  return { github, registry, actions, poller, server, mode, stop };
}
