/**
 * The pins that are merely behind: each one the scan lists with no finding on it that a newer release would clear, and
 * the release it would move to, once that release has waited. moves.ts makes each a routine move, after the findings'
 * moves, and the same lanes, pull requests and gate carry it, so nothing is left on an old version for want of an
 * advisory.
 *
 * A function of the targets the scan read, the checkout's files, the registries' answers, the records the last state
 * kept, the policy and the time: it reads each pin as deadlines.ts reads it for a finding (`Lookups`, which
 * `installable` shares, so a repository's tags, a digest and a chart's index are asked once a run), and names it by the
 * same rule, so a routine move and a finding's move of one pin have one name, one `from` and one branch.
 *
 * What is behind, by the kind of pin:
 *
 * - **An image's pin** (a third-party image under `deploy/`, a Dockerfile's stage, the runtime stage of an image of
 *   ours, a value's pin in a chart's values file, an image a workflow names): the newest tag on its line (`newestOf`),
 *   or for a tag that is not a version the image it names now. Behind when the tag differs, or the tag is the same and
 *   a pin's digest is not the index digest the registry serves, which is asked with a request no registry counts as
 *   a pull. An image that runs Node waits for mise as a fix does (`nodeReady`). A newer tag on the line is never
 *   another major: the line keeps its first number, so Node's and Postgres's majors are no routine move. Each run
 *   reads the line's newest tag and the tags the state has waiting for the pin, and takes the newest that has waited.
 * - **A chart** (an Application's, and the Makefile's): the newest version on the pinned major that renders with our
 *   values; only when that major has nothing newer, the newest of the next major there is, a major.
 * - **k3s**: the newest published release on its line (`k3sLine`).
 * - **A lockfile's package**: a direct dependency alone (one an importer of a `pnpm-lock.yaml` outside fixtures names
 *   in `dependencies`, `devDependencies` or `optionalDependencies`), from the version the lockfile resolves it at to
 *   the newest release its manifest's range admits; only when the range admits nothing newer, the newest release
 *   outside it, a major whatever its numbers, since the pin step writes the manifest for it. Never a prerelease, a
 *   deprecated release, or one past the registry's `latest`. A package the lockfile resolves at two versions, and a
 *   range that is not `^`, `~` or a version (a workspace's, a link, a file, git, an alias), is left alone: the pin step
 *   moves no other.
 *
 * Never listed: what mise pins (a tool, Node itself, k3d's images), since the toolchain moves only when someone
 * upgrades it or for a finding, though an image's move still brings the Node it runs; an image of ours, whose digest
 * is `build.yml`'s, pinned by the deploy pull requests; a pin with no tag; and anything `policy/vulnerabilities.ts`
 * leaves alone (`ROUTINE.leave`).
 *
 * **The wait.** A release is listed once it has waited `ROUTINE.days`, `majorDays` for a major, on top of the waits a
 * fix has (pnpm's `minimumReleaseAge`, mise's for a Node an image brings). A package's day is npm's publish time and
 * a k3s release's its publication on GitHub, which the registry writes, not the publisher; neither is taken to be
 * later than the day the scan first saw the release. An image and a chart have no such day: the time an image's
 * configuration says it was made, and a chart index's `created`, are their publisher's to write, and a backdated one
 * would list the day it appeared. So an image's tag and a chart's version wait from the day the scan first saw the pin
 * behind them, which the state keeps (`StateRoutine.seen`); with no state to read (a proving run, a repository's
 * first run, a state lost) no image or chart is listed, and the wait starts that day. The wait is kept by the pin and
 * the release, never the release's digest: a tag built again while it waits, or after, is the release it was. A record
 * belongs to the pin as it was (its name, what it pins, and the digests an image's pins hold): once the pin moves,
 * its records are dropped and the wait starts again. Where the newest release is too young and an older one is not,
 * the pin takes the newest that has waited: a package's, a chart's and k3s's from what their registries list, an
 * image's from the tags the state has waiting for the pin, at most `TAGS`, and while they are that many no newer tag
 * is taken up, so a line that tags faster than the wait still comes due. A wait counted from the scan's first sight
 * (an image's, a chart's, and its content's day below) may be `ROUTINE.slackHours` less than its days (state.ts's
 * `waitMs`): the daily scan starts minutes either side of its time, and a day by its own clock is not always 24 hours.
 *
 * **The content's day.** A tag is a name, and its publisher, or whoever holds the account, can push it again: so an
 * image's move lists only at a digest the scan first saw at least `ROUTINE.contentDays` ago, on top of the tag's
 * wait. The state keeps the digests each waiting tag served, with the day each was first seen
 * (`StateRoutine.content`), and the move lists at the digest the tag serves that day where that has waited, or else
 * at the newest it has seen that has, so a tag rebuilt every day comes due all the same, a day behind, and one pushed
 * again after its wait lists at what it was. A digest the tag no longer serves is asked for by itself before it is
 * listed: one the registry has dropped is forgotten, and the pin waits for the next. A pin whose tag has waited and
 * whose content has not is in the listing's `waits`, which `moves.json` gives as `waiting`: it is no move that day,
 * and not a move gone. A chart's pin holds no digest
 * and its index's is not read, so a chart's content is its version, whose day is the first sight its wait already
 * counts from. A package has pnpm's wait, and k3s its release's day on GitHub.
 *
 * **It never fails the run.** A lookup that fails costs that pin's routine move for the day, with one warning for each
 * source, which never names a lockfile's package: the log is public.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */
