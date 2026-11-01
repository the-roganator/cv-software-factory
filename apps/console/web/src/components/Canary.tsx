/**
 * The Canary panel: the release in flight against the version it would replace, for everyone, full width under the
 * line. It is always there; before the first release, it is one line. Under the steps and the measures are Martin's controls: buttons for
 * him, and for a visitor the same controls as labels beside what each does.
 */
import type { ReleaseControl } from '@software-factory/events';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Admin } from '../admin.ts';
import { clockSeconds, duration, isCommit, shortVersion, times } from '../format.ts';
import type { CanaryView, Carried, Measured, Release } from '../projection/index.ts';
import {
  abortWords,
  actingWords,
  BACKGROUND,
  type Control,
  CUT,
  controlsOf,
  type Fig,
  failedLooks,
  figureOf,
  firstMeasured,
  horizon,
  JUDGED,
  judgedSaid,
  liveFigures,
  lookOf,
  lookVerdict,
  MEASURES,
  measureLabel,
  measuring,
  nextWords,
  note,
  ownWords,
  phaseOf,
  pointsOf,
  rollouts,
  room,
  SIGNALLED,
  type Switched,
  sawOf,
  showsMeasures,
  standing,
  stepLeft,
  stepPhase,
  stoppedBy,
  type Tone,
  type VerdictPhase,
  waitsForAnalysis,
  written,
} from '../projection/release.ts';
import { Dialog } from './Dialog.tsx';
import { Glyph, type GlyphName } from './Glyph.tsx';
import { ToolMark } from './Logos.tsx';
import { type Asked, Key } from './StepUp.tsx';
import { Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

/** A measure's verdict, from the analysis's own phases: in flight is ink, only a pass is green, a failure is warm. */
export const VERDICT: Record<VerdictPhase, [word: string, tone: Tone, glyph: GlyphName]> = {
  successful: ['passed', 'ok', 'check'],
  failed: ['failed', 'attn', 'cross'],
  running: ['measuring', 'signal', 'ring'],
  pending: ['waiting', 'faint', 'dash'],
  error: ['could not measure', 'faint', 'dash'],
  inconclusive: ['inconclusive · waits for Martin', 'attn', 'ring'],
  // A measure the analysis judged bad in a canary Martin then aborted: a rollback all the same.
  judged: ['judged bad', 'attn', 'cross'],
  dry: ['recorded', 'faint', 'dash'],
  none: ['not measured', 'faint', 'dash'],
};

/** A verdict in words, in its tone, with its glyph. */
type Said = [word: string, tone: Tone, glyph: GlyphName];

function Words({ said: [word, tone, glyph] }: { said: Said }) {
  return (
    <span className={`v tone-${tone}`}>
      <Glyph name={glyph} />
      {word}
    </span>
  );
}

/**
 * A verdict, and for a measure a rollback failed, how many of its looks failed when the event counted them, and by how
 * much the last went over: "failed twice · 64 ms over".
 */
export function Verdict({
  phase,
  looks,
  over,
}: {
  phase: keyof typeof VERDICT;
  looks?: number | undefined;
  over?: string | undefined;
}) {
  const [word, tone, glyph] = VERDICT[phase];
  const counted = looks === undefined ? word : `${word} ${times(looks)}`;
  return <Words said={[over ? `${counted} · ${over}` : counted, tone, glyph]} />;
}

/** The steps: a bar that is the canary's share of the traffic, with a stop at each step's weight. */
function Steps({ r, tone }: { r: Release; tone: Tone }) {
  const { end } = r;
  return (
    <div className={`steps-track ${r.dryRun ? 'dry' : ''}`}>
      <span className="rl" />
      <span className={`fill tone-${r.dryRun ? 'faint' : tone}`} style={{ width: `${r.weight}%` }} />
      {r.steps[0] && r.steps[0].weight >= 10 && (
        <span className="origin" aria-hidden="true">
          0%
        </span>
      )}
      <ol aria-label="The canary’s steps">
        {r.steps.map(({ weight, pauseSeconds: pause, analysis }, index) => {
          // Only a step the analysis judges is measured: a plan may hold its weight twice, a pause and then a judgement.
          const m = analysis ? r.measured.find((x) => x.weight === weight) : undefined;
          let [cls, t, glyph, how]: [string, Tone, GlyphName | '', string] = ['', 'faint', '', 'to come'];
          if (end && end.kind !== 'promoted' && weight === end.weight)
            [cls, t, glyph, how] = [
              'done cut',
              'attn',
              end.kind === 'rolled-back' ? 'cross' : 'dash',
              `${CUT[stoppedBy(end) ?? 'rolled-back']} here`,
            ];
          else if (m || (end?.kind === 'promoted' && weight === 100)) {
            const [word, tone, mark] = VERDICT[r.dryRun ? 'dry' : m ? stepPhase(m) : 'successful'];
            [cls, t, glyph, how] = ['done', tone, mark, word];
          } else if (!end && index === r.step && r.judgedBad)
            [cls, t, glyph, how] = ['done', 'attn', 'ring', 'judged bad here, waiting for Martin'];
          else if (!end && index === r.step) [cls, how] = ['now', analysis ? 'measuring now' : 'here now'];
          else if (index < r.step) [cls, how] = ['done', analysis ? 'passed' : 'not judged'];
          const held =
            weight === 100
              ? 'all'
              : !r.planned
                ? ''
                : (pause === null ? 'waits' : pause % 60 ? `${pause}s` : `${pause / 60}min`) +
                  (analysis ? '' : ' · not judged');
          return (
            <li
              key={`${weight}-${pause}-${analysis}`}
              className={`stop ${cls} tone-${t}`}
              style={{ left: `${weight}%` }}
            >
              <i>{glyph && <Glyph name={glyph} />}</i>
              <b>{weight}%</b>
              <small>{held}</small>
              <span className="sr">, {how}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** How long a figure counts up to its new value. */
const COUNT_MS = 650;

/**
 * A cell whose figure a look changes. When a new look lands it counts up from the figure before, writing React's own
 * text node through a ref each frame, so nothing renders while it counts (the console's rule for anything that runs
 * every frame), and the cell comes up from faint to its own colour. Nothing moves. With motion off, the figure is
 * simply written.
 */
function Fresh({
  fig: { value, text, unit },
  look,
  motion,
  className,
  children,
}: {
  fig: Fig;
  look: number | undefined;
  motion: boolean;
  className: string;
  children?: ReactNode;
}) {
  const cell = useRef<HTMLTableCellElement>(null);
  const was = useRef({ look, value });
  // What React draws now: a count cut short ends there, not at the figure it was counting to.
  const drawn = useRef(text);
  drawn.current = text;
  useLayoutEffect(() => {
    const before = was.current;
    was.current = { look, value };
    const td = cell.current;
    if (!td || !motion || look === undefined || before.look === undefined || before.look === look) return;
    td.classList.remove('landed');
    // Read a layout, so the animation starts again from its beginning.
    void td.offsetWidth;
    td.classList.add('landed');
    const node = td.firstChild;
    const from = before.value;
    if (value === null || from === null || from === value || !(node instanceof Text)) return;
    const start = performance.now();
    node.nodeValue = written(unit, from);
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / COUNT_MS);
      node.nodeValue = written(unit, from + (value - from) * (1 - (1 - k) ** 3));
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
      node.nodeValue = drawn.current;
    };
  }, [look, value, unit, motion]);
  return (
    <td ref={cell} className={className}>
      {text}
      {children}
    </td>
  );
}

const [W, H] = [150, 30];

/**
 * A measure over the release, under the trend column: errors and latency as a line each for the canary (ink) and the
 * baseline (faint), with the limit dashed and warm, and a dotted tick at each step; the requests as a bar with a mark
 * at the least the window needs; the journeys as a dot for each run, hollow and warm for one that failed. It is drawn
 * for the eye: the figures and the verdict beside it say the same in words.
 */
function Trend({ r, name }: { r: Release; name: string }) {
  const [from, to] = horizon(r);
  const x = (at: number) => 3 + ((at - from) / Math.max(1, to - from)) * (W - 6);
  if (name === 'enough-requests') {
    const n = lookOf(r, name)?.figures?.canary.requests;
    const min = BACKGROUND.minRequests;
    const top = Math.max(3 * min, n ?? 0);
    return (
      <td className="trend" aria-hidden="true">
        {n != null && (
          <span className={`reqbar ${n >= min ? 'enough' : ''}`}>
            <span className="f" style={{ width: `${(n / top) * 100}%` }} />
            <i className="m" style={{ left: `${(min / top) * 100}%` }} />
          </span>
        )}
      </td>
    );
  }
  if (name === 'journeys') {
    const runs = r.looks.filter((l) => l.measures.some((m) => m.name === name));
    return (
      <td className="trend" aria-hidden="true">
        {runs.length > 0 && (
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            {runs.map((l) => (
              <circle
                key={l.at}
                className={l.measures.some((m) => m.name === name && m.phase === 'failed') ? 'pip bad' : 'pip'}
                cx={x(l.at)}
                cy={H / 2}
                r={3.5}
              />
            ))}
          </svg>
        )}
      </td>
    );
  }
  const points = name === 'errors' || name === 'latency' ? pointsOf(r, name) : [];
  const last = points.at(-1);
  if (!last) return <td className="trend" aria-hidden="true" />;
  const all = points.flatMap((p) => [p.canary, p.baseline, p.limit]);
  const pad = (Math.max(...all) - Math.min(...all)) * 0.12 || 1;
  const [lo, hi] = [Math.min(...all) - pad, Math.max(...all) + pad];
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  const line = (k: 'canary' | 'baseline' | 'limit') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)} ${y(p[k]).toFixed(1)}`).join(' ');
  const ticks = [...r.measured.map((m) => m.at), ...(r.end ? [] : [r.until ?? 0])].filter(
    (at) => at > from && at <= to,
  );
  return (
    <td className="trend" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {ticks.map((at) => (
          <line key={at} className="tick" x1={x(at)} x2={x(at)} y1={0} y2={H} />
        ))}
        <path className="lim" d={line('limit')} />
        <path className="bl" d={line('baseline')} />
        <path className="cn" d={line('canary')} />
        {points.map((p) =>
          p.failed || p === last ? (
            <circle
              key={p.at}
              className={p.failed ? 'pt over' : 'pt'}
              cx={x(p.at)}
              cy={y(p.canary)}
              r={p === last ? 2.6 : 2.2}
            />
          ) : null,
        )}
      </svg>
    </td>
  );
}

/**
 * Calls `draw` with the time now once a second while the console's clock runs, counted on from `t`. What it draws it
 * writes through refs, so the panel never renders for it; a clock that stands still (a recording, `?t=`) draws nothing
 * more.
 */
function useEachSecond(t: number, ticking: boolean, draw: (now: number) => void) {
  const latest = useRef(draw);
  latest.current = draw;
  useEffect(() => {
    if (!ticking) return;
    const from = Date.now();
    const timer = setInterval(() => latest.current(t + Date.now() - from), 1000);
    return () => clearInterval(timer);
  }, [t, ticking]);
}

/**
 * Writes new words into the one text node React drew in an element, so React's next render finds its own node there
 * and draws over it: setting `textContent` would put a node of its own in its place, which React never updates.
 */
function rewrite(el: HTMLElement | null, words: string) {
  const node = el?.firstChild;
  if (node instanceof Text) node.nodeValue = words;
}

/** The console's clock, for the parts of the panel that move with it. */
export interface Clock {
  t: number;
  /** Whether it moves on by itself: live, and not pinned by `?t=`. */
  ticking: boolean;
  motion: boolean;
}

const STILL: Clock = { t: 0, ticking: false, motion: false };

/**
 * The measures: as each look of the background analysis lands while the release is in flight, or at the latest step
 * measured. Before the first step is measured and before any look, the same rows wait for it, with no figures, each
 * measuring. With looks, a column draws each measure over the release.
 */
function Measures({
  r,
  m,
  until,
  clock: { t, ticking, motion } = STILL,
}: {
  r: Release;
  m: Measured | undefined;
  until?: number | undefined;
  clock?: Clock;
}) {
  // A step that judged the canary bad is the story: its own figures, not the latest look's.
  const live = measuring(r) && !(r.judgedBad && m && m.at === r.judgedBad.at);
  const trend = r.looks.length > 0;
  const next = useRef<HTMLSpanElement>(null);
  const { nextLook } = r;
  useEachSecond(t, ticking && live && nextLook !== undefined, (now) => {
    if (nextLook !== undefined) rewrite(next.current, nextWords(nextLook - now));
  });
  const failedOf = (name: string) => (r.end?.kind === 'rolled-back' ? r.end.failed.filter((f) => f.name === name) : []);
  const { judgedBad } = r;
  return (
    <table className={`measures ${trend ? 'trended' : ''}`}>
      <caption className="label">
        {judgedBad ? (
          `At the ${judgedBad.weight}% step · judged bad ${clockSeconds(judgedBad.at)}`
        ) : live ? (
          <>
            At the {r.weight}% step · {r.until === undefined ? 'measuring' : `measuring until ${clockSeconds(r.until)}`}
            {nextLook !== undefined && (
              <>
                {' · '}
                <span ref={next}>{nextWords(nextLook - t)}</span>
              </>
            )}
          </>
        ) : m ? (
          <>
            At the {m.weight}% step ·{' '}
            {r.dryRun ? `recorded ${clockSeconds(m.at)} by the dry run` : `measured ${clockSeconds(m.at)}`}
          </>
        ) : (
          `At the ${r.weight}% step · measuring until ${until === undefined ? '' : clockSeconds(until)}`
        )}
      </caption>
      <colgroup>
        <col className="name" />
        <col className="fig" />
        <col className="fig base" />
        {trend && <col className="tr" />}
        <col className="vd" />
      </colgroup>
      <thead>
        <tr>
          <th className="label">Measure</th>
          <th className="label">Canary</th>
          <th className="label base">Baseline</th>
          {trend && <th className="label tr">Over the release</th>}
          <th className="label">Verdict</th>
        </tr>
      </thead>
      <tbody>
        {MEASURES.map(([name, label, rule]) => {
          if (live) {
            const { words, kind, ruled } = lookVerdict(r, name);
            const [word, tone, glyph] = kind === 'warm' ? (['', 'attn', 'ring'] as const) : VERDICT[kind];
            const { canary, baseline } = liveFigures(r, name);
            const latest = lookOf(r, name);
            const look = latest?.at;
            const message = latest?.measures.find((x) => x.name === name)?.message;
            return (
              <tr key={name} className={ruled ? 'failed' : ''}>
                <td>
                  {label}
                  <small className="measure-rule">{rule}</small>
                </td>
                <Fresh className="mono" fig={canary} look={look} motion={motion}>
                  <span className="base-inline">baseline {baseline.text}</span>
                </Fresh>
                <Fresh className="mono base" fig={{ ...baseline, value: null }} look={look} motion={motion} />
                <Trend r={r} name={name} />
                <td>
                  <Words said={[words || word, tone, glyph]} />
                  {kind === 'error' && message && <small>{message}</small>}
                </td>
              </tr>
            );
          }
          const measure = m?.stepped.analysis.measures.find((x) => x.name === name);
          const phase = m ? phaseOf(r, m, name) : 'running';
          const [canary, baseline] = m
            ? [figureOf(r, m, name, 'canary'), figureOf(r, m, name, 'baseline')]
            : ['—', '—'];
          // How far over its limit the rollback's look of it went, where one run failed it and said by how much.
          const condemned = phase === 'failed' || phase === 'judged';
          const [f, ...more] = condemned ? failedOf(name) : [];
          const over =
            f && !more.length && JUDGED.has(name) && f.value !== null && f.limit !== null
              ? `${room(name, f.value, f.limit)} over`
              : undefined;
          return (
            <tr key={name} className={condemned || phase === 'inconclusive' ? 'failed' : ''}>
              <td>
                {label}
                <small className="measure-rule">{rule}</small>
              </td>
              <td className="mono">
                {canary}
                <span className="base-inline">baseline {baseline}</span>
              </td>
              <td className="mono base">{baseline}</td>
              {trend && <Trend r={r} name={name} />}
              <td>
                <Verdict phase={phase} looks={condemned ? failedLooks(r.end, name) : undefined} over={over} />
                {phase === 'error' && measure?.message && <small>{measure.message}</small>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * How far through its step the canary is, while the step's pause ends by itself: the step in words, the time left,
 * and a bar. The bar is one Web Animation for the step, which the browser runs on its own, set to where the clock is;
 * with the clock still, or motion off, it is drawn where the clock is, and moved on each second through a ref.
 */
function StepTime({ r, clock: { t, ticking, motion } }: { r: Release; clock: Clock }) {
  const bar = useRef<HTMLSpanElement>(null);
  const left = useRef<HTMLSpanElement>(null);
  const run = useRef<Animation | undefined>(undefined);
  const now = useRef(t);
  now.current = t;
  const { since, until } = r;
  const on = !r.end && !r.paused && !r.acting && since !== undefined && until !== undefined;
  // Past its pause, a judged step waits for its analysis to end, however long that takes: no time left to count.
  const over = on && waitsForAnalysis(r, t);
  const runs = on && ticking && motion;
  const done = (at: number) =>
    since === undefined || until === undefined
      ? 0
      : Math.min(1, Math.max(0, (at - since) / Math.max(1, until - since)));
  useLayoutEffect(() => {
    const el = bar.current;
    if (!runs || !el || since === undefined || until === undefined) return;
    const animation = el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration: Math.max(1, until - since),
      fill: 'both',
    });
    animation.currentTime = now.current - since;
    run.current = animation;
    return () => {
      animation.cancel();
      run.current = undefined;
    };
  }, [runs, since, until]);
  // The clock moves on every ten seconds: the animation is set to it again, never restarted.
  useLayoutEffect(() => {
    if (run.current && since !== undefined) run.current.currentTime = t - since;
  }, [t, since]);
  useEachSecond(t, on && ticking, (at) => {
    if (until !== undefined) rewrite(left.current, stepLeft(until - at));
    if (!run.current && bar.current) bar.current.style.transform = `scaleX(${done(at)})`;
  });
  if (!on) return null;
  const analysed = r.steps[r.step]?.analysis;
  return (
    <div className="steptime">
      <span className="label">
        {r.dryRun
          ? `The ${r.weight}% step, as the dry run records it`
          : `${analysed ? 'Measuring' : 'Holding at'} the ${r.weight}% step`}
      </span>
      <span className={`left${over ? '' : ' mono'}`} ref={left}>
        {stepLeft(until - t)}
      </span>
      <span className="bar" aria-hidden="true">
        <span ref={bar} style={runs ? undefined : { transform: `scaleX(${done(t)})` }} />
      </span>
    </div>
  );
}

/** A rollback: the measures where it failed, the analysis's words, and the ticket its signal opened. */
function Rollback({ r, onOpen }: { r: Release; onOpen: (item: string) => void }) {
  const { end } = r;
  if (end?.kind !== 'rolled-back') return null;
  const m = r.measured.at(-1);
  return (
    <>
      {showsMeasures(r) ? (
        <Measures r={r} m={m} />
      ) : (
        <>
          {!m && (
            <p className="canary-note first">
              No step was measured: it rolled back {duration(end.at - r.startedAt)} into the {end.weight}% step, so the
              failed measure is the whole story.
            </p>
          )}
          <table className="measures">
            <thead>
              <tr>
                <th className="label">Failed</th>
                <th className="label">What the analysis saw</th>
                <th className="label">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {end.failed.map((f, i) => {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a measure can fail in more than one of the attempt's analyses, and an event's list never changes
                  <tr key={i} className="failed">
                    <td>
                      {measureLabel(f.name)}
                      {f.value !== null && ownWords(f.message, end.reason) && <small>{f.message}</small>}
                    </td>
                    <td>{sawOf(f, end.reason)}</td>
                    <td>
                      <Verdict phase={end.by === 'martin' ? 'judged' : 'failed'} looks={f.failures} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <p className="words">{end.reason}</p>
      {end.ticket && (
        <p className="canary-note">
          A rollback is a signal: triage {SIGNALLED[end.ticket.how]} <Item item={end.ticket} titled onOpen={onOpen} />.
        </p>
      )}
    </>
  );
}

/**
 * An analysis that could not judge the canary: the step it could not judge, or, when the background analysis erred
 * between steps, the measures it could not take; then the analysis's words.
 */
function ErrorEnd({ r }: { r: Release }) {
  const { end } = r;
  if (end?.kind !== 'errored') return null;
  const m = r.measured.at(-1);
  return (
    <>
      {showsMeasures(r) ? (
        <Measures r={r} m={m} />
      ) : !end.errored.length ? (
        <p className="canary-note first">
          The analysis ended in Error before any measure did: its words below are all it said.
        </p>
      ) : (
        <table className="measures">
          <thead>
            <tr>
              <th className="label">Not measured</th>
              <th className="label">The analysis’s words</th>
              <th className="label">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {end.errored.map((e) => (
              // The line names each measure once.
              <tr key={e.name}>
                <td>{measureLabel(e.name)}</td>
                <td>{ownWords(e.message, end.reason) ?? '—'}</td>
                <td>
                  <Verdict phase="error" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="words">{end.reason}</p>
    </>
  );
}

function Item({ item, titled, onOpen }: { item: Carried; titled: boolean; onOpen: (item: string) => void }) {
  return (
    <button type="button" className="linkish" onClick={() => onOpen(item.number)}>
      #{item.number}
      {titled && ` ${item.title}`}
    </button>
  );
}

/** What the step-up dialog says of each control that asks for the passkey. */
const ASKED: Partial<Record<ReleaseControl, (r: Release, c: Control) => Asked>> = {
  promote: (r, c) => ({
    title: 'Promote the canary',
    what: `${shortVersion(r.version)} moves to ${c.to}% of the traffic now.`,
    why: 'Promoting ships to more people',
  }),
  'promote-fully': (r) => ({
    title: 'Promote the canary',
    what: (
      <>
        <b>
          {shortVersion(r.version)} takes all the traffic now{r.judgedBad && ', past the analysis’s verdict'}.
        </b>{' '}
        Verify then asks each ticket’s sense whether it cleared.
      </>
    ),
    why: r.judgedBad ? 'Promoting past the analysis’s verdict ships to everyone' : 'Promoting ships to everyone',
  }),
  retry: (r) => ({
    title: 'Retry the release',
    what: `${shortVersion(r.version)}’s canary starts again from its first step.`,
    why: 'Retrying ships again',
  }),
};

/**
 * Martin's acts on a release: each control, its passkey asked for where the access table asks, and Abort behind a
 * dialog that says what it does; what the admin service refused, or warned of, kept to say. The Canary panel's controls
 * and the Needs-you card of a canary paused for him act through it, so the two are the same controls.
 */
function useActs(r: Release, admin: Admin, controls: readonly Control[]) {
  const writes = useWrite(admin.kind === 'martin' ? admin.session.token : undefined);
  const { busy, refusal, fresh } = writes;
  const [aborting, setAborting] = useState(false);
  const act = (c: Control) => {
    const route = c.action === 'promote-fully' ? 'promote' : c.action;
    const body = { release: r.id, ...(c.action === 'promote-fully' && { fully: true }) };
    return writes.send(`/admin/release/${route}`, body, {
      passkey: ASKED[c.action]?.(r, c),
      // Made, with something left undone that Martin must know of: his pause, still set after the control.
      done: (got) => (typeof got.body?.warning === 'string' ? got.body.warning : undefined),
    });
  };
  /** Presses a control: Abort asks first, in its dialog; the rest act at once, or after the passkey. */
  const press = (c: Control) => {
    if (busy) return;
    if (c.action === 'abort') setAborting(true);
    else void act(c);
  };
  const abort = controls.find((c) => c.action === 'abort');
  const dialog = aborting && abort && (
    <Dialog
      title="Abort the canary"
      onClose={() => setAborting(false)}
      actions={
        <button
          type="button"
          className="btn attn"
          onClick={() => {
            setAborting(false);
            void act(abort);
          }}
        >
          Abort
        </button>
      }
    >
      <p>{abortWords(r)}</p>
    </Dialog>
  );
  return { busy, refusal, press, dialog, fresh };
}

/**
 * Martin's controls, under the steps and the note: his buttons, each with the key while the passkey is not fresh
 * where it asks for it, and Abort behind a dialog; or for anyone else, the same controls as labels beside what each
 * does. Each names the release the panel shows, so the admin service acts on that one or none. What it did shows in
 * the panel as the events arrive: the kicker, the steps, the note.
 */
function CanaryControls({ r, admin, lineStopped }: { r: Release; admin: Admin; lineStopped: boolean }) {
  const controls = controlsOf(r, lineStopped);
  const acts = useActs(r, admin, controls);
  // None left to press, as when an act is under way: what the admin service said of the last stays said.
  if (!controls.length)
    return acts.refusal ? (
      <div className="canary-controls">
        <Refusal text={acts.refusal} />
      </div>
    ) : null;
  if (admin.kind !== 'martin') {
    return (
      <div className="canary-controls">
        <span className="label">Martin’s controls</span>
        <dl>
          {controls.map((c) => (
            <div key={c.action}>
              <dt>
                <span className="ro">{c.label}</span>
              </dt>
              <dd>{c.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  const off = controls.find((c) => c.off)?.off;
  return (
    <div className="canary-controls">
      <span className="label">Your controls</span>
      <div className="row">
        {controls.map((c) => (
          <button
            key={c.action}
            type="button"
            className="btn"
            title={c.what}
            disabled={c.off !== undefined}
            // Busy, it stays focusable, so focus comes back to it when a dialog it opened closes.
            aria-disabled={acts.busy || undefined}
            onClick={() => acts.press(c)}
          >
            {c.label}
            {c.stepUp && !acts.fresh && <Key />}
          </button>
        ))}
        {off && <span className="help">{off}</span>}
      </div>
      <Refusal text={acts.refusal} />
      {acts.dialog}
    </div>
  );
}

/**
 * The answers of a canary paused for Martin, as its Needs-you card lists them: the Canary panel's own controls, Promote
 * fully with the key and Abort in the alarm colour's outline, each beside what it does; for anyone else, labels.
 */
export function CanaryAnswers({ r, admin }: { r: Release; admin: Admin }) {
  const controls = controlsOf(r, false);
  const acts = useActs(r, admin, controls);
  const martin = admin.kind === 'martin';
  // Answered, and not yet recorded by the line: what is under way, in place of the answers it took away.
  if (r.acting)
    return (
      <p className="ev acting" role="status">
        {actingWords(r, r.acting, martin ? 'martin' : 'visitor', clockSeconds(r.acting.at))}
      </p>
    );
  return (
    <>
      <div className="answers">
        {controls.map((c) => (
          <div className="answer" key={c.action}>
            {martin ? (
              <button
                type="button"
                className={`btn small${c.action === 'abort' ? ' attn-line' : ''}`}
                aria-disabled={acts.busy || undefined}
                onClick={() => acts.press(c)}
              >
                {c.label}
                {c.stepUp && !acts.fresh && <Key />}
              </button>
            ) : (
              <span className="ro">{c.label}</span>
            )}
            <p>{c.what}</p>
          </div>
        ))}
      </div>
      <Refusal text={acts.refusal} />
      {acts.dialog}
    </>
  );
}

interface CanaryProps {
  view: CanaryView;
  t: number;
  onOpen: (item: string) => void;
  /** Who is looking: Martin's controls are his buttons, and everyone else's labels. */
  admin: Admin;
  /** Whether the line is stopped: a stopped line starts no canary, so Retry waits for it to start. */
  lineStopped: boolean;
  /** Whether the console's clock moves on by itself, for the step's time left and the next look. */
  ticking: boolean;
  motion: boolean;
  /** Whether auto-rollback is on, as Controls has it in force: off, a canary judged bad pauses for Martin. */
  autoRollback: boolean;
}

export function Canary({ view, t, onOpen, admin, lineStopped, ticking, motion, autoRollback }: CanaryProps) {
  if (view.state !== 'shown')
    return (
      <section className="panel canary idle" aria-labelledby="canary-title">
        <h2 id="canary-title">Canary</h2>
        <p>No release yet. Each deploy Martin merges goes out here as a canary, beside the version it would replace.</p>
      </section>
    );
  const r = view.release;
  const [word, tone, dot] = standing(r);
  const { items, image } = r;
  const title = items[0]
    ? items[0].title + (items.length > 1 ? ` and ${items.length - 1} more` : '')
    : 'Carries no work item';
  const m = r.measured.at(-1);
  const first = firstMeasured(r);
  const clock = { t, ticking, motion };
  const right =
    r.end?.kind === 'rolled-back' ? (
      <Rollback r={r} onOpen={onOpen} />
    ) : r.end?.kind === 'errored' ? (
      <ErrorEnd r={r} />
    ) : r.judgedBad ? (
      <>
        <Measures r={r} m={m} clock={clock} />
        {judgedSaid(r.judgedBad).length > 0 && <p className="words">{judgedSaid(r.judgedBad).join('\n')}</p>}
      </>
    ) : (
      (measuring(r) || m || first !== undefined) && <Measures r={r} m={m} until={first} clock={clock} />
    );
  const switched: Switched = { viewer: admin.kind === 'martin' ? 'martin' : 'visitor', autoRollback };
  // With auto-rollback off, or a canary paused for Martin, a failing measure needs him: the last line says so.
  const pauses = !autoRollback || r.judgedBad !== undefined;
  // The measures' table with its trend column, which takes the width it needs, after a rollback or an error too; not
  // the table of their own a rollback or an error has otherwise.
  const trended = r.looks.length > 0 && showsMeasures(r);
  return (
    <section className="panel canary" aria-labelledby="canary-title">
      <div className="canary-head">
        <div>
          <p className="kick">
            <span className={`out tone-${tone}`}>
              <span className={`dot ${dot}`} aria-hidden="true" />
              {word}
            </span>
            {r.dryRun && <span className="pill pill-sample">Dry run</span>}
          </p>
          <h2 id="canary-title">{title}</h2>
          <p className="carries">
            {items.length ? (
              <>
                Carries
                {items.map((item) => (
                  <Item key={item.number} item={item} titled={items.length > 1} onOpen={onOpen} />
                ))}
              </>
            ) : (
              'Martin’s own commits or a dependency update: a release with no work item is on the line, not the reel, unless it rolls back.'
            )}
          </p>
        </div>
        <p className="rel-id mono">
          Release {r.id}
          <br />
          <b>
            {shortVersion(r.previous)} → {shortVersion(r.version)}
          </b>
          {r.commit && !isCommit(r.version) && ` · ${r.commit.slice(0, 7)}`}
          <br />
          {image
            ? `${image.digest.slice(0, 11)}…${image.digest.slice(-4)}${image.signed ? ' · signed' : ''}${image.admitted ? ' · admitted' : ''}`
            : 'no image: nothing shipped'}
        </p>
      </div>
      <div className={`canary-body ${trended ? 'trended' : ''}`}>
        <div className="canary-steps">
          <Steps r={r} tone={tone} />
          <StepTime r={r} clock={clock} />
          <p className="canary-note">{note(r, switched, t)}</p>
        </div>
        {right && <div className="canary-measures">{right}</div>}
        {/* A release of its own: what was pressed for another, and refused, is not said under this one. */}
        <CanaryControls key={r.id} r={r} admin={admin} lineStopped={lineStopped} />
      </div>
      <p className="help tooled">
        {rollouts(r) && <ToolMark name="argo" />}
        <span>
          {rollouts(r) ? 'Argo Rollouts’ canary' : 'The canary'} moves on by itself while every measure passes
          {pauses
            ? '. With auto-rollback off, the moment errors or latency fail it pauses for Martin, who promotes or aborts it; a failed journeys check still rolls it back.'
            : ', and rolls back by itself the moment one fails. Nobody needs to press anything.'}
        </span>
      </p>
    </section>
  );
}
