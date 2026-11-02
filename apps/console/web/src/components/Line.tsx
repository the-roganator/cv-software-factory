/**
 * The line: one station per stage, each captioned with its state word and one figure, the returns drawn over them
 * one at a time, and a panel per stage listing what is in it. Plan carries the "+", a `signal` disc, and its panel ends
 * with the same: Martin asks for an improvement there, and everyone else reads how he does (`ImproveDialog.tsx`).
 */
import type { Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import {
  type CSSProperties,
  lazy,
  type ReactElement,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { STAGE_NAME, STATE } from '../../../../../docs/design/system/station.ts';
import type { Admin } from '../admin.ts';
import { clock, duration, shortVersion } from '../format.ts';
import {
  type CapSpell,
  type PanelRow,
  type Return,
  type RowState,
  SENSE,
  type SenseCount,
  type Station,
  type Status,
  type View,
  whileSending,
} from '../projection/index.ts';
import { Glyph } from './Glyph.tsx';

/** The "+"'s dialog arrives when it is first opened. */
const ImproveDialog = lazy(() => import('./ImproveDialog.tsx').then((module) => ({ default: module.ImproveDialog })));

/** What the "+" is called: Martin asks with it, and everyone else reads how. */
const plusName = (admin: Admin) =>
  admin.kind === 'martin' ? 'Request an improvement' : 'How Martin asks for an improvement';

/** The "+" drawn small, as the disc and the panel's button carry it. */
const PLUS = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1.5V10.5M1.5 6H10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const BLURB: Record<Stage, string> = {
  sense: 'What the probes, the crawler, telemetry and visitor reports picked up.',
  triage: 'Signals deduplicated and backed with evidence before anyone plans work.',
  plan: 'Specs and questions. Improvements wait here for approval.',
  build: 'Coder agents write a failing test first, then the fix.',
  gates: 'Deterministic checks every pull request must pass. Always enforced.',
  review: 'The reviewer’s rounds, the describer, and the wait for Martin’s merge.',
  release: 'Signed images behind a canary that can roll itself back.',
  verify: 'Has the original signal cleared in production? New problems it finds go back to Sense.',
};

/** Sources not built for the demo, shown as such. */
const ELSEWHERE = ['Slack', 'Linear or Jira'];

const SHOW_MS = 5200;
const GAP_MS = 900;

/** Cycles through the returns, newest first, about five seconds each. With motion off, the newest holds still. */
function useReturn(returns: readonly Return[], motion: boolean, stopped: boolean): Return | undefined {
  const [index, setIndex] = useState(0);
  const [showing, setShowing] = useState(true);
  const key = returns.map((r) => `${r.item}@${r.at}`).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new set of returns starts again from the newest
  useEffect(() => setIndex(0), [key]);
  useEffect(() => {
    if (!motion || returns.length === 0 || stopped) {
      setShowing(true);
      return;
    }
    setShowing(true);
    let timer = setTimeout(function hide() {
      setShowing(false);
      timer = setTimeout(() => {
        setIndex((i) => (i + 1) % returns.length);
        setShowing(true);
        timer = setTimeout(hide, SHOW_MS);
      }, GAP_MS);
    }, SHOW_MS);
    return () => clearTimeout(timer);
  }, [motion, returns.length, stopped]);
  if (stopped || !showing) return undefined;
  return returns[motion ? index % returns.length : 0];
}

/** The arc from the sender back to the receiver, in the line's 1344 × 220 coordinates. */
function arc(r: Return) {
  const x = (stage: Stage) => 84 + 168 * STAGES.indexOf(stage);
  const back = STAGES.indexOf(r.to) < STAGES.indexOf(r.from) ? 1 : -1;
  const [x1, x2] = [x(r.from) - 12 * back, x(r.to) + 12 * back];
  const span = Math.abs(x1 - x2);
  const peak = -34 - Math.min(16, span * 0.015);
  return { d: `M${x1} 20 Q${(x1 + x2) / 2} ${2 * peak - 20} ${x2} 20`, mid: (x1 + x2) / 2, peak };
}

/**
 * Parcels on the belt: running through a working stage, piling up in front of one that needs you, and queued in
 * front of one that has tickets waiting for it. Decorative: the counts are in the captions and the panels.
 */
function Parcels({ stations }: { stations: readonly Station[] }) {
  return (
    <g>
      {stations.flatMap((s, i) => {
        const x = 168 * i;
        if (s.queued && s.status === 'idle') {
          // Up to three, stacked two and one, on the belt just before the station.
          return [0, 1, 2]
            .slice(0, Math.min(3, s.queued))
            .map((n) => (
              <rect
                key={`${s.stage}-queued-${n}`}
                className="parcel"
                x={x - 36 + (n === 2 ? 8 : n * 16)}
                y={n === 2 ? 162 : 174}
                width="14"
                height="12"
                rx="1.5"
              />
            ));
        }
        // A station at work while an item waits on a human: the pile in front, and a parcel running through.
        const pile = (s.beacon ? [0, 1] : []).map((n) => (
          <rect
            key={`${s.stage}-held-${n}`}
            className="parcel"
            x={x - 32 + n * 16}
            y="174"
            width="14"
            height="12"
            rx="1.5"
          />
        ));
        if (s.status === 'working' || s.status === 'passing') {
          const style = {
            '--run-from': `${x}px`,
            '--run-to': `${x + 150}px`,
            '--run-time': s.status === 'passing' ? '6s' : '3.5s',
          } as CSSProperties;
          return [
            ...pile,
            <g key={s.stage} className="run" style={style}>
              <rect className="parcel" x="0" y="174" width="14" height="12" rx="1.5" />
            </g>,
          ];
        }
        if (s.status === 'blocked' || s.status === 'failed') {
          return [0, 1].map((n) => (
            <rect
              key={`${s.stage}${n}`}
              className="parcel"
              x={x - 32 + n * 16}
              y="174"
              width="14"
              height="12"
              rx="1.5"
            />
          ));
        }
        return pile;
      })}
    </g>
  );
}

interface LineProps {
  view: View;
  motion: boolean;
  onOpen: (item: string) => void;
  /** Who is looking: Martin's "+" asks, and everyone else's shows how he does. */
  admin: Admin;
  /** No events yet: the stations wait, idle, saying so. */
  pending?: boolean;
  /** The canary bird is out of the Release station's cage, keeping the Canary panel company (`Bird.tsx`). */
  birdOut?: boolean;
}

export function Line({ view, motion, onOpen, admin, pending = false, birdOut = false }: LineProps) {
  const [open, setOpen] = useState<Stage | null>(null);
  const [improving, setImproving] = useState(false);
  const line = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<Stage, HTMLButtonElement>());
  const stopped = view.header.stopped !== undefined;
  const current = useReturn(view.returns, motion, stopped);

  const close = useCallback(() => {
    setOpen((was) => {
      if (was) buttons.current.get(was)?.focus();
      return null;
    });
  }, []);

  return (
    <section className="line" aria-label="The line" ref={line}>
      <ul className="stations">
        {view.stations.map((s) => {
          const sending = current?.from === s.stage;
          const status: Status = stopped ? 'blocked' : whileSending(s.status, sending);
          // A lit beacon names what a person has to do, while the drawing says the station is still at work.
          const beacon = stopped ? undefined : s.beacon;
          // At a spend cap, Triage uses the blocked drawing with its own word, and says when the cap resets.
          const capped = !stopped && s.cappedUntil !== undefined;
          const shown = beacon === 'failed' ? 'failed' : beacon ? 'blocked' : status;
          const word = pending ? 'reading' : stopped ? 'stopped' : capped ? 'capped' : STATE[shown].label;
          const tone = pending ? 'faint' : stopped ? 'attn' : STATE[shown].tone;
          // The name starts with the caption's words in the caption's order, so a person who says what they see
          // reaches the button. A station still at work under its beacon says so after them.
          const still =
            !stopped && !capped && beacon && (status === 'working' || status === 'returning')
              ? `, still ${STATE[status].label}`
              : '';
          // A failed station's hatch reads FAULT, drawn above its caption, so its name starts with that word.
          const fault = !stopped && !capped && status === 'failed' ? 'Fault. ' : '';
          const figure = capped ? `until ${clock(s.cappedUntil ?? 0)}` : s.figure;
          return (
            <li key={s.stage} className={s.stage === 'plan' ? 'plan' : undefined}>
              <button
                type="button"
                className="stage"
                ref={(button) => {
                  if (button) buttons.current.set(s.stage, button);
                }}
                aria-expanded={open === s.stage}
                aria-controls="stage-panel"
                aria-label={
                  pending
                    ? `${STAGE_NAME[s.stage]}: reading the factory’s events`
                    : `${fault}${STAGE_NAME[s.stage]}: ${word}, ${figure}${still}. Show what is in this stage`
                }
                disabled={pending}
                onClick={() => setOpen((was) => (was === s.stage ? null : s.stage))}
              >
                <sf-station
                  kind={s.stage}
                  status={status}
                  beacon={beacon}
                  decorative
                  motion={motion ? undefined : 'off'}
                  bird={s.stage === 'release' && birdOut ? 'out' : undefined}
                />
                {/* The spaces keep the caption's words apart where its text is read, laid out in a column. */}
                <span className="cap" aria-hidden="true">
                  <span className="name">{STAGE_NAME[s.stage]}</span>{' '}
                  <span className="state">
                    <span className={`dot tone-${tone} ${tone === 'attn' ? 'ring' : ''}`} />
                    {word}
                  </span>{' '}
                  {!pending && <span className={`fig ${capped ? 'keep' : ''}`}>{figure}</span>}
                </span>
              </button>
              {s.stage === 'plan' && (
                <button
                  type="button"
                  className="add"
                  title={plusName(admin)}
                  aria-label={plusName(admin)}
                  disabled={pending}
                  onClick={() => setImproving(true)}
                >
                  <span>{PLUS}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="overlay" aria-hidden="true">
        <svg viewBox="0 0 1344 220" aria-hidden="true">
          <defs>
            <marker
              id="ret-head"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="9"
              markerHeight="9"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="ret-head" d="M2 1.5 L8 5 L2 8.5" />
            </marker>
          </defs>
          <Parcels stations={view.stations} />
          {current && <ReturnArc r={current} />}
        </svg>
        {current && <ReturnPill r={current} />}
      </div>
      <p className="ret-note" aria-hidden="true">
        {current && (
          <>
            <Glyph name="back" />
            {STAGE_NAME[current.from]} → {STAGE_NAME[current.to]} · {current.text}
          </>
        )}
      </p>
      {open && (
        <StagePanel
          stage={open}
          view={view}
          anchor={buttons.current.get(open)}
          container={line.current}
          onClose={close}
          onOpen={(item) => {
            setOpen(null);
            onOpen(item);
          }}
          plus={plusName(admin)}
          onImprove={() => {
            setOpen(null);
            setImproving(true);
          }}
        />
      )}
      {improving && (
        <Suspense fallback={null}>
          <ImproveDialog admin={admin} improve={view.improve} onClose={() => setImproving(false)} />
        </Suspense>
      )}
    </section>
  );
}

function ReturnArc({ r }: { r: Return }) {
  return <path className="ret ret-arc show" d={arc(r).d} markerEnd="url(#ret-head)" />;
}

function ReturnPill({ r }: { r: Return }) {
  const { mid, peak } = arc(r);
  const style = { left: `${(mid / 1344) * 100}%`, top: `${(peak / 220) * 100}%` } as CSSProperties;
  return (
    <span className="ret pill ret-pill show" style={style}>
      <Glyph name="back" />
      {r.text}
    </span>
  );
}

/**
 * Where Triage's work comes from: each sense, the signals that became events and the tickets they opened. Counted
 * from events alone, so live and replay agree; the inbox's repeats are not events, and the panel says so.
 */
function Sources({ senses }: { senses: SenseCount[] }) {
  const reports = senses.find((row) => row.sense === 'report')?.routes;
  const routes = reports
    ? [
        reports.quarantined && `${reports.quarantined} quarantined`,
        reports.parked && `${reports.parked} parked`,
        reports.closed && `${reports.closed} closed`,
        reports.joined && `${reports.joined} joined a ticket`,
      ].filter(Boolean)
    : [];
  return (
    <div className="sources">
      <table>
        <caption className="label">Takes work from</caption>
        <thead>
          <tr>
            <th className="label">Sense</th>
            <th className="label num">Signals</th>
            <th className="label num">Tickets</th>
          </tr>
        </thead>
        <tbody>
          {senses.map((row) => (
            <tr key={row.sense}>
              <th scope="row">
                {SENSE[row.sense].group}
                <small>{row.sense === 'report' && routes.length ? routes.join(' · ') : SENSE[row.sense].watches}</small>
              </th>
              <td className={`num ${row.signals ? '' : 'zero'}`}>{row.signals}</td>
              <td className={`num ${row.tickets ? '' : 'zero'}`}>{row.tickets}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="elsewhere">
        {ELSEWHERE.map((name) => (
          <span key={name} className="src off">
            {name}
            <em> not in the demo</em>
          </span>
        ))}
      </div>
      <p className="help">
        A signal counts here when it opened a ticket or added a sense’s evidence to one, once a version. The rest are
        counted by the inbox, not here.
      </p>
    </div>
  );
}

const CAP_NAME = { day: 'The daily spend cap', month: 'The monthly spend cap' };

/**
 * A spend cap in Triage's panel, written as returns are: while it holds, with the work and ruled as held; for the rest
 * of the day it cleared, with what left today.
 */
function CapRow({ spell, t, first }: { spell: CapSpell; t: number; first: boolean }) {
  const cleared = spell.cleared;
  const state = cleared === undefined ? 'held' : 'passed';
  return (
    <div className={rowClass(state, cleared !== undefined, first)}>
      <span className="id">
        cap
        <StatusIcon state={state} />
      </span>
      <span>
        {CAP_NAME[spell.cap]}: reached at {clock(spell.reached)}
        {cleared !== undefined && `, cleared at ${clock(cleared)}`}
        <small className={cleared === undefined ? 'tone-attn' : ''}>
          {cleared === undefined
            ? `Reports wait in the inbox until ${clock(spell.resets)}, ${duration(spell.resets - t)} from now`
            : `Reports waited in the inbox for ${duration(cleared - spell.reached)}`}
        </small>
      </span>
      <span className="aside">{cleared === undefined ? '' : '↺'}</span>
    </div>
  );
}

interface PanelProps {
  stage: Stage;
  view: View;
  anchor: HTMLElement | undefined;
  container: HTMLElement | null;
  onClose: () => void;
  onOpen: (item: string) => void;
  /** The "+"'s name, which Plan's panel ends with, and what it opens. */
  plus: string;
  onImprove: () => void;
}

/**
 * Each row's status icon, on a 12px grid in the console's glyph strokes: solid shapes, as outlines read weakly this
 * small, and a stroked tick. Media-player signs, so they read without a key: play for the work in hand, stop for
 * held or failed, pause for waiting, next for passed on, previous for sent back upstream, and a tick for verified.
 */
const SHAPES: Record<RowState, ReactElement> = {
  'in-hand': <path className="solid" d="M3.75 2.5 9.5 6 3.75 9.5Z" />,
  held: <rect className="solid" x="3" y="3" width="6" height="6" rx="0.5" />,
  waiting: (
    <>
      <rect className="solid" x="3.5" y="2.75" width="1" height="6.5" />
      <rect className="solid" x="7.5" y="2.75" width="1" height="6.5" />
    </>
  ),
  passed: (
    <>
      <path className="solid" d="M2.75 2.75 7.25 6 2.75 9.25Z" />
      <rect className="solid" x="9" y="2.75" width="0.75" height="6.5" />
    </>
  ),
  'sent-back': (
    <>
      <path className="solid" d="M9.25 2.75 4.75 6 9.25 9.25Z" />
      <rect className="solid" x="2.25" y="2.75" width="0.75" height="6.5" />
    </>
  ),
  verified: <path d="M2.75 6.25 5 8.5 9.25 3.5" />,
};

/**
 * A row's status icon, under its number. Hidden from a screen reader: the note says the state in words, and a row in
 * hand says "working" in words a screen reader reads. In hand while the station is at work, it is the station's
 * `signal`, blinking as the reel's "In progress" does; stopped, capped or held, the station is not at work on it, and
 * it stays faint.
 */
function StatusIcon({ state, working }: { state: RowState; working?: true | undefined }) {
  return (
    <svg className={working ? 'glyph sicon tone-signal blink' : 'glyph sicon'} viewBox="0 0 12 12" aria-hidden="true">
      {SHAPES[state]}
    </svg>
  );
}

/**
 * A row's classes: an `attn` rule when held, an `ok` rule when verified, dimmed when it left otherwise, and the first
 * that left under a stronger hairline.
 */
function rowClass(state: RowState, left: boolean | undefined, first: boolean) {
  const ruled = state === 'held' ? 'ruled tone-attn' : state === 'verified' ? 'ruled tone-ok' : left && 'left';
  return ['srow', ruled, first && 'first-left'].filter(Boolean).join(' ');
}

/** One row of a stage panel: a work item, which opens its sheet, or a release with no work item, which opens nothing. */
function Row({ row, first, onOpen }: { row: PanelRow; first: boolean; onOpen: (item: string) => void }) {
  const className = rowClass(row.state, row.left, first);
  const note = row.working ? 'working' : `tone-${row.tone}`;
  if (row.release) {
    // A release with no work item has no sheet to open: its row is the Canary panel's in one line. It has no
    // accessible name of its own either, so the word "working" is written for a screen reader.
    return (
      <div className={className}>
        <span className="id" title={row.item}>
          {shortVersion(row.item)}
          <StatusIcon state={row.state} working={row.working} />
        </span>
        <span>
          {row.title}
          <small className={note}>
            {row.working && <span className="sr">working, </span>}
            {row.note}
          </small>
        </span>
      </div>
    );
  }
  // The row's words are its name, in the order they are seen, so a person who says what they see reaches it, and
  // what only the drawing says (the station is at work on it; a struck-out step was an earlier one) is written in for
  // a screen reader.
  return (
    <button type="button" className={className} onClick={() => onOpen(row.item)}>
      <span className="id">
        #{row.item}
        <StatusIcon state={row.state} working={row.working} />
      </span>{' '}
      <span>
        {row.title}
        <span className="sr">: </span>{' '}
        <small className={note}>
          {row.working && <span className="sr">working, </span>}
          {row.earlier.map((e) => (
            <span key={e}>
              <span className="sr">earlier </span>
              <s>{e}</s> ·{' '}
            </span>
          ))}
          {row.note}
        </small>
      </span>{' '}
      <span className="aside go">
        Open<span aria-hidden="true"> ›</span>
      </span>
    </button>
  );
}

function StagePanel({ stage, view, anchor, container, onClose, onOpen, plus, onImprove }: PanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const { rows, senses, caps, queued } = view.panels[stage];
  // One list: the work in hand, a spend cap that holds (with the work, as held), the rest of what is in the stage,
  // then a cap that cleared today and what left the stage today, the first of them under a stronger hairline.
  const list: (PanelRow | CapSpell)[] = [
    ...rows.filter((row) => !row.left && row.state === 'in-hand'),
    ...caps.filter((spell) => spell.cleared === undefined),
    ...rows.filter((row) => !row.left && row.state !== 'in-hand'),
    ...caps.filter((spell) => spell.cleared !== undefined),
    ...rows.filter((row) => row.left),
  ];
  const firstLeft = list.findIndex((entry) => ('cap' in entry ? entry.cleared !== undefined : entry.left));

  // Under its station, kept inside the line; on a phone the styles make it a bottom sheet instead.
  useLayoutEffect(() => {
    const position = () => {
      if (!anchor || !container) return;
      const box = container.getBoundingClientRect();
      const button = anchor.getBoundingClientRect();
      const centre = button.left - box.left + button.width / 2;
      const left = Math.max(0, Math.min(box.width - 400, centre - 200));
      setPlace({
        '--panel-left': `${left}px`,
        '--panel-top': `${button.bottom - box.top + 12}px`,
        '--caret-left': `${centre - left - 7}px`,
      } as CSSProperties);
    };
    position();
    addEventListener('resize', position);
    return () => removeEventListener('resize', position);
  }, [anchor, container]);

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const onEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', onEscape);
    };
  }, [anchor, onClose]);

  return (
    <div className="stage-panel" id="stage-panel" role="dialog" aria-labelledby="stage-title" ref={panel} style={place}>
      <span className="caret" />
      <header>
        <div>
          <h3 id="stage-title" tabIndex={-1} ref={title}>
            {STAGE_NAME[stage]}
          </h3>
        </div>
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <p>{BLURB[stage]}</p>
      {rows.length === 0 && caps.length === 0 && <div className="empty">Nothing in {STAGE_NAME[stage]} today.</div>}
      {list.map((entry, i) =>
        'cap' in entry ? (
          <CapRow key={`cap-${entry.cap}-${entry.reached}`} spell={entry} t={view.t} first={i === firstLeft} />
        ) : (
          <Row key={`${entry.item}-${entry.at}`} row={entry} first={i === firstLeft} onOpen={onOpen} />
        ),
      )}
      {senses && (
        <div className="ref">
          <Sources senses={senses} />
        </div>
      )}
      {stage === 'plan' && queued > 0 && (
        <div className="ref">
          <p className="queue-note">
            Tickets wait here for the planner, which takes one at a time, and an improvement Martin asked for waits
            behind every open ticket.
          </p>
        </div>
      )}
      {stage === 'plan' && (
        <button type="button" className="btn plus" onClick={onImprove}>
          {PLUS}
          {plus}
        </button>
      )}
    </div>
  );
}
