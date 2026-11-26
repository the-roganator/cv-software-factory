/**
 * A dependency's move as the line says it: in its issue, in its pull request's description, and in naming the
 * Dependabot pull request its own replaces. Everything here is read from the signal (its move and its scan's
 * findings), from the pin step's patch as the pull request carries it, and from the gates' notices: fixed fields the
 * schemas bound to one word each, never an advisory's or a pull request's words, and no model retypes a figure.
 */
import { ADVISORY_SEVERITIES, cutTo, type PayloadOf } from '@software-factory/events';
import { parsePatch } from 'diff';
// Types only: the factory image holds no runner, so a value from it would fail to load there (`scripts/image-modules.test.ts`).
import type { Move as PinnedMove } from '../../../runner/src/pins.ts';
import type { DependencyPull } from '../github/dependabot.ts';
import { groupMovesTo } from '../github/dependabot.ts';
import { filesIn } from '../github/patches.ts';
import { compareVersions } from '../vulnerabilities/versions.ts';
import type { StepContext } from './agents/agent.ts';
import type { Signal } from './agents/evidence.ts';

export type { PinnedMove };

type Move = NonNullable<Signal['move']>;
type Scan = Extract<NonNullable<Signal['evidence']>[number], { kind: 'scan' }>;
type Ticket = PayloadOf<'ticket.opened'>;

/** The scan's evidence a dependency's signal carries, if it carries one. */
export const scanOf = (signal: Signal | undefined): Scan | undefined =>
  signal?.evidence?.find((each): each is Scan => each.kind === 'scan');

const code = (word: string) => `\`${word}\``;

/**
 * A move's versions as a sentence says them, each in code: `5.7.2` alone, or, for a package locked at two versions,
 * whose move names both in one word (`5.7.2,7.5.2`), `5.7.2` and `7.5.2`.
 */
export function versionsWords(versions: string): string {
  const each = versions.split(',').filter(Boolean).map(code);
  return each.length > 1 ? `${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : (each[0] ?? '');
}

/** One finding of the scan, as a line of Markdown: its advisory and package, its ratings, its fix and its deadline. */
export function findingLine(finding: Scan['findings'][number]): string {
  const publisher = finding.severity.publisher ? ` (${finding.severity.publisher} by its publisher)` : '';
  const fixed = finding.fixed ? `, fixed in ${finding.fixed.split(', ').map(code).join(', ')}` : ', no fix yet';
  const due = finding.deadline ? `, due ${finding.deadline.slice(0, 10)}` : '';
  return `${code(finding.advisory)} in ${code(finding.package)}: ${finding.severity.scanner}${publisher}${fixed}${due}`;
}

/** The findings the scan counted beyond those it listed, by rating: `2 high, 1 low`, or nothing. */
export function restWords(scan: Scan): string {
  return ADVISORY_SEVERITIES.flatMap((rating) => (scan.rest[rating] ? [`${scan.rest[rating]} ${rating}`] : [])).join(
    ', ',
  );
}

/**
 * A move's issue in the app's repository: the move, from its newest signal (or the ticket's own fingerprint before
 * any), and the scan's findings, each by its advisory's id. The issue is where a finding's package and advisory first
 * become public, as Dependabot's own pull request would make them: so it is built from the ticket's own payload and
 * the signal, never from a public view, which may withhold both. `rated` gives the category and the severity, as the
 * line reads them for every ticket. A routine update's signal carries no scan, and its issue says why it moves: a
 * newer release, and no advisory.
 */
export function moveIssue(
  workItem: string,
  own: Ticket,
  rated: Pick<Ticket, 'category' | 'severity'>,
  signal: Signal | undefined,
): { title: string; body: string } {
  const named = 'ecosystem' in own.fingerprint ? own.fingerprint : undefined;
  const move = signal?.move;
  const what = move
    ? `the move of ${code(move.name)}, in ${move.ecosystem}, from ${versionsWords(move.from)} to ${targetWords(move)}, in ${move.repository}`
    : `the move of ${code(named?.name ?? own.title)}${named ? `, in ${named.ecosystem}` : ''}`;
  const scan = scanOf(signal);
  const rest = scan ? restWords(scan) : '';
  const body = [
    `The factory’s ticket #${workItem}: ${what}.`,
    '',
    `- Category: ${rated.category}`,
    `- Severity: ${rated.severity}`,
    ...(move ? [`- Pinned at: ${move.pins.map((pin) => code(`${pin.file}:${pin.line}`)).join(', ')}`] : []),
    ...(scan
      ? [
          '- What the scan found on it:',
          ...scan.findings.map((finding) => `  - ${findingLine(finding)}`),
          ...(rest ? [`  - and more: ${rest}`] : []),
        ]
      : signal?.symptom === 'outdated-dependency'
        ? ['- A routine update: the scan lists a newer release, with no advisory behind it and no deadline.']
        : []),
    '',
    'The factory is working on it: its move will come as a pull request that refers here. The issue closes when the move is verified in production, by the scan of the release.',
  ].join('\n');
  return { title: own.title, body };
}

