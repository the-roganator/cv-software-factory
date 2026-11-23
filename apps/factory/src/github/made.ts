/**
 * The moves no pin's line can write, made by the scan with the pin step: a lockfile's package, which pnpm moves, a tool
 * mise pins, which mise locks, and an image that brings another pin with it (`bringsPins`: the Node it runs, or
 * Playwright's library), whose `FROM`s the step moves with what it brings. Each is the pin step's own move
 * (apps/runner/src/pins.ts), made by scripts/derive.ts on the commit the scan read, in the scan's run (scripts/pins.ts),
 * and sealed with the scan's key beside its state, since what it writes names a package the public list withholds: the
 * artifact `pins`.
 *
 * In the factory they are the pin watch's moves, which it commits (`madeByStep`). In the app they are the line's
 * (`madeByLine`), which its pin step makes again on main's tip and commits itself: what the scan made of them is the
 * time it made them as of and the digest it was given for each tag it asked (`askedIn`), which the line's pin step is
 * given, so the line makes them as the scan did.
 *
 * The moves are made in groups, by the files they write, as the pin watch keeps one pull request for a file's moves:
 * every lockfile move of the day in one, every move of mise's in another. Each group's moves are made in the order of
 * `moves.json`, each on what the ones before it wrote, and a move the step refuses is undone and named with the step's
 * words, which may name its package; the rest of its group go on. The review gate makes the same moves in the same
 * order again on main's tip (scripts/move.ts), with the same step, as of the scan's time and with the digests the
 * scan's step was given for each tag it asked (`MadeGroup.asked`), and compares.
 *
 * Nothing here runs anything: it says which move is made so and what it is, and seals and opens what the scan made.
 */

import type { Move as PinStepMove } from '../../../runner/src/pins.ts';
import { moveOf } from '../patching/sends.ts';
import { readTarget } from '../vulnerabilities/fixes.ts';
import { bringsPins, libraryOf } from '../vulnerabilities/registry.ts';
import { openJson, StateError, sealJson } from '../vulnerabilities/state.ts';
import type { MoveFinding, ReadMove } from './scanning.ts';

/** The scan's artifact of the moves it made, and the file in it. */
export const MADE_ARTIFACT = 'pins';
export const MADE_FILE = 'pins.sealed';
/** The shape of the file: a reader refuses a version it does not know. */
export const MADE_VERSION = 1;

/** One group of moves the scan made: those that write the same files, and are named `major` or not alike. */
export interface MadeGroup {
  /** The files its moves write, sorted: the pin watch's branch is named for them. */
  files: string[];
  /** Whether its moves are those the review gate will name `major` (`namedMajor`), which ride apart. */
  major: boolean;
  /** The moves made, by their place in `moves.json` (from 1), in the order they were made. */
  moves: number[];
  /** The moves the step refused, by their place, with its words, which may name a package. */
  refused: { move: number; reason: string }[];
  /** Every file the made moves wrote, whole, where it differs from the commit scanned. */
  changed: { path: string; text: string }[];
  /**
   * What each made move moved, as its diff shows it: a package and the versions the lockfile resolves it at before and
   * after (`npm`), or a tool, Node or an image and the version it pinned and pins.
   */
  steps: MadeStep[];
  /**
   * Each tag of an image the step asked its registry for, with the digest it was given (scripts/derive.ts), so the
   * review gate makes the same moves with the same answers. Absent from a run before it was kept.
   */
  asked?: Asked[] | undefined;
}

/** A tag of an image, and the digest its registry gave it when the scan's step asked. */
export interface Asked {
  image: string;
  tag: string;
  digest: string;
}

/** One made move, as its pull request's diff shows it. */
export interface MadeStep {
  move: number;
  ecosystem: PinStepMove['ecosystem'];
  name: string;
  before: string[];
  after: string[];
}

/** What the scan made, for one run. */
export interface Made {
  version: typeof MADE_VERSION;
  repository: string;
  run: string;
  /** The commit it made them on: the one the run scanned. */
  commit: string;
  groups: MadeGroup[];
}

/**
 * A Critical by Trivy's own rating, as the state gives a finding (`severity`). A publisher's rating, which the move's
 * counts and deadline take where it is higher, may hold a major and never release one: the party that ships the major
 * cannot ask for its merge. Node's own advisories are rated by Node alone (scan.ts's `nodeFindingsOf`), so none of
 * them is one.
 */
