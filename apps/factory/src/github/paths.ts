/**
 * Which paths a patch may change, as both the line's scope fence and the GitHub worker read them. The worker checks
 * again what the line checked: the fence is a fast answer, and the worker, which holds the App's key, is the last.
 *
 * A path entry is a file (`src/money.ts`), a folder ending in `/` (`test/`), or a pattern with `*` (one path
 * segment) or `**` (any number). Whatever a scope says, a patch may never change the workflows, the deployment, or a
 * path the repository's CODEOWNERS gives a person.
 */

import { inScope, PATH_CHARS, pattern } from '@software-factory/events';

/** Never in a patch: the rules of the line, in the app's repository. */
export const NEVER = ['.github/', 'deploy/'];

/**
 * A path a patch may name: relative, with no empty, `.` or `..` segment, and no backslash, control character (C1's,
 * U+0080 to U+009F, included), line or paragraph separator, or format character (a bidi override, a zero-width
 * space): any of which a terminal or a page that shows the path could act on, or hide. And no longer than an event
 * records (`PATH_CHARS`), so the line can record what it did with the patch, and matching it to a scope stays cheap.
 */
export function plainPath(path: string): boolean {
  return (
    path.length <= PATH_CHARS &&
    !path.startsWith('/') &&
    !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** Where GitHub looks for a CODEOWNERS file. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/**
 * The scope's path rule (`inScope`, shared with the console, which marks each path a spec's scope allows), and one
 * entry's test of a path (`pattern`).
 */
export { inScope, pattern };

/**
 * The paths a CODEOWNERS file gives anyone, as scope entries, read as GitHub reads them, or more widely where scope
 * entries cannot say it: `/deploy/` is `deploy/`, and an entry with no leading slash matches anywhere. An entry that
 * does not end in `/` names a file or a folder, so `/Dockerfile` is `Dockerfile` and `Dockerfile/`, everything in a
 * folder of that name. `?`, one character, is `*`, and `/` alone is everything.
 */
export function ownedPaths(codeowners: string): string[] {
  return codeowners
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter(Boolean)
    .map((path) => path.replaceAll('?', '*'))
    .map((path) => (path === '/' ? '**' : path.startsWith('/') ? path.slice(1) : `**/${path}`))
    .flatMap((path) => (path.endsWith('/') ? [path] : [path, `${path}/`]));
}

/**
 * The paths no patch may change as a reader is told them, such as in the planner's prompt: each CODEOWNERS entry once,
 * as it reads (`Dockerfile`), without the folder `ownedPaths` matches beside it (`Dockerfile/`). For words only: the
 * checks match every entry.
 */
export const protectedWords = (paths: readonly string[]): string[] =>
  paths.filter((path) => !(path.endsWith('/') && paths.includes(path.slice(0, -1))));

/**
 * The paths no patch may change, as scope entries: the workflows, the deployment, and those a CODEOWNERS file (the
 * first GitHub finds at a commit, or none) gives a person.
 */
export function protectedFrom(codeowners: string | null): string[] {
  return [...new Set([...NEVER, ...ownedPaths(codeowners ?? '')])];
}

/** The lockfiles' names: the pin step writes them, and a patch of an agent's never does (`apps/runner/src/pins.ts`). */
export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'pnpm-lock.*.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'mise.lock',
];
/** The lockfiles, as scope entries: at the root and below it. */
export const LOCKFILES = LOCKFILE_NAMES.flatMap((name) => [name, `**/${name}`]);
/** Where pnpm reads its settings or a resolution's override, which neither an agent nor the pin step writes. */
export const PNPM_SETTINGS = ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.pnpmfile.mjs', 'patches/'].flatMap(
  (entry) => [entry, `**/${entry}`],
);

/**
 * Whether a pnpm lockfile's line resolves something other than a registry package: a tarball, a git source, a
 * folder, or an importer's `link:` or `file:`. pnpm writes a registry package's resolution as its integrity alone. The
 * runner's pin step refuses the same before it prints a lockfile (`registryOnly`); the worker asks again.
 */
