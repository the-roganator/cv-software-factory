/**
 * The vulnerability scan's day, as the GitHub worker reads it for the factory: the one door through which the factory
 * learns of a vulnerability.
 *
 * `moves` takes two artifacts from the last finished run of `vulnerabilities.yml` on the default branch, by schedule,
 * push or hand (a pull request's run of the same workflow is never read, and a run still going is passed over), with
 * that run's conclusion: `moves.json`, which is public, and the state the scan kept, sealed with the repository's key
 * (vulnerabilities/state.ts, ADR 0021), for what `moves.json` withholds: a lockfile move's package and versions, and
 * each move's findings. It reads no alert: code scanning is where findings are shown, not where the worker learns them.
 *
 * A third, `pins`, sealed the same way, holds the moves the run made with the pin step (github/made.ts), where it
 * made any: in the factory for the pin watch to commit, in the app for the line's pin step to make again as the scan
 * made them. Absent, there are none; there and not opening for that run and its commit, the read fails.
 *
 * Both are the scan's by where they are, one run's, and each is held to the other: a state that does not open with
 * the repository's key for that run, a finding in a move past the list, or a count that differs from `moves.json`'s,
 * fails the whole read, and nothing of it is returned. A run that left `moves.json` and no state fails it too: there
 * is no second source. Only what the state's shape holds is returned: an advisory's id, never its title or its text.
 *
 * What the App lacks is named: a read refused for want of `actions: read` says so, and a worker with no key for a
 * repository's state says which.
 *
 * A whole read is kept, one for each repository, and served again while the last finished run is the same one and its
 * artifacts are there to read: an artifact never changes, so each call asks only which run is the last finished.
 * Callers at once share one read in flight. A read that fails is never kept.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { type Fix, type Target, targetText } from '../vulnerabilities/fixes.ts';
import type { Kind } from '../vulnerabilities/inventory.ts';
import {
  type DayCounts,
  furthest,
  LANES,
  MOVES_VERSION,
  type MovesFile,
  type PublicMove,
  type ScannedImage,
} from '../vulnerabilities/moves.ts';
import { SEVERITIES, type Severity } from '../vulnerabilities/sarif.ts';
import {
  MAX_SEALED_BYTES,
  open,
  readStateFix,
  SCAN_EVENTS,
  SCAN_WORKFLOW,
  STATE_ARTIFACT,
  STATE_FILE,
  type State,
  StateError,
} from '../vulnerabilities/state.ts';
import { type ZipError, zipEntry } from '../vulnerabilities/zip.ts';
import { type GitHub, GitHubError } from './client.ts';
import { MADE_ARTIFACT, MADE_FILE, type Made, openMade } from './made.ts';
import { DIGEST } from './registry.ts';

export { SCAN_EVENTS, SCAN_WORKFLOW };
/** The scan's artifact, and the file in it. */
export const MOVES_ARTIFACT = 'moves';
export const MOVES_FILE = 'moves.json';
/** The most runs looked through for the last finished one, a page at a time. */
const RUN_PAGES = 5;
const RUNS_PER_PAGE = 20;
/** The most `moves.json` may hold: the day's moves, far below this. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** What an archive of one file may hold beyond the file: its name and its directory. A sealed state does not shrink. */
const ARCHIVE_BYTES = 64 * 1024;

/** The run a day's moves came from. */
export interface ScanRun {
  id: number;
  event: string;
  /** The run's conclusion: `success`, `failure`, `cancelled`… */
  conclusion: string | null;
  headSha: string;
  /** When it last finished, as GitHub gives it. */
  updatedAt: string;
  url: string;
}

/** One finding a move clears, as the scan's state gives it. */
export interface MoveFinding {
  advisory: string;
  /**
   * Trivy's rating of the result, or Node's of its own advisory; the move's counts are by the higher of this and the
   * publisher's (deadlines.ts).
   */
  severity: Severity;
  /** Trivy's type of the result it was in (`pnpm`, `debian`…), or `node` for Node's own advisory (scan.ts). */
  type: string;
  package: string;
  installed: string;
  file: string;
  line: number;
  /**
   * The versions that fix the advisory, as the scan's message gives them (`fixed in …`), joined by `, `; absent for
   * `no fix yet`. The advisory's own, of the package: not the move's target, which for an image is the image's.
   */
  fixed?: string | undefined;
  /** What fixes it (fixes.ts's text), and the day that was first seen. */
  fix: string;
  firstSeen: string;
}

