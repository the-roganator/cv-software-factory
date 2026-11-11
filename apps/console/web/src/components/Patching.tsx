/**
 * Patching: what must move, and who moves it, full width above Guardrails, for everyone (the design system's README,
 * "Patching"). One row for each move of a pin the daily scan found a fix for, in either repository, and each row the
 * dependency sense made of what the cluster runs: what waits on Martin first, then by deadline. A row is Guardrails'
 * row with more columns, opening in place, one at a time: its state as a glyph and a word, what moves and where its
 * pin is, from and to, what it clears by severity, its deadline and who moves it. Above the rows, the day's scan in a
 * line; under them, four figures for the findings no row can clear.
 *
 * It is a chunk of its own, with its stylesheet and its projection (`projection/patching.ts`), which the console loads
 * once the first view has shown: it sits under the bottom row, and the first view carries none of it. The view is
 * worked out here, from the events, and kept while what it reads is the same, so an event that changes nothing here
 * renders nothing here.
 *
 * A visitor reads all of it, read-only, with "Martin" for "you", no link into code scanning, and a lockfile's package
 * withheld until its pull request is open, as the public view withholds it.
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Admin } from '../admin.ts';
import { clock, count, dayLabel, plural, startOfDay, when } from '../format.ts';
import { foldOf, type View } from '../projection/index.ts';
import type { ItemState } from '../projection/items.ts';
import {
  APP_REPOSITORY,
  type Counts,
  dayView,
  dueSoon,
  dueWords,
  lastRead,
  type MoveState,
  OPEN_ROW,
  type PatchingRow,
  type PatchingView,
  pinText,
  total,
} from '../projection/patching.ts';
import { renders } from '../renders.ts';
import { Glyph, type GlyphName } from './Glyph.tsx';
import '../styles/patching.css';

const FACTORY = 'https://github.com/the-roganator/cv-software-factory';
const repoUrl = (repository: string | undefined) =>
  `https://github.com/${repository ?? 'the-roganator/cv-software-factory'}`;

/** The row a link opened (`?move=`), as the mockup's: which move to show opened, by its key. */
const asked = new URLSearchParams(location.search).get('move') ?? undefined;

/** Who a word names: Martin, signed in, reads "you"; everyone else reads "Martin". */
interface Who {
  martin: boolean;
}
const you = ({ martin }: Who) => (martin ? 'you' : 'Martin');
const your = ({ martin }: Who) => (martin ? 'Your' : 'Martin’s');
const yours = ({ martin }: Who) => (martin ? 'your' : 'Martin’s');

/** Who moves a move, as its pill says. */
function route(row: PatchingRow, who: Who): string {
  if (row.source.kind !== 'move') return `${your(who)} cluster`;
  switch (row.source.lane) {
    case 'line':
      return 'The line';
    case 'worker':
      return 'The worker';
    case 'dependabot':
      return 'Dependabot';
    case 'approval':
      return `${your(who)} approval`;
    case 'cluster':
      return `${your(who)} cluster`;
    case 'issue':
      return 'An issue';
    case 'none':
      return 'None yet';
  }
}

/** A row's state, as a glyph and a word: a ring for waiting or in flight, a dash for nothing to do. */
function reads(row: PatchingRow, who: Who): [word: string, tone: string, glyph: GlyphName] {
  const state: MoveState = row.state;
  switch (state.kind) {
    case 'waits':
      return [`Waits on ${you(who)}`, 'attn', 'ring'];
    case 'opened':
      return ['Opened', 'signal', 'ring'];
    case 'stage':
      return [`In ${state.stage}`, 'signal', 'ring'];
    case 'lane':
      return [route(row, who), 'signal', 'ring'];
    case 'no-route':
      return ['No route yet', 'faint', 'dash'];
  }
}

/** What a row's sense found, as its name says it when the event gives none of its own. */
const RUNNING_NAME = {
  'unlisted-image': 'An image no list names',
  'unscanned-digest': 'A running digest no scan read',
  'not-running': 'A pin the cluster does not run yet',
} as const;

const isApp = (row: PatchingRow) => row.repository === APP_REPOSITORY;

