/**
 * The pin watch's guard (`pins.ts`): what lets a commit onto `factory/pin/<files>` replace the version or digest at each
 * pin of the moves it carries, and write the files the scan's pin step made for them where a move writes them, and
 * refuses everything else. It is the guard, not the watch's good behaviour, that holds "nothing
 * else": `commitPins` is the one action that writes a pin branch (`branches.ts`), and it writes only what this gives
 * back, worked out here from the repository itself, never from the file text its caller read.
 *
 * A commit is let through only when all of these hold, and refused, before GitHub is asked to write, otherwise:
 *
 * - **Its branch** is `factory/pin/<files>`, one plain segment made from the files its moves pin (`pinBranchFor`):
 *   nothing that could reach outside it.
 * - **Its pins** are at most `MAX_PINS`, no two at one line, each in a plain path (`plainPath`), none under `.github/` or
 *   `policy/`, in a lockfile, or in mise's files, which only the pin step writes (below).
 * - **Each pin's file** is an ordinary file in the tree of `main`'s head, as git's own tree names it (a symbolic link,
 *   a submodule or a folder is refused), and of the commit the scan read.
 * - **Each pin's line** is the same at `main`'s head as at the commit the scan read: a line that has changed since
 *   is not the pin the scan named.
 * - **What it pins** before and after is a version, or a tag and its digest, as the scan's grammar writes a target
 *   (`fixes.ts`'s `readTarget`), the same shape on both sides, and different.
 * - **The line** holds what it pins before exactly once, as a word of its own, and the commit's line is that line with
 *   that span alone replaced.
 *
 * A move no pin's line writes (a lockfile's package, what mise pins) is made by the pin step in the scan's run, and
 * its commit carries the files that step wrote, whole (github/made.ts). The guard cannot make them itself, and holds
 * each to what a move writes in it:
 *
 * - **Each such file** is one the step writes (`madeFile`): a pnpm lockfile, a manifest, mise's two files, or a
 *   Dockerfile whose `FROM`s an image's move writes with what it brings; of the files CODEOWNERS gives a person, only
 *   mise's and a pin's place (`ownedPinPlace`); never under `.github/` or `policy/`, and never a file the commit's edits
 *   also write.
 * - **It is the same** at `main`'s head as at the commit the scan made it on, an ordinary file in both, and the commit
 *   changes it.
 * - **What changes** is what a move writes there (`madeRefusal`), and nothing that runs: a Dockerfile's `FROM`s, a
 *   manifest's ranges, a lockfile's registry packages, `mise.toml`'s Node, `mise.lock`'s tools' entries. Which
 *   versions they move to is the scan's, which the review gate makes again on main and compares, byte for byte,
 *   before anything merges.
 *
 * `main`'s head is read here, and a commit is made on it alone: one that moved since the watch read it is no refusal,
 * the watch tries again on its next pass.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readTarget } from '../vulnerabilities/fixes.ts';
import { DIGEST, splitReference } from '../vulnerabilities/reference.ts';
import { BranchRefused, PIN_NEXT_PREFIX, PIN_PREFIX } from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import { PatchRefused } from './patches.ts';
import {
  CODEOWNERS_PATHS,
  inScope,
  LOCKFILES,
  manifestRefusals,
  notFromRegistry,
  plainPath,
  protectedFrom,
} from './paths.ts';

/** One pin a commit moves: where it is, and the text it pins before and after (`2.14.2@sha256:…`, `13.7.0`). */
export interface PinEdit {
  file: string;
  line: number;
  from: string;
  to: string;
}

/** A pin pull request's commit, as the watch asks for it: every pin of the moves it carries. */
export interface PinCommit {
  /** `factory/pin/<files>`. */
  branch: string;
  /** `main`'s head as the watch read it: the commit is made on it, and refused as stale if `main` has moved. */
  base: string;
  /** The commit the scan read, whose lines the pins must still be. */
  scanned: string;
  message: string;
  pins: PinEdit[];
  /**
   * The files the scan's pin step wrote for the moves it carries that no pin's line writes (github/made.ts), whole: a
   * lockfile, a manifest whose range moved, mise's two files. None for a pull request of edits alone.
   */
  files?: { path: string; text: string }[] | undefined;
}

