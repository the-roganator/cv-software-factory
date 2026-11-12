/**
 * The repository's open Dependabot pull requests, each with the pin and version its branch names, so a move can tell
 * whether Dependabot is already moving its pin (task 33's pin watch does not fight it).
 *
 * Dependabot names a branch `dependabot/<ecosystem>/<directory>/<dependency>-<version>`, the directory left out at the
 * root, and a scoped npm package without its `@`: `dependabot/npm_and_yarn/grpc/grpc-js-1.14.7` is `@grpc/grpc-js`
 * at 1.14.7 in `/`. A group's branch names the group and a hash instead (`dependabot/npm_and_yarn/tooling-7ddd2f2d32`,
 * and `dependabot/<group>-<hash>` for a group across ecosystems), and names no pin, so its pins are read from its
 * changes instead: each line its files rewrite in place, at its place in the base, with the text before and after
 * (`changed`), which a move's pins are matched against (`groupMovesTo`). A file whose patch GitHub does not send (too
 * large to show) is named in `unread`, so a reader knows it cannot tell what moves there. The directory and the
 * dependency are told apart by the directories `.github/dependabot.yml` names on the default branch, the longest
 * first. Only a pull request Dependabot opened, from a branch of its own in the repository, is listed; its title and
 * body, which are Dependabot's prose, are never read.
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
  /** For a group's, which names no pin: each line its files rewrite in place. Empty for any other. */
  changed: ChangedLine[];
  /** For a group's: the files it changes whose patch GitHub did not send, where what moves cannot be read. */
  unread: string[];
}

/** A line a pull request rewrites in place: its file, its number in the base, and its text before and after. */
export interface ChangedLine {
  file: string;
  line: number;
  before: string;
  after: string;
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
        groups: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});

/** What `dependabot.yml` says of each ecosystem: the directories it names, as it writes them, and its groups. */
export interface Ecosystems {
  directories: Map<string, string[]>;
  groups: Map<string, Set<string>>;
  /** Whether the repository has a `dependabot.yml`: without one, only the root is read. */
  read: boolean;
}

/** Each ecosystem's directories and groups, from `dependabot.yml`'s text; none from a file that is not its shape. */
export function ecosystemsOf(text: string | null): Ecosystems {
  const out: Ecosystems = { directories: new Map(), groups: new Map(), read: text !== null };
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
    const ecosystem = entry['package-ecosystem'];
    const dirs = out.directories.get(ecosystem) ?? [];
    dirs.push(...(entry.directory ? [entry.directory] : []), ...(entry.directories ?? []));
    out.directories.set(ecosystem, dirs);
    const groups = out.groups.get(ecosystem) ?? new Set();
    for (const group of Object.keys(entry.groups ?? {})) groups.add(group);
    out.groups.set(ecosystem, groups);
  }
  return out;
}

/** A version: a digit first, as Dependabot writes one, and no spaces. */
const VERSION = /^v?\d[0-9A-Za-z.+_-]*$/;
/** A dependency's name as a branch writes it. */
const NAME = /^[0-9A-Za-z][0-9A-Za-z._/-]*$/;
/** A group's branch: its name and ten hex digits of a hash. */
const GROUP = /^([0-9A-Za-z._-]+)-([0-9a-f]{10})$/;

const none = { directory: null, dependency: null, version: null };

/** A directory as a glob matches the start of a branch's path, as `dependabot.yml` takes one. */
const globStart = (written: string) =>
  new RegExp(
    `^${written
      .split(/(\*\*|\*)/)
      .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('')}/`,
  );

/**
 * A branch's last part as a dependency and its version: split at the last hyphen before a digit whose version has a
 * dot (`utf-8-validate-6.0.5`, `node-24.11.0-trixie-20251110`), or else the last hyphen before a digit.
 */
function nameAndVersion(tail: string): [string, string] | undefined {
  const splits = [...tail.matchAll(/-(?=v?\d)/g)].map((m) => m.index);
  const at = splits.findLast((i) => tail.slice(i + 1).includes('.')) ?? splits.at(-1);
  if (at === undefined || at === 0) return undefined;
  return [tail.slice(0, at), tail.slice(at + 1)];
}

/** The pin and version a Dependabot branch names, or nulls for a group's or one this cannot read for sure. */
export function branchPin(
  ref: string,
  ecosystems: Ecosystems,
): Pick<DependencyPull, 'ecosystem' | 'directory' | 'dependency' | 'version'> {
  const [prefix, written, ...rest] = ref.split('/');
  const ecosystem = written === undefined ? undefined : ECOSYSTEMS[written];
  if (prefix !== 'dependabot' || !ecosystem || !rest.length) return { ecosystem: ecosystem ?? null, ...none };
  const path = rest.join('/');
  // An ecosystem a `dependabot.yml` does not name has no directory it is sure of; with no file, only the root.
  const named = (ecosystems.directories.get(ecosystem) ?? (ecosystems.read ? [] : ['/'])).map((dir) => ({
    dir,
    written: dir.replace(/^\/+|\/+$/g, ''),
  }));
  // A directory named by a glob could be any of several: one the branch may be under is not read.
  if (named.some(({ written }) => written.includes('*') && globStart(written).test(path)))
    return { ecosystem, ...none };
  // The longest directory the branch begins with; the root's is written as nothing, and only matches when named.
  const found = named
    .filter(({ written }) => !written.includes('*'))
    .sort((a, b) => b.written.length - a.written.length)
    .find(({ written }) => written === '' || path.startsWith(`${written}/`));
  if (!found) return { ecosystem, ...none };
  const tail = found.written ? path.slice(found.written.length + 1) : path;
  const group = GROUP.exec(tail);
  // A group's: one `dependabot.yml` names, or (with `group-by`, or across ecosystems) a hash with a letter in it.
  if (group && (ecosystems.groups.get(ecosystem)?.has(group[1] ?? '') || /[a-f]/.test(group[2] ?? '')))
    return { ecosystem, ...none };
  const [name, version] = nameAndVersion(tail) ?? [];
  if (!name || !version || !NAME.test(name) || !VERSION.test(version)) return { ecosystem, ...none };
  const dependency = ecosystem === 'npm' && name.includes('/') ? `@${name}` : name;
  return { ecosystem, directory: found.dir, dependency, version };
}