import type { Routine } from '../../../../policy/vulnerabilities.ts';
import { repositoryOfImage } from '../repositories.ts';
import {
  CANDIDATES,
  EARLIEST,
  K3S_IMAGE,
  k3sLine,
  newestOf,
  newestOnLine,
  type PackageVersions,
  pool,
  type Sources,
  type Where,
} from './deadlines.ts';
import { dayText, readTarget, type Target, targetText, writable } from './fixes.ts';
import { type Chart, isFixture } from './inventory.ts';
import { type Behind, isMajor, isRoutine, type Move, type Pin, pinKey, type RoutineWait } from './moves.ts';
import { satisfies } from './node.ts';
import { repositoryOf, splitReference } from './reference.ts';
import { lockfileLine, type ReadTarget } from './scan.ts';
import { type StateRoutine, type StateSeen, settle, waitMs } from './state.ts';
import { compareTags, compareVersions, majorOf } from './versions.ts';

const DAY = 86_400_000;

/** The most tags of one image's line the state keeps for a pin: the newest that has waited and those still waiting. */
export const TAGS = 8;

/** A version with no prerelease, and a manifest's range the pin step moves: `^`, `~` or a version. */
const PLAIN = /^\d+\.\d+\.\d+$/;
const RANGE = /^[\^~]?\d+\.\d+\.\d+$/;

/** The sections of a lockfile's importer that name its direct dependencies. */
const DIRECT = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);

/**
 * How deadlines.ts reads a pin, shared by `installable`, each answer asked once a run: a repository's tags, a
 * reference's index digest, when the Node an image runs is one mise may install, the runtime stage of an image of
 * ours, where a target's pin is written and what it pins now, a chart's versions, a chart's rendering (none when it
 * does not render with our values), and a k3s release.
 */
export interface Lookups {
  tags(repository: string): Promise<string[]>;
  digest(reference: string): Promise<string>;
  nodeReady(reference: string): Promise<number | undefined>;
  stageOf(target: ReadTarget): { image: string; dockerfile: string; line: number } | undefined;
  where(target: ReadTarget): Where;
  chartVersions(chart: Chart): Promise<{ version: string; created: string }[]>;
  rendered(chart: Chart): Promise<string[] | undefined>;
  k3s(release: string): Promise<{ published: string; images: string[] } | undefined>;
}

/** What the listing is made from. */
export interface Asked {
  repository: string;
  targets: ReadTarget[];
  sources: Pick<Sources, 'file' | 'versions' | 'served'>;
  lookups: Lookups;
  /** The wait and what is left alone, or none, and then nothing is listed. */
  policy: Routine | undefined;
  /** The records the last state kept (`State.routine`): when each target was first seen. */
  last?: StateRoutine[] | undefined;
  /** When the scan first saw each content any record of the last state has a day for (state.ts's `sightings`). */
  seen?: Map<string, number> | undefined;
  /** The pins a finding's move has (moves.ts's `pinsOf`): none of them is looked up. */
  taken?: Set<string> | undefined;
  /** pnpm's `minimumReleaseAge` in the scanned repository, in minutes. */
  minimumReleaseAge: number;
  now: number;
  log?: ((line: string) => void) | undefined;
}

/** A release a pin is behind, as the state keeps it, before its move has a place. */
export type Seen = Omit<StateRoutine, 'move'>;