/** A move as `moves.json` gives it, with what the state holds. */
export interface ReadMove extends PublicMove {
  /** Its place in `moves.json`, from 1. */
  index: number;
  /**
   * What `moves.json` withholds of a lockfile's move, which it names only by its file: the package, its version, its
   * target and its pins, as the state gives them. Absent for any other move, which the artifact names whole.
   */
  withheld?: { package: string; from: string; to: string; pins: { file: string; line: number }[] } | undefined;
  /**
   * A lockfile's move's mark: a name for it that is the same on every read while its package and its files are, and
   * says nothing of the package to anyone without the state's key (a digest keyed by it). What may be written where
   * the public reads, in place of the package: an issue is found again by it.
   */
  mark?: string | undefined;
  findings: MoveFinding[];
}

export interface Moves {
  repository: string;
  run: ScanRun;
  /**
   * The day as `moves.json` gives it; null only when the run failed before it wrote one, when its conclusion says
   * why. A successful run with none fails the read.
   */
  file: Omit<MovesFile, 'moves'> | null;
  moves: ReadMove[];
  /**
   * The moves the run made with the pin step (github/made.ts): in the factory for the pin watch to commit, in the app
   * for the time and the answers its line's pin step makes them again with. Absent where it made none, or for a run
   * before it did.
   */
  made?: Made | undefined;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);

const REPOSITORY = z.object({ default_branch: z.string().min(1) });

/** A repository's default branch: one conditional read, shared by every read of it. */
export async function defaultBranch(github: GitHub, repo: string): Promise<string> {
  const { body } = await github.poll(repo, `/repos/${repo}`, REPOSITORY);
  return body.default_branch;
}

const RUNS = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      event: z.string(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      head_branch: z.string().nullable(),
      head_sha: SHA,
      updated_at: z.string(),
      html_url: z.string(),
      head_repository: z.object({ full_name: z.string() }).nullable().optional(),
    }),
  ),
});

const ARTIFACTS = z.object({
  artifacts: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      expired: z.boolean(),
      expires_at: z.string().nullable().optional(),
      size_in_bytes: z.number().int().nonnegative(),
    }),
  ),
});

const COUNTS = z.strictObject(
  Object.fromEntries(SEVERITIES.map((s) => [s, z.number().int().nonnegative()])) as Record<Severity, z.ZodNumber>,
);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

/** Every kind of item inventory.ts lists that is an image: the compiler holds this to its `Kind`, both ways. */
const KINDS = [
  'ours',
  'third-party',
  'chart',
  'k3s',
  'k3s-release',
  'k3d',
  'dockerfile',
  'workflow',
] as const satisfies readonly Kind[];
const ALL_KINDS: Exclude<Kind, (typeof KINDS)[number] | 'lockfile'> extends never ? true : never = true;
void ALL_KINDS;

/**
 * An image reference by the distribution grammar (`[domain/]path[:tag][@digest]`), its digest a sha256 alone: what
 * the scan writes is an image GitHub's runner pulled, and anything else in its place is not one.
 */
const LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
/** A registry: a first part with a dot or a port, or `localhost`; anything else is the image's own path. */
const DOMAIN = String.raw`(?:(?:localhost|${LABEL}(?:\.${LABEL})+)(?::\d+)?|${LABEL}:\d+)/`;
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
export const IMAGE_REFERENCE = new RegExp(
  String.raw`^(?:${DOMAIN})?${COMPONENT}(?:/${COMPONENT})*(?::[\w][\w.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$`,
);

/** Text with no control character in it: a line, never a second one. */
const PLAIN = /^[^\p{Cc}]+$/u;
/** A path in the repository, as a pin names one: relative, and never up out of it. */
const PATH = z
  .string()
  .max(512)
  .regex(PLAIN)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'a path out of the repository');

