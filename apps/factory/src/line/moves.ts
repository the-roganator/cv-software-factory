/**
 * A dependency's move as the line says it: in its issue, in its pull request's description, and in naming the
 * Dependabot pull request its own replaces. Everything here is read from the signal (its move and its scan's
 * findings), from the pin step's patch as the pull request carries it, and from the gates' notices: fixed fields the
 * schemas bound to one word each, never an advisory's or a pull request's words, and no model retypes a figure.
 */
import { ADVISORY_SEVERITIES, type PayloadOf } from '@software-factory/events';
import { parsePatch } from 'diff';
import type { DependencyPull } from '../github/dependabot.ts';
import { groupMovesTo } from '../github/dependabot.ts';
import type { StepContext } from './agents/agent.ts';
import type { Signal } from './agents/evidence.ts';

type Move = NonNullable<Signal['move']>;
type Scan = Extract<NonNullable<Signal['evidence']>[number], { kind: 'scan' }>;
type Ticket = PayloadOf<'ticket.opened'>;

/** The scan's evidence a dependency's signal carries, if it carries one. */
export const scanOf = (signal: Signal | undefined): Scan | undefined =>
  signal?.evidence?.find((each): each is Scan => each.kind === 'scan');

const code = (word: string) => `\`${word}\``;

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
 * line reads them for every ticket.
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
    ? `the move of ${code(move.name)}, in ${move.ecosystem}, from ${code(move.from)} to ${code(move.to)}, in ${move.repository}`
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
      : []),
    '',
    'The factory is working on it: its move will come as a pull request that refers here. The issue closes when the move is verified in production, by the scan of the release.',
  ].join('\n');
  return { title: own.title, body };
}

const directoryOf = (file: string) => `/${file.split('/').slice(0, -1).join('/')}`;
const bare = (name: string) => name.replace(/^@/, '');

/**
 * The Dependabot pull request the line's own replaces: the open one for the same pin, by its branch's dependency in
 * the directory of one of the move's pins, or a group's that rewrites one of the pins' lines. Read from the branch and
 * the lines it changes alone, never its title or body, which are Dependabot's prose. The lowest number when several
 * do; none when none does.
 */
export function replacedPull(move: Pick<Move, 'name' | 'pins'>, pulls: readonly DependencyPull[]): number | undefined {
  const directories = new Set(move.pins.map((pin) => directoryOf(pin.file).replace(/\/$/, '') || '/'));
  const found = pulls.filter((pull) => {
    if (pull.dependency !== null && pull.directory !== null) {
      const directory = pull.directory.replace(/\/+$/, '') || '/';
      return bare(pull.dependency) === bare(move.name) && directories.has(directory);
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
  move: Pick<Move, 'name' | 'from' | 'to' | 'pins'>,
  lockfiles: readonly string[],
): PinChange[] {
  const pinned = new Set([...move.pins.map((pin) => pin.file), ...lockfiles]);
  const names = [move.name, move.from, move.to].filter((word) => word.length > 1);
  const named = (line: string) => names.some((word) => line.includes(word));
  const out: PinChange[] = [];
  for (const file of files) {
    if (!file.patch || !(pinned.has(file.path) || lockfiles.some((l) => file.path.endsWith(`/${l}`)))) continue;
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
 * the pull request's diff and `gate.finished`, so no figure in it is a model's.
 */
export function moveSection(
  spec: PayloadOf<'spec.written'>,
  pins: readonly PinChange[],
  counts: readonly GateCounts[],
  replaces: number | undefined,
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
    '**What the scans counted**, on `main` and on this change, as the gates’ own notices give them:',
    '',
    ...(counts.length
      ? counts.map(
          ({ check, findings }) =>
            `- ${check}: before ${countsWords(findings.before)}; after ${countsWords(findings.after)}`,
        )
      : ['- No scan gate gave its counts at this head.']),
    '',
    'No package is named runtime-critical in the app, so no proof of one ran before the gates counted.',
    ...(replaces ? ['', replacesLine(replaces)] : []),
  ].join('\n');
}
