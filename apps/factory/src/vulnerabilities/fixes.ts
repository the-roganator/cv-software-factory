/**
 * What fixes a finding, as the end of its alert's message says it: `Fixed by <target>, first seen <day>.` The one
 * grammar for writing and for reading it. The scan writes it (deadlines.ts) into each result's message before the
 * upload; a later run reads it back from the finding's alert, so the day a fix was first seen never moves forward; and
 * the GitHub worker reads it from the alerts for what `moves.json` withholds. A message that does not end this way says
 * no fix.
 *
 * The targets, each as the message writes it:
 *
 * - a version, or one for each copy of a package in several versions: `version 1.0.1`, `versions 1.0.1 and 2.0.3`;
 * - an image's tag with its index digest, as `scripts/ci-images.sh current` reads one: `image 2.14.3@sha256:<64 hex>`;
 * - a chart's version on the pinned major, or the first later major that has the fix: `chart grafana 13.7.0`,
 *   `chart grafana 14.3.1 (a major)`;
 * - a k3s release: `k3s v1.37.2+k3s1`;
 * - a tool's release, for what a tool in `mise.toml` brings into an image of ours: `tool pnpm 12.17.0`;
 * - a line no longer built, a move with no target, with the day its image was last made: `another line (this one last
 *   built 2025-10-16T08:00:00Z)`.
 *
 * The day is UTC to the second (`2026-11-10T19:19:04Z`): a fix's day, not a date, so the clock it starts reads the same
 * on every run.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */
import { DIGEST, DIGEST_PATTERN } from './reference.ts';

export type Target =
  | { kind: 'version'; versions: string[] }
  | { kind: 'image'; tag: string; digest: string }
  | { kind: 'chart'; chart: string; version: string; major: boolean }
  | { kind: 'k3s'; release: string }
  | { kind: 'tool'; tool: string; version: string }
  | { kind: 'unbuilt'; built: number };

/** A finding's fix: its target, and the day it was first seen installable, in milliseconds. */
export interface Fix {
  target: Target;
  day: number;
}

/** A day as the message writes it: UTC, to the second. */
export const dayText = (day: number) => new Date(Math.floor(day / 1000) * 1000).toISOString().replace('.000Z', 'Z');

