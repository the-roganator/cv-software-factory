/**
 * The GitHub worker's settings, read from the environment.
 *
 *     GITHUB_APP_CLIENT_ID            the App's Client ID; with the key, the worker acts as the App
 *     GITHUB_APP_PRIVATE_KEY          the App's private key, as PEM. Without it the worker reads, writes nothing,
 *                                     and says so
 *     GITHUB_DRY_RUN                  true: write nothing to GitHub, and record each action in the artifact store
 *                                     instead
 *     ARTIFACTS_DIR                   the artifact store, for a dry run's records and the refusals it keeps;
 *                                     a worker with the key will not start without it
 *     REFUSAL_SIGNING_KEY             the Ed25519 private key, as PEM, it signs each refusal with (`refusals.ts`);
 *                                     without it, it answers each unsigned, and no worker records one
 *     GITHUB_DRY_RUN_CHECKS_SECONDS   how long after a dry run's commit its checks pass (default 120)
 *     GITHUB_DRY_RUN_MERGE_SECONDS    how long after a dry run's pull request is readied it is merged (default 1200)
 *     GITHUB_REPOSITORIES             the repositories it acts on, separated by commas (default: both public ones)
 *                                     written as GitHub names them: one of those two in another case is refused
 *     GITHUB_POLL_SECONDS             how often it polls (default 60)
 *     GITHUB_API_URL, GHCR_URL        GitHub's API and GHCR, for a stand-in
 *     TUF_CACHE_DIR                   where Sigstore's trust root is kept, to check images' signatures (default: the
 *                                     user's cache)
 *     ATTACK_PORT                     the red-team harness's attack door, on a port of its own (github/attacks.ts);
 *                                     unset, it is not served
 *     PATCHING_PORT                   the dependency sense's door, on a port of its own: its two reads, and no
 *                                     action (server.ts's PATCHING_READS); unset, it is not served
 *     PIN_WATCH_ONLY                  the moves the pin watch takes, by name, separated by commas, or * for every
 *                                     one; unset or blank, it takes none, and opens, updates and closes nothing
 *     PORT                            default 8080
 *     HOST                            the address to listen on (default 127.0.0.1; the cluster's Deployment says
 *                                     0.0.0.0)
 */
import type { KeyObject } from 'node:crypto';
import { signingKey } from '../signed-refusals.ts';
import type { AppCredentials } from './app.ts';
import { API } from './client.ts';
import type { DryRunTimes } from './dry-run-reads.ts';
import { type PinScope, readPinScope } from './pins.ts';
import { GHCR } from './registry.ts';

/** The two public repositories: the factory's own, and the app it looks after. */
export const REPOSITORIES = ['the-roganator/cv-software-factory', 'the-roganator/cv-worlds-worst-website'] as const;