export const trivysCritical = (finding: Pick<MoveFinding, 'severity' | 'type'>): boolean =>
  finding.severity === 'CRITICAL' && finding.type !== 'node';

/**
 * Whether the review gate names a move `major` (scripts/move.ts): across a major, clearing no Critical by Trivy's own
 * rating (`trivysCritical`).
 */
export const namedMajor = (move: Pick<ReadMove, 'major' | 'findings'>): boolean =>
  move.major && !move.findings.some(trivysCritical);

/**
 * The digest each tag of an image was found at by the scan's step, each tag once: the first group's answer where two
 * asked the same tag. None from a run before it kept them.
 */
export function askedIn(made: Pick<Made, 'groups'>): Asked[] {
  const asked = new Map<string, Asked>();
  for (const group of made.groups)
    for (const each of group.asked ?? []) {
      const key = `${each.image}:${each.tag}`;
      if (!asked.has(key)) asked.set(key, each);
    }
  return [...asked.values()];
}

/** The group a move the step makes is in: the files it writes, and whether it is named `major`. */
export const groupOf = (move: Pick<ReadMove, 'lockfile' | 'pins' | 'major' | 'findings' | 'name'>) => ({
  files: writtenBy(move),
  major: namedMajor(move),
});

/** One key for a group, the same for its moves and for what the scan made of them. */
export const groupKey = (group: { files: readonly string[]; major: boolean }) =>
  JSON.stringify([[...group.files].sort(), group.major]);

const MISE = /(^|\/)mise\.(toml|lock)$/;
const LOCKFILE = /(^|\/)pnpm-lock\.yaml$/;

/**
 * Whether a move of the factory's is made by the pin step, not by a pin's edit: a lockfile's, one mise pins, or an
 * image's that brings another pin with it (`bringsPins`), whose `FROM`s alone would leave what it brings behind.
 */
export const madeByStep = (move: Pick<ReadMove, 'lockfile' | 'pins' | 'name' | 'to'>): boolean =>
  move.lockfile ||
  move.pins.some((pin) => MISE.test(pin.file)) ||
  (readTarget(move.to)?.kind === 'image' && bringsPins(move.name));

/**
 * Whether a move of the app's is made by its line's pin step, not by a pin's edit: a lockfile's, or an image's that
 * brings another pin with it (`bringsPins`), Node among them. The review gate makes the same moves so (scripts/move.ts).
 */
export const madeByLine = (move: Pick<ReadMove, 'lockfile' | 'name'>): boolean =>
  move.lockfile || bringsPins(move.name);

/**
 * The files a move the step makes writes, by which it is grouped: a lockfile's, where the scan found its package (its
 * pin at an image of ours that carries the package is moved by a deploy, after the merge), mise's, or an image's
 * Dockerfiles, beside which it writes the Node it brings. An image with a library is grouped by the lockfile, as the
 * day's lockfile moves are: it writes the lockfile too, and one pull request for the lockfile's moves leaves none to
 * wait for another's merge.
 */
export function writtenBy(move: Pick<ReadMove, 'lockfile' | 'pins' | 'name'>): string[] {
  if (!move.lockfile && libraryOf(move.name)) return ['pnpm-lock.yaml'];
  const files = move.pins.map((pin) => pin.file).filter((file) => (move.lockfile ? LOCKFILE.test(file) : true));
  return [...new Set(files)].sort();
}

