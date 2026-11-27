/**
 * What the scan keeps between runs: each finding's first-seen day, its fix and the day that became installable, and its
 * move, in one sealed file on the run, the artifact `state` (ADR 0026). The next scan reads it for its clocks, and the
 * GitHub worker for what `moves.json` withholds, in place of paging every alert in code scanning for what the scan
 * itself wrote there. It also keeps the day the scan first saw each image's digest and each chart's version a move
 * could list at (`StateSeen`), which only it can: no move lists at content the scan has known for less than
 * `ROUTINE.contentDays` (`settle`, `contentWaits`), and a run with no state to read starts that wait.
 *
 * The repository is public and so are its runs' artifacts, so the file is sealed with the repository's key (AES-256-GCM
 * over the gzipped JSON), which the scan's job takes from an environment only `main` may use, and the worker from its
 * own secret. The seal is for secrecy: what makes a state the scan's is where it is, on a run of the scan's workflow on
 * the default branch, which is how its readers find it. The seal also binds the repository and the run, so a file
 * moved from another run or repository does not open.
 *
 * Losing it resets no deadline: a scan that finds no state it can open reads the alerts, as a proving run always does
 * (deadlines.ts's `seen` and `stated`), and writes the next. The alerts hold every day; what they do not hold is a
 * finding whole, so only a state carries an image's findings into a run that could not read it (deadlines.ts's
 * `carried`).
 *
 *     node apps/factory/src/vulnerabilities/state.ts new        a key, base64, for SCAN_STATE_KEY
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dayText, type Fix, readTarget, type Target, targetText } from './fixes.ts';
import { DIGEST } from './reference.ts';
import { SEVERITIES, type Severity } from './sarif.ts';
import { ZipError, zipEntry } from './zip.ts';

export const STATE_VERSION = 1;
/** The artifact, and the file in it. */
export const STATE_ARTIFACT = 'state';
export const STATE_FILE = 'state.sealed';
/** The secret that holds the key, and the environment a workflow reads it from (scripts/github-settings.ts). */
export const STATE_KEY = 'SCAN_STATE_KEY';
/** The scan's workflow, in both repositories, and the events a run that keeps a state is started by. */
export const SCAN_WORKFLOW = 'vulnerabilities.yml';
export const SCAN_EVENTS: readonly string[] = ['schedule', 'push', 'workflow_dispatch'];
/** The most a state may hold, sealed and opened: 100,000 findings come to far less. */
export const MAX_SEALED_BYTES = 16 * 1024 * 1024;
export const MAX_STATE_BYTES = 128 * 1024 * 1024;

/** One finding as the scan judged it. */
export interface StateFinding {
  advisory: string;
  package: string;
  installed: string;
  /** Where it is pinned, as its alert is located. */
  file: string;
  line: number;
  /** Its item's repository: a lockfile's path, or an image's name without its tag or digest (deadlines.ts's place). */
  repository: string;
  /** Trivy's type of the result it was in (`pnpm`, `debian`…), which tells two findings of one place apart. */
  type: string;
  /** As the scan rated the result, which its message says. */
  severity: Severity;
  /** The versions the advisory says fix it, as the message gives them; absent for `no fix yet`. */
  fixed?: string | undefined;
  /** When it was first seen, itself, UTC to the second: its place's day is the earliest of its findings'. */
  seen: string;
  /** What fixes it, as fixes.ts writes a target, and the day that was first installable, UTC to the second. */
  fix?: { target: string; day: string } | undefined;
  /** Its move's place in the run's `moves.json`, from 1; absent for one with no fix, or excepted. */
  move?: number | undefined;
  /**
   * Its pin's place in the run's `moves.json`'s `waiting`, from 1, for one with a fix that is no move today; absent
   * for any other, and in a state written before the scan said what waits.
   */
  waiting?: number | undefined;
  /**
   * For a fix that is an image or a chart: each target the scan found to fix it on this pin, the newest whose content
   * has waited its day and those still waiting (`contentWaits`). A state written before these has none, and each
   * such fix waits from the first run after.
   */
  waits?: StateWait[] | undefined;
  /**
   * The rest of the finding as the scan read it (sarif.ts's `Finding`), which makes the same result again on a run
   * that cannot pull its image (deadlines.ts's `carried`): its item's key and the item as the list names it, the label
   * its message names, with the digest read, the publisher's rating, the CVSS score, where in the image it is, and the
   * advisory's title and link. Its description is left out: with it the state would be several times the size, and
   * only the rule's long text, never a result or its alert, is made from it. A state written before these has none,
   * and carries nothing.
   */
  item?: string | undefined;
  listed?: string | undefined;
  label?: string | undefined;
  publisher?: Severity | undefined;
  score?: number | undefined;
  path?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
}