const DAY = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`;
/** A version, a tag, a chart's or a tool's name: no spaces, commas or parentheses, which the grammar uses. */
const WORD = '[A-Za-z0-9][A-Za-z0-9._+~-]*';

const readDay = (text: string) => {
  const day = Date.parse(text);
  return Number.isNaN(day) ? undefined : day;
};

/** Whether a word fits the grammar: what the scan writes is checked before it is written. */
const fits = (word: string) => new RegExp(`^${WORD}$`).test(word);

/** A target as the message writes it. */
export function targetText(target: Target): string {
  switch (target.kind) {
    case 'version':
      return target.versions.length === 1
        ? `version ${target.versions[0]}`
        : `versions ${target.versions.join(' and ')}`;
    case 'image':
      return `image ${target.tag}@${target.digest}`;
    case 'chart':
      return `chart ${target.chart} ${target.version}${target.major ? ' (a major)' : ''}`;
    case 'k3s':
      return `k3s ${target.release}`;
    case 'tool':
      return `tool ${target.tool} ${target.version}`;
    case 'unbuilt':
      return `another line (this one last built ${dayText(target.built)})`;
  }
}

/** The words a target is made of, each of which must fit the grammar. */
function words(target: Target) {
  switch (target.kind) {
    case 'version':
      return target.versions;
    case 'image':
      return [target.tag];
    case 'chart':
      return [target.chart, target.version];
    case 'k3s':
      return [target.release];
    case 'tool':
      return [target.tool, target.version];
    case 'unbuilt':
      return [];
  }
}

/** Whether a fix can be written so that it reads back the same. */
export function writable(fix: Fix) {
  const target = fix.target;
  if (!Number.isFinite(fix.day)) return false;
  if (target.kind === 'version' && !target.versions.length) return false;
  if (target.kind === 'image' && !DIGEST.test(target.digest)) return false;
  if (target.kind === 'unbuilt' && !Number.isFinite(target.built)) return false;
  return words(target).every(fits);
}

/** The end of a result's message: `Fixed by <target>, first seen <day>.` */
export function fixText(fix: Fix) {
  if (!writable(fix)) throw new Error(`a fix the grammar cannot write: ${JSON.stringify(fix)}`);
  return `Fixed by ${targetText(fix.target)}, first seen ${dayText(fix.day)}.`;
}

const ENDING = new RegExp(String.raw`(?:^| )Fixed by (.+), first seen (${DAY})\.$`);

/**
 * Where a result's move is, after its fix: its place in that run's `moves.json` (`moves`, from 1) and the run, `Move 3
 * of run 19234567890.`, so a reader of the alerts ties each to its move and can tell an upload from another run than
 * the artifact's. An index names nothing about a lockfile's hidden package.
 */
export interface MoveTag {
  index: number;
  run: string;
}

const MOVE = / Move (\d+) of run (\d+)\.$/;

/** A result's move, as its message ends after its fix. */
export function moveText(tag: MoveTag) {
  if (!Number.isInteger(tag.index) || tag.index < 1 || !/^\d+$/.test(tag.run))
    throw new Error(`a move the grammar cannot write: ${JSON.stringify(tag)}`);
  return `Move ${tag.index} of run ${tag.run}.`;
}

/** The move a message ends with, or undefined when it names none. */
export function readMove(message: string): MoveTag | undefined {
  const m = MOVE.exec(message);
  return m?.[1] && m[2] ? { index: Number(m[1]), run: m[2] } : undefined;
}

/** A target from its text, or undefined. */
export function readTarget(text: string): Target | undefined {
  let m = new RegExp(`^version (${WORD})$`).exec(text);
  if (m?.[1]) return { kind: 'version', versions: [m[1]] };
  m = new RegExp(`^versions (${WORD}(?: and ${WORD})+)$`).exec(text);
  if (m?.[1]) return { kind: 'version', versions: m[1].split(' and ') };
  m = new RegExp(`^image (${WORD})@(${DIGEST_PATTERN})$`).exec(text);
  if (m?.[1] && m[2]) return { kind: 'image', tag: m[1], digest: m[2] };
  m = new RegExp(`^chart (${WORD}) (${WORD})( \\(a major\\))?$`).exec(text);
  if (m?.[1] && m[2]) return { kind: 'chart', chart: m[1], version: m[2], major: m[3] !== undefined };
  m = new RegExp(`^k3s (${WORD})$`).exec(text);
  if (m?.[1]) return { kind: 'k3s', release: m[1] };
  m = new RegExp(`^tool (${WORD}) (${WORD})$`).exec(text);
  if (m?.[1] && m[2]) return { kind: 'tool', tool: m[1], version: m[2] };
  m = new RegExp(`^another line \\(this one last built (${DAY})\\)$`).exec(text);
  const built = m?.[1] ? readDay(m[1]) : undefined;
  if (built !== undefined) return { kind: 'unbuilt', built };
  return undefined;
}

/**
 * The fix a message ends with, or undefined when it ends otherwise. A message whose ending looks like a fix but does
 * not parse is an error, not a finding with no fix: the caller decides what that costs.
 */
export function readFix(message: string): Fix | undefined {
  if (!/(?:^| )Fixed by /.test(message)) return undefined;
  const m = ENDING.exec(message.replace(MOVE, ''));
  const target = m?.[1] ? readTarget(m[1]) : undefined;
  const day = m?.[2] ? readDay(m[2]) : undefined;
  if (!target || day === undefined) throw new Error('a message ends with a fix the grammar does not read');
  return { target, day };
}
