/**
 * A move (spec 4.3): whether a pull request is exactly the scan's moves and nothing else. The review gate passes one as
 * `move`, or as `major` when one of its moves crosses a major and clears no Critical by Trivy's own rating, whatever the
 * publisher's (`namedMajor`, scripts/review-routing.ts).
 *
 * The gate takes the moves the daily scan of `main` asked for (`ScanMove`: `moves.json` joined with the state the scan
 * sealed, read by scripts/moves.ts), makes them itself on the pull request's base, main's tip (for the merge queue's
 * commit, the commit it was made on), and compares the result with what the merge makes, file by file, byte for byte.
 * Each move is made as the one who makes it makes it:
 *
 * - a pin's line, by the pin watch's own edit (`editAt`): an image's tag and digest, a chart's version, k3s's release;
 * - a lockfile's package, each image that brings another pin with it (the Node it runs, or its library: `bringsPins`),
 *   and in the factory anything mise pins, by the pin step (apps/runner/src/pins.ts's `writePins`), run on main's tip
 *   with this repository's pnpm and mise (scripts/derive.ts): the derivation, in `MoveIO.derive`. In the factory it is
 *   what the scan ran to make the moves the pin watch commits, in the same order (github/made.ts).
 *
 * The pull request carries a move when it rewrites a line one of the move's pins is on (a lockfile's, where the scan
 * found its package); it may carry several of the day's moves, and must carry each whole. Anything that differs is refused, and the
 * reason says where: a line no move writes, a pin left unmoved, a version or digest other than the scan's, a file
 * added, removed, renamed or changed in mode, anything under `.github/`. What a lockfile's move withholds (its package
 * and versions) is never said: its name is the public list's, and a file the derivation writes is named by its line
 * alone.
 *
 * Every fact the verdict names comes from the scan's move, never from the pull request: where its pins are, what it
 * moves to, whether it crosses a major, and what it clears. Who opened the pull request decides nothing here.
 */

import { madeByLine, madeByStep, namedMajor, stepOf } from '../apps/factory/src/github/made.ts';
import { spans } from '../apps/factory/src/github/pin-guard.ts';
import { editAt } from '../apps/factory/src/github/pins.ts';
import type { ReadMove } from '../apps/factory/src/github/scanning.ts';
import { moveOf } from '../apps/factory/src/patching/sends.ts';
import { repositoryOfImage } from '../apps/factory/src/repositories.ts';
import { readTarget, type Target } from '../apps/factory/src/vulnerabilities/fixes.ts';
import type { Move as PinStepMove } from '../apps/runner/src/pins.ts';
import type { MoveResult } from './review-routing.ts';

export type { MoveResult } from './review-routing.ts';

/** One of the scan's moves, as the GitHub worker reads it (github/scanning.ts): `moves.json` and the sealed state. */
export type ScanMove = ReadMove;

/**
 * One file the change touches, as git's `--raw` list gives it, with its text on each side where it has one
 * (`exactText`): `null` where its bytes there are not UTF-8.
 */
export interface Changed {
  path: string;
  /** git's status letter: `M` modified, `A` added, `D` deleted, `T` its type changed. */
  status: string;
  modes: [string, string];
  base?: string | null | undefined;
  head?: string | null | undefined;
  /** The lines of main's text it rewrites or removes, from 1, as git's hunks give them; by position where absent. */
  rewrites?: readonly number[] | undefined;
}

/** What the rule reads beyond the change: main's files, and the pin step's derivation on main's tip. */
export interface MoveIO {
  /** A file at main's tip, or undefined where there is none. */
  base(path: string): string | undefined;
  /**
   * The files the pin step writes for these moves, in order, on a checkout of main's tip, each with its text. Throws
   * when the step refuses or fails; the rule then says so without the step's words, which may name a package.
   */
  derive(moves: readonly PinStepMove[]): Promise<Map<string, string>>;
}

const REGULAR = /^100(644|755)$/;

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A file's bytes as the text the rule compares, or `null` where they are not UTF-8. Decoded strictly, with any mark at
 * its start kept, two texts are the same exactly when their bytes are: a lenient decoding reads different invalid bytes
 * as one replacement character, and would compare them equal.
 */
export function exactText(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}
const LOCKFILE = /(^|\/)pnpm-lock\.yaml$/;

const short = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** git's `--raw --no-renames` list, read: each entry's modes, status and path. */
export function rawEntries(raw: string): Omit<Changed, 'base' | 'head'>[] {
  return raw
    .split('\n')
    .filter((line) => line.startsWith(':'))
    .map((line) => {
      const [meta = '', ...rest] = line.split('\t');
      const [modeA = '', modeB = '', , , status = ''] = meta.slice(1).split(' ');
      return { path: rest.join('\t'), status: status.charAt(0), modes: [modeA, modeB] as [string, string] };
    });
}