/** The most open pull requests read: ten pages. */
const PAGES = 10;
/** The most files of one pull request read: GitHub lists 3,000 at most. */
const FILE_PAGES = 30;

const FILES = z.array(
  z.object({
    filename: z.string(),
    status: z.string(),
    patch: z.string().optional(),
  }),
);

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines a patch rewrites in place, by their numbers in the base: a run of removed lines followed by as many added
 * ones, paired in order. A run that adds or removes lines rather than rewriting them is not a pin's, and is left out.
 */
export function rewrittenLines(file: string, patch: string): ChangedLine[] {
  const out: ChangedLine[] = [];
  let base = 0;
  let removed: { line: number; text: string }[] = [];
  let added: string[] = [];
  const flush = () => {
    if (removed.length && removed.length === added.length)
      for (const [i, was] of removed.entries())
        out.push({ file, line: was.line, before: was.text, after: added[i] as string });
    removed = [];
    added = [];
  };
  for (const text of patch.split('\n')) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      flush();
      base = Number(hunk[1]);
      continue;
    }
    if (text.startsWith('\\')) continue;
    if (text.startsWith('-')) {
      // A removed line after added ones starts a new run.
      if (added.length) flush();
      removed.push({ line: base, text: text.slice(1) });
      base++;
    } else if (text.startsWith('+')) added.push(text.slice(1));
    else {
      flush();
      base++;
    }
  }
  flush();
  return out;
}

const WORDS = /[A-Za-z0-9._+-]+/g;
const VERSION_WORD = /^v?\d+(\.\d+)*([-+][A-Za-z0-9.+-]*)?$/;

const DIGESTS = /sha256:[0-9a-f]{64}/g;

/**
 * Where a group's pull request moves a pin, from the line it rewrites at the pin's place: the first word that changes
 * and is a version (`FROM ghcr.io/anchore/syft:v1.54.0@sha256:…` to `…:v1.57.1@sha256:…` is `v1.57.1`), read only when
 * the line's words line up, and every digest the line has after that it did not have before, read whatever the words
 * do (a digest-only move has no version; a line that gains a digest has a word more). Nothing when it rewrites no line
 * there, or moves neither.
 */
export function groupMovesTo(
  pull: Pick<DependencyPull, 'changed'>,
  pin: { file: string; line: number },
): { version: string | undefined; digests: string[] } | undefined {
  const line = pull.changed.find((each) => each.file === pin.file && each.line === pin.line);
  if (!line) return undefined;
  const [was, now] = [line.before.match(WORDS) ?? [], line.after.match(WORDS) ?? []];
  const version =
    was.length === now.length ? now.find((word, i) => word !== was[i] && VERSION_WORD.test(word)) : undefined;
  const before = new Set(line.before.match(DIGESTS) ?? []);
  const digests = (line.after.match(DIGESTS) ?? []).filter((each) => !before.has(each));
  return version === undefined && !digests.length ? undefined : { version, digests };
}

/** What a group's pull request changes, from its files' patches. */
async function changesOf(github: GitHub, repo: string, number: number) {
  const changed: ChangedLine[] = [];
  const unread: string[] = [];
  for (let page = 1; page <= FILE_PAGES; page++) {
    const { body } = await github.poll(repo, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, FILES);
    for (const file of body) {
      if (file.patch === undefined) unread.push(file.filename);
      else changed.push(...rewrittenLines(file.filename, file.patch));
    }
    if (body.length < 100) return { changed, unread };
  }
  throw new GitHubError(
    'malformed',
    `${repo}#${number} changes more files than GitHub lists: what it moves is not read.`,
  );
}

export async function dependencyPulls(
  github: GitHub,
  repo: string,
  /** `.github/dependabot.yml` on the default branch, or null where there is none. */
  config: () => Promise<string | null>,
): Promise<DependencyPull[]> {
  const out: DependencyPull[] = [];
  let ecosystems: Ecosystems | undefined;
  // One page past the most read, to tell exactly that many from more.
  for (let page = 1; page <= PAGES + 1; page++) {
    const { body } = await github.poll(repo, `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, PULLS);
    if (page > PAGES && body.length) break;
    for (const pull of body) {
      if (pull.user?.login !== DEPENDABOT || pull.head.repo?.full_name !== repo) continue;
      if (!pull.head.ref.startsWith('dependabot/')) continue;
      ecosystems ??= ecosystemsOf(await config());
      const named = branchPin(pull.head.ref, ecosystems);
      // A branch that names no pin is read by what it changes.
      const changes = named.dependency === null ? await changesOf(github, repo, pull.number) : undefined;
      out.push({
        number: pull.number,
        head: { ref: pull.head.ref, sha: pull.head.sha },
        draft: pull.draft ?? false,
        createdAt: pull.created_at,
        ...named,
        changed: changes?.changed ?? [],
        unread: changes?.unread ?? [],
      });
    }
    if (body.length < 100) return out.sort((a, b) => a.number - b.number);
  }
  throw new GitHubError(
    'malformed',
    `${repo} has more than ${PAGES * 100} open pull requests: its Dependabot ones are not all read.`,
  );
}