/**
 * Whether a move's spec asks for nothing but the move: every criterion is shown by the gates (its scans and its
 * required checks), none by a test, and it contradicts no test. Then Build is the pin step alone: the line makes the
 * commit from the pin step's patch, titled and noted from the move (`moveTitle`, `moveNote`), and no model is called.
 * A criterion that does not say what shows it, as none of a version 5 spec's does, is a test's: the coder runs.
 */
export const movesAlone = (spec: PayloadOf<'spec.written'>): boolean =>
  spec.criteria.every((criterion) => criterion.shownBy === 'gates') && !spec.contradicts?.length;

/**
 * A move's target, as the line says it before the pins exist: a package's is a floor, since the pin step takes the
 * newest release its range admits at or above it (`pnpm update`, under the app's release age), so "`1.14.5` or later";
 * Node's and an image's are what the pin step writes. Each version is in code (`versionsWords`).
 */
export const targetWords = (move: Pick<PinnedMove, 'ecosystem' | 'to'>): string =>
  move.ecosystem === 'npm' ? `${versionsWords(move.to)} or later` : versionsWords(move.to);

/** Why the line will not title a move: the pins say no version it can name, or one below the move's floor. */
export class UnreadMove extends Error {
  override name = 'UnreadMove';
}

/**
 * The version the pin step wrote, read from its patch: for a package, the version the lockfile's importers resolve it
 * to (the lowest, where they differ), or, for one no importer names, the versions its patch adds to the lockfile's
 * packages; for Node or an image, the move's own target, which the pin step writes as it is, once a line the patch
 * adds has it. Throws `UnreadMove` when
 * the patch names none, or one below the move's floor: the line never titles a guess.
 */
export function writtenVersion(move: PinnedMove, pins: string): string {
  // Node's and an image's are written as they are: one the patch does not add is not one it wrote.
  if (move.ecosystem !== 'npm') {
    const added = pins.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
    if (!added.some((line) => line.includes(move.to))) {
      throw new UnreadMove(`The pin step’s patch does not write ${move.name} ${versionsWords(move.to)}`);
    }
    return move.to;
  }
  const named = move.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importer: string[] = [];
  const added: string[] = [];
  let files: ReturnType<typeof filesIn>;
  try {
    files = filesIn(pins);
  } catch {
    throw new UnreadMove(`The pin step’s patch cannot be read for the version of ${move.name}`);
  }
  for (const { path, patch } of files) {
    if (!/(^|\/)pnpm-lock(\.[^/]*)?\.yaml$/.test(path)) continue;
    for (const hunk of patch.hunks) {
      // The hunk as the lockfile reads after the move: its context and its added lines.
      const after = hunk.lines
        .filter((l) => !l.startsWith('-'))
        .map((l) => ({ text: l.slice(1), added: l.startsWith('+') }));
      after.forEach(({ text, added: isAdded }, i) => {
        if (new RegExp(`^\\s+'?${named}'?:\\s*$`).test(text)) {
          for (const next of after.slice(i + 1, i + 3)) {
            const m = /^\s+version:\s*'?([^\s'(]+)/.exec(next.text);
            if (!m?.[1]) continue;
            // An importer the move left as it was, shown as context, is not one the pin step wrote.
            if (next.added) importer.push(m[1]);
            break;
          }
        }
        const key = new RegExp(`^\\s+'?${named}@([^\\s'(:]+)'?(\\(.*\\))?:`).exec(text);
        if (isAdded && key?.[1]) added.push(key[1]);
      });
    }
  }
  const versions = (importer.length ? importer : added).sort(compareVersions);
  const [lowest] = versions;
  if (!lowest) throw new UnreadMove(`The pin step’s patch names no version of ${move.name} the line can read`);
  // A package at two versions moves to a floor for each (`6.11.5,7.6.6`): the lowest copy is held to the lowest.
  const [floor = move.to] = move.to.split(',').sort(compareVersions);
  if (compareVersions(lowest, floor) < 0) {
    throw new UnreadMove(
      `The pin step’s patch resolves ${move.name} to ${code(lowest)}, below the move’s ${versionsWords(move.to)}`,
    );
  }
  return lowest;
}

