/**
 * Everything a pin move reads (`PinMoveIO`), and the gate's real readers of it: git, kustomize, yq and Helm from mise,
 * Trivy in its pinned image through Docker, the registries over HTTP, each main's code run on the two commits as data.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type Chart,
  type Item,
  inventory,
  type Unlisted,
  unlisted,
} from '../apps/factory/src/vulnerabilities/inventory.ts';
import {
  API_VERSIONS_RECORD,
  apiVersionsOf,
  DB_MAX_AGE_MS,
  databases,
  kubeVersionOf,
  realTools,
  repositoryOf,
} from '../apps/factory/src/vulnerabilities/scan.ts';
import { trivyPin } from '../apps/factory/src/vulnerabilities/trivy-pin.ts';
import { patchedByTheCheck, ROOT, type Run, type Workload } from './pin-move-ran.ts';
import { type Rewritten, tagAndDigest } from './pin-move-sides.ts';
import { PROFILE, RECORDS, type RecordName, render, taken } from './policy-hash.ts';

/** What a Trivy report says, as far as the rule reads it. */
export interface Scan {
  /** Whether it read anything: a report with no results read nothing, and proves nothing. */
  read: boolean;
  /** Each finding by its advisory and its package's name: where in the image it was found is never part of it. */
  findings: { id: string; pkg: string; path?: string; severity: string; fixed: boolean }[];
}

/** Everything the rule reads, so the tests give it answers instead. Each may throw: a fact not read holds. */
export interface PinMoveIO {
  /** The change from the merge base to the head: git's `--raw` list, and each modified file's text at both commits. */
  diff(): Promise<{ raw: string; files: Rewritten[] }>;
  /** The scan's list, at the merge base or at the head. */
  list(side: Side): Promise<Item[]>;
  /** What the list does not read, at the head. */
  unlisted(): Promise<Unlisted[]>;
  /** Every tag of an image's repository. */
  tags(repository: string): Promise<string[]>;
  /** An image's index digest now, as `scripts/ci-images.sh current` reads one. */
  digest(reference: string): Promise<string>;
  /** A chart's versions in its repository's index. */
  chartVersions(repo: string, chart: string): Promise<string[]>;
  /** A chart rendered with its values from one side's tree. */
  render(side: Side, chart: Chart): Promise<string>;
  /** The overlay the cluster runs, rendered from one side's tree. */
  overlay(side: Side): Promise<string>;
  /** Each refusal record's policy hash, from one side's tree. */
  hashes(side: Side): Promise<Record<string, string>>;
  /** Trivy's report of an image on one platform; one the index does not have is an error, and holds. */
  scan(reference: string, platform: string): Promise<Scan>;
  /** The check runs at the head, each with the workflow that made it (`workflowsOf`). */
  runs(): Promise<Run[]>;
  /** The workloads the platform check's cluster changes from what main runs (`patchedByTheCheck`), main's, or why not. */
  patched(): Promise<Workload[] | string>;
}

export type Side = 'base' | 'head';

// The gate's readers, as review.yml has them: git, kustomize, yq and Helm from mise, Trivy in its pinned image through
// Docker, the registries over HTTP. Each is main's code, run on the two commits as data.

const exec = promisify(execFile);