export const notFromRegistry = (line: string): boolean =>
  (/\bresolution: \{/.test(line) && (!/\bintegrity: /.test(line) || /\b(tarball|type|repo|directory):/.test(line))) ||
  /^\s+(version|specifier): ['"]?(link|file|git|git\+[a-z]+|https?|npm|github|workspace):/.test(line);

/** Whether a path is a manifest, whose dependencies' ranges the pin step moves. */
const isManifest = (path: string) => path === 'package.json' || path.endsWith('/package.json');

/** Whether a path is a Dockerfile, whose `FROM`s the pin step moves, owned by a person or not. */
const isDockerfile = (path: string) => /(^|\/)(Dockerfile|[^/]+\.Dockerfile)$/.test(path);

/** The paths a unified diff's `diff --git` headers name, before and after. */
export const pathsIn = (patch: string): string[] =>
  [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap(([, a = '', b = '']) => (a === b ? [a] : [a, b]));

/** Whether a unified diff changes a manifest, so the pin step writes the lockfile after it. */
export const changesManifest = (patch: string): boolean => pathsIn(patch).some(isManifest);

/** A version (`24.22.2`, `5.1.0`, a tag's `3.24`) or a SHA-256 digest, as a pin's line names them. */
const PIN_VALUE = /sha256:[0-9a-f]{64}|\d+(?:\.\d+){1,3}/g;

/** A line with its versions and digests taken out: two lines of a pin that moved read the same, and name one. */
const masked = (line: string) => line.replace(PIN_VALUE, '\0');

/**
 * Why a hunk of the pin step's is not a pin's move: each line it removes is replaced by one line, in order, that
 * differs from it only in its versions and digests, and changes one. Nothing when it is.
 */
function notPinLines(lines: readonly string[]): string | undefined {
  let removed: string[] = [];
  let added: string[] = [];
  const pairs: [string, string][] = [];
  const flush = (): string | undefined => {
    if (removed.length !== added.length) return 'adds or removes a line';
    for (const [i, line] of removed.entries()) pairs.push([line, added[i] as string]);
    removed = [];
    added = [];
    return undefined;
  };
  for (const line of lines) {
    if (line.startsWith('-')) {
      if (added.length && flush()) return 'adds or removes a line';
      removed.push(line.slice(1));
    } else if (line.startsWith('+')) added.push(line.slice(1));
    else if (flush()) return 'adds or removes a line';
  }
  if (flush()) return 'adds or removes a line';
  for (const [before, after] of pairs) {
    if (!before.match(PIN_VALUE)) return `changes ${JSON.stringify(before.trim())}, which names no version or digest`;
    if (masked(before) !== masked(after))
      return `changes ${JSON.stringify(before.trim())} to ${JSON.stringify(after.trim())}, not only its version or digest`;
  }
  return undefined;
}

/**
 * Why the pin step's patch may not go on GitHub: the reasons, one for each file, or none. It may change the version or
 * digest on a pin's line in a file a person owns (`owned`, and every manifest), and the lockfiles pnpm writes, whole,
 * and nothing else: never the workflows or the deployment, pnpm's settings, another line, or a file it adds or
 * deletes. A lockfile it writes after the coder (`lockfileOnly`) is a pnpm lockfile and nothing more.
 */
export function pinStepRefusals(
  files: readonly { path: string; change: 'add' | 'modify' | 'delete'; lines: readonly string[][] }[],
  owned: readonly string[],
  { lockfileOnly = false } = {},
): string[] {
  const pnpmLock = ['pnpm-lock.yaml', '**/pnpm-lock.yaml'];
  return files.flatMap(({ path, change, lines }) => {
    if (lockfileOnly && !inScope(path, pnpmLock)) return [`${path}: the lockfile step writes pnpm's lockfile alone`];
    if (inScope(path, [...NEVER, ...PNPM_SETTINGS])) return [`${path}: the pin step never writes it`];
    if (change !== 'modify') return [`${path}: the pin step adds or deletes no file`];
    if (inScope(path, pnpmLock) && !inScope(path, owned)) {
      const resolved = lines.flat().filter((line) => line.startsWith('+') && notFromRegistry(line.slice(1)));
      return resolved.length
        ? [`${path}: the lockfile resolves ${resolved[0]?.slice(1).trim()}, not a registry package`]
        : [];
    }
    if (!inScope(path, owned) && !isManifest(path) && !isDockerfile(path))
      return [`${path}: the pin step writes pins, ranges and lockfiles alone`];
    const why = lines.map(notPinLines).find(Boolean);
    return why ? [`${path}: the pin step ${why}`] : [];
  });
}

/** A manifest's fields whose ranges pin what is installed: the only ones the pin step's change to a manifest moves. */
const PINNED_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** One comparator of a range of the registry's versions, as the runner reads them (`apps/runner/src/pins.ts`). */
const COMPARATOR = /^(?:[\^~]|[<>]=?|=)?\d+(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const registryRange = (spec: unknown): boolean =>
  typeof spec === 'string' &&
  (spec.trim() === '*' ||
    spec.split('||').every(
      (part) =>
        part.trim() !== '' &&
        part
          .trim()
          .split(/\s+/)
          .every((t) => COMPARATOR.test(t)),
    ));

/**
 * Why the pin step's change to a manifest is not a move of dependencies' ranges, read as JSON: every field but the
 * pinned ones is as it was, no dependency is added or removed, and each range it moves is a range of the registry's.
 * Nothing when it is.
 */
export function manifestRefusals(path: string, before: string, after: string): string[] {
  let was: Record<string, unknown>;
  let now: Record<string, unknown>;
  try {
    was = JSON.parse(before) as Record<string, unknown>;
    now = JSON.parse(after) as Record<string, unknown>;
  } catch {
    return [`${path}: the pin step leaves a manifest that is not JSON`];
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const fields = [...new Set([...Object.keys(was), ...Object.keys(now)])];
  const moved = fields.filter((field) => !PINNED_FIELDS.includes(field) && !same(was[field], now[field]));
  if (moved.length) return [`${path}: the pin step changes ${moved.join(', ')}, which pins no dependency`];
  return PINNED_FIELDS.flatMap((field) => {
    const a = (was[field] ?? {}) as Record<string, unknown>;
    const b = (now[field] ?? {}) as Record<string, unknown>;
    if (!same(Object.keys(a).sort(), Object.keys(b).sort()))
      return [`${path}: the pin step adds or removes a dependency`];
    return Object.keys(b)
      .filter((name) => a[name] !== b[name] && !registryRange(b[name]))
      .map((name) => `${path}: the pin step gives ${name} ${JSON.stringify(b[name])}, not a range of the registry's`);
  });
}
