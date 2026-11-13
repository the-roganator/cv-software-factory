/**
 * A pin move's two sides, read (ADR 0019, condition 1): the lines the change rewrites, from each file whole at both
 * commits, and the scan's list at both, compared item by item into the pins it moves. The text first, so nothing
 * renders a head that changes more than versions and digests.
 */
import type { Chart, Item, Kind } from '../apps/factory/src/vulnerabilities/inventory.ts';
import { repositoryOf } from '../apps/factory/src/vulnerabilities/scan.ts';
import { short, VERSION_WORD } from './pin-move-shared.ts';

/** A place in a file: where a pin is written. */
export interface Place {
  file: string;
  line: number;
}

/** A line the change rewrites, at the same place before and after. */
export interface LineChange extends Place {
  before: string;
  after: string;
}

/** What one pin of the move is: an image's reference, a chart's version, or the digest a chart's value sets. */
export type What = 'image' | 'chart' | 'value';

/** One pin the move writes: where, what it pins before and after, and the item of the list it belongs to. */
export interface Moved {
  what: What;
  /** The list's item: its kind and name at the base. */
  kind: Kind;
  item: string;
  place: Place;
  from: string;
  to: string;
  /** For a chart or a value: the chart, at the base and at the head. */
  chart?: { base: Chart; head: Chart };
}

const MISE_FILES = new Set(['mise.toml', 'mise.lock']);
/** A digest's hex, and the words a line is read as. */
const HEX_WORD = /^[0-9a-f]{64}$/;
const WORDS = /[A-Za-z0-9._+-]+/g;

/** An image reference's tag and digest, each if it has one. */
export function tagAndDigest(reference: string) {
  const [name = '', digest] = reference.split('@');
  const repository = repositoryOf(reference);
  return { tag: name.length > repository.length ? name.slice(repository.length + 1) : undefined, digest };
}

/**
 * Whether a line changes only in versions and digests: the same words and the same text between them, each word that
 * differs a version or a digest's hex. An image's name, a key, a registry or anything else written differently is not a
 * pin's change.
 */
export function onlyPinsChange(before: string, after: string): boolean {
  if (before === after) return false;
  const split = (text: string) => ({ words: text.match(WORDS) ?? [], between: text.split(WORDS) });
  const a = split(before);
  const b = split(after);
  if (a.words.length !== b.words.length || a.between.join('\0') !== b.between.join('\0')) return false;
  return a.words.every((word, i) => {
    const other = b.words[i] as string;
    if (word === other) return true;
    return (VERSION_WORD.test(word) && VERSION_WORD.test(other)) || (HEX_WORD.test(word) && HEX_WORD.test(other));
  });
}

/** A file the change modifies, whole, as each commit has it: blobs read by git, never a patch's text. */
export interface Rewritten {
  path: string;
  before: string;
  after: string;
}

/**
 * The lines a change rewrites, from git's `--raw` list of the files it changes and each modified file's text at both
 * commits, or why it is not a change of pins' lines: each file modified in place, regular, with its mode, as many lines
 * before as after, and each line that differs only in versions and digests. Nothing under `.github/`, and neither of
 * mise's files. The two texts are compared line by line, never read from a patch, whose `+++` and `---` a line's own
 * text could imitate.
 */
