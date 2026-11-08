/**
 * The daily scan's `coverage` job: proves that Trivy reads the whole of each lockfile it scans, so a package it skips
 * cannot hide a vulnerability. For each lockfile on the scanned repository's list, the packages `pnpm list` names once
 * it is installed, development dependencies included, are each in Trivy's SBOM of the lockfile alone (CycloneDX, no
 * advisories). Trivy may name more: other platforms' optional builds, which the install leaves out.
 *
 *     node apps/factory/src/vulnerabilities/coverage.ts --pnpm-version <checkout>   the pnpm its mise pins
 *     node apps/factory/src/vulnerabilities/coverage.ts <checkout> --trivy-pin <Dockerfile> --out <dir>
 *
 * The checkout is data. The pnpm that installs it is the one its mise.lock (or mise.toml) names, installed by this
 * repository's mise, never by mise in the checkout; it installs `--frozen-lockfile --ignore-scripts --ignore-pnpmfile`,
 * with the checkout's `.npmrc` files removed and an empty one of its own, so nothing in the checkout runs or chooses
 * where packages come from. Its only output is whether it passed.
 */
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isFixture } from './inventory.ts';
import { trivyPin } from './scan.ts';

const run = promisify(execFile);

/** The exact pnpm a checkout's mise pins: its mise.lock's, or an exact version in its mise.toml. */
export function pnpmVersion(lock: string | undefined, toml: string | undefined) {
  const locked = lock?.split(/^\[\[tools\.pnpm\]\]$/m)[1]?.match(/^version = "(\d+\.\d+\.\d+)"$/m)?.[1];
  if (locked) return locked;
  return toml?.match(/^pnpm = "(\d+\.\d+\.\d+)"$/m)?.[1];
}

interface Listed {
  from?: string;
  version?: string;
  dependencies?: Record<string, Listed>;
  devDependencies?: Record<string, Listed>;
  optionalDependencies?: Record<string, Listed>;
}

const OWN = /^(link|file|workspace|portal):/;

