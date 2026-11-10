/**
 * The `osv-scanner.toml` policy/vulnerabilities.ts gives a repository, which Scorecard reads beside its lockfile: an
 * `IgnoredVulns` for each advisory an exception in force excepts there, with its `ignoreUntil`.
 *
 *     node scripts/osv-scanner.ts <owner/name> > osv-scanner.toml
 *
 * This repository's is at its root, beside `pnpm-lock.yaml`, and CODEOWNERS gives it to Martin with the policy. The daily
 * scan warns when a repository's file is not the one this prints for it that day.
 */

import { REPOSITORIES } from '../apps/factory/src/github/config.ts';
import { osvScannerToml } from '../apps/factory/src/vulnerabilities/exceptions.ts';
import * as policy from '../policy/vulnerabilities.ts';

export function main(args: string[]): number {
  const [repository] = args;
  if (!repository || !(REPOSITORIES as readonly string[]).includes(repository)) {
    console.error(`Usage: osv-scanner.ts <${REPOSITORIES.join(' | ')}>`);
    return 2;
  }
  process.stdout.write(osvScannerToml(policy, repository));
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