export interface State {
  version: typeof STATE_VERSION;
  repository: string;
  /** The run that wrote it (GITHUB_RUN_ID), which its seal binds. */
  run: string;
  findings: StateFinding[];
  /**
   * The day's routine moves, which no finding carries: what `moves.json` withholds of a lockfile's, and each one's
   * day; and each release the scan saw that is still inside its wait, which is no move yet.
   */
  routine?: StateRoutine[] | undefined;
}

/**
 * Content the scan saw: an image's tag with the digest it served, or a chart's version, as fixes.ts writes a target,
 * and when the scan first saw it, UTC to the second.
 */
export interface StateSeen {
  target: string;
  seen: string;
}

/** A target the scan found to fix a finding, whose content waits its day or has waited it. */
export interface StateWait extends StateSeen {
  /** What the pin held when it was seen (moves.ts's `from`): a pin that holds another has moved, and the record is not its own. */
  from: string;
  /** The day it is installable, its content's day waited: what a fix's `day` is counted from. */
  day: string;
}

/** A release a pin with no finding is behind (routine.ts), listed as a move or still waiting to be. */
export interface StateRoutine {
  /** Its place in the run's `moves.json`, from 1; absent while the release waits, and for one passed over. */
  move?: number | undefined;
  /** What moves: a package, an image's repository, a chart's name, `k3s`. */
  name: string;
  from: string;
  /** Its target, as fixes.ts writes one (`targetText`). */
  to: string;
  pins: { file: string; line: number }[];
  /**
   * For an image, the digests its pins held when it was seen, in order: a pin that holds another has moved, and the
   * record is no longer its own.
   */
  held?: string[] | undefined;
  /** Set on the record of a routine move that is a major (its `Move.major`); absent otherwise. */
  major?: boolean | undefined;
  /**
   * When the scan first saw this release for this pin, UTC to the second: an image's and a chart's wait counts from
   * it, and a package's and k3s's from their registry's day, never taken to be later than it.
   */
  seen: string;
  /**
   * For an image, the digests its tag served while the pin was behind it: the newest that has waited its day, which
   * is the one a move lists at, and those still waiting (`settle`). A state written before these has none.
   */
  content?: StateSeen[] | undefined;
}

/** A state that cannot be read: sealed with another key, for another run or repository, or not a state at all. */
export class StateError extends Error {
  override name = 'StateError';
}

const MAGIC = Buffer.from('SFSTATE1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A new key, as the secret holds it. */
export const newKey = () => randomBytes(32).toString('base64');

/** The key from its secret's text, or an error that never repeats it. */
export function readKey(text: string) {
  const written = text.trim();
  const key = Buffer.from(written, 'base64');
  // As `newKey` writes one, and no other spelling: Node reads base64 it would not write (unpadded, or with other
  // characters dropped), and a key that is not what was made opens nothing.
  if (key.length !== 32 || key.toString('base64') !== written)
    throw new StateError(`${STATE_KEY} is not 32 bytes in base64`);
  return key;
}

/** What a seal binds besides its bytes: the repository and the run it is on. */
const bound = (repository: string, run: string) => Buffer.from(`scan state ${STATE_VERSION}\n${repository}\n${run}`);

/**
 * JSON sealed with the key, bound to what `aad` names: a state, or another of the scan's sealed files (the moves it
 * made, github/made.ts), each bound to its own kind, repository and run, so none opens as another.
 */
export function sealJson(json: unknown, key: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const sealed = Buffer.concat([cipher.update(gzipSync(JSON.stringify(json))), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), sealed]);
}

/** Sealed JSON opened with the key, for what it is bound to, or a `StateError` naming `what` and `where`. */
export function openJson(bytes: Buffer, key: Buffer, aad: Buffer, what: string, where: string): unknown {
  if (bytes.length > MAX_SEALED_BYTES) throw new StateError(`the ${what} is too large`);
  const head = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (bytes.length < head || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
    throw new StateError(`the file is not a sealed ${what}`);
  let json: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + IV_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(MAGIC.length + IV_BYTES, head));
    const zipped = Buffer.concat([decipher.update(bytes.subarray(head)), decipher.final()]);
    json = gunzipSync(zipped, { maxOutputLength: MAX_STATE_BYTES }).toString('utf-8');
  } catch {
    throw new StateError(`the ${what} does not open with this key for ${where}`);
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new StateError(`the ${what} is not JSON`);
  }
}