/** The tool whose entry in `mise.lock` holds a line: the nearest `[[tools.<name>]]` at or above it. */
export function toolAt(lock: string, line: number): string | undefined {
  const lines = lock.split('\n');
  for (let at = Math.min(line, lines.length) - 1; at >= 0; at--) {
    const text = (lines[at] ?? '').trim();
    if (!text.startsWith('[[')) continue;
    // The first entry above the line is the one it is in: a tool's, or not one.
    return /^\[\[tools\.(?:"([^"]+)"|([\w.-]+))\]\]$/.exec(text)?.slice(1).find(Boolean);
  }
  return undefined;
}

/**
 * The pin step's move for one of the scan's, made so (`madeByStep`), or why it cannot be: a lockfile's package, from
 * what the state withholds; Node, where mise pins it, or Node's image to a tag of another release; an image that brings
 * another pin, to the scan's tag and digest; any other tool mise pins, at the entry its pin is in, moved to the scan's
 * target (a tool's release, or the image's tag for an image mise's tool pins, k3d's), read from `mise.lock` as it is
 * where the move is made.
 */
export function stepOf(move: ReadMove, lock: string | undefined): PinStepMove | string {
  const image = readTarget(move.to)?.kind === 'image' && !move.pins.some((pin) => MISE.test(pin.file));
  if (move.lockfile || move.name === 'node' || (image && bringsPins(move.name))) {
    const made = moveOf(move.repository, move);
    if (typeof made === 'string') return made;
    return { ecosystem: made.ecosystem, name: made.name, from: made.from, to: made.to };
  }
  const pin = move.pins.find((each) => each.file === 'mise.lock');
  if (!pin) return `${move.name} is pinned in no entry of mise.lock`;
  const tool = lock === undefined ? undefined : toolAt(lock, pin.line);
  if (!tool) return `${move.name}'s pin, mise.lock:${pin.line}, is in no tool's entry`;
  const target = readTarget(move.to);
  const to =
    target?.kind === 'tool' ? target.version : target?.kind === 'image' ? target.tag.replace(/^v/, '') : undefined;
  if (!to) return `${move.name} moves to ${move.to || 'nothing'}, which is no release of ${tool}`;
  return { ecosystem: 'tool', name: tool, from: move.from.replace(/^v/, ''), to };
}

/** What a seal of the moves made binds besides its bytes. */
const bound = (repository: string, run: string) => Buffer.from(`scan pins ${MADE_VERSION}\n${repository}\n${run}`);

export const sealMade = (made: Made, key: Buffer): Buffer => sealJson(made, key, bound(made.repository, made.run));

const isText = (value: unknown, most = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= most && !/\p{Cc}/u.test(value);
const isPlace = (value: unknown) => Number.isInteger(value) && (value as number) >= 1;
const PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\p{Cc}]+$/u;
const TAG = /^[\w][\w.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ECOSYSTEMS: unknown[] = ['npm', 'node', 'docker', 'tool'] satisfies PinStepMove['ecosystem'][];

/** What the scan made, opened for its repository and run and held to its shape, or a `StateError`. */
export function openMade(bytes: Buffer, key: Buffer, repository: string, run: string): Made {
  const made = openJson(bytes, key, bound(repository, run), 'moves the scan made', `run ${run} of ${repository}`);
  const problem = problemOf(made, repository, run);
  if (problem) throw new StateError(`the moves the scan made ${problem}`);
  return made as Made;
}

function problemOf(made: unknown, repository: string, run: string): string | undefined {
  if (typeof made !== 'object' || made === null) return 'are not an object';
  const m = made as Record<string, unknown>;
  if (m.version !== MADE_VERSION) return `are version ${JSON.stringify(m.version)}, not ${MADE_VERSION}`;
  if (m.repository !== repository) return "are another repository's";
  if (m.run !== run) return "are another run's";
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) return 'name no commit';
  if (!Array.isArray(m.groups)) return 'list no groups';
  for (const [index, each] of m.groups.entries()) {
    const at = `group ${index + 1}`;
    const g = (each ?? {}) as Record<string, unknown>;
    if (!Array.isArray(g.files) || !g.files.length || !g.files.every((f) => isText(f, 512) && PATH.test(f)))
      return `give ${at} no files`;
    if (typeof g.major !== 'boolean') return `do not say whether ${at} is named major`;
    if (!Array.isArray(g.moves) || !g.moves.every(isPlace)) return `give ${at} no moves`;
    if (!Array.isArray(g.refused) || !g.refused.every((r) => isPlace(r?.move) && isText(r?.reason, 8192)))
      return `give ${at} a refusal that is not one`;
    if (
      !Array.isArray(g.changed) ||
      !g.changed.every((c) => isText(c?.path, 512) && PATH.test(c.path) && typeof c?.text === 'string')
    )
      return `give ${at} a file that is not one`;
    if (
      !Array.isArray(g.steps) ||
      !g.steps.every(
        (p) =>
          isPlace(p?.move) &&
          ECOSYSTEMS.includes(p?.ecosystem) &&
          isText(p?.name, 214) &&
          Array.isArray(p?.before) &&
          Array.isArray(p?.after) &&
          [...p.before, ...p.after].every((v: unknown) => isText(v, 256)),
      )
    )
      return `give ${at} a move that is not one`;
    if (
      g.asked !== undefined &&
      (!Array.isArray(g.asked) ||
        !g.asked.every(
          (a) =>
            isText(a?.image, 512) && TAG.test(a?.tag ?? '') && typeof a?.digest === 'string' && DIGEST.test(a.digest),
        ))
    )
      return `give ${at} a registry's answer that is not one`;
  }
  return undefined;
}