/**
 * The lines of main's text a diff's hunks rewrite or remove (`git diff -U0`'s `@@ -start,count`), from 1: an insertion
 * alone counts the line it follows.
 */
export function hunkLines(diff: string): number[] {
  const out: number[] = [];
  for (const [, start = '0', count] of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const [from, n] = [Number(start), count === undefined ? 1 : Number(count)];
    if (n === 0) out.push(Math.max(from, 1));
    for (let i = 0; i < n; i++) out.push(from + i);
  }
  return out;
}

/** The lines two texts differ at, from 1, compared line by line; a text with more lines differs at each extra one. */
function differing(a: string, b: string): number[] {
  const [x, y] = [a.split('\n'), b.split('\n')];
  const out: number[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(i + 1);
  return out;
}

/**
 * The pin step's move for one it makes, or undefined for an edit: a lockfile's package; each image that brings another
 * pin with it (`bringsPins`): one that runs Node brings its Node (Node's own move, from the build stage's image, or the
 * runtime's at a digest that runs another release), and Playwright's its library; in the factory anything mise pins,
 * as its scan made it for the pin watch (github/made.ts).
 */
function stepMove(move: ScanMove, app: boolean, base: MoveIO['base']): PinStepMove | string | undefined {
  if (!app) return madeByStep(move) ? stepOf(move, base('mise.lock')) : undefined;
  if (!madeByLine(move)) return undefined;
  const made = moveOf(move.repository, move);
  if (typeof made === 'string') return made;
  return { ecosystem: made.ecosystem, name: made.name, from: made.from, to: made.to };
}

/** Why the gate will not make a move by an edit, or nothing when it will. */
function unedited(move: ScanMove, target: Target | undefined): string | undefined {
  if (!target) return `the scan names no target the gate can make for ${move.name}`;
  if (target.kind === 'unbuilt' || target.kind === 'tool')
    return `${move.name} moves to ${move.to}, which no pin's line writes`;
  // An image of ours is signed by build.yml on main, and passes only as an exact pin.
  if (repositoryOfImage(move.name))
    return `${move.name} is an image of ours, which passes only as an exact pin, signed by build.yml on main`;
  return undefined;
}

/** The text of the files the edits write, each made from main's: the pin watch's edit at each pin. */
export function edit(
  moves: readonly ScanMove[],
  base: (path: string) => string | undefined,
): { files: Map<string, string> } | { reason: string } {
  const files = new Map<string, string[]>();
  for (const move of moves) {
    const target = readTarget(move.to);
    const why = unedited(move, target);
    if (why || !target) return { reason: why ?? `no target for ${move.name}` };
    for (const pin of move.pins) {
      let lines = files.get(pin.file);
      if (!lines) {
        const text = base(pin.file);
        if (text === undefined) return { reason: `${pin.file}, a pin of ${move.name}, is not a file on main` };
        lines = text.split('\n');
        files.set(pin.file, lines);
      }
      const line = lines[pin.line - 1];
      if (line === undefined)
        return { reason: `${pin.file}:${pin.line}, a pin of ${move.name}, is past its end on main` };
      const made = editAt(pin, line, move.from, target);
      if ('reason' in made) return { reason: `the gate cannot make ${move.name} on main: ${made.reason}` };
      // The one span the pin watch's guard replaces: the same bytes as its commit.
      const at = spans(line, made.from)[0] as number;
      lines[pin.line - 1] = `${line.slice(0, at)}${made.to}${line.slice(at + made.from.length)}`;
    }
  }
  return { files: new Map([...files].map(([path, lines]) => [path, lines.join('\n')])) };
}

/**
 * Whether the change is the scan's moves and nothing else: the moves it carries, made by the gate on main, the same
 * bytes as the merge makes. `changed` is every file the merge changes against main's tip; `app` says the repository's
 * moves are its line's.
 */
export async function proveMove(
  changed: readonly Changed[],
  scan: readonly ScanMove[],
  io: MoveIO,
  app: boolean,
): Promise<MoveResult> {
  if (changed.length === 0) return { none: 'it changes no file' };
  for (const file of changed) {
    if (file.path.startsWith('.github/'))
      return { reason: `it changes ${file.path}, and no move is made under .github/` };
    if (file.status !== 'M')
      return {
        reason: `${file.path} is ${file.status === 'A' ? 'added' : file.status === 'D' ? 'deleted' : 'changed in type'}, and a move only rewrites a pin's line`,
      };
    if (file.modes[0] !== file.modes[1] || !REGULAR.test(file.modes[0]))
      return { reason: `${file.path} changes its mode, or is not a regular file` };
    if (file.base === null || file.head === null)
      return { reason: `${file.path} is not UTF-8 text, and a move writes text alone` };
    if (file.base === undefined || file.head === undefined)
      return { reason: `the gate did not read ${file.path} on both sides` };
  }
  // Every file now has its text on both sides.
  const byPath = new Map(changed.map((file) => [file.path, { ...file, base: file.base ?? '', head: file.head ?? '' }]));
  // The moves it carries: each with a pin on a line the change rewrites, or in a lockfile it changes.
  const touched = new Map(
    changed.map((file) => [file.path, new Set(file.rewrites ?? differing(file.base ?? '', file.head ?? ''))]),
  );
  // A lockfile's move is pinned where the scan found its package in a lockfile, a line that moves with its version.
  // The scan also pins it at an image of ours that carries the package, which a deploy moves after the merge: that pin
  // carries no move, and nothing of the move writes it.
  const pinsOf = (move: ScanMove) =>
    move.lockfile ? (move.withheld?.pins ?? move.pins).filter((pin) => LOCKFILE.test(pin.file)) : move.pins;
  // One the scan found at no line (0) is carried by none: any change to its file would carry it, and a pull request
  // that makes another move there would have to make it too.
  const carried = scan.filter((move) =>
    pinsOf(move).some((pin) => pin.line >= 1 && touched.get(pin.file)?.has(pin.line)),
  );
  if (!carried.length) {
    const first = changed[0] as Changed;
    const line = touched.get(first.path)?.values().next().value;
    return { none: `${first.path}${line ? `:${line}` : ''} is no pin of a move the scan of main asked for` };
  }
  const steps: PinStepMove[] = [];
  const edits: ScanMove[] = [];
  for (const move of carried) {
    const step = stepMove(move, app, io.base);
    if (typeof step === 'string') return { reason: `the gate cannot make ${move.name}: ${step}` };
    if (step) steps.push(step);
    else edits.push(move);
  }
  let derived = new Map<string, string>();
  if (steps.length) {
    try {
      derived = await io.derive(steps);
    } catch {
      // The step's own words may name a package a lockfile's move withholds: the reason says only that it failed.
      const names = carried.filter((move) => stepMove(move, app, io.base)).map((move) => move.name);
      return { reason: `the pin step could not make ${names.join(', ')} on main` };
    }
  }
  // The edits on what the pin step wrote, each on a line the pin step leaves as main has it.
  const edited = edit(edits, (path) => derived.get(path) ?? byPath.get(path)?.base ?? io.base(path));
  if ('reason' in edited) return edited;
  const made = new Map([...derived, ...edited.files]);
  // What a lockfile's derivation writes may show the package its move withholds.
  const withheld = steps.some((each) => each.ecosystem === 'npm');
  // Every file the merge changes, and every file the moves write, is the same on both.
  for (const path of new Set([...byPath.keys(), ...made.keys()])) {
    const ours = made.get(path) ?? byPath.get(path)?.base;
    const theirs = byPath.get(path)?.head ?? byPath.get(path)?.base;
    if (theirs === undefined) return { reason: `it leaves ${path} unmoved, which the moves it carries write` };
    if (ours === theirs) continue;
    const at = differing(ours ?? '', theirs)[0] ?? 1;
    if (!made.has(path)) return { reason: `${path}:${at} changes, and no move it carries writes ${path}` };
    // What the pin step derives may show a package a lockfile's move withholds: its line is named, never its text.
    if (withheld && derived.has(path))
      return { reason: `${path}:${at} is not what the pin step writes for the moves it carries` };
    const line = theirs.split('\n')[at - 1];
    const want = (ours ?? '').split('\n')[at - 1];
    const quote = (text: string | undefined, none: string) =>
      text === undefined ? none : text.trim() === '' ? 'an empty line' : `\`${short(text.trim())}\``;
    return {
      reason: `${path}:${at} is ${quote(line, 'missing')} where the scan's moves make ${quote(want, 'no line')}`,
    };
  }
  const major = carried.filter(namedMajor);
  const names = carried.map((move) => (move.lockfile ? move.name : `${move.name} to ${shortTarget(move.to)}`));
  const title = `${carried.length === 1 ? 'The scan’s move' : `The scan’s ${plural(carried.length, 'move')}`} of ${names.join(', ')}, made by the gate on main and the same as the pull request`;
  return major.length
    ? {
        rule: 'major',
        title: `${title}; a major that clears no Critical by Trivy’s rating: ${major.map((m) => m.name).join(', ')}`,
      }
    : { rule: 'move', title };
}

/** A target as a title names it: a tag without its digest, a chart's or a package's version. */
function shortTarget(to: string): string {
  const target = readTarget(to);
  switch (target?.kind) {
    case 'image':
      return target.tag;
    case 'chart':
      return target.version;
    case 'k3s':
      return target.release;
    case 'version':
      return target.versions.join(' and ');
    default:
      return to;
  }
}
