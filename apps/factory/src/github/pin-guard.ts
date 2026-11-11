/**
 * The pin watch's guard (`pins.ts`): what lets a commit onto `factory/pin/<move>` replace the version or digest at each
 * of a move's pins, and refuses everything else. It is the guard, not the watch's good behaviour, that holds "nothing
 * else": `commitPins` is the one action that writes a pin branch (`branches.ts`), and it writes only what this gives
 * back, worked out here from the repository itself, never from the file text its caller read.
 *
 * A commit is let through only when all of these hold, and refused, before GitHub is asked to write, otherwise:
 *
 * - **Its branch** is `factory/pin/<move>`, the move's name made one plain segment: nothing that could reach outside it.
 * - **Its pins** are at most `MAX_PINS`, no two at one line, each in a plain path (`plainPath`), none under `.github/` or
 *   `policy/`, in a lockfile, or in mise's files, which move only when someone upgrades the toolchain.
 * - **Each pin's file** is an ordinary file in the tree of `main`'s head, as git's own tree names it (a symbolic link,
 *   a submodule or a folder is refused), and of the commit the scan read.
 * - **Each pin's line** is the same at `main`'s head as at the commit the scan read: a line that has changed since
 *   is not the pin the scan named.
 * - **What it pins** before and after is a version, or a tag and its digest, as the scan's grammar writes a target
 *   (`fixes.ts`'s `readTarget`), the same shape on both sides, and different.
 * - **The line** holds what it pins before exactly once, as a word of its own, and the commit's line is that line with
 *   that span alone replaced.
 *
 * `main`'s head is read here, and a commit is made on it alone: one that moved since the watch read it is no refusal,
 * the watch tries again on its next pass.
 */
import { z } from 'zod';
import { readTarget } from '../vulnerabilities/fixes.ts';
import { BranchRefused, PIN_NEXT_PREFIX, PIN_PREFIX } from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import { PatchRefused } from './patches.ts';
import { CODEOWNERS_PATHS, inScope, plainPath, protectedFrom } from './paths.ts';

/** One pin a commit moves: where it is, and the text it pins before and after (`2.14.2@sha256:…`, `13.7.0`). */
export interface PinEdit {
  file: string;
  line: number;
  from: string;
  to: string;
}

/** A pin move's commit, as the watch asks for it. */
export interface PinCommit {
  /** `factory/pin/<move>`. */
  branch: string;
  /** `main`'s head as the watch read it: the commit is made on it, and refused as stale if `main` has moved. */
  base: string;
  /** The commit the scan read, whose lines the pins must still be. */
  scanned: string;
  message: string;
  pins: PinEdit[];
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

/** The most pins one move writes: one image in every Dockerfile that runs it. */
export const MAX_PINS = 20;

/** A move's branch: its name made one segment, lower case, of letters, digits, dots and dashes. */
const SEGMENT = /^[a-z0-9](?:[a-z0-9-]|\.(?!\.))*[a-z0-9]$|^[a-z0-9]$/;
const MAX_SEGMENT = 80;

/** The branch a move's pull request is on, from its name: `docker.io/library/postgres` is `factory/pin/docker-io-library-postgres`. */
export function pinBranchFor(name: string): string {
  const segment = name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_SEGMENT)
    .replace(/[-.]+$/, '');
  // A ref may not end `.lock`: the segment ends in a word of its own instead, within the length the guard takes.
  return `${PIN_PREFIX}${segment.endsWith('.lock') ? `${segment.slice(0, MAX_SEGMENT - 4)}-pin` : segment}`;
}

/** Where a pin branch's commit is made before the branch moves to it. */
export const pinNextBranch = (branch: string) => `${PIN_NEXT_PREFIX}${branch.slice(PIN_PREFIX.length)}`;

/** Throws `BranchRefused` unless a branch is a pin move's own: `factory/pin/` and one plain segment. */
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
  if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(file))
    return 'a lockfile moves by its package manager, and the App writes none';
  if (/(^|\/)\.?mise(\.[\w-]+)?\.(toml|lock)$/.test(file))
    return 'mise’s files move only when someone upgrades the toolchain';
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

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** What a pin's text is: a tag and its digest, or a version alone, as the scan's grammar reads a target; or neither. */
function shapeOf(text: string): 'image' | 'version' | undefined {
  const [tag = '', digest, ...rest] = text.split('@');
  if (rest.length) return undefined;
  if (digest !== undefined) {
    const read = readTarget(`image ${tag}@${digest}`);
    return read?.kind === 'image' && read.tag === tag && DIGEST.test(digest) && /^v?\d/.test(tag) ? 'image' : undefined;
  }
  const read = readTarget(`version ${text}`);
  return read?.kind === 'version' && read.versions.length === 1 && read.versions[0] === text && /^v?\d/.test(text)
    ? 'version'
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
  if (!pins.length) refuse('A pin move with no pins moves nothing.');
  if (pins.length > MAX_PINS) refuse(`A pin move of ${pins.length} pins is more than one move writes (${MAX_PINS}).`);
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
    if (!from) refuse(`${place} pins ${JSON.stringify(pin.from)}, which is not a version or a tag with its digest.`);
    if (!to) refuse(`${place} would pin ${JSON.stringify(pin.to)}, which is not a version or a tag with its digest.`);
    if (from !== to)
      refuse(
        `${place} would pin a ${to === 'image' ? 'digest' : 'version alone'} where it pinned a ${from === 'image' ? 'digest' : 'version alone'}.`,
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

  const out: { path: string; contents: Uint8Array }[] = [];
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