export interface GitHubConfig {
  credentials: AppCredentials | undefined;
  dryRun: boolean;
  artifactsDir: string | undefined;
  /** What it signs each refusal with, or undefined. */
  refusalKey: KeyObject | undefined;
  /** When the dry run's checks pass, and its pull requests merge, so a line in dry-run goes round. */
  dryRunTimes: DryRunTimes;
  repositories: string[];
  pollMs: number;
  api: string;
  ghcr: string;
  tufCacheDir: string | undefined;
  /** The attack door's port, for the red-team harness (github/attacks.ts); unset, the door is not served. */
  attackPort: number | undefined;
  /** The dependency sense's door, which serves its two reads and nothing else; unset, the door is not served. */
  patchingPort: number | undefined;
  /** The moves the pin watch takes (`PIN_WATCH_ONLY`): every one (`*`), those named, or, unset, none. */
  pinWatchOnly: PinScope;
  port: number;
  host: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv): GitHubConfig {
  const clientId = env.GITHUB_APP_CLIENT_ID || undefined;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY || undefined;
  if (privateKey && !clientId) throw new Error('GITHUB_APP_PRIVATE_KEY is set without GITHUB_APP_CLIENT_ID.');
  // The setting that keeps the worker from acting fails closed: anything but a plain yes or no stops it starting.
  const asked = (env.GITHUB_DRY_RUN ?? 'false').trim().toLowerCase();
  if (!['true', 'false', '1', '0', ''].includes(asked)) {
    throw new Error(`GITHUB_DRY_RUN is ${JSON.stringify(env.GITHUB_DRY_RUN)}; it must be true or false.`);
  }
  const dryRun = asked === 'true' || asked === '1';
  const config: GitHubConfig = {
    credentials: clientId && privateKey ? { clientId, privateKey } : undefined,
    dryRun,
    artifactsDir: env.ARTIFACTS_DIR || undefined,
    // A key that is set and not an Ed25519 private key stops it starting, rather than it answering unsigned.
    refusalKey: env.REFUSAL_SIGNING_KEY?.trim() ? signingKey(env.REFUSAL_SIGNING_KEY) : undefined,
    dryRunTimes: {
      checksAfterMs: seconds(env, 'GITHUB_DRY_RUN_CHECKS_SECONDS', 120) * 1000,
      mergeAfterMs: seconds(env, 'GITHUB_DRY_RUN_MERGE_SECONDS', 1200) * 1000,
    },
    repositories: (env.GITHUB_REPOSITORIES || REPOSITORIES.join(','))
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    pollMs: Number(env.GITHUB_POLL_SECONDS || 60) * 1000,
    api: env.GITHUB_API_URL || API,
    ghcr: env.GHCR_URL || GHCR,
    tufCacheDir: env.TUF_CACHE_DIR || undefined,
    attackPort: env.ATTACK_PORT?.trim() ? Number(env.ATTACK_PORT) : undefined,
    patchingPort: env.PATCHING_PORT?.trim() ? Number(env.PATCHING_PORT) : undefined,
    pinWatchOnly: readPinScope(env.PIN_WATCH_ONLY),
    port: Number(env.PORT ?? 8080),
    host: env.HOST || '127.0.0.1',
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error(`PORT is ${JSON.stringify(env.PORT)}; it must be a port number.`);
  }
  if (
    config.attackPort !== undefined &&
    (!Number.isInteger(config.attackPort) || config.attackPort < 1 || config.attackPort > 65_535)
  ) {
    throw new Error(`ATTACK_PORT is ${JSON.stringify(env.ATTACK_PORT)}; it must be a port number.`);
  }
  if (config.attackPort !== undefined && config.attackPort === config.port) {
    throw new Error('ATTACK_PORT must differ from PORT: the attack door is on a port of its own.');
  }
  if (
    config.patchingPort !== undefined &&
    (!Number.isInteger(config.patchingPort) || config.patchingPort < 1 || config.patchingPort > 65_535)
  ) {
    throw new Error(`PATCHING_PORT is ${JSON.stringify(env.PATCHING_PORT)}; it must be a port number.`);
  }
  if (config.patchingPort !== undefined && [config.port, config.attackPort].includes(config.patchingPort)) {
    throw new Error("PATCHING_PORT must differ from PORT and ATTACK_PORT: the sense's door is on a port of its own.");
  }
  if (dryRun && !config.artifactsDir)
    throw new Error('GITHUB_DRY_RUN records to the artifact store: set ARTIFACTS_DIR.');
  for (const repo of config.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(`GITHUB_REPOSITORIES has ${JSON.stringify(repo)}, not owner/name.`);
    // The worker's guards name these two exactly: another case is the same repository to GitHub and none to them.
    const known = REPOSITORIES.find((r) => r.toLowerCase() === repo.toLowerCase());
    if (known && known !== repo) {
      throw new Error(
        `GITHUB_REPOSITORIES has ${JSON.stringify(repo)}: write it ${known}, as the worker's guards name it.`,
      );
    }
  }
  if (!(config.pollMs >= 10_000)) throw new Error('GITHUB_POLL_SECONDS must be at least 10.');
  return config;
}

/** A number of seconds from the environment, or its default: whole, and not negative. */
function seconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim() ? Number(env[name]) : fallback;
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} is ${JSON.stringify(env[name])}; it must be whole seconds.`);
  return value;
}