/** A state sealed for its repository and run. */
export function seal(state: State, key: Buffer): Buffer {
  return sealJson(state, key, bound(state.repository, state.run));
}

/**
 * A sealed state opened, for the repository and run it was taken from, and held to its shape: anything else is a
 * `StateError`, and nothing of it is returned.
 */
export function open(bytes: Buffer, key: Buffer, repository: string, run: string): State {
  const state = openJson(bytes, key, bound(repository, run), 'state', `run ${run} of ${repository}`);
  const problem = problemOf(state, repository, run);
  if (problem) throw new StateError(`the state ${problem}`);
  return state as State;
}

const DAY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isDay = (value: unknown) => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(value));
const isText = (value: unknown): value is string =>
  // No control character: every string is one the scan wrote of a package, a path or a version.
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\p{Cc}/u.test(value);

/** Content seen, as the state lists it: each a target the grammar reads and the day it was first seen. */
const isSeen = (list: unknown) =>
  Array.isArray(list) &&
  list.every(
    (each: Record<string, unknown> | null) =>
      typeof each === 'object' &&
      each !== null &&
      typeof each.target === 'string' &&
      readTarget(each.target) !== undefined &&
      isDay(each.seen),
  );

/** What is wrong with a state's shape, or undefined: the first thing, by the finding's place in the list alone. */
function problemOf(state: unknown, repository: string, run: string): string | undefined {
  if (typeof state !== 'object' || state === null) return 'is not an object';
  const { version, findings, routine, ...rest } = state as Record<string, unknown>;
  if (version !== STATE_VERSION) return `is version ${JSON.stringify(version)}, not ${STATE_VERSION}`;
  if (rest.repository !== repository) return "is another repository's";
  if (rest.run !== run) return "is another run's";
  if (!Array.isArray(findings)) return 'lists no findings';
  for (const [index, each] of findings.entries()) {
    const at = `finding ${index + 1}`;
    if (typeof each !== 'object' || each === null) return `has no ${at}`;
    const f = each as Record<string, unknown>;
    for (const name of ['advisory', 'package', 'file', 'repository', 'type'])
      if (!isText(f[name])) return `gives ${at} no ${name}`;
    // Trivy gives some packages no installed version, and the scan writes that as it reads it.
    if (f.installed !== '' && !isText(f.installed)) return `gives ${at} no installed version`;
    if (!Number.isInteger(f.line) || (f.line as number) < 0) return `gives ${at} no line`;
    if (!SEVERITIES.includes(f.severity as Severity)) return `gives ${at} no severity`;
    if (f.fixed !== undefined && !isText(f.fixed)) return `gives ${at} a fixed version that is not text`;
    if (!isDay(f.seen)) return `gives ${at} no day it was first seen`;
    if (f.fix !== undefined) {
      const fix = f.fix as Record<string, unknown> | null;
      if (typeof fix !== 'object' || fix === null) return `gives ${at} a fix that is not one`;
      if (typeof fix.target !== 'string' || !readTarget(fix.target))
        return `gives ${at} a fix the grammar does not read`;
      if (!isDay(fix.day)) return `gives ${at} a fix with no day`;
    }
    if (f.move !== undefined && (!Number.isInteger(f.move) || (f.move as number) < 1 || f.fix === undefined))
      return `gives ${at} a move that is not one`;
    if (f.waiting !== undefined && (!Number.isInteger(f.waiting) || (f.waiting as number) < 1 || f.move !== undefined))
      return `gives ${at} a place among those waiting that is not one`;
    if (f.waits !== undefined) {
      if (!isSeen(f.waits)) return `gives ${at} waiting fixes that are not ones`;
      for (const wait of f.waits as Record<string, unknown>[])
        if (!isText(wait.from) || !isDay(wait.day)) return `gives ${at} waiting fixes that are not ones`;
    }
    // What carries it on a run that cannot pull its image, each held to its shape where it is there.
    for (const name of ['item', 'listed', 'label'])
      if (f[name] !== undefined && !isText(f[name])) return `gives ${at} a value for ${name} that is not text`;
    // A path in an image and an advisory's own words, as Trivy gave them: any text the state's own size allows.
    for (const name of ['path', 'title', 'url'])
      if (f[name] !== undefined && typeof f[name] !== 'string')
        return `gives ${at} a value for ${name} that is not text`;
    if (f.publisher !== undefined && !SEVERITIES.includes(f.publisher as Severity))
      return `gives ${at} a publisher's rating that is not one`;
    if (f.score !== undefined && !(typeof f.score === 'number' && Number.isFinite(f.score) && f.score >= 0))
      return `gives ${at} a score that is not one`;
  }
  if (routine === undefined) return undefined;
  if (!Array.isArray(routine)) return 'lists routine moves that are not a list';
  for (const [index, each] of routine.entries()) {
    const at = `routine move ${index + 1}`;
    if (typeof each !== 'object' || each === null) return `has no ${at}`;
    const r = each as Record<string, unknown>;
    if (r.move !== undefined && (!Number.isInteger(r.move) || (r.move as number) < 1))
      return `gives ${at} a place that is not one`;
    for (const name of ['name', 'from']) if (!isText(r[name])) return `gives ${at} no ${name}`;
    if (typeof r.to !== 'string' || !readTarget(r.to)) return `gives ${at} a target the grammar does not read`;
    if (!Array.isArray(r.pins) || !r.pins.length) return `gives ${at} no pins`;
    for (const pin of r.pins as (Record<string, unknown> | null)[])
      if (
        typeof pin !== 'object' ||
        pin === null ||
        !isText(pin.file) ||
        !Number.isInteger(pin.line) ||
        (pin.line as number) < 0
      )
        return `gives ${at} a pin that is not one`;
    if (
      r.held !== undefined &&
      (!Array.isArray(r.held) || !r.held.every((each) => typeof each === 'string' && DIGEST.test(each)))
    )
      return `gives ${at} digests that are not ones`;
    if (r.major !== undefined && typeof r.major !== 'boolean') return `gives ${at} a major that is not one`;
    if (!isDay(r.seen)) return `gives ${at} no day it was first seen`;
    if (r.content !== undefined && !isSeen(r.content)) return `gives ${at} digests seen that are not ones`;
  }
  return undefined;
}