/** A registry's answer to an image's name, anonymously, with the token it asks for. */
async function registry(repository: string, path: string, accept?: string): Promise<Response> {
  const [first = '', ...rest] = repository.split('/');
  const hosted = repository.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const host = hosted ? first : 'registry-1.docker.io';
  const name = hosted ? rest.join('/') : repository.includes('/') ? repository : `library/${repository}`;
  const url = `https://${host}/v2/${name}/${path}`;
  const get = (token?: string) =>
    fetch(url, {
      headers: { ...(accept ? { accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  // A registry's moment (a 429, a 5xx, a dropped connection) is asked again, as the scan's reads are.
  let answer: Response | undefined;
  for (const wait of [0, 5_000, 15_000]) {
    if (wait) await new Promise((done) => setTimeout(done, wait));
    try {
      answer = await get();
      if (answer.status !== 429 && answer.status < 500) break;
    } catch (error) {
      if (wait === 15_000) throw error;
    }
  }
  if (!answer) throw new Error(`${host} did not answer for ${name}`);
  if (answer.status === 401) {
    const challenge = answer.headers.get('www-authenticate') ?? '';
    const field = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(challenge)?.[1];
    const realm = field('realm');
    if (!realm) throw new Error(`${host} asked for a token, and said nowhere to get one`);
    const query = new URLSearchParams({
      service: field('service') ?? host,
      scope: field('scope') ?? `repository:${name}:pull`,
    });
    const auth = await fetch(`${realm}?${query}`, { signal: AbortSignal.timeout(30_000) });
    if (!auth.ok) throw new Error(`${host} gave no token to read ${name}: ${auth.status}`);
    const body = (await auth.json()) as { token?: string; access_token?: string };
    answer = await get(body.token ?? body.access_token);
  }
  if (!answer.ok) throw new Error(`${host} answered ${answer.status} for ${name}'s ${path.split('?')[0]}`);
  return answer;
}

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface RealOptions {
  repo: string;
  /**
   * The base branch's tip, the merge base and the head, as full SHAs. The move is proved on what the merge makes: the
   * head's change merged onto the tip, against the tip, never against a merge base main has moved on from.
   */
  base: string;
  mergeBase: string;
  head: string;
  /** Where the commits are fetched from: the repository on GitHub, unless a test names a local one. */
  remote?: string;
  /** The check runs at the head, each with the workflow that made it, read through the API by the gate. */
  runs: () => Promise<Run[]>;
}

/**
 * Removes a reader's directory, as far as it can, and never throws: Trivy runs as root in its container and writes its
 * cache there, which a runner's own user cannot then remove (`EACCES` on the directory, as Node names it). What it
 * leaves is in the runner's temp, which goes with the job; a failure to tidy is never a failure to judge. It says
 * what it could not remove, on stderr, so the answers on stdout stay the job's own.
 */
export function removeWork(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error(`left ${dir}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    return false;
  }
}

/** The readers on two commits of `repo`, fetched into a directory of their own, as data. */
export async function realPinMoveIO(options: RealOptions): Promise<PinMoveIO & { close(): void }> {
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'pin-move-'));
  const git = (...args: string[]) =>
    exec('git', ['-C', join(work, 'repo'), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
  mkdirSync(join(work, 'repo'));
  await git('init', '--quiet');
  await git(
    'fetch',
    '--quiet',
    '--depth=1',
    '--no-tags',
    options.remote ?? `https://github.com/${options.repo}.git`,
    ...new Set([options.base, options.mergeBase, options.head]),
  );
  // What the merge makes: the head's change onto the base's tip, from their merge base. A conflict is no move to prove.
  const tree = await git('merge-tree', '--write-tree', `--merge-base=${options.mergeBase}`, options.base, options.head)
    .then(({ stdout }) => stdout.trim().split('\n')[0] ?? '')
    .catch(() => {
      throw new Error(`the head does not merge onto ${options.base.slice(0, 7)} without a conflict`);
    });
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('git wrote no tree of the merge');
  const merged = (
    await git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=pin move',
      '-c',
      'user.email=pin-move@localhost',
      'commit-tree',
      tree,
      '-p',
      options.base,
      '-m',
      'the merge, as data',
    )
  ).stdout.trim();
  const sides: Record<Side, string> = { base: options.base, head: merged };
  const dirs: Record<Side, string> = { base: join(work, 'base'), head: join(work, 'head') };
  await git('worktree', 'add', '--quiet', '--detach', dirs.base, sides.base);
  await git('worktree', 'add', '--quiet', '--detach', dirs.head, sides.head);
  const tools = realTools(trivyImage(), join(work, 'cache'), work);
  mkdirSync(join(work, 'cache'));
  let pulled: Promise<unknown> | undefined;
  // The cluster main describes, read once from the gate's own checkout.
  let cluster: { kubeVersion: string | undefined; apiVersions: string[] } | undefined;
  return {
    close: () => removeWork(work),
    async diff() {
      const raw = (await git('diff', '--raw', '--no-renames', '--no-abbrev', sides.base, sides.head)).stdout;
      // Each modified file's blob at both commits, as bytes git stores: no patch to parse, no filter or driver run.
      const show = async (sha: string, path: string) => (await git('cat-file', 'blob', `${sha}:${path}`)).stdout;
      const files: Rewritten[] = [];
      for (const entry of raw.split('\n').filter((line) => / M\t/.test(line))) {
        const path = entry.split('\t').slice(1).join('\t');
        files.push({ path, before: await show(sides.base, path), after: await show(sides.head, path) });
      }
      return { raw, files };
    },
    list: async (side) => inventory(dirs[side]).items,
    unlisted: async () => unlisted(dirs.head),
    async tags(repository) {
      const tags: string[] = [];
      let path = 'tags/list?n=1000';
      for (let page = 0; page < 50; page++) {
        const answer = await registry(repository, path);
        const body = (await answer.json()) as { tags?: unknown };
        if (!Array.isArray(body.tags)) throw new Error(`${repository}'s registry gave no list of tags`);
        tags.push(...body.tags.filter((t): t is string => typeof t === 'string'));
        const next = /<[^>]*\/v2\/[^>]*\/(tags\/list\?[^>]*)>;\s*rel="next"/.exec(
          answer.headers.get('link') ?? '',
        )?.[1];
        if (!next) return tags;
        path = next;
      }
      throw new Error(`${repository} has more pages of tags than the gate reads`);
    },
    async digest(reference) {
      const { tag } = tagAndDigest(reference);
      if (!tag) throw new Error(`${reference} names no tag`);
      const answer = await registry(repositoryOf(reference), `manifests/${tag}`, MANIFESTS);
      return `sha256:${createHash('sha256')
        .update(Buffer.from(await answer.arrayBuffer()))
        .digest('hex')}`;
    },
    async chartVersions(repo, chart) {
      if (!/^https:\/\/[\w.-]+(\/[\w.~-]+)*\/?$/.test(repo))
        throw new Error(`${repo} is not an HTTPS chart repository`);
      const answer = await fetch(`${repo.replace(/\/$/, '')}/index.yaml`, { signal: AbortSignal.timeout(60_000) });
      if (!answer.ok) throw new Error(`${repo} answered ${answer.status} for its index`);
      const text = await answer.text();
      const child = exec(
        'yq',
        ['eval', '--output-format=json', '--indent=0', '[.entries[strenv(CHART)][] | .version]', '-'],
        {
          env: { ...process.env, CHART: chart },
          maxBuffer: 256 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
        },
      );
      child.child.stdin?.end(text);
      const versions = JSON.parse((await child).stdout) as unknown;
      if (!Array.isArray(versions)) throw new Error(`${repo} lists no versions of ${chart}`);
      return versions.filter((v): v is string => typeof v === 'string');
    },
    // As Argo CD renders it, on the cluster main describes: the k3s main pins and the API versions main's record keeps,
    // never the head's, so a head that changes either renders as main's cluster would run it.
    render: async (side, chart) => {
      cluster ??= (() => {
        const apiVersions = apiVersionsOf(ROOT);
        if (!apiVersions)
          throw new Error(`the gate's checkout keeps no ${API_VERSIONS_RECORD} to render charts as Argo CD does`);
        return { kubeVersion: kubeVersionOf(inventory(ROOT).items), apiVersions };
      })();
      return tools.render(chart, dirs[side], cluster.kubeVersion, cluster.apiVersions);
    },
    async overlay(side) {
      const { stdout } = await exec('kustomize', ['build', join(dirs[side], 'deploy/overlays/local')], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      });
      return stdout;
    },
    hashes: (side) => hashesOf(dirs[side]),
    async scan(reference, platform) {
      pulled ??= databases(tools, trivyImage(), join(work, 'cache'));
      // As the daily scan refuses one: findings read from a stale database prove nothing new is High.
      const age = await pulled;
      if (typeof age !== 'number' || age > DB_MAX_AGE_MS)
        throw new Error(`the advisory database is refused: ${typeof age === 'string' ? age : 'it is too old'}`);
      const { digest } = tagAndDigest(reference);
      const target = digest ? `${repositoryOf(reference)}@${digest}` : reference;
      const report = await tools.retry(() =>
        tools.trivy(['image', '--scanners', 'vuln', '--image-src', 'remote', '--platform', platform, '--', target]),
      );
      const results = report.Results ?? [];
      return {
        read: results.length > 0,
        findings: results.flatMap((result) =>
          (result.Vulnerabilities ?? []).map((v) => ({
            id: v.VulnerabilityID ?? '',
            pkg: v.PkgName ?? '',
            path: v.PkgPath ?? '',
            severity: v.Severity ?? 'UNKNOWN',
            fixed: Boolean(v.FixedVersion),
          })),
        ),
      };
    },
    runs: options.runs,
    patched: async () => patchedByTheCheck(),
  };
}

/**
 * Each refusal record's policy hash, as the gate's own policy-hash.ts (main's) computes it from a tree's deploy/: what
 * a record holds, so a move that changes one stales that record.
 */
export async function hashesOf(root: string): Promise<Record<string, string>> {
  const manifests = render(PROFILE, root);
  return Object.fromEntries(
    (Object.keys(RECORDS) as RecordName[]).map((record) => [record, taken(record, manifests).policyHash]),
  );
}

/** The Trivy image the gate's own checkout pins (deploy/images/trivy/Dockerfile), never the head's. */
function trivyImage() {
  const pinned = trivyPin(readFileSync(join(ROOT, 'deploy/images/trivy/Dockerfile'), 'utf-8'))?.[1];
  if (!pinned) throw new Error("the gate's checkout pins no Trivy it can read");
  return pinned;
}
