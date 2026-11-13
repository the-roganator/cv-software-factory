/**
 * Forward on its line (ADR 0019, condition 4): the target resolved by the gate itself, as the scan resolves a fix, and
 * the images a chart's or a value's move runs in place of the ones before.
 */
import { compareVersions, newestOf } from '../apps/factory/src/vulnerabilities/deadlines.ts';
import { readTarget, type Target, targetText } from '../apps/factory/src/vulnerabilities/fixes.ts';
import { isMajor } from '../apps/factory/src/vulnerabilities/moves.ts';
import { repositoryOf } from '../apps/factory/src/vulnerabilities/scan.ts';
import type { Move } from './pin-move-one.ts';
import type { PinMoveIO } from './pin-move-readers.ts';
import { short, VERSION_WORD } from './pin-move-shared.ts';
import { tagAndDigest } from './pin-move-sides.ts';

/** The image a chart's rendering runs at a digest: the one reference there that carries it. */
function imageAt(rendered: string, digest: string): string | undefined {
  const found = new Set<string>();
  for (const line of rendered.split('\n')) {
    const image = /^\s*(?:-\s+)?image:\s*['"]?([a-z0-9][\w./:@-]*)['"]?\s*(?:#.*)?$/i.exec(line)?.[1];
    if (image?.endsWith(`@${digest}`)) found.add(image);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Whether an image's move is forward on its line, resolved by the gate: the same tag at its index digest now, or the
 * newest tag on its line (`newestOf`, as the scan resolves a fix) at its index digest now. Never back, never a major,
 * never a digest the tag does not name.
 */
export async function imageForward(
  from: string,
  to: string,
  io: Pick<PinMoveIO, 'tags' | 'digest'>,
): Promise<string | undefined> {
  const repository = repositoryOf(from);
  const was = tagAndDigest(from);
  const now = tagAndDigest(to);
  if (!was.tag || !now.tag) return `${repository} is pinned by digest alone: no tag to resolve the move by`;
  if (!now.digest) return `${short(to)} is not pinned by digest`;
  const target: Target = { kind: 'image', tag: now.tag, digest: now.digest };
  // The grammar the scan writes a fix in: a tag it cannot write is no target the scan would name.
  const read = readTarget(targetText(target));
  if (read?.kind !== 'image' || read.tag !== now.tag || read.digest !== now.digest)
    return `${short(to)} is not a target the scan's grammar writes`;
  if (now.tag !== was.tag) {
    const order = compareVersions(now.tag, was.tag);
    if (!/^v?\d/.test(now.tag) || !/^v?\d/.test(was.tag))
      return `${now.tag} is another tag than ${was.tag}, which is not a version`;
    if (order < 0) return `a move backwards, from ${was.tag} to ${now.tag}`;
    if (major(now.tag) !== major(was.tag)) return `a major, from ${was.tag} to ${now.tag}`;
    const newest = await newestOf(from, io.tags);
    if (!newest?.version) return `${was.tag} names no line the gate can resolve`;
    if (newest.tag !== now.tag) return `${now.tag} is not the newest tag on ${was.tag}'s line, ${newest.tag}`;
  }
  const current = await io.digest(`${repository}:${now.tag}`);
  if (current !== now.digest)
    return `a digest that is not the tag's: ${repository}:${now.tag} is ${current.slice(0, 19)} now, not ${now.digest.slice(0, 19)}`;
  return undefined;
}

const major = (version: string) => Number(/\d+/.exec(version)?.[0] ?? Number.NaN);

/**
 * Whether an image a chart's new version runs in place of one its old version ran is forward on its line: a version
 * tag on both, the same or later, on the same major, and, where the chart pins a digest, the tag's index digest now.
 * A chart pins its images as its publisher writes them, often by tag alone, so a bare version tag is whatever it names
 * when the cluster pulls it: that much is the chart's publisher's, as the chart is. A tag that is no version
 * (`nightly`, `latest`), a move back or across a major, or a digest the tag does not name, holds.
 */
export async function chartImageForward(
  from: string,
  to: string,
  io: Pick<PinMoveIO, 'digest'>,
): Promise<string | undefined> {
  const repository = repositoryOf(to);
  const was = tagAndDigest(from);
  const now = tagAndDigest(to);
  const version = (tag: string | undefined) => tag !== undefined && VERSION_WORD.test(tag);
  if (!version(now.tag)) return `${short(to)} is not pinned to a version tag: no line to hold it to`;
  if (!version(was.tag)) return `${short(from)} is not pinned to a version tag: no line to hold the move to`;
  const [a, b] = [was.tag as string, now.tag as string];
  // The line is the version's variant too: `1.4.0-alpine` moves to `1.4.1-alpine`, never to `-debian` or `-rc.1`.
  const variant = (tag: string) => tag.replace(/^v?\d+(\.\d+)*/, '');
  if (variant(a) !== variant(b)) return `${repository} moves off its line, from ${a} to ${b}`;
  if (/^[-+.]?(rc|alpha|beta|pre|dev|snapshot|nightly|canary)/i.test(variant(b)))
    return `${repository} ${b} is a prerelease, not a release`;
  if (was.digest && !now.digest) return `${short(to)} drops the digest ${short(from)} was pinned to`;
  if (compareVersions(b, a) < 0) return `a move backwards in ${repository}, from ${a} to ${b}`;
  if (major(b) !== major(a)) return `a major in ${repository}, from ${a} to ${b}`;
  if (now.digest) {
    const current = await io.digest(`${repository}:${b}`);
    if (current !== now.digest)
      return `a digest that is not the tag's: ${repository}:${b} is ${current.slice(0, 19)} now, not ${now.digest.slice(0, 19)}`;
  }
  return undefined;
}

/** Whether a chart's move is to a later version on the same major, which its repository's index has. */
export async function chartForward(move: Move, io: Pick<PinMoveIO, 'chartVersions'>): Promise<string | undefined> {
  const chart = move.pins[0]?.chart?.head;
  if (!chart) return `${move.name} names no chart`;
  if (compareVersions(move.to, move.from) <= 0) return `a move backwards, from ${move.from} to ${move.to}`;
  if (!/^v?\d+(\.\d+)*$/.test(move.to)) return `${chart.chart} ${move.to} is a prerelease, not a release`;
  const target: Target = {
    kind: 'chart',
    chart: chart.chart,
    version: move.to,
    major: major(move.to) !== major(move.from),
  };
  // The scan's rule for a chart's major is the flag its fix carries, set from the versions' first numbers as here.
  if (isMajor(target, move.from)) return `a major, from ${move.from} to ${move.to}`;
  const read = readTarget(targetText(target));
  if (read?.kind !== 'chart' || read.version !== move.to)
    return `${move.to} is not a version the scan's grammar writes`;
  const versions = await io.chartVersions(chart.repo, chart.chart);
  if (!versions.includes(move.to)) return `${chart.repo} has no ${chart.chart} ${move.to}`;
  return undefined;
}

/** The image references before and after each moved image, for the scans and the renderings. */
export async function imagePairs(
  move: Move,
  io: Pick<PinMoveIO, 'render'>,
): Promise<{ from: string; to: string }[] | string> {
  if (move.what === 'image') return [{ from: move.from, to: move.to }];
  const chart = move.pins[0]?.chart;
  if (!chart) return `${move.name} names no chart`;
  const [was, now] = await Promise.all([io.render('base', chart.base), io.render('head', chart.head)]);
  if (move.what === 'value') {
    const from = imageAt(was, move.from);
    const to = imageAt(now, move.to);
    if (!from || !to) return `${move.name}'s rendering runs no one image at its digest`;
    return [{ from, to }];
  }
  // A chart: each image its rendering runs at the head that it did not at the base, beside the one it replaces.
  const images = (text: string) =>
    new Set(
      text
        .split('\n')
        .flatMap((line) => /^\s*(?:-\s+)?image:\s*['"]?([a-z0-9][\w./:@-]*)['"]?\s*$/i.exec(line)?.[1] ?? []),
    );
  const [before, after] = [images(was), images(now)];
  const pairs: { from: string; to: string }[] = [];
  for (const to of after) {
    if (before.has(to)) continue;
    const from = [...before].find((each) => repositoryOf(each) === repositoryOf(to) && !after.has(each));
    if (!from) return `${move.name} ${move.to} runs an image ${move.from} did not: ${short(to)}`;
    pairs.push({ from, to });
  }
  for (const from of before)
    if (!after.has(from) && !pairs.some((p) => p.from === from))
      return `${move.name} ${move.to} no longer runs ${short(from)}`;
  if (!pairs.length) return `${move.name} ${move.to} runs the same images as ${move.from}: nothing to scan`;
  return pairs;
}
