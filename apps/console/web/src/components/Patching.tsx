/**
 * Patching's sheet: what must move, and who moves it, whole, for everyone (the design system's README, "Patching"),
 * opened from its summary in the bottom row (`Summaries.tsx`), from Needs you's Patching card, or at a row by the
 * address (`?move=`). What waits on Martin first, grouped by what he does (Yours to approve, Waits for your bench run,
 * Held by you, Tried and stopped, Yours to do by hand; a visitor's withheld rows in Waits on Martin), each group by
 * earliest deadline; then what moves by itself; then Done in the last 28 days, closed until opened. A row is Guardrails'
 * row with more columns, opening in place, one at a time: its state as a glyph and a word, what moves and where its pin
 * is, from and to, what it clears by severity, its deadline and who moves it, with its pull request's or issue's number.
 * Opened, it says why it waits or where it is, what failed and its run (never its log), the one way forward on GitHub
 * and what it does, what happens if it is left, what it clears and every pin. Above the rows, the day's scan in a line,
 * when each repository's scan judged and the pull requests were read in another, and a banner when the sense has not
 * read for a while or a scan is too old for its moves to pass; the Clears column under the headers C, H, M and L, and
 * All open under the rows as its total; under them, four figures for the findings no row can clear.
 *
 * It is a chunk of its own, with its stylesheet, which the console loads when the sheet first opens: neither the first
 * view nor the summary carries it. The view is the summary's, worked out once for both (`patching-view.ts`), kept while
 * what it reads is the same, so an event that changes nothing here renders nothing here. Its words are
 * `patching-words.ts`'s.
 *
 * A visitor reads all of it, read-only, with "Martin" for "you", no link into code scanning, and a lockfile's package
 * withheld, as the public view withholds it, and of one that waits on Martin, what it waits for.
 */
import { memo, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { Admin } from '../admin.ts';
import { capital, clock, count, dayLabel, plural, startOfDay, when } from '../format.ts';
import type { View } from '../projection/index.ts';
import {
  APP_REPOSITORY,
  dueSoon,
  dueWords,
  type PatchingRow,
  type PatchingView,
  pinText,
  readStale,
  type ScanJudged,
  staleScans,
  total,
} from '../projection/patching.ts';
import { renders } from '../renders.ts';
import { REPOSITORIES } from '../repositories.ts';
import { CountsHead, SeverityCounts, severityWords } from './Counts.tsx';
import { Glyph } from './Glyph.tsx';
import { ToolMark } from './Logos.tsx';
import { movesWords, onDay, runningWords, waitWords } from './panel-words.ts';
import { patchingNow } from './patching-view.ts';
import {
  clearsNote,
  failedOf,
  GROUP_WORDS,
  isApp,
  leftWords,
  lockfileName,
  pillNumber,
  repoUrl,
  routeWords,
  SEVERITY_WORD,
  stateWords,
  type Who,
  wayOf,
  whatToDo,
  whyWords,
  withheld,
} from './patching-words.ts';
import { bringIntoSheet, SheetFrame } from './SheetFrame.tsx';
import '../styles/patching.css';

const FACTORY = repoUrl(undefined);

/** Words with `code` in backticks, drawn as code. */
function Words({ text }: { text: string }) {
  // Each part keyed by where it starts in the text, which no two share.
  let at = 0;
  const parts = text.split('`').map((part, i) => {
    const key = `${at}`;
    at += part.length + 1;
    return i % 2 ? <code key={key}>{part}</code> : <span key={key}>{part}</span>;
  });
  return <>{parts}</>;
}

/** What a row's sense found, as its name says it when the event gives none of its own. */
const RUNNING_NAME = {
  'unlisted-image': 'Unscanned image running',
  'unscanned-digest': 'A running digest no scan read',
  'not-running': 'A pin the cluster does not run yet',
} as const;

/** A row's name, and the place under it: its pin, or where it runs, and whether it is in the app's repository. */
function named(row: PatchingRow): [name: string, where: string, app: boolean] {
  const { source, where } = row;
  if (withheld(row)) return [lockfileName(row), 'pnpm-lock.yaml', false];
  if (source.kind === 'unlisted-image' || source.kind === 'unscanned-digest' || source.kind === 'not-running') {
    const running = where && 'namespace' in where;
    return [
      RUNNING_NAME[source.kind],
      running ? `running in ${where.namespace} · pod ${where.pod}` : where ? pinText(where) : '',
      !running && isApp(row),
    ];
  }
  return [row.name ?? '', pinAt(row), isApp(row)];
}

/** Where a move's pin is: its first two, and how many more. */
function pinAt(row: PatchingRow): string {
  const { where } = row;
  if (!where || 'namespace' in where) return '';
  if (row.pins.length < 2) return where.line > 0 ? `${where.file}:${where.line}` : where.file;
  const more = row.pins.length > 2 ? ` and ${count(row.pins.length - 2)} more` : '';
  return `${row.pins
    .slice(0, 2)
    .map((pin) => pin.at)
    .join(', ')}${more}`;
}

/** What a row clears, in the Clears column: four counts under C, H, M and L, or why it has none. */
function Clears({ row }: { row: PatchingRow }) {
  if (withheld(row)) return <span className="clr none">withheld</span>;
  const note = clearsNote(row);
  if (note && (!row.clears || total(row.clears) === 0)) return <span className="clr none">{note}</span>;
  if (!row.clears) return <span className="clr none">not scanned</span>;
  return <SeverityCounts counts={row.clears} words="clears" />;
}

const done = (row: PatchingRow) => row.on !== undefined;

/** The way to a row's pull request, issue or run, drawn as Needs you draws a merge's: the verb and GitHub's mark. */
function Way({ row, who }: { row: PatchingRow; who: Who }) {
  const way = wayOf(row);
  if (!way) return null;
  return (
    <div className="answers">
      <a className="btn small way" href={way.href} target="_blank" rel="noopener">
        <span className="way-words" aria-hidden="true">
          {way.verb}
          <ToolMark name="github" />
        </span>
        <span className="sr">
          {way.verb} {way.what} on GitHub (opens GitHub in a new tab)
        </span>
      </a>
      <p>{who.martin ? <Words text={way.does} /> : 'Martin does it there.'}</p>
    </div>
  );
}

/** A labelled part of an opened row. */
const Part = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <span className="label">{label}</span>
    {children}
  </div>
);