/** A row's name, and the place under it: its pin, or where it runs, and whether it is in the app's repository. */
function named(row: PatchingRow): [name: string, where: string, app: boolean] {
  const { source, where } = row;
  if (source.kind === 'move' && source.lockfile && row.name === undefined) {
    return [`A package in ${isApp(row) ? 'the app’s' : 'the factory’s'} lockfile`, 'pnpm-lock.yaml', false];
  }
  if (source.kind !== 'move') {
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

const SEVERITY_WORDS = ['Critical', 'High', 'Medium', 'Low'] as const;
const columns = (c: Counts) => [c.critical, c.high, c.medium, c.low];
/** "2 Critical, 45 High, 60 Medium, 12 Low", with the unrated after, when there are any. */
const severityWords = (c: Counts) =>
  [
    ...columns(c).map((n, i) => `${count(n)} ${SEVERITY_WORDS[i]}`),
    ...(c.unknown ? [`${count(c.unknown)} unrated`] : []),
  ].join(', ');

/** What a row clears, in four fixed columns of tabular mono, a zero wholly muted. */
function Clears({ row }: { row: PatchingRow }) {
  if (!row.clears) return <span className="clr none">not scanned</span>;
  if (row.source.kind === 'move' && row.source.lane === 'none' && total(row.clears) === 0) {
    return <span className="clr none">nothing: no fix yet</span>;
  }
  return (
    <span className="clr">
      <span className="sr">clears {severityWords(row.clears)}</span>
      {columns(row.clears).map((n, i) => (
        <span key={SEVERITY_WORDS[i]} className={n === 0 ? 'zero' : undefined} aria-hidden="true">
          {count(n)}
          <i>{'CHML'[i]}</i>
        </span>
      ))}
    </span>
  );
}

/** Its pull request or work item, after who moves it. */
const linkWords = (row: PatchingRow) => (row.link ? ` · #${row.link.number}` : '');

/** Why a row is where it is: what its lane means, or what the sense found. */
function why(row: PatchingRow, who: Who): string {
  const { source } = row;
  switch (source.kind) {
    case 'unlisted-image':
      return 'The sense found a pod running an image that no pin names, so the daily scan never sees it. It came from outside a merge: a pod started by hand, or by something the list does not read.';
    case 'unscanned-digest':
      return 'A pod runs a reference the list has, at a digest the scan never read, such as a tag rebuilt upstream since: what runs there is not what was scanned.';
    case 'not-running':
      return `main pins it, and ${yours(who)} cluster runs another of the same image: Argo CD has not applied the pin yet, or, for k3s, only the cluster’s own command does.`;
    case 'move':
      switch (source.lane) {
        case 'line':
          return row.link
            ? `The app’s move goes down the line as work item #${row.link.number}: its pins are written, then its gates and review, as any change.`
            : 'The app’s moves are the line’s: it takes one as a work item, as it takes any ticket.';
        case 'worker':
          return 'A pin forward on its own line, which the review gate can prove from its pull request: the factory’s App moves it.';
        case 'dependabot':
          return row.link?.kind === 'pull'
            ? `Dependabot opened #${row.link.number}, to ${row.link.version}, and the move has no High or Critical on a deadline, so the pin stays Dependabot’s.`
            : 'A pin Dependabot reads, with no High or Critical on a deadline, so it stays Dependabot’s.';
        case 'approval':
          return `${source.major ? 'Its fix is a major on, so' : 'It changes more than a pin, so'} the review gate passes it only with ${yours(who)} approval.`;
        case 'cluster':
          return 'Only the cluster’s own command applies a new k3s, with the line stopped: no pull request can show it works.';
        case 'issue':
          return 'No pull request of the factory’s App can write it: mise pins it, or it is a workflow, or a package in the lockfile Dependabot has not moved. A person moves it.';
        case 'none':
          return source.unbuilt
            ? 'Its tag is not a version, and its image is more than 180 days old: a line nobody builds any more, so there is nothing to move to. Its findings count under No fix yet.'
            : 'Nobody publishes a version without its findings yet, so they count under No fix yet. The scan looks again each day; a fix starts its deadline.';
      }
  }
}

/** What Martin does about a row that waits on him. */
function whatToDo(row: PatchingRow, who: Who): string {
  const { source } = row;
  if (source.kind === 'unlisted-image')
    return 'Nothing to merge: add the image to the list in a pull request, or delete the pod. The sense reads again when it starts, and each day.';
  if (source.kind === 'unscanned-digest')
    return 'Pin the digest that runs, or restart the pod onto the one the list names. The sense reads again when it starts, and each day.';
  if (source.kind === 'not-running')
    return 'Sync it in Argo CD, or for k3s run make upgrade-cluster with the line stopped. The row goes once the sense reads it running.';
  if (source.lane === 'cluster')
    return 'Run make upgrade-cluster, with the line stopped. It loses nothing in the store.';
  if (source.lane === 'approval')
    return `Move it in a pull request ${who.martin ? 'of your own' : 'of his own'}, and review it there.`;
  return 'Move it by hand in a pull request: the App writes no mise file, workflow or lockfile.';
}

/** What happens if it is left: the scan fails from its deadline. */
const leftWords = (row: PatchingRow) =>
  row.deadline === undefined ? undefined : `Left as it is, the scan fails from ${when(row.deadline)}.`;

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
  const [word, tone, glyph] = reads(row, who);
  const [name, where, app] = named(row);
  const withheld = row.source.kind === 'move' && row.source.lockfile && row.name === undefined;
  const left = leftWords(row);
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
        </span>
        <span className="facts">
          {withheld ? (
            <span className="ft zero">versions once its pull request opens</span>
          ) : row.source.kind === 'unlisted-image' ? (
            <span className="ft">not on the list</span>
          ) : (
            (row.from || row.to) && (
              <span className="ft">
                {row.from}
                {row.to && (
                  <>
                    {row.from ? ' → ' : ''}
                    <span className="to">{row.to}</span>
                  </>
                )}
              </span>
            )
          )}
          <Clears row={row} />
          <span className={dueSoon(row.deadline, t) ? 'due tone-attn' : 'due'}>{dueWords(row.deadline, t)}</span>
        </span>
        <span className="pill route">
          {route(row, who)}
          {linkWords(row)}
        </span>
        <Glyph name="right" className="glyph chev" />
      </button>
      {open && (
        <div className="more" id={id}>
          <div>
            <span className="label">{row.waits ? 'Why it waits' : 'Where it is'}</span>
            <p>{why(row, who)}</p>
          </div>
          {row.waits && (
            <div>
              <span className="label">What to do</span>
              <p>{who.martin ? whatToDo(row, who) : 'Martin does it, on GitHub or his cluster.'}</p>
              {left && <p className="help">{left}</p>}
            </div>
          )}
          {row.clears && total(row.clears) > 0 && (
            <div>
              <span className="label">Clears · {plural(total(row.clears), 'finding')}</span>
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
            </div>
          )}
          {row.link && (
            <div>
              <span className="label">{row.link.kind === 'pull' ? 'Its pull request' : 'Its work item'}</span>
              <p>
                {row.link.kind === 'pull' ? (
                  <a href={`${repoUrl(row.repository)}/pull/${row.link.number}`} target="_blank" rel="noopener">
                    #{row.link.number} on GitHub ↗
                  </a>
                ) : (
                  // The work item's sheet, opened in place as Guardrails opens an attack's.
                  <button type="button" className="linkish" onClick={() => onOpen(String(row.link?.number))}>
                    #{row.link.number}
                  </button>
                )}
              </p>
            </div>
          )}
          {row.pins.length > 0 && (
            <div>
              <span className="label">{row.source.kind === 'move' ? 'Every pin' : 'Where it runs'}</span>
              <div className="reflist pins">
                {row.pins.map((pin) => (
                  <div key={pin.at}>
                    <span className="mono">{pin.at}</span>
                    <span>{pin.change}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "today", or the day it was, as the line says when the scan ran. */
const onDay = (at: number, t: number) => (startOfDay(at) === startOfDay(t) ? 'today' : `on ${dayLabel(at)}`);

/** A count in the day's line: a zero muted, a count above zero in `attn` where it asks for a look. */
const Figure = ({ n, warm = false }: { n: number; warm?: boolean }) => (
  <span className={n === 0 ? 'zero' : warm ? 'tone-attn' : undefined}>{count(n)}</span>
);
const inMoves = (n: number) => (n > 0 ? ` (in ${plural(n, 'move')} below)` : '');

/** How the day's scan went, in one line: passed or failed, when, and each of its three reasons with where it landed. */
function DayLine({ view, t }: { view: Extract<PatchingView, { state: 'read' }>; t: number }) {
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
            · {r.repository === APP_REPOSITORY ? 'the app’s' : 'the factory’s'} run itself failed:{' '}
            <a href={r.url} target="_blank" rel="noopener">
              its run ↗
            </a>
          </span>
        ))}
        {day.unjudged.map((r) => (
          <span key={r.repository}>
            {' '}
            · {r.repository === APP_REPOSITORY ? 'the app’s' : 'the factory’s'} run wrote no moves:{' '}
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

/** What the head says: how many moves, the rows the sense made, and how many wait. */
function headWords(view: Extract<PatchingView, { state: 'read' }>) {
  const { running } = view;
  return [
    plural(view.moves, 'move'),
    running['unlisted-image'] > 0 && `${plural(running['unlisted-image'], 'image')} off the list`,
    running['unscanned-digest'] > 0 && `${plural(running['unscanned-digest'], 'digest')} no scan read`,
    running['not-running'] > 0 && `${plural(running['not-running'], 'pin')} not running yet`,
  ].filter(Boolean) as string[];
}

const Panel = memo(function Panel({
  view,
  t,
  martin,
  onOpen,
}: {
  view: PatchingView;
  t: number;
  martin: boolean;
  onOpen: (item: string) => void;
}) {
  renders.patching = (renders.patching ?? 0) + 1;
  const who: Who = { martin };
  const [open, setOpen] = useState<string | undefined>(asked);
  const panel = useRef<HTMLElement>(null);
  // A card in Needs you asks for its row: it opens, as a click on it would, and the panel comes into view.
  useEffect(() => {
    const ask = (event: Event) => {
      const key = (event as CustomEvent<unknown>).detail;
      if (typeof key !== 'string') return;
      setOpen(key);
      panel.current?.scrollIntoView({ block: 'start' });
    };
    window.addEventListener(OPEN_ROW, ask);
    return () => window.removeEventListener(OPEN_ROW, ask);
  }, []);
  const readOnly = !martin && <> · Read only</>;
  if (view.state === 'unread') {
    return (
      <section className="panel patching" id="patching" aria-labelledby="patching-title" ref={panel}>
        <div className="panel-head">
          <h2 id="patching-title">Patching</h2>
          <span className="label">No read yet{readOnly}</span>
        </div>
        <p className="patch-empty">
          The dependency sense has not read a day’s scan yet. It reads each morning, after the scan, and when it starts.
        </p>
      </section>
    );
  }
  const head = headWords(view);
  const empty = view.rows.length === 0;
  return (
    <section className="panel patching" id="patching" aria-labelledby="patching-title" ref={panel}>
      <div className="panel-head">
        <h2 id="patching-title">Patching</h2>
        <span className="label">
          {head.join(' · ')}
          {view.waiting > 0 && (
            <>
              {' · '}
              <span className="tone-attn">
                {count(view.waiting)} wait{view.waiting === 1 ? 's' : ''} on {you(who)}
              </span>
            </>
          )}
          {readOnly}
        </span>
      </div>
      {!empty && (
        <p className="help">
          Everything the factory and the app build or run is scanned every day. A finding with a fix has a deadline by
          its severity. One row here is one pin to move, and what moving it clears.
        </p>
      )}
      <DayLine view={view} t={t} />
      {empty && view.day.unjudged.length > 0 ? (
        // Nothing to show is not nothing to move: a run that wrote no moves judged nothing.
        <p className="patch-empty">
          No moves to show: the day’s scan wrote none, so nothing was judged. Its line above says which run, and links
          it.
        </p>
      ) : empty ? (
        <p className="patch-empty">
          Nothing to move. Every finding with a fix has been cleared. {count(view.figures.noFix)}{' '}
          {view.figures.noFix === 1 ? 'has' : 'have'} no fix yet, and {view.figures.noFix === 1 ? 'is' : 'are'} looked
          at again tomorrow.
        </p>
      ) : (
        <>
          <div className="pm-list">
            {view.rows.map((row) => (
              <Row
                key={row.key}
                row={row}
                open={open === row.key}
                onToggle={() => setOpen(open === row.key ? undefined : row.key)}
                who={who}
                t={t}
                onOpen={onOpen}
              />
            ))}
          </div>
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
            A move the review gate can prove from its pull request merges by itself. One that needs a cluster, or
            changes more than a pin, waits on {martin ? 'you' : 'Martin, signed in with his passkey'}. Each merge is in
            the audit log.
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

/**
 * What the view reads of the work items: those that carry a dependency, by where each stands. Two folds that agree on
 * this give the same view, so a new event elsewhere keeps it.
 */
const carriedKey = (items: readonly ItemState[]) =>
  items
    .filter((item) => item.dependency)
    .map((item) => `${item.number}:${item.stage}:${item.closedAt ?? ''}:${item.dependency?.name}`)
    .join(' ');

/** A minute's resolution is all a deadline's words need. */
const MINUTE = 60_000;

/** The panel, from the fold the console's view was drawn from: the events by its time and the work items. */
export function Patching({
  view: drawn,
  admin,
  onOpen,
}: {
  view: View;
  admin: Admin;
  /** Opens a work item's sheet, as the console's other panels do. */
  onOpen: (item: string) => void;
}) {
  const { seen: events, items } = foldOf(drawn);
  const t = drawn.t;
  // The fold holds the events by t already, so the newest day from the sense's role in it is the one to show.
  const read = lastRead(events, t);
  const carried = carriedKey(items);
  const minute = Math.floor(t / MINUTE) * MINUTE;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view reads only the day, the carried work items and the minute, and is kept while they are the same
  const view: PatchingView = useMemo(
    () => (read ? dayView(read.payload, Date.parse(read.ts), items, minute) : { state: 'unread' }),
    [read, carried, minute],
  );
  return <Panel view={view} t={minute} martin={admin.kind === 'martin'} onOpen={onOpen} />;
}