/** A finding's fix as the state writes it. */
export const fixOf = (fix: Fix) => ({ target: targetText(fix.target), day: dayText(fix.day) });

/** A state's fix read back, which `open` has held to the grammar. */
export function readStateFix(fix: { target: string; day: string }): Fix {
  const target = readTarget(fix.target);
  if (!target) throw new StateError('a fix the grammar does not read');
  return { target, day: Date.parse(fix.day) };
}

const DAY_MS = 86_400_000;

/**
 * A wait of so many days counted from the scan's own first sight, in milliseconds: the days less the slack
 * (`ROUTINE.slackHours`), since a daily scan's runs are not exactly a day apart, and one that starts minutes earlier
 * than the day before would find a day's wait a day longer. The one place a first sight's wait is worked out.
 */
export const waitMs = (days: number, slackHours = 0) => Math.max(0, days * DAY_MS - slackHours * 3_600_000);

/** The most sightings kept still waiting, of one tag's digests or one finding's fixes. */
export const WAITING = 4;

/** What a sighting is of: an image's digest, whatever tag or repository served it, or a chart's version. */
export const contentOf = (target: Target) => (target.kind === 'image' ? target.digest : targetText(target));

/**
 * When the scan first saw each content the state has a day for, by `contentOf`: the digests a routine record's tag
 * served, a chart's version a pin is behind, and each fix that waits. The day is the content's, whichever record has
 * it: a digest a routine update has waited on is no newer to a fix of the same pin.
 */
export function sightings(state: Pick<State, 'findings' | 'routine'> | undefined): Map<string, number> {
  const seen = new Map<string, number>();
  const add = (each: StateSeen) => {
    const target = readTarget(each.target);
    const day = Date.parse(each.seen);
    if (!target || Number.isNaN(day)) return;
    const key = contentOf(target);
    seen.set(key, Math.min(seen.get(key) ?? day, day));
  };
  for (const each of state?.routine ?? []) {
    for (const content of each.content ?? []) add(content);
    // A chart's version has no digest the scan reads: the day the pin was first seen behind it is its content's.
    if (each.to.startsWith('chart ')) add({ target: each.to, seen: each.seen });
  }
  for (const each of state?.findings ?? []) for (const wait of each.waits ?? []) add(wait);
  return seen;
}