const DOCKERFILE = /(^|\/)(Dockerfile(\.(?!dockerignore$)[a-z]+)?|[^/]+\.Dockerfile)$/;

/**
 * Whether a file is one the scan's pin step writes for a move: a pnpm lockfile, a manifest whose range a package's move
 * moves, mise's `mise.toml` and `mise.lock` at the root, which a move of what mise pins writes (the App may write
 * them for a move, and nothing else does but `mise upgrade`), or a Dockerfile, whose `FROM`s an image's move writes
 * with the Node or the library it brings.
 */
export const madeFile = (path: string): boolean =>
  /(^|\/)(pnpm-lock\.yaml|package\.json)$/.test(path) ||
  path === 'mise.toml' ||
  path === 'mise.lock' ||
  DOCKERFILE.test(path);

/** A Dockerfile's `FROM` that pins an image by its tag and digest, in parts, as the pin step reads one. */
const FROM =
  /^(\s*FROM\s+(?:--platform=\S+\s+)?)([^\s:@/]+(?::\d+)?(?:\/[^\s:@/]+)*):([\w][\w.-]{0,127})@(sha256:[0-9a-f]{64})(.*)$/i;

/** `mise.toml`'s pin of Node, the one line of it a move writes: an exact release. */
const NODE_PIN = /^node\s*=\s*"\d+\.\d+\.\d+"\s*$/;

/** The lines two texts of one file differ at, each line of one against the same line of the other, by place; or why not. */
function changedLines(before: string, after: string): [number, string, string][] | string {
  const [was, now] = [before.split('\n'), after.split('\n')];
  if (was.length !== now.length) return 'adds or removes a line';
  return was.flatMap((line, i) => (line === now[i] ? [] : [[i, line, now[i] as string] as [number, string, string]]));
}