/** The most a commit's title may be, as the coder's and the describer's (`commitTitle`). */
const TITLE_CHARS = 80;

/**
 * A move's commit title, the line's own: `fix(deps): move <name> to <version>`, the version the pin step wrote
 * (`writtenVersion`), within the title's rule however long the name or the version. A version too long to fit is
 * left out, then the name's scope, then the name is cut. A routine update's, which no advisory asked for, is a
 * chore's (`chore(deps): …`): it fixes nothing, and the app's release notes list no chore.
 */
export function moveTitle(name: string, version: string, routine = false): string {
  const unscoped = name.replace(/^@[^/]+\//, '');
  const type = routine ? 'chore(deps)' : 'fix(deps)';
  const said = [
    `${type}: move ${name} to ${version}`,
    `${type}: move ${name}`,
    `${type}: move ${unscoped} to ${version}`,
    `${type}: move ${unscoped}`,
  ].find((title) => title.length <= TITLE_CHARS);
  return said ?? cutTo(`${type}: move ${unscoped}`, TITLE_CHARS);
}

/**
 * A move's commit note, the line's own: what moved, from which version to the one the pin step wrote, against the
 * move's floor, which files the pin step wrote, and why no coder's change is in it. It names no advisory: the issue
 * is where those are disclosed.
 */
export function moveNote(move: PinnedMove, version: string, pins: string, coder: boolean): string {
  const files = [...new Set(filesIn(pins).map(({ path }) => path))];
  const shown = files.length > 6 ? [...files.slice(0, 5), `${files.length - 5} more files`] : files;
  const floor =
    move.ecosystem === 'npm' && version !== move.to
      ? `, the newest release its range admits at or above ${versionsWords(move.to)},`
      : '';
  return cutTo(
    [
      `The pin step moved ${move.name} (${move.ecosystem}) from ${versionsWords(move.from)} to ${code(version)}${floor} in ${shown.join(', ')}.`,
      coder
        ? 'The coder found nothing more the criteria need of it: the move is the whole change.'
        : 'The spec asks for nothing but the move, which its scans and its required checks show, so no coder ran.',
    ].join(' '),
    1000,
  );
}

/** What a move's issue discloses, as `issue.opened` records it. */
export type DisclosedMove = NonNullable<PayloadOf<'issue.opened'>['move']>;

/**
 * What a move's issue names (`moveIssue`), from the same inputs: the fingerprint's name and ecosystem, or the newest
 * signal's move with its versions and pins, and each of the scan's findings the issue lists, by its advisory, its
 * package, its ratings and its fix. The line records it as the issue opens, so the console names the move from it.
 */
export function disclosedMove(
  fingerprint: { name: string; ecosystem: Move['ecosystem'] },
  signal: Signal | undefined,
): DisclosedMove {
  const move = signal?.move;
  const findings = scanOf(signal)?.findings.map(({ deadline: _deadline, ...finding }) => finding);
  return {
    ...(move
      ? { name: move.name, ecosystem: move.ecosystem, from: move.from, to: move.to, pins: move.pins }
      : { name: fingerprint.name, ecosystem: fingerprint.ecosystem }),
    ...(findings?.length && { findings }),
  };
}

const directoryOf = (file: string) => `/${file.split('/').slice(0, -1).join('/')}`;
const bare = (name: string) => name.replace(/^@/, '');
/** The ecosystem, as `dependabot.yml` names it, that moves each kind of move's pin: Node's is an image's. */
const DEPENDABOT_ECOSYSTEM: Record<Move['ecosystem'], string> = { npm: 'npm', docker: 'docker', node: 'docker' };

/**
 * The Dependabot pull request the line's own replaces: the open one for the same pin, by its branch's dependency in
 * the move's ecosystem and the directory of one of the move's pins, or a group's that rewrites one of the pins' lines.
 * Read from the branch and the lines it changes alone, never its title or body, which are Dependabot's prose. The
 * lowest number when several do; none when none does.
 */
export function replacedPull(
  move: Pick<Move, 'name' | 'ecosystem' | 'pins'>,
  pulls: readonly DependencyPull[],
): number | undefined {
  const directories = new Set(move.pins.map((pin) => directoryOf(pin.file).replace(/\/$/, '') || '/'));
  const found = pulls.filter((pull) => {
    if (pull.dependency !== null && pull.directory !== null) {
      const directory = pull.directory.replace(/\/+$/, '') || '/';
      return (
        pull.ecosystem === DEPENDABOT_ECOSYSTEM[move.ecosystem] &&
        bare(pull.dependency) === bare(move.name) &&
        directories.has(directory)
      );
    }
    return move.pins.some((pin) => groupMovesTo(pull, pin) !== undefined);
  });
  return found.map((pull) => pull.number).sort((a, b) => a - b)[0];
}

/**
 * The Dependabot pull request a move's own replaces, read from the app's open dependency pull requests as the pull
 * request is opened or described; none for a work item that is no move. The move is the newest signal's.
 */
export async function replacedFor(
  context: Pick<StepContext, 'signals' | 'read'>,
  ticket: PayloadOf<'ticket.opened'> | undefined,
): Promise<number | undefined> {
  if (!ticket || !('ecosystem' in ticket.fingerprint)) return undefined;
  const move = (await context.signals()).findLast((signal) => signal.sense === 'dependency')?.move;
  if (!move) return undefined;
  return replacedPull(move, await context.read('dependencyPulls', {}));
}

/** The line a description gives to the Dependabot pull request it replaces. Never a closing keyword. */
export const replacesLine = (number: number) =>
  `It replaces Dependabot’s #${number} for the same pin, which Dependabot closes itself once \`main\` has the version.`;

/** A pin's line before the move and after it, in one file. */
export interface PinChange {
  file: string;
  before: string;
  after: string;
}

/** The most pins a description lists; the rest are counted. */
export const MOST_PINS = 20;

/**
 * Each pin the pull request moves, before and after, from its diff: in the files the move pins, and in the lockfiles
 * the pin step writes, each line it removes paired with the line it adds in its place, where that line names the
 * move's name or a version it moves from or to. Lines a coder's change made around them are not pins and are left out.
 */
export function pinChanges(
  files: readonly { path: string; patch: string | null }[],
  move: Pick<Move, 'name' | 'from' | 'to' | 'pins'> & Partial<Pick<Move, 'ecosystem'>>,
  lockfiles: readonly string[],
): PinChange[] {
  // A package's manifests too: the pin step moves its range there (`pnpm update` writes it), though a signal that found
  // the package in a lockfile pins only that. Node's and an image's pins are where the signal says.
  const manifests = move.ecosystem === 'npm' ? ['package.json'] : [];
  const pinned = new Set([...move.pins.map((pin) => pin.file), ...lockfiles, ...manifests]);
  // Whole words only: `ms` is not in `items` or `@ms/x`, nor 2.1.2 in 12.1.20; a version after `@`, as a lockfile
  // writes it, is. A package at two versions is each of them (`5.7.1,7.5.1`).
  const words = [move.name, ...move.from.split(','), ...move.to.split(',')].map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const pattern = new RegExp(`(?<![\\w./-])(${words.join('|')})(?![\\w/-]|\\.\\d)`);
  const named = (line: string) => pattern.test(line);
  const out: PinChange[] = [];
  for (const file of files) {
    const nested = [...lockfiles, ...manifests].some((l) => file.path.endsWith(`/${l}`));
    if (!file.patch || !(pinned.has(file.path) || nested)) continue;
    let hunks: ReturnType<typeof parsePatch>[number]['hunks'];
    try {
      hunks = parsePatch(`--- a/${file.path}\n+++ b/${file.path}\n${file.patch}\n`)[0]?.hunks ?? [];
    } catch {
      continue;
    }
    for (const hunk of hunks) {
      // A run of removed lines followed by a run of added ones, paired in order.
      let removed: string[] = [];
      let added: string[] = [];
      const flush = () => {
        for (let i = 0; i < Math.min(removed.length, added.length); i++) {
          const before = (removed[i] as string).trim();
          const after = (added[i] as string).trim();
          if (before !== after && (named(before) || named(after))) out.push({ file: file.path, before, after });
        }
        removed = [];
        added = [];
      };
      for (const line of hunk.lines) {
        if (line.startsWith('-')) {
          if (added.length) flush();
          removed.push(line.slice(1));
        } else if (line.startsWith('+')) added.push(line.slice(1));
        else flush();
      }
      flush();
    }
  }
  return out;
}

/** Counts by severity, as the gates' notices give them. */
type Counts = NonNullable<PayloadOf<'gate.finished'>['findings']>['before'];

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
const countsWords = (counts: Counts) => SEVERITIES.map((s) => `${counts[s] ?? 0} ${s}`).join(', ');

/** A gate's counts, as `gate.finished` recorded them at the head, by check. */
export interface GateCounts {
  check: string;
  findings: NonNullable<PayloadOf<'gate.finished'>['findings']>;
}

/** Markdown inline code that holds any text: fenced by more backticks than it has in a row. */
const inline = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${longest ? ` ${text} ` : text}${fence}`;
};

/** A table's cell: its text as code, with any pipe escaped, which would otherwise end the cell. */
const cell = (text: string) => inline(text).replaceAll('|', '\\|');

/**
 * The factory's part of a move's description, after the describer's words: the spec it was held to, each pin before
 * and after, and what the scan gates counted on the base and on the change. The line writes it whole, from the spec,
 * the pull request's diff and `gate.finished`, so no figure in it is a model's. A routine update's says why it moves
 * in place of the counts: no advisory asked for it, so the scans counted nothing it clears.
 */
export function moveSection(
  spec: PayloadOf<'spec.written'>,
  pins: readonly PinChange[],
  counts: readonly GateCounts[],
  replaces: number | undefined,
  routine = false,
): string {
  const shown = pins.slice(0, MOST_PINS);
  return [
    '## The move',
    '',
    `**Outcome.** ${spec.outcome}`,
    '',
    '**Acceptance criteria**',
    '',
    ...spec.criteria.map((c) => `- Given ${c.given}, when ${c.when}, then ${c.expect}.`),
    '',
    '**Pins, before and after**',
    '',
    ...(shown.length
      ? [
          '| File | Before | After |',
          '|---|---|---|',
          ...shown.map((pin) => `| ${cell(pin.file)} | ${cell(pin.before)} | ${cell(pin.after)} |`),
          ...(pins.length > shown.length ? ['', `And ${pins.length - shown.length} more lines like these.`] : []),
        ]
      : ['The pull request’s diff shows no pin of the move’s.']),
    '',
    ...(routine
      ? ['**Why it moves.** A routine update: the scan lists a newer release, with no advisory behind it.']
      : [
          '**What the scans counted**, on `main` and on this change, as the gates’ own notices give them:',
          '',
          ...(counts.length
            ? counts.map(
                ({ check, findings }) =>
                  `- ${check}: before ${countsWords(findings.before)}; after ${countsWords(findings.after)}`,
              )
            : ['- No scan gate gave its counts at this head.']),
        ]),
    '',
    'No package is named runtime-critical in the app, so no proof of one ran before the gates counted.',
    ...(replaces ? ['', replacesLine(replaces)] : []),
  ].join('\n');
}