/**
 * Of the sightings of one tag's digests, or of one finding's fixes, which a move lists at and which are kept: today's
 * where it has waited, and it alone is kept; otherwise the newest seen of the others that has waited, kept with those
 * still waiting, oldest first, and today's while they are fewer than `WAITING`. So content pushed again and again
 * comes due all the same, at the newest the scan has known a day, and the list stays short.
 */
export function settle<T extends StateSeen>(last: T[], today: T, ready: (each: T) => boolean) {
  if (ready(today)) return { due: today, kept: [today] };
  const bySeen = (a: T, b: T) => Date.parse(a.seen) - Date.parse(b.seen);
  const others = last.filter((each) => each.target !== today.target).sort(bySeen);
  const due = others.filter(ready).at(-1);
  const waiting = others.filter((each) => !ready(each)).slice(0, WAITING);
  if (waiting.length < WAITING) waiting.push(today);
  return { due, kept: due ? [due, ...waiting] : waiting };
}

/**
 * The content's day, for each fix that is an image or a chart: a fix is installable only once the scan has known its
 * content for `days`, as an npm fix is only after pnpm's wait, so its deadline counts from then and the wait makes
 * nothing overdue. Where today's target is too new, the newest target the last runs found for the same finding on
 * the same pin that has waited stands in for it; with none, the fix is not yet installable. `found` is changed in
 * place (deadlines.ts's `installable` made it), and each result's sightings are returned for the next state. `keys`
 * names each result's place, and `last` the state read with the same key of each of its findings; with none, every
 * such fix is first seen now. A policy of no days sets no wait, and nothing is changed or kept. The days are less
 * `slackHours` (`waitMs`).
 */
export function contentWaits(
  found: { at: (number | undefined)[]; fixes: (Target | undefined)[]; places: { from: string }[] },
  keys: string[],
  last: { state: State; keyOf(finding: StateFinding): string } | undefined,
  days: number,
  now: number,
  slackHours = 0,
): (StateWait[] | undefined)[] {
  if (!(days > 0)) return found.fixes.map(() => undefined);
  const wait = waitMs(days, slackHours);
  const before = sightings(last?.state);
  // Each place's sightings, each target once, with the earliest day it has: two results may share a place.
  const byKey = new Map<string, Map<string, StateWait>>();
  for (const each of last?.state.findings ?? []) {
    if (!each.waits?.length) continue;
    const key = last?.keyOf(each) ?? '';
    const waits = byKey.get(key) ?? new Map<string, StateWait>();
    for (const wait of each.waits) {
      const had = waits.get(wait.target);
      if (!had || had.from !== wait.from || wait.seen < had.seen) waits.set(wait.target, wait);
    }
    byKey.set(key, waits);
  }
  const dayOf = (each: StateWait) => Math.max(Date.parse(each.day), Date.parse(each.seen) + wait);
  return found.fixes.map((target, index) => {
    const own = found.at[index];
    if (!target || own === undefined || (target.kind !== 'image' && target.kind !== 'chart')) return undefined;
    const from = found.places[index]?.from ?? '';
    const text = targetText(target);
    // The pin's own records: one of the pin as it was before it moved would move it back.
    const kept = [...(byKey.get(keys[index] ?? '')?.values() ?? [])].filter((each) => each.from === from);
    const first = Math.min(
      now,
      before.get(contentOf(target)) ?? now,
      ...kept.filter((each) => each.target === text).map((each) => Date.parse(each.seen)),
    );
    const day = Math.max(own, first + wait);
    const today: StateWait = { from, target: text, seen: dayText(first), day: dayText(day) };
    const { due, kept: next } = settle(kept, today, (each) => (each === today ? day : dayOf(each)) <= now);
    const stands = due && due !== today ? readTarget(due.target) : undefined;
    if (due && stands) {
      found.fixes[index] = stands;
      found.at[index] = dayOf(due);
    } else found.at[index] = day;
    return next;
  });
}

/** GitHub's REST API as the state is found through it, so the tests give it recorded answers. */
export interface StateApi {
  json(path: string): Promise<unknown>;
  /** A download's bytes, or undefined when it is gone. */
  bytes(path: string): Promise<Buffer | undefined>;
}

/** The most runs of each event looked through for the last that kept a state: the most GitHub gives in a page. */
const RUNS_PER_EVENT = 100;

interface Runs {
  workflow_runs?: {
    id?: number;
    event?: string;
    head_branch?: string | null;
    head_repository?: { full_name?: string } | null;
  }[];
}
interface Artifacts {
  artifacts?: { id?: number; name?: string; expired?: boolean; size_in_bytes?: number }[];
}