/** The table of a TOML file a line is in: the nearest header at or above it, or none at the top. */
const tableAt = (lines: readonly string[], at: number): string | undefined => {
  for (let i = at; i >= 0; i--) if (/^\s*\[/.test(lines[i] ?? '')) return (lines[i] as string).trim();
  return undefined;
};

/** `mise.lock` in its entries: what comes before the first, and each tool's, by the header that starts it. */
function entriesOf(lock: string): { head: string; entries: { header: string; text: string }[] } {
  // A split before the text's first character makes no part, so an entry at the top has nothing before it.
  const [head = '', ...rest] = `\n${lock}`.split(/^(?=\[\[)/m);
  return { head: head.slice(1), entries: rest.map((text) => ({ header: text.split('\n')[0] as string, text })) };
}

/**
 * Where a tool's entry downloads from: each address in it as a client reads it (`..` resolved, the host in lower
 * case), up to what names the release, its version, or for an address that names none (an asset's number) its last
 * part. So a move may change the release an address names, never the repository or the place it is fetched from.
 */
const sources = (entry: string) => {
  const version = /^version\s*=\s*"([^"]+)"/m.exec(entry)?.[1];
  return new Set(
    [...entry.matchAll(/\bhttps?:\/\/[^\s"']+/g)].map(([address]) => {
      if (!URL.canParse(address)) return address;
      const { href } = new URL(address);
      const at = version ? href.indexOf(version) : -1;
      return at >= 0 ? href.slice(0, at) : href.slice(0, href.lastIndexOf('/') + 1);
    }),
  );
};

/**
 * Why a change to `mise.lock` is not a move of what it pins, or nothing: every entry is a tool's, the same tools in
 * the same order, and what is before them as it was; each entry that changes keeps its tool's own sections, its
 * backend, and its downloads where they were.
 */
function miseLockRefusal(before: string, after: string): string | undefined {
  const [was, now] = [entriesOf(before), entriesOf(after)];
  if (was.head !== now.head) return 'changes what is before its tools’ entries';
  const headers = (lock: typeof was) => JSON.stringify(lock.entries.map((entry) => entry.header));
  if (headers(was) !== headers(now)) return 'adds, removes or reorders a tool’s entry';
  for (const [i, entry] of now.entries.entries()) {
    const old = was.entries[i] as (typeof was.entries)[number];
    if (old.text === entry.text) continue;
    const tool = /^\[\[tools\.((?:"[^"]+"|[\w.-]+?))\]\]$/.exec(entry.header)?.[1];
    if (!tool) return `changes ${JSON.stringify(entry.header)}, which is no tool’s entry`;
    const header = entry.text
      .split('\n')
      .slice(1)
      .find((line) => /^\s*\[/.test(line) && !line.startsWith(`[tools.${tool}.`));
    if (header) return `gives ${tool}’s entry ${JSON.stringify(header.trim())}, which is not its own`;
    const backend = (text: string) => text.split('\n').filter((line) => /^\s*backend\s*=/.test(line));
    if (JSON.stringify(backend(old.text)) !== JSON.stringify(backend(entry.text))) return `changes ${tool}’s backend`;
    const from = sources(old.text);
    const elsewhere = [...sources(entry.text)].find((source) => !from.has(source));
    if (elsewhere) return `downloads ${tool} from ${elsewhere}, where it did not`;
  }
  return undefined;
}

/**
 * Why a file the pin step wrote is not what a move writes in it, or nothing: in a Dockerfile, a `FROM`'s tag and digest
 * alone; in a manifest, its dependencies' ranges (`manifestRefusals`); in a pnpm lockfile, no line added that resolves
 * anything but a registry's package; in `mise.toml`, its pin of Node; in `mise.lock`, what each tool's entry pins. A
 * script, a `RUN`, an `[env]` or a hook, each of which runs, is none of them.
 */
export function madeRefusal(path: string, before: string, after: string): string | undefined {
  if (DOCKERFILE.test(path)) {
    const changed = changedLines(before, after);
    if (typeof changed === 'string') return changed;
    for (const [, was, now] of changed) {
      const [a, b] = [FROM.exec(was), FROM.exec(now)];
      if (!a || !b || a[1] !== b[1] || a[2] !== b[2] || a[5] !== b[5])
        return `changes ${JSON.stringify(was.trim())}, which is not an image’s tag and digest at a FROM`;
    }
    return undefined;
  }
  if (/(^|\/)package\.json$/.test(path)) return manifestRefusals(path, before, after)[0];
  if (/(^|\/)pnpm-lock\.yaml$/.test(path)) {
    const had = new Map<string, number>();
    for (const line of before.split('\n')) had.set(line, (had.get(line) ?? 0) + 1);
    for (const line of after.split('\n')) {
      const left = had.get(line) ?? 0;
      if (left) had.set(line, left - 1);
      else if (notFromRegistry(line)) return `resolves ${JSON.stringify(line.trim())}, not a registry’s package`;
    }
    return undefined;
  }
  if (path === 'mise.toml') {
    const changed = changedLines(before, after);
    if (typeof changed === 'string') return changed;
    const lines = after.split('\n');
    for (const [at, was, now] of changed) {
      if (!NODE_PIN.test(was) || !NODE_PIN.test(now) || tableAt(lines, at) !== '[tools]')
        return `changes ${JSON.stringify(was.trim())}, which is not its pin of Node`;
    }
    return undefined;
  }
  if (path === 'mise.lock') return miseLockRefusal(before, after);
  return 'is not a file the scan’s pin step writes';
}

/** A file as git's tree has it at a commit: its mode, and its text. */
export interface TreeFile {
  mode: string;
  text: string;
}

/** What the guard reads of the repository: `main`'s head, and a file in a commit's tree, or null if it is not there. */
export interface PinSource {
  head(repo: string): Promise<string>;
  file(repo: string, ref: string, path: string): Promise<TreeFile | null>;
}

/** The most pins one pull request writes: a few images, each in every Dockerfile that runs it. */
export const MAX_PINS = 40;

/** A pin branch's one segment: lower case, of letters, digits, dots and dashes. */
const SEGMENT = /^[a-z0-9](?:[a-z0-9-]|\.(?!\.))*[a-z0-9]$|^[a-z0-9]$/;
const MAX_SEGMENT = 80;

/** A text made a plain segment of at most `most` characters: `docker.io/library/postgres` is `docker.io-library-postgres`. */
export function segmentOf(text: string, most = MAX_SEGMENT): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, most)
    .replace(/[-.]+$/, '');
}

/**
 * The branch of the pull request that carries the day's moves at these files: the first file's path, for whoever reads
 * it, and a digest of them all, so no two sets of files share a branch whatever their paths fold or are cut to.
 * `deploy/base/postgres/statefulset.yaml` is `factory/pin/deploy-base-postgres-statefulset.yaml-<8 hex>`. The moves the
 * review gate names `major` are on a branch of their own, marked so.
 */
export function pinBranchFor(files: readonly string[], major = false): string {
  const sorted = [...new Set(files)].sort();
  const digest = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 8);
  // The path is cut so the whole is one segment the guard takes, with `-major-` and the digest after it.
  const path = segmentOf(sorted[0] ?? '', MAX_SEGMENT - 15);
  return `${PIN_PREFIX}${[path, ...(major ? ['major'] : []), digest].filter(Boolean).join('-')}`;
}

/** Where a pin branch's commit is made before the branch moves to it. */
export const pinNextBranch = (branch: string) => `${PIN_NEXT_PREFIX}${branch.slice(PIN_PREFIX.length)}`;

/** Throws `BranchRefused` unless a branch is a pin pull request's own: `factory/pin/` and one plain segment. */
export function guardPinBranch(branch: string): void {
  const segment = branch.startsWith(PIN_PREFIX) ? branch.slice(PIN_PREFIX.length) : undefined;
  if (segment === undefined || segment.length > MAX_SEGMENT || !SEGMENT.test(segment) || segment.endsWith('.lock')) {
    throw new BranchRefused(
      `${branch} is not a pin move's branch: ${PIN_PREFIX} and one segment of letters, digits, dots and dashes.`,
    );
  }
}

/** The files no pin move writes, by name: a workflow's, the policies', a lockfile, mise's, the Makefile. */
export function forbiddenPin(file: string): string | undefined {
  if (file.startsWith('.github/')) return 'a pin under .github/ is a workflow’s, and the App writes none';
  if (file.startsWith('policy/')) return 'policy/ holds the rules of the line, which no pin move writes';
  if (file === 'Makefile') return 'the Makefile’s pins move with the toolchain, by hand';
  if (/(^|\/)\.?mise(\.[\w-]+)?\.(toml|lock)$/.test(file))
    return 'mise’s files are written by the scan’s pin step, whole, never edited at a line';
  if (inScope(file, LOCKFILES)) return 'a lockfile is written by the scan’s pin step, whole, never edited at a line';
  return undefined;
}

/**
 * Whether a file CODEOWNERS gives a person (as `paths.ts` reads it) may hold a pin the watch moves: one under `deploy/`,
 * where the cluster's pins are, or a `Dockerfile`'s. Any other such file (the worker's code, the gate's scripts,
 * `AGENTS.md`, a config) holds the rules of the line, whose numbers are no pin, whatever a scan says.
 */
export function ownedPinPlace(file: string): boolean {
  return file.startsWith('deploy/') || /(^|\/)Dockerfile$/.test(file);
}

/** Whether a tag or version starts as a version does (`2.14.3`, `v1.54.0`), not as a word (`bookworm`, `main`). */
const VERSIONED = /^v?\d/;

/**
 * What a pin's text is: a tag and its digest, or a version alone, as the scan's grammar reads a target; or neither. A
 * tag that is not a version (`bookworm`) is read with its digest, which is all of it that moves.
 */
function shapeOf(text: string): { kind: 'image'; tag: string } | { kind: 'version' } | undefined {
  // A second `@` is left in the digest, which DIGEST then refuses.
  const { name: tag, digest } = splitReference(text);
  if (digest !== undefined) {
    const read = readTarget(`image ${tag}@${digest}`);
    return read?.kind === 'image' && read.tag === tag && DIGEST.test(digest) ? { kind: 'image', tag } : undefined;
  }
  const read = readTarget(`version ${text}`);
  return read?.kind === 'version' && read.versions.length === 1 && read.versions[0] === text && VERSIONED.test(text)
    ? { kind: 'version' }
    : undefined;
}

/** A character a pin's text could run on into: a word's, a reference's, or a path's. */
const WORDISH = /[A-Za-z0-9._+@:~/-]/;

/**
 * Where a text is on a line as a word of its own, every time it is: after the line's start, `:` (a tag, `syft:v1.54.0`)
 * or a character no word has (a space, a quote, `=`), and before the line's end or such a character, or, with
 * `digestAfter`, `@` (a tag the watch reads with its digest after it). The one rule for the watch's edit and the guard.
 */
export function spans(line: string, text: string, { digestAfter = false } = {}): number[] {
  const found: number[] = [];
  if (!text) return found;
  for (let at = line.indexOf(text); at !== -1; at = line.indexOf(text, at + 1)) {
    const before = at === 0 ? '' : (line[at - 1] ?? '');
    const after = line[at + text.length] ?? '';
    const startsWord = before === '' || before === ':' || !WORDISH.test(before);
    const endsWord = after === '' || !WORDISH.test(after) || (digestAfter && after === '@');
    if (startsWord && endsWord) found.push(at);
  }
  return found;
}

const refuse = (output: string): never => {
  throw new PatchRefused('protected', output);
};

/**
 * The files a pin move's commit changes, each its text at `base` with the one span at each pin replaced, or a refusal
 * (`BranchRefused`, or `PatchRefused` with kind `protected`) of anything else. Throws a `GitHubError` of kind
 * `conflict` when `main` has moved from `base`.
 */
export async function pinChanges(
  repo: string,
  commit: PinCommit,
  source: PinSource,
): Promise<{ path: string; contents: Uint8Array }[]> {
  guardPinBranch(commit.branch);
  const { pins } = commit;
  const made = commit.files ?? [];
  if (!pins.length && !made.length) refuse('A pin move with no pins moves nothing.');
  const madePaths = new Set<string>();
  for (const file of made) {
    if (!plainPath(file.path)) refuse(`${JSON.stringify(file.path)} is not a plain path in the repository.`);
    if (file.path.startsWith('.github/') || file.path.startsWith('policy/') || !madeFile(file.path))
      refuse(`${file.path} is not a file the scan’s pin step writes: a lockfile, a manifest, mise’s or a Dockerfile.`);
    if (madePaths.has(file.path)) refuse(`${file.path} is written twice in one pin move.`);
    if (pins.some((pin) => pin.file === file.path)) refuse(`${file.path} is both edited and written whole.`);
    madePaths.add(file.path);
  }
  if (pins.length > MAX_PINS)
    refuse(`A commit of ${pins.length} pins is more than one pull request writes (${MAX_PINS}).`);
  const places = new Set<string>();
  for (const pin of pins) {
    const place = `${pin.file}:${pin.line}`;
    if (!plainPath(pin.file)) refuse(`${JSON.stringify(pin.file)} is not a plain path in the repository.`);
    const forbidden = forbiddenPin(pin.file);
    if (forbidden) refuse(`${pin.file} is not a pin the watch may move: ${forbidden}.`);
    if (!Number.isInteger(pin.line) || pin.line < 1) refuse(`${place} is not a line of ${pin.file}.`);
    if (places.has(place)) refuse(`${place} is named twice in one pin move.`);
    places.add(place);
    const [from, to] = [shapeOf(pin.from), shapeOf(pin.to)];
    if (!from)
      return refuse(`${place} pins ${JSON.stringify(pin.from)}, which is not a version or a tag with its digest.`);
    if (!to)
      return refuse(`${place} would pin ${JSON.stringify(pin.to)}, which is not a version or a tag with its digest.`);
    if (from.kind !== to.kind)
      refuse(
        `${place} would pin a ${to.kind === 'image' ? 'digest' : 'version alone'} where it pinned a ${from.kind === 'image' ? 'digest' : 'version alone'}.`,
      );
    // A tag that is not a version keeps its name: only its digest moves, as the scan's fix for it does.
    if (
      from.kind === 'image' &&
      to.kind === 'image' &&
      from.tag !== to.tag &&
      !(VERSIONED.test(from.tag) && VERSIONED.test(to.tag))
    )
      refuse(
        `${place} would pin the tag ${to.tag} where it pinned ${from.tag}: a tag that is not a version moves its digest alone.`,
      );
    if (pin.from === pin.to) refuse(`${place} would pin what it pins already.`);
  }
  const head = await source.head(repo);
  if (head !== commit.base)
    throw new GitHubError(
      'conflict',
      `main is at ${head.slice(0, 7)}, not ${commit.base.slice(0, 7)}: the watch reads it again.`,
      409,
    );

  // The rules of the line, as CODEOWNERS at main's head gives them, hold no pin but the cluster's and a Dockerfile's.
  const owners = (await Promise.all(CODEOWNERS_PATHS.map((path) => source.file(repo, commit.base, path)))).find(
    (found) => found !== null,
  );
  const owned = protectedFrom(owners?.text ?? null).filter((entry) => entry !== 'deploy/');
  for (const pin of pins)
    if (inScope(pin.file, owned) && !ownedPinPlace(pin.file))
      refuse(`${pin.file} is a rule of the line CODEOWNERS gives a person, and holds no pin the watch moves.`);
  // mise's files are Martin's, and a move may write them (the scan's pin step, for what mise pins), as it may a
  // Dockerfile's FROMs, a pin's place; no other.
  for (const path of madePaths)
    if (inScope(path, owned) && path !== 'mise.toml' && path !== 'mise.lock' && !ownedPinPlace(path))
      refuse(`${path} is a rule of the line CODEOWNERS gives a person, and the scan’s pin step writes no such file.`);

  const out: { path: string; contents: Uint8Array }[] = [];
  // A file the scan's pin step wrote: the same at main's head as at the commit it was made on, so what it made is
  // made on main's file, and different from it. Its bytes are the scan's; the review gate makes them again on main.
  for (const file of made) {
    const [now, then] = await Promise.all([
      source.file(repo, commit.base, file.path),
      source.file(repo, commit.scanned, file.path),
    ]);
    for (const [at, found] of [
      ['main', now],
      ['the commit the scan read', then],
    ] as const) {
      if (!found) refuse(`${file.path} is not a file in ${at}.`);
      else if (found.mode !== '100644' && found.mode !== '100755')
        refuse(`${file.path} is not an ordinary file in ${at} (mode ${found.mode}).`);
    }
    if ((now as TreeFile).text !== (then as TreeFile).text)
      refuse(`${file.path} has changed since the scan made its moves: they are not made on main’s file.`);
    if ((now as TreeFile).text === file.text) refuse(`${file.path} would be written as it is.`);
    const why = madeRefusal(file.path, (now as TreeFile).text, file.text);
    if (why) refuse(`${file.path} is not what a move writes in it: it ${why}.`);
    out.push({ path: file.path, contents: new TextEncoder().encode(file.text) });
  }
  for (const file of [...new Set(pins.map((pin) => pin.file))]) {
    const [now, then] = await Promise.all([
      source.file(repo, commit.base, file),
      source.file(repo, commit.scanned, file),
    ]);
    for (const [at, found] of [
      ['main', now],
      ['the commit the scan read', then],
    ] as const) {
      if (!found) refuse(`${file} is not a file in ${at}.`);
      else if (found.mode !== '100644' && found.mode !== '100755')
        refuse(
          `${file} is not an ordinary file in ${at} (mode ${found.mode}): a symbolic link, a submodule or a folder is no pin.`,
        );
    }
    const lines = (now as TreeFile).text.split('\n');
    const scannedLines = (then as TreeFile).text.split('\n');
    for (const pin of pins.filter((each) => each.file === file)) {
      const place = `${pin.file}:${pin.line}`;
      const line = lines[pin.line - 1];
      if (line === undefined) refuse(`${place} is past the end of ${file}.`);
      if (scannedLines[pin.line - 1] !== line)
        refuse(`${place} has changed since the scan read it: it is not the pin the scan named.`);
      const at = spans(line as string, pin.from);
      if (at.length !== 1)
        refuse(
          `${place} holds ${JSON.stringify(pin.from)} ${at.length ? `${at.length} times` : 'nowhere'} as a word of its own: the watch replaces one span.`,
        );
      const start = at[0] as number;
      lines[pin.line - 1] =
        `${(line as string).slice(0, start)}${pin.to}${(line as string).slice(start + pin.from.length)}`;
    }
    out.push({ path: file, contents: new TextEncoder().encode(lines.join('\n')) });
  }
  return out;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const HEAD = z.object({ object: z.object({ sha: SHA }) });
const TREE = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() })),
});
const BLOB = z.object({ encoding: z.literal('base64'), content: z.string() });
// A byte-order mark is kept, so a file is written back with every byte but its pins' as it was.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The guard's reads, through GitHub: `main`'s head from its ref, and a file from a commit's whole tree, as git lists it
 * (never the contents API, which follows a symbolic link to the file it names), its text from its blob. A tree GitHub
 * cut short is refused: a file it does not list is not known to be the file it seems.
 */
