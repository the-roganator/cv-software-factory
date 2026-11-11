/**
 * The repository's open Dependabot pull requests, each with the pin and version its branch names, so a move can tell
 * whether Dependabot is already moving its pin (task 33's pin watch does not fight it).
 *
 * Dependabot names a branch `dependabot/<ecosystem>/<directory>/<dependency>-<version>`, the directory left out at the
 * root, and a scoped npm package without its `@`: `dependabot/npm_and_yarn/grpc/grpc-js-1.14.7` is `@grpc/grpc-js`
 * at 1.14.7 in `/`. A group's branch names the group and a hash instead (`dependabot/npm_and_yarn/tooling-7ddd2f2d32`,
 * and `dependabot/<group>-<hash>` for a group across ecosystems), and names no pin: it is listed with none. The
 * directory and the dependency are told apart by the directories `.github/dependabot.yml` names on the default branch,
 * the longest first. Only a pull request Dependabot opened, from a branch of its own in the repository, is listed; its
 * title and body, which are Dependabot's prose, are never read.
 */
import { parse } from 'yaml';
import { z } from 'zod';
import { type GitHub, GitHubError } from './client.ts';

export interface DependencyPull {
  number: number;
  head: { ref: string; sha: string };
  draft: boolean;
  createdAt: string;
  /** The ecosystem as `dependabot.yml` names it (`npm`, `docker`, `github-actions`…), when the branch names one. */
  ecosystem: string | null;
  /** The pin its branch names: the directory, as `dependabot.yml` writes it, and the dependency; null for a group's. */
  directory: string | null;
  dependency: string | null;
  /** The version it moves the pin to, as the branch names it; null for a group's. */
  version: string | null;
}

/** Dependabot's account, which alone opens its pull requests. */
export const DEPENDABOT = 'dependabot[bot]';

/** How Dependabot writes each ecosystem in a branch, and how `dependabot.yml` names it. */
const ECOSYSTEMS: Record<string, string> = {
  npm_and_yarn: 'npm',
  github_actions: 'github-actions',
  docker: 'docker',
  devcontainers: 'devcontainers',
  bundler: 'bundler',
  cargo: 'cargo',
  composer: 'composer',
  gomod: 'gomod',
  pip: 'pip',
  terraform: 'terraform',
};

const SHA = z.string().regex(/^[0-9a-f]{40}$/);

const PULLS = z.array(
  z.object({
    number: z.number().int().positive(),
    draft: z.boolean().optional(),
    created_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
    head: z.object({ ref: z.string(), sha: SHA, repo: z.object({ full_name: z.string() }).nullable() }),
  }),
);

const CONFIG = z.object({
  updates: z
    .array(
      z.object({
        'package-ecosystem': z.string(),
        directory: z.string().optional(),
        directories: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/** The directories `dependabot.yml` names for each ecosystem, as it writes them. */
export type Directories = Map<string, string[]>;

/** The directories of each ecosystem, from `dependabot.yml`'s text; none from a file that is not its shape. */
export function directoriesOf(text: string | null): Directories {
  const out: Directories = new Map();
  if (!text) return out;
  let config: z.infer<typeof CONFIG>;
  try {
    const parsed = CONFIG.safeParse(parse(text));
    if (!parsed.success) return out;
    config = parsed.data;
  } catch {
    return out;
  }
  for (const entry of config.updates ?? []) {
    const list = out.get(entry['package-ecosystem']) ?? [];
    list.push(...(entry.directory ? [entry.directory] : []), ...(entry.directories ?? []));
    out.set(entry['package-ecosystem'], list);
  }
  return out;
}

/** A version: a digit first, as Dependabot writes one, and no spaces. */
const VERSION = /^v?\d[0-9A-Za-z.+_-]*$/;
/** A dependency's name as a branch writes it. */
const NAME = /^[0-9A-Za-z][0-9A-Za-z._/-]*$/;
/** A group's branch: its name and ten hex digits of a hash, at least one a letter. */
const GROUP = /^[0-9A-Za-z._-]+-(?=[0-9a-f]*[a-f])[0-9a-f]{10}$/;

const none = { directory: null, dependency: null, version: null };

/** The pin and version a Dependabot branch names, or nulls for a group's or one this cannot read. */
export function branchPin(
  ref: string,
  directories: Directories,
): Pick<DependencyPull, 'ecosystem' | 'directory' | 'dependency' | 'version'> {
  const [prefix, written, ...rest] = ref.split('/');
  const ecosystem = written === undefined ? undefined : ECOSYSTEMS[written];
  if (prefix !== 'dependabot' || !ecosystem || !rest.length) return { ecosystem: ecosystem ?? null, ...none };
  const path = rest.join('/');
  // The longest directory the branch begins with; the root's is written as nothing.
  const dirs = (directories.get(ecosystem) ?? ['/'])
    .map((dir) => ({ dir, written: dir.replace(/^\/+|\/+$/g, '') }))
    .filter(({ written }) => !written.includes('*'))
    .sort((a, b) => b.written.length - a.written.length);
  const found = dirs.find(({ written }) => written === '' || path.startsWith(`${written}/`));
  if (!found) return { ecosystem, ...none };
  const tail = found.written ? path.slice(found.written.length + 1) : path;
  if (GROUP.test(tail)) return { ecosystem, ...none };
  const m = /^(.+?)-(v?\d.*)$/.exec(tail);
  const [, name, version] = m ?? [];
  if (!name || !version || !NAME.test(name) || !VERSION.test(version)) return { ecosystem, ...none };
  const dependency = ecosystem === 'npm' && name.includes('/') ? `@${name}` : name;
  return { ecosystem, directory: found.dir, dependency, version };
}

/** The most open pull requests read: ten pages. */
const PAGES = 10;

export async function dependencyPulls(
  github: GitHub,
  repo: string,
  /** `.github/dependabot.yml` on the default branch, or null where there is none. */
  config: () => Promise<string | null>,
): Promise<DependencyPull[]> {
  const out: DependencyPull[] = [];
  let directories: Directories | undefined;
  for (let page = 1; page <= PAGES; page++) {
    const { body } = await github.poll(repo, `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, PULLS);
    for (const pull of body) {
      if (pull.user?.login !== DEPENDABOT || pull.head.repo?.full_name !== repo) continue;
      if (!pull.head.ref.startsWith('dependabot/')) continue;
      directories ??= directoriesOf(await config());
      out.push({
        number: pull.number,
        head: { ref: pull.head.ref, sha: pull.head.sha },
        draft: pull.draft ?? false,
        createdAt: pull.created_at,
        ...branchPin(pull.head.ref, directories),
      });
    }
    if (body.length < 100) return out.sort((a, b) => a.number - b.number);
  }
  throw new GitHubError(
    'malformed',
    `${repo} has more than ${PAGES * 100} open pull requests: its Dependabot ones are not all read.`,
  );
}