/** One image the scan read, as moves.ts writes `ScannedImage`. */
const SCANNED = (
  z.strictObject({
    kind: z.enum(KINDS),
    item: z.string().max(1024).regex(PLAIN),
    image: z.string().max(512).regex(IMAGE_REFERENCE),
    digests: z
      .array(z.string().regex(DIGEST))
      .min(1)
      .refine((list) => new Set(list).size === list.length, 'a digest twice'),
    // An image's pin is a line of a file: the scan writes none at 0.
    pin: z.strictObject({ file: PATH, line: z.number().int().positive() }),
  }) satisfies z.ZodType<ScannedImage>
)
  // An image pinned by its digest has it among those read.
  .refine((entry) => {
    const pinned = entry.image.split('@')[1];
    return pinned === undefined || entry.digests.includes(pinned);
  }, 'an image whose digest is not among those read');

/** The day's figures beside the moves, as moves.ts writes `DayCounts`: each a count. */
const COUNT = z.number().int().nonnegative();
const DAY_COUNTS = {
  noFix: COUNT,
  excepted: COUNT,
  overdue: COUNT,
  dueWithinDay: COUNT,
  newHighWithFix: COUNT,
  newHighWithoutFix: COUNT,
} satisfies Record<keyof DayCounts, z.ZodNumber>;
// Every figure moves.ts writes is read: one it adds and this lacks does not compile.
const ALL_COUNTS: Exclude<keyof DayCounts, keyof typeof DAY_COUNTS> extends never ? true : never = true;
void ALL_COUNTS;

/** `moves.json`, as moves.ts writes it: a reader refuses a version it does not know. */
export const MOVES_FILE_SCHEMA = z.strictObject({
  version: z.literal(MOVES_VERSION),
  repository: z.string(),
  judged: DAY,
  run: z.string().regex(/^\d+$/).optional(),
  totals: z.strictObject({
    fixed: z.number().int().nonnegative(),
    moves: z.number().int().nonnegative(),
    // The day's other figures, as the Patching panel shows them.
    ...DAY_COUNTS,
    // Every open result by severity: a scan made before it counted them writes none, and its file reads as it did.
    open: COUNTS.optional(),
    lanes: z.strictObject(
      Object.fromEntries(LANES.map((lane) => [lane, z.number().int().nonnegative()])) as Record<
        (typeof LANES)[number],
        z.ZodNumber
      >,
    ),
  }),
  moves: z.array(
    z.strictObject({
      repository: z.string(),
      name: z.string(),
      pins: z.array(z.strictObject({ file: z.string(), line: z.number().int().nonnegative() })),
      from: z.string(),
      to: z.string(),
      major: z.boolean(),
      clears: COUNTS,
      leaves: COUNTS,
      deadline: DAY.optional(),
      newToday: z.number().int().nonnegative(),
      lane: z.enum(LANES as [(typeof LANES)[number], ...(typeof LANES)[number][]]),
      lockfile: z.boolean(),
    }),
  ),
  scanned: z
    .array(SCANNED)
    .refine((list) => new Set(list.map((each) => JSON.stringify(each))).size === list.length, 'an image twice'),
});

const total = (counts: Record<Severity, number>) => SEVERITIES.reduce((sum, s) => sum + counts[s], 0);

/** A read the scan's own artifact does not agree with: nothing of it is returned. */
const disagrees = (repo: string, why: string) =>
  new GitHubError('malformed', `The scan's moves in ${repo} cannot be read: ${why}.`);

/** The permissions the read needs, as GitHub names them. */
const NEEDED = ['actions'];

const lacksError = (repo: string, lacks: string[]) =>
  new GitHubError(
    'refused',
    `The factory's App cannot read the scan's moves in ${repo}: it lacks ${lacks.join(' and ')}.`,
    403,
  );

/** What the App lacks when GitHub refuses a read for it with a 403: a 404 is something missing, never a permission. */
const lacking = (error: unknown, permission: string) =>
  error instanceof GitHubError && error.kind === 'refused' && error.status === 403 ? permission : undefined;

/** Each repository's key for its scan's state, or none where the worker holds none. */
export type StateKeys = (repo: string) => Buffer | undefined;

/** The scan's moves: see the module's comment. */
export class ScanReads {
  readonly #github: GitHub;
  readonly #keys: StateKeys;
  /** Each repository's last whole read, the run it is of, and until when its artifacts are there to read again. */
  readonly #kept = new Map<string, { run: number; until: number; moves: Moves }>();
  /** Each repository's read in flight, which a caller asking of the same run waits for. */
  readonly #reading = new Map<string, { run: number; read: Promise<{ until: number; moves: Moves }> }>();
  readonly #now: () => number;