export function treeSource(github: GitHub): PinSource {
  const trees = new Map<string, Promise<z.infer<typeof TREE>>>();
  return {
    async head(repo) {
      const ref = await github.read(repo, `/repos/${repo}/git/ref/heads/main`, HEAD);
      return ref.object.sha;
    },
    async file(repo, ref, path) {
      if (!SHA.safeParse(ref).success) refuse(`${ref} is not a commit.`);
      const key = `${repo} ${ref}`;
      let tree = trees.get(key);
      if (!tree) {
        tree = github.read(repo, `/repos/${repo}/git/trees/${ref}?recursive=1`, TREE);
        // A guard against a leak, not a working limit: a pass reads two commits.
        if (trees.size >= 20) trees.clear();
        trees.set(key, tree);
        tree.catch(() => trees.delete(key));
      }
      const listed = await tree;
      if (listed.truncated)
        refuse(`GitHub cut the tree of ${ref.slice(0, 7)} short: ${path} cannot be known to be a file.`);
      const entry = listed.tree.find((each) => each.path === path);
      if (!entry) return null;
      if (entry.type !== 'blob') return { mode: entry.mode, text: '' };
      const blob = await github.read(repo, `/repos/${repo}/git/blobs/${entry.sha}`, BLOB);
      let text: string;
      try {
        text = UTF8.decode(Buffer.from(blob.content, 'base64'));
      } catch {
        return refuse(`${path} is not UTF-8 text.`);
      }
      return { mode: entry.mode, text };
    },
  };
}