/** Where a run's state is: the run and the artifact's archive. */
export interface Kept {
  run: string;
  archive: Buffer;
}

/**
 * The newest state a run of the scan kept, sealed still: from the scan's own workflow's runs on the default branch,
 * by schedule, push or hand and from the repository itself, finished, before the run given (its own), newest first. Each event's
 * runs are asked for by that event, so no pull request's run, a fork's from a branch of the same name among them,
 * takes a place among those looked through. Undefined when none of them kept one that is still there. Another of the
 * scan's artifacts is found the same way, by its name: the review gate reads `moves` so (scripts/moves.ts).
 */
export async function latest(
  api: StateApi,
  repository: string,
  branch: string,
  before?: string,
  artifactName = STATE_ARTIFACT,
): Promise<Kept | undefined> {
  const lists = await Promise.all(
    SCAN_EVENTS.map(async (event) => {
      const path = `/repos/${repository}/actions/workflows/${SCAN_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&event=${event}&status=completed&per_page=${RUNS_PER_EVENT}`;
      return listOf(((await api.json(path)) as Runs | null)?.workflow_runs, 'runs');
    }),
  );
  const runs = lists
    .flat()
    .filter(
      (run): run is typeof run & { id: number } =>
        typeof run === 'object' &&
        run !== null &&
        typeof run.id === 'number' &&
        Number.isSafeInteger(run.id) &&
        SCAN_EVENTS.includes(run.event ?? '') &&
        run.head_branch === branch &&
        run.head_repository?.full_name === repository &&
        (before === undefined || BigInt(run.id) < BigInt(before)),
    )
    .sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const kept = await keptBy(api, repository, String(run.id), artifactName);
    if (kept) return kept;
  }
  return undefined;
}

/**
 * One run's artifact of that name, sealed still, or undefined where the run kept none that is still there: the review
 * gate reads the `pins` of the run whose moves it read so (scripts/moves.ts).
 */
export async function keptBy(
  api: StateApi,
  repository: string,
  run: string,
  artifactName: string,
): Promise<Kept | undefined> {
  const listed = (await api.json(
    `/repos/${repository}/actions/runs/${run}/artifacts?name=${artifactName}&per_page=10`,
  )) as Artifacts | null;
  const artifact = listOf(listed?.artifacts, 'artifacts').find(
    (each) => typeof each === 'object' && each !== null && each.name === artifactName && !each.expired,
  );
  if (typeof artifact?.id !== 'number') return undefined;
  if ((artifact.size_in_bytes ?? 0) > MAX_SEALED_BYTES)
    throw new StateError(`run ${run}'s ${artifactName} is too large`);
  const archive = await api.bytes(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`);
  return archive ? { run, archive } : undefined;
}

/** A list GitHub answered with, or an error that says it gave none: its answers are held to their shape here. */
function listOf<T>(list: T[] | undefined, what: string): T[] {
  if (!Array.isArray(list)) throw new Error(`GitHub answered the scan's ${what} with something other than a list`);
  return list;
}

/** A kept state opened: the one file of its archive, for the repository and the run it was on. */
export function openKept(kept: Kept, key: Buffer, repository: string): State {
  let sealed: Buffer | undefined;
  try {
    sealed = zipEntry(kept.archive, STATE_FILE, MAX_SEALED_BYTES);
  } catch (error) {
    if (error instanceof ZipError) throw new StateError(`run ${kept.run}'s state is not a readable archive`);
    throw error;
  }
  if (!sealed) throw new StateError(`run ${kept.run}'s state holds no ${STATE_FILE}`);
  return open(sealed, key, repository, kept.run);
}

/** The API through fetch, with the token: a download follows GitHub's redirect to where the archive is. */
export function realStateApi(token: string, base = process.env.GITHUB_API_URL ?? 'https://api.github.com'): StateApi {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const ask = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(60_000) });
    if (!response.ok && response.status !== 404 && response.status !== 410)
      throw new Error(`GET ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response;
  };
  return {
    async json(path) {
      const response = await ask(path);
      if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
      return response.json();
    },
    async bytes(path) {
      const response = await ask(path);
      return response.ok ? Buffer.from(await response.arrayBuffer()) : undefined;
    },
  };
}

if (import.meta.main) {
  if (process.argv[2] === 'new') console.log(newKey());
  else {
    console.error('Usage: state.ts new');
    process.exitCode = 2;
  }
}