  /** `keys` gives each repository's key; `now` is for a test of the clock. */
  constructor(
    github: GitHub,
    { keys = () => undefined, now = Date.now }: { keys?: StateKeys; now?: () => number } = {},
  ) {
    this.#github = github;
    this.#keys = keys;
    this.#now = now;
  }

  async moves(repo: string): Promise<Moves> {
    // A run's artifacts are read with the App's token alone, even on a public repository.
    if (!this.#github.writable)
      throw new GitHubError('read-only', `The worker has no App key, so it cannot read the scan's moves in ${repo}.`);
    // What the token may do, as GitHub granted it: a public repository's runs read without `actions: read`, and only
    // the artifact's download would be refused, so the permission is named before anything is asked.
    const granted = await this.#github.permissions(repo);
    if (granted) {
      const lacks = NEEDED.filter((permission) => !['read', 'write'].includes(granted[permission] ?? ''));
      if (lacks.length)
        throw lacksError(
          repo,
          lacks.map((permission) => `\`${permission}: read\``),
        );
    }
    const branch = await defaultBranch(this.#github, repo);
    let run: ScanRun;
    try {
      run = await this.#run(repo, branch);
    } catch (error) {
      const lacks = lacking(error, '`actions: read`');
      throw lacks ? lacksError(repo, [lacks]) : error;
    }
    const kept = this.#kept.get(repo);
    if (kept && kept.run === run.id && this.#now() < kept.until) return structuredClone(kept.moves);
    let reading = this.#reading.get(repo);
    if (!reading || reading.run !== run.id) {
      const own = { run: run.id, read: this.#read(repo, run) };
      reading = own;
      this.#reading.set(repo, own);
      // Kept once whole, unless a later run's read was asked for meanwhile; a read that fails is never kept.
      own.read.then(
        ({ until, moves }) => {
          if (this.#reading.get(repo) !== own) return;
          this.#reading.delete(repo);
          this.#kept.set(repo, { run: run.id, until, moves });
        },
        () => {
          if (this.#reading.get(repo) === own) this.#reading.delete(repo);
        },
      );
    }
    return structuredClone((await reading.read).moves);
  }

  /** One whole read: the run's `moves.json` and its state, each held to the other, and when the first of them expires. */
  async #read(repo: string, run: ScanRun): Promise<{ until: number; moves: Moves }> {
    const [moves, sealed, made] = await Promise.all([
      this.#artifact(repo, run, MOVES_ARTIFACT, MOVES_FILE, MAX_FILE_BYTES),
      this.#artifact(repo, run, STATE_ARTIFACT, STATE_FILE, MAX_SEALED_BYTES),
      this.#artifact(repo, run, MADE_ARTIFACT, MADE_FILE, MAX_SEALED_BYTES),
    ]);
    if (!moves) {
      if (run.conclusion === 'success') throw disagrees(repo, `run ${run.id} succeeded and left no ${MOVES_FILE}`);
      return { until: Number.POSITIVE_INFINITY, moves: { repository: repo, run, file: null, moves: [] } };
    }
    const file = movesFileOf(repo, run, moves.bytes);
    if (!sealed) throw disagrees(repo, `run ${run.id} left ${MOVES_FILE} and kept no state to read its findings from`);
    const key = this.#keys(repo);
    if (!key)
      throw new GitHubError(
        'read-only',
        `The worker has no key for the state ${repo}'s scan keeps, so it cannot read its moves: \`make scan-state-key\` gives it one.`,
      );
    let state: State;
    try {
      state = open(sealed.bytes, key, repo, String(run.id));
    } catch (error) {
      if (error instanceof StateError) throw disagrees(repo, `run ${run.id}'s state cannot be read: ${error.message}`);
      throw error;
    }
    const read = joined(repo, run, file, state);
    for (const move of read.moves) if (move.withheld) move.mark = markOf(key, repo, move.withheld);
    // What the run made, held to the run as its state is: a file that does not open fails the read.
    let opened: Made | undefined;
    if (made) {
      try {
        opened = openMade(made.bytes, key, repo, String(run.id));
      } catch (error) {
        if (error instanceof StateError)
          throw disagrees(repo, `run ${run.id}'s made moves cannot be read: ${error.message}`);
        throw error;
      }
      if (opened.commit !== run.headSha) throw disagrees(repo, `run ${run.id} made its moves on another commit`);
      const known = (index: number) => index >= 1 && index <= read.moves.length;
      if (!opened.groups.every((g) => [...g.moves, ...g.refused.map((r) => r.move)].every(known)))
        throw disagrees(repo, `run ${run.id} made a move past its list`);
    }
    const until = Math.min(moves.until, sealed.until, made?.until ?? Number.POSITIVE_INFINITY);
    return { until, moves: { repository: repo, run, ...read, ...(opened ? { made: opened } : {}) } };
  }

  /** The last finished run of the scan on the default branch, by schedule, push or hand. */
  async #run(repo: string, branch: string): Promise<ScanRun> {
    for (let page = 1; page <= RUN_PAGES; page++) {
      const path = `/repos/${repo}/actions/workflows/${SCAN_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&status=completed&exclude_pull_requests=true&per_page=${RUNS_PER_PAGE}&page=${page}`;
      const { body } = await this.#github.poll(repo, path, RUNS);
      const found = body.workflow_runs.find(
        (run) =>
          run.status === 'completed' &&
          SCAN_EVENTS.includes(run.event) &&
          run.head_branch === branch &&
          run.head_repository?.full_name === repo,
      );
      if (found)
        return {
          id: found.id,
          event: found.event,
          conclusion: found.conclusion,
          headSha: found.head_sha,
          updatedAt: found.updated_at,
          url: found.html_url,
        };
      if (body.workflow_runs.length < RUNS_PER_PAGE) break;
    }
    throw new GitHubError('not-found', `${repo} has no finished run of ${SCAN_WORKFLOW} on ${branch} to read.`, 404);
  }

  /** One file of one of the run's artifacts, and when the artifact expires, or undefined when the run uploaded none. */
  async #artifact(
    repo: string,
    run: ScanRun,
    name: string,
    fileName: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; until: number } | undefined> {
    const path = `/repos/${repo}/actions/runs/${run.id}/artifacts?name=${name}&per_page=10`;
    const { body } = await this.#github.poll(repo, path, ARTIFACTS);
    const artifact = body.artifacts.find((each) => each.name === name);
    if (!artifact) return undefined;
    if (artifact.expired)
      throw new GitHubError('not-found', `Run ${run.id}'s ${name} artifact in ${repo} has expired.`, 404);
    const maxArchive = maxBytes + ARCHIVE_BYTES;
    if (artifact.size_in_bytes > maxArchive) throw disagrees(repo, `run ${run.id}'s ${name} artifact is too large`);
    const zip = await this.#github.download(repo, `/repos/${repo}/actions/artifacts/${artifact.id}/zip`, maxArchive);
    let bytes: Buffer | undefined;
    try {
      bytes = zipEntry(zip, fileName, maxBytes);
    } catch (error) {
      throw disagrees(
        repo,
        `run ${run.id}'s ${name} artifact is not a readable archive (${(error as ZipError).message})`,
      );
    }
    if (!bytes) throw disagrees(repo, `run ${run.id}'s ${name} artifact holds no ${fileName}`);
    // An artifact whose expiry GitHub does not give, or gives as no date, is read again on each call.
    const until = Date.parse(artifact.expires_at ?? '');
    return { bytes, until: Number.isNaN(until) ? 0 : until };
  }
}

/** A lockfile's move's mark (`ReadMove.mark`): its repository, package and files, digested with the state's key. */
export function markOf(key: Buffer, repo: string, withheld: NonNullable<ReadMove['withheld']>): string {
  const files = [...new Set(withheld.pins.map((pin) => pin.file))].sort();
  return createHmac('sha256', key)
    .update(JSON.stringify(['lockfile move', repo, withheld.package, files]))
    .digest('hex')
    .slice(0, 12);
}

/** A run's `moves.json` from its bytes, through the schema: a version or a shape this worker does not read fails. */
function movesFileOf(repo: string, run: ScanRun, bytes: Buffer): MovesFile {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} is not JSON`);
  }
  const parsed = MOVES_FILE_SCHEMA.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join('.') || '(file)')
      .join(', ');
    throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} is not the shape this worker reads (${where})`);
  }
  return parsed.data as MovesFile;
}