/** What an opened row says, under its line. */
function More({ row, who, id, onOpen }: { row: PatchingRow; who: Who; id: string; onOpen: (item: string) => void }) {
  const shown = !withheld(row);
  const failed = shown ? failedOf(row) : undefined;
  const todo = whatToDo(row);
  const cleared = row.state.kind === 'merged' ? 'Cleared' : done(row) ? 'Would have cleared' : 'Clears';
  const findings = row.findings;
  return (
    <div className="more" id={id}>
      <Part label={row.waits ? 'Why it waits' : 'Where it is'}>
        <p>
          <Words text={whyWords(row, who)} />
        </p>
      </Part>
      {row.held.length > 0 && (
        <Part label="Held with it">
          {shown && row.held.every((held) => !withheld(held)) ? (
            <div className="reflist pins">
              {row.held.map((held) => (
                <div key={held.key}>
                  <span className="mono">{held.name}</span>
                  <span>
                    {[
                      held.from && held.to ? `${held.from} → ${held.to}` : '',
                      held.clears && total(held.clears) > 0 ? `clears ${severityWords(held.clears)}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p>{plural(row.held.length, 'other move')} in the same lockfile.</p>
          )}
        </Part>
      )}
      {findings && shown && (
        <Part label={`Its findings · ${count(findings.count)}`}>
          {who.martin && findings.listed.some((f) => f.package) ? (
            <>
              <div className="reflist pins">
                {findings.listed
                  .filter((f) => f.package)
                  .map((f) => (
                    <div key={`${f.package} ${f.severity} ${f.deadline}`}>
                      <span className="mono">{f.package}</span>
                      <span>
                        {SEVERITY_WORD[f.severity]} ·{' '}
                        {f.deadline === undefined ? 'no deadline' : `due ${when(f.deadline)}`}
                      </span>
                    </div>
                  ))}
              </div>
              <p className="help">Each advisory is named on its issue and in code scanning, never here.</p>
            </>
          ) : (
            <p>Martin sees each, signed in. Each advisory is named on its issue and in code scanning.</p>
          )}
        </Part>
      )}
      {row.leaves && shown && (
        <Part label="Leaves · a major clears the rest">
          <p>{severityWords(row.leaves)}, which only a move across its major clears.</p>
        </Part>
      )}
      {failed && (
        <Part label={failed.label}>
          {failed.lines.map((line) => (
            <p className="failed-run" key={`${line.name}${line.href}`}>
              <span className="mono">{line.name}</span> · {line.words} ·{' '}
              <a href={line.href} target="_blank" rel="noopener">
                its run ↗
              </a>
            </p>
          ))}
          <p className="help">The console never copies a check’s log: the run on GitHub has it whole.</p>
        </Part>
      )}
      {row.waits && (
        <Part label="What to do">
          {shown && <Way row={row} who={who} />}
          {shown && todo && !wayOf(row) && <p>{who.martin ? todo : 'Martin does it, on GitHub or his cluster.'}</p>}
          {who.martin && row.state.kind === 'waits' && row.state.why === 'bench' && (
            <p className="help">
              How to run it:{' '}
              <a href={`${FACTORY}/blob/main/docs/ON-THE-HOST.md#the-bench`} target="_blank" rel="noopener">
                the bench, on the host
              </a>
              .
            </p>
          )}
          {(row.source.kind === 'move' || row.source.kind === 'waiting') && <p className="help">{leftWords(row)}</p>}
        </Part>
      )}
      {shown && row.clears && total(row.clears) > 0 && (
        <Part label={`${cleared} · ${plural(total(row.clears), 'finding')}`}>
          <p>
            {severityWords(row.clears)}. The packages and advisories are in code scanning.
            {who.martin && (
              <>
                {' '}
                <a href={`${repoUrl(row.repository)}/security/code-scanning`} target="_blank" rel="noopener">
                  Code scanning ↗
                </a>
              </>
            )}
          </p>
        </Part>
      )}
      {row.link && (
        <Part label="Its work item">
          <p>
            {/* The work item's sheet, opened in place as Guardrails opens an attack's. */}
            <button type="button" className="linkish" onClick={() => onOpen(String(row.link?.number))}>
              #{row.link.number}
            </button>
          </p>
        </Part>
      )}
      {shown && row.pins.length > 0 && (
        <Part label={row.source.kind === 'move' || row.source.kind === 'waiting' ? 'Every pin' : 'Where it runs'}>
          <div className="reflist pins">
            {row.pins.map((pin) => (
              <div key={pin.at}>
                <span className="mono">{pin.at}</span>
                <span>{pin.change}</span>
              </div>
            ))}
          </div>
        </Part>
      )}
    </div>
  );
}

function Row({
  row,
  open,
  onToggle,
  who,
  t,
  onOpen,
}: {
  row: PatchingRow;
  open: boolean;
  onToggle: () => void;
  who: Who;
  t: number;
  onOpen: (item: string) => void;
}) {
  const id = useId();
  const [word, tone, glyph] = stateWords(row, who);
  const [name, where, app] = named(row);
  const hidden = withheld(row);
  // A row the public view withholds, which waits on Martin, names nothing of what it waits for: not its number.
  const number = hidden && row.waits ? undefined : pillNumber(row);
  return (
    <div className={row.waits ? 'pm wait' : 'pm'}>
      <button type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
        <span className={`v tone-${tone}`}>
          <Glyph name={glyph} />
          {word}
        </span>
        <span className="what">
          <span className="name">{name}</span>
          {where && (
            <span className="pin">
              {app && <span className="sans">the app’s </span>}
              {where}
            </span>
          )}
          {row.leaves && !done(row) && <span className="leaves">a major clears the rest</span>}
          {row.held.length > 0 && <span className="leaves">holds {count(row.held.length)} more with it</span>}
          {row.stopped && <span className="leaves tone-attn">waits: the line is stopped</span>}
        </span>
        <span className="facts">
          {hidden ? (
            <span className="ft zero">versions withheld</span>
          ) : row.source.kind === 'unlisted-image' ? (
            <span className="ft">pinned nowhere</span>
          ) : (
            (row.from || row.to) && (
              <span className="ft">
                {row.from}
                {row.to && (
                  <>
                    {row.from ? ' → ' : '→ '}
                    <span className="to">{row.to}</span>
                  </>
                )}
              </span>
            )
          )}
          <Clears row={row} />
          {row.on !== undefined ? (
            <span className="due">{dayLabel(row.on)}</span>
          ) : (
            <span className={dueSoon(row.deadline, t) ? 'due tone-attn' : 'due'}>{dueWords(row.deadline, t)}</span>
          )}
        </span>
        <span className="pill route">
          {routeWords(row, who)}
          {number !== undefined && ` · #${number}`}
        </span>
        <Glyph name="right" className="glyph chev" />
      </button>
      {open && <More row={row} who={who} id={id} onOpen={onOpen} />}
    </div>
  );
}

/** A count in the day's line: a zero muted, a count above zero in `attn` where it asks for a look. */
const Figure = ({ n, warm = false }: { n: number; warm?: boolean }) => (
  <span className={n === 0 ? 'zero' : warm ? 'tone-attn' : undefined}>{count(n)}</span>
);
const inMoves = (n: number) => (n > 0 ? ` (in ${plural(n, 'move')} below)` : '');

type Read = Extract<PatchingView, { state: 'read' }>;

/** "the factory’s" or "the app’s". */
const whose = (repository: string) => (repository === APP_REPOSITORY ? 'the app’s' : 'the factory’s');

/** How the day's scan went, in one line: passed or failed, when, and each of its three reasons with where it landed. */
function DayLine({ view, t }: { view: Read; t: number }) {
  const { day } = view;
  const newHigh = day.newHighWithFix + day.newHighWithoutFix;
  return (
    <p className="patch-day">
      {day.passed ? (
        <span className="v tone-ok">
          <Glyph name="check" />
          Scan passed {onDay(day.finished, t)}
        </span>
      ) : (
        <span className="v tone-attn">
          <Glyph name="cross" />
          Scan failed {onDay(day.finished, t)}
        </span>
      )}
      <span>
        · {clock(day.finished)} · <Figure n={newHigh} /> new High or Critical
        {newHigh > 0 && (
          <>
            : {count(day.newHighWithFix)} {day.newHighWithFix === 1 ? 'has' : 'have'} a fix{inMoves(day.movesWithNew)},{' '}
            {count(day.newHighWithoutFix)} {day.newHighWithoutFix === 1 ? 'has' : 'have'} none yet
          </>
        )}{' '}
        · <Figure n={day.overdue} warm /> overdue{day.overdue > 0 && inMoves(day.movesOverdue)} ·{' '}
        <span className={day.dueWithinDay > 0 ? 'tone-attn' : undefined}>
          <Figure n={day.dueWithinDay} warm /> due within a day{day.dueWithinDay > 0 && inMoves(day.movesDueWithinDay)}
        </span>
        {day.broken.map((r) => (
          <span key={`broken ${r.repository}`}>
            {' '}
            · {whose(r.repository)} run itself failed:{' '}
            <a href={r.url} target="_blank" rel="noopener">
              its run ↗
            </a>
          </span>
        ))}
        {day.unjudged.map((r) => (
          <span key={r.repository}>
            {' '}
            · {whose(r.repository)} run wrote no moves:{' '}
            <a href={r.url} target="_blank" rel="noopener">
              its run ↗
            </a>
          </span>
        ))}
        {!view.compared && <span> · the cluster was not compared, as a list is missing</span>}
      </span>
    </p>
  );
}

/** A time as the day's lines say it: its clock today, its day and clock before. */
const at = (time: number, t: number) => (startOfDay(time) === startOfDay(t) ? clock(time) : when(time));
/** How many hours ago, counted down. */
const hoursAgo = (time: number, t: number) => `${Math.floor((t - time) / 3_600_000)} hours ago`;

/** When each repository's scan judged, when the pull requests were read, and the fixes that wait their day. */
function ReadLine({ view, t }: { view: Read; t: number }) {
  const stale = new Set(staleScans(view.scans, t).map((scan) => scan.repository));
  // The factory's first, then the app's.
  const order = [...view.scans].sort(
    (a, b) => Number(b.repository === REPOSITORIES.factory) - Number(a.repository === REPOSITORIES.factory),
  );
  const { waitDay } = view;
  return (
    <p className="patch-day patch-read">
      <span>
        Judged:{' '}
        {order.map((scan, i) => (
          <span key={scan.repository}>
            {i > 0 && ' · '}
            {whose(scan.repository)}{' '}
            {scan.judged === undefined ? (
              'nothing'
            ) : stale.has(scan.repository) ? (
              <span className="tone-attn">
                {when(scan.judged)}, {hoursAgo(scan.judged, t)}
              </span>
            ) : (
              at(scan.judged, t)
            )}
          </span>
        ))}{' '}
        · pull requests read {at(view.read, t)}
        {waitDay.count > 0 && (
          <>
            {' '}
            · {plural(waitDay.count, 'fix', 'fixes')} {waitDay.count === 1 ? 'waits its' : 'wait their'} day
            {waitDay.name ? ` (${waitDay.name}, below)` : ''}
          </>
        )}
      </span>
    </p>
  );
}

/** A banner over the rows: the sense has not read for a while, or a scan is too old for its moves to pass. */
function Stale({ view, t, martin }: { view: Read; t: number; martin: boolean }) {
  const scans: ScanJudged[] = staleScans(view.scans, t);
  return (
    <>
      {readStale(view.read, t) && (
        <p className="patch-stale">
          <Glyph name="cross" className="glyph stale-mark" />
          <span>
            <b>
              The dependency sense has not read since {when(view.read)}, {hoursAgo(view.read, t)}.
            </b>{' '}
            Everything below is that read’s, and may be out of date: a pull request may have merged, or stopped, since.{' '}
            {martin ? 'Its log says why; your phone was told at 26 hours.' : 'Martin has been told.'}
          </span>
        </p>
      )}
      {scans.map((scan) => (
        <p className="patch-stale" key={scan.repository}>
          <Glyph name="cross" className="glyph stale-mark" />
          <span>
            <b>
              {capital(whose(scan.repository))} scan was last judged {hoursAgo(scan.judged ?? t, t)}.
            </b>{' '}
            Past 36 hours the review gate passes no move, so every{' '}
            {scan.repository === APP_REPOSITORY ? 'app' : 'factory'} move below waits until a scan runs again.{' '}
            {martin ? 'Your phone was told. ' : 'Martin has been told. '}
            <a className="stale-run" href={scan.run} target="_blank" rel="noopener">
              Its last run ↗
            </a>
          </span>
        </p>
      ))}
    </>
  );
}

/** What the head says: how many moves, the rows the sense made, and how many wait. */
function headWords(view: Read) {
  return [movesWords(view.moves), ...runningWords(view)];
}

/** The sheet's kicker: how many moves, the rows the sense made, and how many wait on Martin. */
function Kicker({ view, martin }: { view: PatchingView; martin: boolean }) {
  const readOnly = !martin && ' · Read only';
  if (view.state === 'unread') {
    return (
      <span className="label panel-count">
        No read yet
        {readOnly}
      </span>
    );
  }
  return (
    <span className="label panel-count">
      {headWords(view).join(' · ')}
      {view.waiting > 0 && (
        <>
          {' · '}
          <span className="tone-attn">{waitWords(view.waiting, martin)}</span>
        </>
      )}
      {readOnly}
    </span>
  );
}

/** Done's line: how many merged and how many no longer listed, and what the merged cleared. */
function doneLine(rows: readonly PatchingRow[]): string {
  const merged = rows.filter((row) => row.state.kind === 'merged');
  const gone = rows.filter((row) => row.state.kind === 'gone').length;
  const closed = rows.filter((row) => row.state.kind === 'closed').length;
  const cleared = merged.reduce(
    (n, row) =>
      row.clears
        ? {
            critical: n.critical + row.clears.critical,
            high: n.high + row.clears.high,
            medium: n.medium + row.clears.medium,
            low: n.low + row.clears.low,
            unknown: n.unknown + row.clears.unknown,
          }
        : n,
    { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
  );
  return [
    `${count(merged.length)} merged, ${count(gone)} no longer listed${closed ? `, ${count(closed)} closed` : ''}`,
    `cleared ${severityWords(cleared)}`,
  ].join(' · ');
}

const Body = memo(function Body({
  view,
  t,
  martin,
  row: asked,
  onOpen,
}: {
  view: PatchingView;
  t: number;
  martin: boolean;
  row: string | undefined;
  onOpen: (item: string) => void;
}) {
  renders.patchingSheet = (renders.patchingSheet ?? 0) + 1;
  const who: Who = { martin };
  const [open, setOpen] = useState<string | undefined>(asked);
  // Done is closed until opened, or opened at one of its rows.
  const [doneOpen, setDoneOpen] = useState(asked?.startsWith('done ') ?? false);
  const list = useRef<HTMLDivElement>(null);
  // The row it was opened at comes into view, focused, as the sheet opens, and is lined up again as it settles until
  // the sheet closes or the viewer opens or closes a row.
  const settling = useRef(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the sheet opens
  useEffect(() => {
    if (asked !== undefined)
      settling.current = bringIntoSheet(list.current?.querySelector<HTMLElement>('.pm > button[aria-expanded="true"]'));
    return () => settling.current();
  }, []);
  useEffect(() => {
    if (open !== asked) settling.current();
  }, [open, asked]);
  if (view.state === 'unread') {
    return (
      <section className="patching" id="patching" aria-labelledby="sheet-title">
        <p className="patch-empty">
          The dependency sense has not read a day’s scan yet. It reads each morning, after the scan, and when it starts.
        </p>
      </section>
    );
  }
  const empty = view.rows.length === 0;
  const rowOf = (row: PatchingRow) => (
    <Row
      key={row.key}
      row={row}
      open={open === row.key}
      onToggle={() => setOpen(open === row.key ? undefined : row.key)}
      who={who}
      t={t}
      onOpen={onOpen}
    />
  );
  return (
    <section className="patching" id="patching" aria-labelledby="sheet-title">
      {!empty && (
        <p className="help">
          Everything the factory and the app build or run is scanned every day. A finding with a fix has a deadline by
          its severity. One row here is one pin to move, and what moving it clears.
        </p>
      )}
      <Stale view={view} t={t} martin={martin} />
      <DayLine view={view} t={t} />
      <ReadLine view={view} t={t} />
      {view.nothing === 'unjudged' ? (
        // Nothing to show is not nothing to move: a run that wrote no moves judged nothing.
        <p className="patch-empty">
          No moves to show: the day’s scan wrote none, so nothing was judged. Its line above says which run, and links
          it.
        </p>
      ) : view.nothing === 'failed' ? (
        // Nor is a run that failed in itself: what it judged cannot be said cleared.
        <p className="patch-empty">
          No moves to show, but the day’s scan failed in itself, so nothing can be said cleared. Its line above says
          which run, and links it.
        </p>
      ) : view.nothing === 'cleared' ? (
        <p className="patch-empty">
          Nothing to move. Every finding with a fix has been cleared. {count(view.figures.noFix)}{' '}
          {view.figures.noFix === 1 ? 'has' : 'have'} no fix yet, and {view.figures.noFix === 1 ? 'is' : 'are'} looked
          at again tomorrow.
        </p>
      ) : null}
      <div className="pm-lists" ref={list}>
        {!empty && (
          <>
            {/* The Clears column's headers, over its counts; narrower, where they cannot stand over them, each count
                follows its letter. */}
            <div className="pm-head" aria-hidden="true">
              <CountsHead />
            </div>
            {view.groups.map(({ group, rows }) => (
              <div key={group}>
                <div className="pm-group wait">
                  <h3 className="label">
                    {martin ? GROUP_WORDS[group].mine : GROUP_WORDS[group].his} · {count(rows.length)}
                  </h3>
                  <p className="help">{GROUP_WORDS[group].line}</p>
                </div>
                <div className="pm-list">{rows.map(rowOf)}</div>
              </div>
            ))}
            {view.moving.length > 0 && (
              <div>
                <div className="pm-group">
                  <h3 className="label">Moving by itself · {count(view.moving.length)}</h3>
                  <p className="help">Nothing to do: each merges by itself, or has nothing to move to yet.</p>
                </div>
                <div className="pm-list">{view.moving.map(rowOf)}</div>
              </div>
            )}
          </>
        )}
        {view.done.length > 0 && (
          <div>
            <div className="pm-group done">
              <button type="button" className="linkish" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
                <Glyph name="right" className="glyph done-chev" />
                <span className="label">Done in the last 28 days · {count(view.done.length)}</span>
              </button>
              <p className="help">{doneLine(view.done)}</p>
            </div>
            {doneOpen && <div className="pm-list">{view.done.map(rowOf)}</div>}
          </div>
        )}
      </div>
      {!empty && (
        <>
          {/* Every open finding, under the rows, in the Clears column: the column's total. */}
          <p className="pm-total">
            <span className="label">All open</span>
            <SeverityCounts counts={view.open} words="All open:" />
          </p>
          <div className="patch-counts">
            <div>
              <b className={view.figures.noFix === 0 ? 'zero' : undefined}>{count(view.figures.noFix)}</b>
              <span className="label">No fix yet</span>
              <p className="help">looked at again each day; a fix starts its deadline</p>
            </div>
            <div>
              <b className={view.figures.cleared === 0 ? 'zero' : undefined}>{count(view.figures.cleared)}</b>
              <span className="label">Cleared by the moves above</span>
              <p className="help">
                {plural(view.figures.clearingMoves, 'move')}, not {count(view.figures.cleared)} rows
              </p>
            </div>
            <div>
              <b className={view.figures.excepted === 0 ? 'zero' : undefined}>{count(view.figures.excepted)}</b>
              <span className="label">Excepted</span>
              <p className="help">Martin’s, in policy/vulnerabilities.ts, each for 90 days at most</p>
            </div>
            <div>
              <b className={view.figures.overdue === 0 ? 'zero' : undefined}>{count(view.figures.overdue)}</b>
              <span className="label">Past their deadline</span>
              <p className="help">the scan fails while there is one</p>
            </div>
          </div>
          <p className="help">
            A move the review gate can prove from its pull request merges by itself, at the level{' '}
            {martin ? 'you set' : 'Martin sets'}. A major below Lights-out, a workflow’s pin, the cluster, the agent
            loop and anything the factory tried and could not finish wait on {martin ? 'you' : 'Martin'}. Each merge is
            in the audit log.
          </p>
        </>
      )}
      <div className="links">
        <a href="?view=audit">Audit log</a>
        {martin && (
          <a href={`${FACTORY}/security/code-scanning`} target="_blank" rel="noopener">
            Code scanning ↗
          </a>
        )}
        <a href={`${FACTORY}/blob/main/docs/COMPONENTS/PATCHING.md`} target="_blank" rel="noopener">
          How patching works
        </a>
      </div>
    </section>
  );
});

/** The sheet, from the fold the console's view was drawn from. */
export function PatchingSheet({
  view: drawn,
  admin,
  row,
  onOpen,
  motion,
  rise,
  onClose,
}: {
  view: View;
  admin: Admin;
  /** The row it opens at, by its key, opened, scrolled to and focused; none opens it at its top. */
  row: string | undefined;
  /** Opens a work item's sheet, in this one's place. */
  onOpen: (item: string) => void;
  motion: boolean;
  rise: boolean;
  onClose: () => void;
}) {
  const { view, t } = patchingNow(drawn);
  const martin = admin.kind === 'martin';
  return (
    <SheetFrame
      kicker={<Kicker view={view} martin={martin} />}
      title="Patching"
      motion={motion}
      rise={rise}
      onClose={onClose}
    >
      <div className="wrap sheet-whole">
        <Body view={view} t={t} martin={martin} row={row} onOpen={onOpen} />
      </div>
    </SheetFrame>
  );
}