export function lineChanges(raw: string, files: readonly Rewritten[]): { lines: LineChange[] } | { reason: string } {
  const entries = raw.split('\n').filter((line) => line.startsWith(':'));
  if (entries.length === 0) return { reason: 'it changes no file' };
  const paths: string[] = [];
  for (const entry of entries) {
    const [meta = '', ...rest] = entry.split('\t');
    const [modeA, modeB, , , status] = meta.slice(1).split(' ');
    const path = rest.join('\t');
    if (path.startsWith('.github/'))
      return { reason: `it changes ${path}: a pin under .github/ is a workflow's, and the App writes none` };
    if (MISE_FILES.has(path))
      return { reason: `it changes ${path}: mise's files move only when someone upgrades the toolchain` };
    if (status !== 'M')
      return {
        reason: `${path} is ${status === 'A' ? 'added' : status === 'D' ? 'deleted' : `changed (${status})`}, not modified in place`,
      };
    if (modeA !== modeB || !/^100(644|755)$/.test(modeA ?? ''))
      return { reason: `${path} changes its mode, or is not a regular file` };
    paths.push(path);
  }
  const lines: LineChange[] = [];
  for (const path of paths) {
    const file = files.find((each) => each.path === path);
    if (!file) return { reason: `the gate did not read ${path} at both commits` };
    if (file.before.includes('\0') || file.after.includes('\0')) return { reason: `${path} is binary` };
    const [a, b] = [file.before.split('\n'), file.after.split('\n')];
    if (a.length !== b.length)
      return {
        reason: `${path} adds or removes a line rather than rewriting one (${a.length} lines before, ${b.length} after)`,
      };
    const before = lines.length;
    for (const [i, was] of a.entries()) {
      const now = b[i] as string;
      if (was === now) continue;
      if (!onlyPinsChange(was, now))
        return { reason: `${path}:${i + 1} changes more than a version or a digest: ${short(now.trim())}` };
      lines.push({ file: path, line: i + 1, before: was, after: now });
    }
    if (lines.length === before) return { reason: `${path} rewrites no line` };
  }
  return { lines };
}

export const placeKey = (place: Place) => `${place.file}:${place.line}`;

/**
 * The pins the list moves between the base and the head, or why the two lists are not one move apart: the same items
 * in the same order at the same places, each the same but in what it pins.
 */
export function listMoves(base: readonly Item[], head: readonly Item[]): { moved: Moved[] } | { reason: string } {
  if (base.length !== head.length)
    return {
      reason: `the list has ${head.length} items at the head and ${base.length} at the base: it adds or removes one`,
    };
  const moved: Moved[] = [];
  for (const [i, was] of base.entries()) {
    const now = head[i] as Item;
    const at = `${was.file}:${was.line}`;
    if (now.kind !== was.kind || now.file !== was.file || now.line !== was.line)
      return { reason: `the list's ${was.kind} at ${at} is not at the same place at the head` };
    if (was.image !== undefined || now.image !== undefined) {
      if (!was.image || !now.image || repositoryOf(was.image) !== repositoryOf(now.image))
        return { reason: `${at} names another image at the head: ${short(now.image ?? 'none')}` };
      if (was.image !== now.image)
        moved.push({
          what: 'image',
          kind: was.kind,
          item: was.name,
          place: { file: was.file, line: was.line },
          from: was.image,
          to: now.image,
        });
    }
    if (was.chart || now.chart) {
      const [b, h] = [was.chart, now.chart];
      if (
        !b ||
        !h ||
        b.repo !== h.repo ||
        b.chart !== h.chart ||
        b.release !== h.release ||
        b.values.join('\n') !== h.values.join('\n')
      )
        return {
          reason: `${was.name}'s chart at ${at} is not the same chart, from the same repository, with the same values`,
        };
      if (b.version !== h.version)
        moved.push({
          what: 'chart',
          kind: was.kind,
          item: was.name,
          place: { file: was.file, line: was.line },
          from: b.version,
          to: h.version,
          chart: { base: b, head: h },
        });
      const [bp, hp] = [was.pins ?? [], now.pins ?? []];
      if (bp.length !== hp.length || bp.some((p, j) => placeKey(p) !== placeKey(hp[j] as Place)))
        return { reason: `${was.name}'s values pin images at other places at the head` };
      for (const [j, p] of bp.entries()) {
        const q = hp[j] as typeof p;
        if (p.digest !== q.digest)
          moved.push({
            what: 'value',
            kind: was.kind,
            item: was.name,
            place: { file: p.file, line: p.line },
            from: p.digest,
            to: q.digest,
            chart: { base: b, head: h },
          });
      }
    }
    if (!was.image && !was.chart && was.name !== now.name)
      return { reason: `${at} names ${short(now.name)} at the head` };
  }
  if (!moved.length) return { reason: 'the list moves no pin between the base and the head' };
  return { moved };
}