/**
 * `moves.json`'s moves with their findings from the state, each checked against the other: every move has as many
 * findings as it clears, none names a move past the list, and the total is `moves.json`'s.
 */
export function joined(
  repo: string,
  run: ScanRun,
  file: MovesFile,
  state: State,
): { file: Omit<MovesFile, 'moves'>; moves: ReadMove[] } {
  if (file.repository !== repo) throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} is another repository's`);
  if (file.run !== String(run.id))
    throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} names ${file.run ? `run ${file.run}` : 'no run'}`);
  if (file.totals.moves !== file.moves.length)
    throw disagrees(repo, `${MOVES_FILE} counts ${file.totals.moves} moves and lists ${file.moves.length}`);
  const cleared = file.moves.reduce((sum, move) => sum + total(move.clears), 0);
  if (file.totals.fixed !== cleared)
    throw disagrees(
      repo,
      `${MOVES_FILE} counts ${file.totals.fixed} results with a fix and its moves clear ${cleared}`,
    );

  const findings: MoveFinding[][] = file.moves.map(() => []);
  const fixes: Fix[][] = file.moves.map(() => []);
  for (const [at, each] of state.findings.entries()) {
    // One with a fix and no move is excepted, or has none: it is in no move.
    if (each.move === undefined || !each.fix) continue;
    const list = findings[each.move - 1];
    if (!list) throw disagrees(repo, `the state's finding ${at + 1} names move ${each.move} of ${file.moves.length}`);
    list.push({
      advisory: each.advisory,
      severity: each.severity,
      type: each.type,
      package: each.package,
      installed: each.installed,
      file: each.file,
      line: each.line,
      ...(each.fixed && { fixed: each.fixed }),
      fix: each.fix.target,
      firstSeen: each.fix.day,
    });
    fixes[each.move - 1]?.push(readStateFix(each.fix));
  }

  const moves = file.moves.map((move, i): ReadMove => {
    const own = (findings[i] ?? []).sort(byPlace);
    if (own.length !== total(move.clears))
      throw disagrees(repo, `move ${i + 1} clears ${total(move.clears)} results and the state gives it ${own.length}`);
    return { ...move, index: i + 1, ...lockfileOf(repo, move, i, own, fixes[i] ?? []), findings: own };
  });
  const read = moves.reduce((sum, move) => sum + move.findings.length, 0);
  if (read !== file.totals.fixed)
    throw disagrees(
      repo,
      `${MOVES_FILE} counts ${file.totals.fixed} results with a fix and the state gives its moves ${read}`,
    );
  const { moves: _, ...rest } = file;
  return { file: rest, moves };
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A move's findings in one order on every read: by where they are pinned, then advisory and package. */
const byPlace = (a: MoveFinding, b: MoveFinding) =>
  order(a.file, b.file) || a.line - b.line || order(a.advisory, b.advisory) || order(a.package, b.package);