export interface Listing {
  /** Each pin that is behind and whose release has waited. */
  behind: Behind[];
  /** Each release considered, listed or still waiting, with the day it was first seen. */
  records: Seen[];
  /**
   * Each image whose tag has waited its days and whose content has not waited its own (`ROUTINE.contentDays`): the
   * first of its digests to come due, and when. Absent where there is none.
   */
  waits?: RoutineWait[] | undefined;
  /** The pins read, by what became of them: listed, waiting for a release's day, up to date, or left alone. */
  counts: { pins: number; listed: number; waiting: number; current: number; left: number; unread: number };
}

/** A lockfile's direct dependencies: each one an importer names, with its manifest's range and where it resolves. */
export function directs(lockfile: string) {
  const found: { name: string; specifier: string; version: string }[] = [];
  const unquoted = (text: string) => text.trim().replace(/^(['"])(.*)\1$/, '$2');
  let importers = false;
  let section = '';
  let name = '';
  let specifier = '';
  for (const line of lockfile.split('\n')) {
    if (/^\S/.test(line)) {
      importers = line.trimEnd() === 'importers:';
      section = '';
      continue;
    }
    if (!importers) continue;
    if (/^ {2}\S/.test(line)) section = '';
    const head = /^ {4}(\S+?):/.exec(line);
    if (head?.[1]) {
      section = head[1];
      name = '';
      continue;
    }
    if (!DIRECT.has(section)) continue;
    const key = /^ {6}(\S.*?):\s*$/.exec(line);
    if (key?.[1]) {
      name = unquoted(key[1]);
      specifier = '';
      continue;
    }
    const field = /^ {8}(specifier|version):\s*(.+)$/.exec(line);
    if (!field?.[2] || !name) continue;
    if (field[1] === 'specifier') specifier = unquoted(field[2]);
    // The version as the importer resolves it: its peers, in brackets after it, are no part of it.
    else found.push({ name, specifier, version: unquoted(field[2]).replace(/\(.*$/, '') });
  }
  return found;
}

/** The versions a lockfile resolves a package at, from the keys of its `packages:`. */
function lockedAt(lockfile: string, name: string) {
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const key = new RegExp(`^ {2}'?${literal}@([^'(:\\s]+)['(:]`, 'gm');
  return new Set([...lockfile.matchAll(key)].map((m) => m[1] ?? ''));
}

/**
 * The entry that leaves a package, or an image by its repository's name, alone in a repository: every move of it, or
 * with `major` only its majors.
 */
export function leftAlone(
  policy: Routine,
  repository: string,
  what: { package: string } | { image: string },
  major: boolean,
) {
  return policy.leave.find(
    (entry) =>
      (entry.repository === 'all' || entry.repository === repository) &&
      ('image' in what ? entry.image === what.image : entry.package === what.package) &&
      (!entry.major || major),
  );
}

/** One pin, wherever it is written: what is asked of the registries for it. */
interface Pinned extends Omit<Where, 'pin'> {
  how: 'image' | 'chart' | 'k3s' | 'npm';
  pins: Map<string, Pin>;
  /** An image's references, as each pin writes it. */
  references: Set<string>;
  chart?: Chart | undefined;
  /** A package's ranges, one for each importer that names it. */
  specifiers: Set<string>;
}

type Outcome = 'listed' | 'waiting' | 'current' | 'left';

const time = (text: string | undefined) => (text ? Date.parse(text) : Number.NaN);
const newestFirst = (a: { version: string }, b: { version: string }) => compareVersions(b.version, a.version);
const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 300) ?? '';

/** The pins the list has, each once: an image's, a chart's, k3s's, and each lockfile's direct dependencies. */
function pinned(asked: Asked) {
  const { targets, sources, lookups } = asked;
  const groups = new Map<string, Pinned>();
  const add = (how: Pinned['how'], where: Where, reference?: string, chart?: Chart, specifier?: string) => {
    const key = JSON.stringify([how, pinKey(where)]);
    const group = groups.get(key) ?? {
      how,
      kind: where.kind,
      name: where.name,
      from: where.from,
      pins: new Map(),
      references: new Set(),
      chart,
      specifiers: new Set(),
    };
    group.pins.set(`${where.pin.file}:${where.pin.line}`, where.pin);
    if (reference) group.references.add(reference);
    if (specifier) group.specifiers.add(specifier);
    groups.set(key, group);
  };
  for (const target of targets) {
    // What mise pins (k3d's images, at its version in mise.lock) moves with the toolchain.
    if (target.kind === 'lockfile' || target.kind === 'k3d') continue;
    if (target.kind === 'k3s' || target.kind === 'k3s-release') {
      add('k3s', lookups.where(target));
      continue;
    }
    // The chart's own pin, whichever of its images the target is: an image a values file pins is a pin of its own.
    if (target.kind === 'chart' && target.chart)
      add('chart', lookups.where({ ...target, pin: undefined }), undefined, target.chart);
    if (target.kind === 'chart' && !target.pin) continue;
    const reference = target.kind === 'ours' ? lookups.stageOf(target)?.image : target.image;
    // An image of ours is build.yml's to pin; one with no tag names no line to be behind on.
    if (!reference || repositoryOfImage(repositoryOf(reference)) || !splitReference(reference).tag) continue;
    add('image', lookups.where(target), reference);
  }
  // Each lockfile pnpm installs where it lies, as the coverage job takes them: a package by its name, wherever it is.
  const packages = new Map<string, { file: string; lines: string[]; specifier: string; version: string }[]>();
  const versions = new Map<string, Set<string>>();
  for (const target of targets) {
    if (target.kind !== 'lockfile' || !/(^|\/)pnpm-lock\.yaml$/.test(target.file) || isFixture(target.file)) continue;
    const text = sources.file(target.file);
    if (text === undefined) continue;
    const lines = text.split('\n');
    for (const direct of directs(text)) {
      packages.set(direct.name, [...(packages.get(direct.name) ?? []), { file: target.file, lines, ...direct }]);
      const at = versions.get(direct.name) ?? new Set<string>();
      for (const version of lockedAt(text, direct.name)) at.add(version);
      versions.set(direct.name, at.add(direct.version));
    }
  }
  let left = 0;
  for (const [name, places] of packages) {
    const version = places[0]?.version ?? '';
    // One version, from the registry, in a range the pin step moves: anything else is left as it is.
    if (
      versions.get(name)?.size !== 1 ||
      !PLAIN.test(version) ||
      places.some((place) => !RANGE.test(place.specifier))
    ) {
      left++;
      continue;
    }
    for (const place of places)
      add(
        'npm',
        {
          kind: 'lockfile',
          name,
          pin: { file: place.file, line: lockfileLine(place.lines, name, version) },
          from: version,
        },
        undefined,
        undefined,
        place.specifier,
      );
  }
  return { groups: [...groups.values()], left };
}

/**
 * The day's pins that are behind, each with the release it moves to, and the record of each release considered. It
 * throws nothing a lookup can cause: a fault costs that pin's move, and is said once for its source.
 */
export async function routine(asked: Asked): Promise<Listing> {
  const { repository, sources, lookups, policy, now } = asked;
  const log = asked.log ?? (() => {});
  const counts = { pins: 0, listed: 0, waiting: 0, current: 0, left: 0, unread: 0 };
  if (!policy) return { behind: [], records: [], counts };
  const { groups, left } = pinned(asked);
  counts.left = left;
  counts.pins = groups.length + left;
  const behind: Behind[] = [];
  const waits: RoutineWait[] = [];
  const records = new Map<string, Seen>();
  /** The digests an image's pins hold, in order: what tells a pin from the same pin once it has moved on its tag. */
  const heldOf = (group: Pinned) =>
    [...new Set([...group.references].flatMap((each) => splitReference(each).digest ?? []))].sort();
  /**
   * What a wait is kept by: the pin as it is (its name, what it pins, and for an image the digests it holds) and the
   * release, never a digest of the release, so a tag built again is the release it was, and a pin that has moved, to
   * another tag or on its own, is another pin, whose records are dropped.
   */
  const waitKey = (pin: { name: string; from: string; held?: string[] | undefined }, target: Target) =>
    JSON.stringify([
      pin.name,
      pin.from,
      pin.held ?? [],
      target.kind === 'image' ? `image ${target.tag}` : targetText(target),
    ]);
  const pinOf = (each: { name: string; from: string; held?: string[] | undefined }) =>
    JSON.stringify([each.name, each.from, each.held ?? []]);
  const before = new Map<string, number>();
  /** The digests each waiting tag served, as the last state has them, and the tags it has for each pin. */
  const contents = new Map<string, StateSeen[]>();
  const known = new Map<string, Set<string>>();
  for (const each of asked.last ?? []) {
    const seen = Date.parse(each.seen);
    const target = readTarget(each.to);
    if (Number.isNaN(seen) || !target) continue;
    const key = waitKey(each, target);
    before.set(key, Math.min(before.get(key) ?? seen, seen));
    if (target.kind !== 'image') continue;
    contents.set(key, [...(contents.get(key) ?? []), ...(each.content ?? [])]);
    known.set(pinOf(each), (known.get(pinOf(each)) ?? new Set()).add(target.tag));
  }
  /**
   * Whether a release has waited its days, and whatever else it waits for: its record is kept either way, with the
   * day the scan first saw it for this pin. `own` is the release's day where its registry, not its publisher, gives
   * one, never taken to be later than that first sight; with none (an image, a chart), first sight is its day.
   */
  const waited = (group: Pinned, target: Target, own: number, days: number, also = 0, content?: StateSeen[]) => {
    const held = heldOf(group);
    const key = waitKey({ ...group, held }, target);
    const last = before.get(key);
    const seen = last !== undefined && last < now ? last : now;
    const day = Number.isFinite(own) && own >= EARLIEST && own < seen ? own : seen;
    records.set(key, {
      name: group.name,
      from: group.from,
      to: targetText(target),
      pins: pinsOf(group),
      ...(held.length ? { held } : {}),
      seen: dayText(seen),
      ...(content?.length ? { content } : {}),
    });
    // Counted from the scan's own first sight, the days are less the slack of a scan that starts a little early.
    const wait = day === seen ? waitMs(days, policy.slackHours) : days * DAY;
    return day + wait <= now && also <= now;
  };
  const pinsOf = (group: Pinned) =>
    [...group.pins.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const list = (group: Pinned, to: Target, outside = false): Outcome => {
    behind.push({ kind: group.kind, name: group.name, pins: pinsOf(group), from: group.from, to, outside });
    return 'listed';
  };
  const usable = (target: Target) => writable({ target, day: now });
  /** A tag that has waited and whose content has not: the first of the digests seen to come due, and when. */
  const contentWait = (group: Pinned, seen: StateSeen[]): Outcome => {
    const wait = waitMs(policy.contentDays, policy.slackHours);
    const [first] = seen
      .map((each) => ({ to: readTarget(each.target), until: Date.parse(each.seen) + wait }))
      .filter((each) => each.to && !Number.isNaN(each.until))
      .sort((a, b) => a.until - b.until);
    if (first?.to)
      waits.push({ kind: group.kind, name: group.name, pins: pinsOf(group), from: group.from, ...first, to: first.to });
    return 'waiting';
  };

  const image = async (group: Pinned): Promise<Outcome> => {
    const [reference = ''] = group.references;
    const { repository: name, tag = '' } = splitReference(reference);
    if (leftAlone(policy, repository, { image: name }, false)) return 'left';
    const latest = await newestOf(reference, lookups.tags);
    // A registry that lists nothing as new as the pin moves nothing back.
    if (!latest || (latest.version && compareTags(latest.tag, tag) < 0)) return 'current';
    const held = heldOf(group);
    // The tags the state has for the pin that the line still lists, and the newest while they are fewer than `TAGS`.
    const listed = latest.version ? await lookups.tags(name) : [latest.tag];
    const had = [...(known.get(pinOf({ ...group, held })) ?? [])].filter(
      (each) => listed.includes(each) && (!latest.version || newestOnLine(tag, [each])) && compareTags(each, tag) >= 0,
    );
    const tags = had.includes(latest.tag) || had.length >= TAGS ? had : [...had, latest.tag];
    // The digest alone is wanted: asked with a request a registry does not count as a pull, where the sources have one.
    const served = sources.served ?? lookups.digest;
    let waiting = false;
    for (const each of tags.sort((a, b) => compareTags(b, a))) {
      const digest = await served(`${name}:${each}`);
      // The pin's own tag, serving what the pin holds: nothing there, or older, to move to.
      if (each === tag && held.every((pin) => pin === digest)) break;
      const today: Target = { kind: 'image', tag: each, digest };
      if (!usable(today)) continue;
      // The digests the tag has served: today's from the first day any record saw it, and the one a move lists at.
      const key = waitKey({ ...group, held }, today);
      const last = contents.get(key) ?? [];
      const text = targetText(today);
      const first = Math.min(
        now,
        asked.seen?.get(digest) ?? now,
        ...last.filter((seen) => seen.target === text).map((seen) => Date.parse(seen.seen)),
      );
      const content = settle(
        last,
        { target: text, seen: dayText(first) },
        (seen) => Date.parse(seen.seen) + waitMs(policy.contentDays, policy.slackHours) <= now,
      );
      const due = content.due && readTarget(content.due.target);
      const target = due?.kind === 'image' ? due : today;
      // The wait is from the first day the scan saw the pin behind this tag, whatever digest the tag served then: the
      // day an image says it was made is its publisher's to write. A newer tag that waits still leaves the older ones.
      waiting = true;
      if (!waited(group, target, Number.NaN, policy.days, 0, content.kept)) continue;
      // The newest tag that has waited: it lists at a digest that has waited its own day, or not yet.
      if (!due) return contentWait(group, content.kept);
      const at = target.digest === digest ? `${name}:${each}` : `${name}@${target.digest}`;
      if (target.digest !== digest && !(await served(at).catch(() => undefined))) {
        // A digest the tag has moved on from and the registry no longer has: forgotten, and the next is waited for.
        const left = content.kept.filter((seen) => seen !== content.due);
        waited(group, today, Number.NaN, policy.days, 0, left);
        return contentWait(group, left);
      }
      // An image that runs Node brings its Node, which waits for mise as Node's own move does.
      const ready = await lookups.nodeReady(at);
      return ready !== undefined && ready <= now ? list(group, target) : 'waiting';
    }
    return waiting ? 'waiting' : 'current';
  };

  const chart = async (group: Pinned): Promise<Outcome> => {
    const pin = group.chart;
    // The pin read as a fix for it reads it (`chartFix`): by its major, a `v` before it or none.
    const pinnedMajor = pin ? majorOf(pin.version) : undefined;
    if (!pin || pinnedMajor === undefined) return 'current';
    const newer = (await lookups.chartVersions(pin)).filter(
      (each) => PLAIN.test(each.version) && compareVersions(each.version, pin.version) > 0,
    );
    if (!newer.length) return 'current';
    // The pinned major while it has anything newer; only then the next major there is.
    const same = newer.filter((each) => majorOf(each.version) === pinnedMajor);
    const [next] = newer.map((each) => majorOf(each.version) ?? '').sort(compareVersions);
    const major = !same.length;
    const candidates = (major ? newer.filter((each) => majorOf(each.version) === next) : same).sort(newestFirst);
    let tried = 0;
    for (const candidate of candidates) {
      const target: Target = { kind: 'chart', chart: pin.chart, version: candidate.version, major };
      if (!usable(target)) continue;
      // From the first day the scan saw the version: the index's `created` is its publisher's to write. That day is
      // its content's too, so the wait is never less than the content's.
      const days = Math.max(major ? policy.majorDays : policy.days, policy.contentDays);
      if (!waited(group, target, Number.NaN, days)) continue;
      // The newest that has waited and renders with our values, a few tried: one that does not is passed over.
      if (++tried > CANDIDATES) break;
      if (await lookups.rendered({ ...pin, version: candidate.version })) return list(group, target);
    }
    return 'waiting';
  };

  const k3s = async (group: Pinned): Promise<Outcome> => {
    const after = k3sLine(group.from, await lookups.tags(K3S_IMAGE)).reverse();
    if (!after.length) return 'current';
    for (const release of after.slice(0, CANDIDATES)) {
      // A tag with no published, stable release is nothing to install.
      const read = await lookups.k3s(release);
      const target: Target = { kind: 'k3s', release };
      if (read && usable(target) && waited(group, target, time(read.published), policy.days))
        return list(group, target);
    }
    return 'waiting';
  };

  const packuments = new Map<string, Promise<PackageVersions | undefined>>();
  const npm = async (group: Pinned): Promise<Outcome> => {
    if (!sources.versions) return 'current';
    if (leftAlone(policy, repository, { package: group.name }, false)) return 'left';
    let once = packuments.get(group.name);
    if (!once) {
      once = sources.versions(group.name);
      packuments.set(group.name, once);
    }
    const read = await once;
    if (!read) throw new Error('no such package');
    const latest = read.latest;
    const newer = read.versions
      .filter(
        (each) =>
          PLAIN.test(each.version) &&
          compareVersions(each.version, group.from) > 0 &&
          (!latest || compareVersions(each.version, latest) <= 0),
      )
      .sort(newestFirst);
    if (!newer.length) return 'current';
    const admitted = newer.filter((each) => [...group.specifiers].every((range) => satisfies(each.version, range)));
    // What the range admits; only when it admits nothing newer, the newest outside it, a major.
    const outside = !admitted.length;
    if (outside && leftAlone(policy, repository, { package: group.name }, true)) return 'left';
    for (const candidate of outside ? newer : admitted) {
      const target: Target = { kind: 'version', versions: [candidate.version] };
      const days = outside || isMajor(target, group.from) ? policy.majorDays : policy.days;
      const published = time(candidate.published);
      if (usable(target) && waited(group, target, published, days, published + asked.minimumReleaseAge * 60_000))
        return list(group, target, outside);
    }
    return 'waiting';
  };

  // A fault, by its source: said once, with how many pins it cost, and never with a lockfile's package.
  const faults = new Map<string, { pins: number; why: string }>();
  const sourceOf = (group: Pinned) => {
    if (group.how === 'npm') return "npm's registry";
    if (group.how === 'k3s') return "k3s's releases";
    if (group.how === 'chart') return `the chart repository ${group.chart?.repo ?? ''}`;
    return `the registry of ${repositoryOf([...group.references][0] ?? group.name)}`;
  };
  const reads = { image, chart, k3s, npm };
  // The pins not read today, whose records of the last run stand: a day's fault restarts no release's wait.
  const unread = new Set<string>();
  await pool(
    groups.map((group) => async () => {
      if (asked.taken?.has(pinKey(group))) {
        counts.current++;
        unread.add(pinOf({ ...group, held: heldOf(group) }));
        return;
      }
      try {
        counts[await reads[group.how](group)]++;
      } catch (error) {
        counts.unread++;
        unread.add(pinOf({ ...group, held: heldOf(group) }));
        const source = sourceOf(group);
        const fault = faults.get(source) ?? { pins: 0, why: group.how === 'npm' ? '' : firstLine(error) };
        fault.pins++;
        faults.set(source, fault);
      }
    }),
  );
  for (const [source, fault] of [...faults].sort(([a], [b]) => (a < b ? -1 : 1)))
    log(
      `::warning::${source} could not be read for ${fault.pins} ${fault.pins === 1 ? 'pin' : 'pins'}${fault.why ? ` (${fault.why})` : ''}: no routine move is listed for ${fault.pins === 1 ? 'it' : 'them'} today.`,
    );
  for (const { move: _, ...each } of asked.last ?? []) {
    const target = readTarget(each.to);
    const key = target && waitKey(each, target);
    if (key && unread.has(pinOf(each)) && !records.has(key) && before.has(key)) records.set(key, each);
  }
  const sorted = [...records.values()].sort((a, b) =>
    a.name !== b.name
      ? a.name < b.name
        ? -1
        : 1
      : a.from !== b.from
        ? a.from < b.from
          ? -1
          : 1
        : a.to < b.to
          ? -1
          : 1,
  );
  return { behind, records: sorted, counts, ...(waits.length ? { waits } : {}) };
}

/**
 * The state's records of the day's routine listing: each release's, with its move's place in the list where it has
 * one, and its major where the move is one. Every routine move listed has its record, a lockfile's or not.
 */
export function recorded(records: Seen[], list: Move[]): StateRoutine[] {
  return records.map((record) => {
    const at = list.findIndex(
      (move) =>
        isRoutine(move) &&
        move.name === record.name &&
        move.from === record.from &&
        move.to !== undefined &&
        targetText(move.to) === record.to,
    );
    return at < 0 ? record : { move: at + 1, ...record, ...(list[at]?.major ? { major: true } : {}) };
  });
}

/** What the log says of the listing: counts alone. */
export function summary(listing: Listing, policy: Routine | undefined, lookups: { made: number; kept: number }) {
  if (!policy) return "Routine moves: main's policy/vulnerabilities.ts sets no wait for them, so none is listed.";
  const { counts } = listing;
  return `Routine moves: ${counts.pins} pins read, ${counts.listed} behind and listed, ${counts.waiting} waiting for a release to be ${policy.days} days old (${policy.majorDays} for a major), ${counts.left} left alone, ${counts.unread} not read. Lookups: ${lookups.made} made, ${lookups.kept} of them answered from the day's.`;
}