/** Every package `pnpm list --recursive --depth Infinity --json` names, as `name@version`, the workspace's own left out. */
export function listed(projects: (Listed & { name?: string })[]) {
  const own = new Set(projects.map((project) => project.name));
  const found = new Set<string>();
  const walk = (dependencies: Record<string, Listed> | undefined) => {
    for (const [alias, entry] of Object.entries(dependencies ?? {})) {
      const name = entry.from ?? alias;
      const version = (entry.version ?? '').replace(/\(.*$/, '');
      // A workspace package is not named, but what it depends on is: pnpm lists a package's tree in full at its first
      // place alone, and marks it `deduped` elsewhere, so that first place may be under a workspace link.
      if (!own.has(name) && !OWN.test(version)) found.add(`${name}@${version}`);
      walk(entry.dependencies);
      walk(entry.optionalDependencies);
    }
  };
  for (const project of projects) {
    walk(project.dependencies);
    walk(project.devDependencies);
    walk(project.optionalDependencies);
  }
  return found;
}

interface Component {
  name?: string;
  group?: string;
  version?: string;
  purl?: string;
  components?: Component[];
}

/** Every npm package a CycloneDX SBOM names, as `name@version`. */
export function inSbom(sbom: { components?: Component[] }) {
  const found = new Set<string>();
  const walk = (components: Component[] | undefined) => {
    for (const component of components ?? []) {
      const purl = /^pkg:npm\/(.+)@([^@?#]+)(?:[?#].*)?$/.exec(component.purl ?? '');
      if (purl?.[1] && purl[2]) found.add(`${decodeURIComponent(purl[1])}@${decodeURIComponent(purl[2])}`);
      walk(component.components);
    }
  };
  walk(sbom.components);
  return found;
}

/**
 * The packages pnpm lists that the SBOM does not name. A version that is not a registry's (a tarball's or a git
 * repository's URL) is matched by name alone, as Trivy may write it another way.
 */
export function missing(fromPnpm: Set<string>, fromTrivy: Set<string>) {
  const names = new Set([...fromTrivy].map((entry) => entry.slice(0, entry.lastIndexOf('@'))));
  return [...fromPnpm].filter((entry) => {
    if (fromTrivy.has(entry)) return false;
    const at = entry.lastIndexOf('@');
    return /^\d+\.\d+\.\d+/.test(entry.slice(at + 1)) || !names.has(entry.slice(0, at));
  });
}

export async function main(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const [root] = args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.match(/^--(trivy-pin|out)$/));
  if (!root) {
    console.error(
      'Usage: coverage.ts --pnpm-version <checkout> | coverage.ts <checkout> --trivy-pin <file> --out <dir>',
    );
    return 2;
  }
  const checkout = resolve(root);
  const text = (file: string) => {
    try {
      return readFileSync(join(checkout, file), 'utf-8');
    } catch {
      return undefined;
    }
  };
  if (args.includes('--pnpm-version')) {
    const version = pnpmVersion(text('mise.lock'), text('mise.toml'));
    if (!version) {
      console.error('::error::The checkout names no exact pnpm in mise.lock or mise.toml.');
      return 1;
    }
    console.log(version);
    return 0;
  }
  const pinFile = option('--trivy-pin');
  const out = option('--out');
  const trivy = pinFile ? trivyPin(readFileSync(pinFile, 'utf-8'))?.[1] : undefined;
  if (!trivy || !out) {
    console.error('::error::coverage.ts needs --trivy-pin naming the pinned Trivy, and --out.');
    return 2;
  }
  // The lockfiles on the list, as inventory.ts finds them: each git tracks, outside prose and test fixtures.
  const tracked = await run('git', ['-C', checkout, '-c', 'core.fsmonitor=false', 'ls-files', '-z'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const lockfiles = tracked.stdout
    .split('\0')
    .filter((file) => /(^|\/)pnpm-lock\.yaml$/.test(file) && !isFixture(file))
    .map((file) => ({ file }));
  if (!lockfiles.length) {
    console.error('::error::The list names no lockfile.');
    return 1;
  }
  // No .npmrc of the checkout's: nothing it says chooses a registry, a token or a script. An empty one of ours instead.
  const { stdout } = await run('git', ['-C', checkout, 'ls-files', '-z', '--', '*.npmrc', '.npmrc'], {
    encoding: 'utf-8',
  });
  for (const file of stdout.split('\0').filter(Boolean)) rmSync(join(checkout, file), { force: true });
  const work = mkdtempSync(join(resolve(out), 'coverage-'));
  const npmrc = join(work, 'npmrc');
  writeFileSync(npmrc, '');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: work,
    CI: 'true',
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: npmrc,
    pnpm_config_userconfig: npmrc,
    pnpm_config_globalconfig: npmrc,
    // The pnpm this repository installed, never one the checkout's packageManager names.
    npm_config_manage_package_manager_versions: 'false',
    pnpm_config_manage_package_manager_versions: 'false',
  };

  let failed = false;
  for (const lockfile of lockfiles) {
    const dir = join(checkout, dirname(lockfile.file));
    const alone = mkdtempSync(join(work, 'lockfile-'));
    cpSync(join(checkout, lockfile.file), join(alone, 'pnpm-lock.yaml'));
    try {
      await run(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${alone}:/src:ro`,
          '-v',
          `${work}:/out`,
          trivy,
          'fs',
          '--quiet',
          '--format',
          'cyclonedx',
          '--include-dev-deps',
          '--output',
          `/out/${lockfile.file.replaceAll('/', '_')}.cdx.json`,
          '/src',
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'], {
        cwd: dir,
        env,
        maxBuffer: 64 * 1024 * 1024,
      });
      const list = await run('pnpm', ['list', '--recursive', '--depth', 'Infinity', '--json'], {
        cwd: dir,
        env,
        maxBuffer: 512 * 1024 * 1024,
      });
      const fromPnpm = listed(JSON.parse(list.stdout));
      const fromTrivy = inSbom(
        JSON.parse(readFileSync(join(work, `${lockfile.file.replaceAll('/', '_')}.cdx.json`), 'utf-8')),
      );
      const gone = missing(fromPnpm, fromTrivy);
      console.log(
        `${lockfile.file}: pnpm lists ${fromPnpm.size} packages; Trivy's SBOM of the lockfile names ${fromTrivy.size}; ${gone.length} not in it.`,
      );
      if (!fromPnpm.size || gone.length) {
        failed = true;
        console.error(
          fromPnpm.size
            ? `::error::Trivy does not read all of ${lockfile.file}: ${gone.slice(0, 20).join(', ')}${gone.length > 20 ? ', …' : ''}`
            : `::error::pnpm lists no package from ${lockfile.file}.`,
        );
      }
    } catch (error) {
      failed = true;
      const message = String((error as { stderr?: string }).stderr || (error as Error).message)
        .trim()
        .split('\n')
        .slice(-3)
        .join(' ');
      console.error(`::error::${lockfile.file} could not be compared: ${message}`);
    }
  }
  console.log(failed ? 'Coverage fails.' : 'Trivy reads every package pnpm lists, in every lockfile.');
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
