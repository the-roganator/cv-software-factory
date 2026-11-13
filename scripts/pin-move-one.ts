/** The one move a pull request makes (ADR 0019, condition 1): one pin's name, from one value to one other, on its own lines. */
import type { Kind } from '../apps/factory/src/vulnerabilities/inventory.ts';
import { repositoryOf } from '../apps/factory/src/vulnerabilities/scan.ts';
import { type LineChange, literal, type Moved, placeKey, short, type What } from './pin-move-sides.ts';

/** The move a pull request makes, once the list shows it is one. */
export interface Move {
  what: What;
  /** What moves: an image's repository, a chart's name, or a chart's value. */
  name: string;
  kind: Kind;
  from: string;
  to: string;
  pins: Moved[];
}

/** The move the pins make, or why they are more than one: one item, one pin's name, from one value to one other. */
export function oneMove(moved: readonly Moved[]): { move: Move } | { reason: string } {
  const [first, ...rest] = moved;
  if (!first) return { reason: 'the list moves no pin' };
  const nameOf = (m: Moved) =>
    m.what === 'image'
      ? repositoryOf(m.from)
      : m.what === 'chart'
        ? m.item
        : `${m.item}'s value at ${placeKey(m.place)}`;
  const second = rest.find(
    (m) => m.what !== first.what || nameOf(m) !== nameOf(first) || m.from !== first.from || m.to !== first.to,
  );
  if (second) return { reason: `a second pin in the same change: ${nameOf(second)} beside ${nameOf(first)}` };
  return {
    move: { what: first.what, name: nameOf(first), kind: first.kind, from: first.from, to: first.to, pins: [...moved] },
  };
}

/** Whether every line the change rewrites is a pin the move writes, and every pin it writes is a line it rewrites. */
export function onlyItsPins(lines: readonly LineChange[], move: Move): string | undefined {
  const pins = new Set(move.pins.map((m) => placeKey(m.place)));
  const other = lines.find((line) => !pins.has(placeKey(line)));
  if (other) return `${placeKey(other)} is a line that is not a pin of ${move.name}: ${short(other.after.trim())}`;
  for (const m of move.pins) {
    const line = lines.find((each) => placeKey(each) === placeKey(m.place));
    if (!line) return `${placeKey(m.place)}, a pin of ${move.name}, is not a line it rewrites`;
    // The pin's own text, and nothing else on its line: the line as it was, with that one span written anew.
    if (!rewritesOnly(line, m))
      return `${placeKey(m.place)} changes more than ${move.name}'s pin: ${short(line.after.trim())}`;
  }
  return undefined;
}

/** Whether a line is its old text with the pin's span alone replaced: the reference, the version, or a value's tag and digest. */
function rewritesOnly(line: LineChange, m: Moved): boolean {
  const span = (text: string, value: string) => {
    const found = [...text.matchAll(new RegExp(`${m.what === 'value' ? '(?:[\\w.-]+@)?' : ''}${literal(value)}`, 'g'))];
    return found.length === 1 ? found[0]?.[0] : undefined;
  };
  const was = span(line.before, m.from);
  const now = span(line.after, m.to);
  return was !== undefined && now !== undefined && line.before.replace(was, now) === line.after;
}

/** The tag a value's line writes beside its digest (`tag: 2.14.3@sha256:…`), if it writes one. */
export const valueTag = (line: string) => /^\s*(?:tag|digest):\s*['"]?([\w.-]+)@sha256:/.exec(line)?.[1];