/**
 * What `moves.json` withholds of a lockfile's move, from its findings: one package at one version, as moves.ts groups
 * it, in the files the artifact names.
 */
function lockfileOf(repo: string, move: PublicMove, i: number, own: MoveFinding[], fixes: Fix[]) {
  if (!move.lockfile) return {};
  const packages = new Set(own.map((each) => each.package));
  const versions = new Set(own.map((each) => each.installed));
  const [name] = packages;
  const [from] = versions;
  if (packages.size !== 1 || versions.size !== 1 || name === undefined || from === undefined)
    throw disagrees(repo, `move ${i + 1}, a lockfile's, has findings of more than one package or version`);
  const to: Target | undefined = furthest(fixes.map((fix) => fix.target));
  const pins = [
    ...new Map(own.map((each) => [`${each.file}:${each.line}`, { file: each.file, line: each.line }])).values(),
  ];
  pins.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  // The artifact names the move's files: its findings must be in exactly those.
  const named = [...new Set(move.pins.map((pin) => pin.file))].sort().join('\n');
  const found = [...new Set(pins.map((pin) => pin.file))].sort().join('\n');
  if (named !== found) throw disagrees(repo, `move ${i + 1}, a lockfile's, has findings outside the files it names`);
  return { withheld: { package: name, from, to: to ? targetText(to) : '', pins } };
}
