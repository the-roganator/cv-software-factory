/**
 * The picture on a card, and at full size in its sheet. A picture is evidence the factory captured, never an
 * illustration: screenshots with the probe's marks, a metric series, log lines, a scan, a refusal, a judgement.
 */
import type { Evidence, PayloadOf, Screenshot } from '@software-factory/events';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useArtifactUrl } from '../artifacts.ts';
import { AGENT_NAME, axis, capital, clock, figure, inWords, money, plural, shortVersion, times } from '../format.ts';
import type { Picture as PictureData, Source, Tag } from '../projection/index.ts';
import { deployCaption, deployWords, QUARANTINE_AT, SENSE } from '../projection/index.ts';
import { clamp } from './flight.ts';
import { Glyph } from './Glyph.tsx';
import { LogoMark, logoFor } from './Logos.tsx';

const TAG_TONE: Record<Tag, 'faint' | 'attn' | 'ok'> = {
  BEFORE: 'faint',
  BROKEN: 'attn',
  FIXED: 'ok',
  AFTER: 'ok',
  NOW: 'attn',
  SEEN: 'attn',
};

const PAGE_NAME: Record<string, string> = {
  '/': 'the home page',
  '/products': 'the product list',
  '/search': 'the search page',
  '/contact': 'the contact page',
};

const pageName = (route: string) => PAGE_NAME[route] ?? route;

/** A mark on a screenshot: where, whether the problem or the fix, and its label or its number in a list. */
export interface Mark {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'problem' | 'fix';
  label?: string | undefined;
  /** Numbered marks are keyed to a list beside the screenshot, which does their labelling. */
  n?: number | undefined;
}

/** A frame's height as a share of its width, until it is measured: a picture's frame is 16:10. */
const FRAME = 10 / 16;

/**
 * A figure read from an element's box when it is laid out and whenever it changes size, kept in state: the element's
 * ref, and the figure. `read` may give back the figure before, for a change too small to draw again.
 */
export function useMeasured<T>(initial: T, read: (box: DOMRect, before: T) => T) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(initial);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is a fixed rule, the same in every render
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setValue((before) => read(el.getBoundingClientRect(), before));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, value] as const;
}

/** A frame's height as a share of its width: only a change of shape renders the shot again, not every resize. */
const useFrame = () =>
  useMeasured(FRAME, ({ width, height }, ratio) =>
    !width || Math.abs(ratio - height / width) < 1e-3 ? ratio : height / width,
  );

/**
 * A screenshot of the app, with the probe's marks drawn where it looked. Several marks are numbered, keyed to a
 * list beside the picture: one label per side still holds, and the list has room for what the screenshot can't show.
 * The frame shows the shot at its full width, so of a whole page it shows a window: the one that holds its first
 * mark, a third of the way down, or its top when it has none. Marks are placed in the shot's own scale, by its width,
 * and those outside the window are counted at the frame's foot instead.
 */
export function Shot({
  shot,
  eager = false,
  marks: given,
  numbered = false,
  anchor,
  alt: said,
}: {
  shot: Screenshot;
  eager?: boolean;
  /** Marks other than the screenshot's own boxes, such as the elements an accessibility check named. */
  marks?: Mark[];
  numbered?: boolean;
  /** The mark to place the window by, when not the shot's own first: two shots compared share one window. */
  anchor?: Mark | undefined;
  /** What the picture shows, when it is no plain screenshot of the page: where two pictures of it differ. */
  alt?: string;
}) {
  const url = useArtifactUrl();
  const [failed, setFailed] = useState(false);
  const [frame, ratio] = useFrame();
  const marks: Mark[] = given ?? shot.boxes.map((box, i) => ({ ...box, ...(numbered && { n: i + 1 }) }));
  const named = marks.map((mark) => [mark.n, mark.label].filter(Boolean).join(' ')).filter(Boolean);
  const alt =
    said ??
    `Screenshot of ${pageName(shot.route)} at ${shortVersion(shot.version)}${named.length ? `, marked: ${named.join('; ')}` : ''}`;
  // The shot's height the frame shows, in the shot's own pixels, from where the window starts.
  const shown = shot.width * ratio;
  const first = anchor ?? marks[0];
  const top = first ? clamp(first.y - shown / 3, 0, Math.max(0, shot.height - shown)) : 0;
  const scale = (px: number) => `${(px / shot.width) * 100}cqw`;
  // A mark counts as in the window by its middle, rather than be drawn half under its edge or the strip.
  const middle = (mark: Mark) => mark.y + mark.height / 2 - top;
  const inFrame = (mark: Mark) => middle(mark) >= 0 && middle(mark) < shown;
  const above = marks.filter((mark) => middle(mark) < 0).length;
  const outside = marks.length - marks.filter(inFrame).length;
  return (
    <div className="shot" ref={frame}>
      {failed ? (
        <div className="shot-missing" role="img" aria-label={`${alt}. It could not be loaded.`}>
          <span className="label">Screenshot unavailable</span>
          <span>
            The console could not load this screenshot of {pageName(shot.route)}. The rest of the work item is still
            here.
          </span>
        </div>
      ) : (
        <img
          src={url(shot.hash)}
          alt={alt}
          width={shot.width}
          height={shot.height}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          style={top ? { marginTop: `-${scale(top)}` } : undefined}
          onError={() => setFailed(true)}
        />
      )}
      {!failed &&
        marks.filter(inFrame).map((box) => (
          <span
            key={`${box.x},${box.y},${box.kind}`}
            className={`mk ${box.kind} ${box.y + box.height - top > shown * 0.8 ? 'up' : ''}`}
            style={{
              left: scale(box.x),
              top: scale(box.y - top),
              width: scale(box.width),
              height: scale(box.height),
            }}
            aria-hidden="true"
          >
            {box.n !== undefined ? (
              <span className="mk-n">{box.n}</span>
            ) : (
              box.label && <span className="mk-label">{box.label}</span>
            )}
          </span>
        ))}
      {!failed && outside > 0 && (
        <span className="fold" aria-hidden="true">
          {above === outside ? '↑' : above ? '↕' : '↓'} {plural(outside, 'more mark')} outside the frame
        </span>
      )}
    </div>
  );
}

/**
 * Where a wipe starts: between the two sides' marks when it can be, so both show; otherwise just left of the
 * after side's mark, so the change shows and the earlier state is a drag away.
 */
function startAt(before: Screenshot, after: Screenshot): number {
  const right = Math.max(...before.boxes.map((b) => ((b.x + b.width) / before.width) * 100));
  const left = Math.min(...after.boxes.map((b) => (b.x / after.width) * 100));
  if (!before.boxes.length && !after.boxes.length) return 50;
  if (!after.boxes.length) return clamp(Math.max(50, right + 3), 8, 94);
  if (!before.boxes.length) return clamp(Math.min(50, left - 3), 6, 92);
  return right < left ? clamp((right + left) / 2, 8, 92) : clamp(left - 2, 6, 92);
}

/**
 * Before and after, with a wipe between them. The handle moves with the pointer or the arrow keys; the position is
 * kept on the element, not in state, so dragging it draws frames without rendering anything.
 */
function Wipe({ before, after, tags, interactive }: Extract<PictureData, { type: 'wipe' }> & { interactive: boolean }) {
  const wipe = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const at = useRef(startAt(before, after));
  const set = (value: number) => {
    at.current = Math.max(0, Math.min(100, value));
    wipe.current?.style.setProperty('--at', `${at.current}%`);
    handle.current?.setAttribute('aria-valuenow', String(Math.round(at.current)));
  };
  // The starting place, once; from then on the handle moves it.
  useLayoutEffect(() => {
    wipe.current?.style.setProperty('--at', `${at.current}%`);
  }, []);
  const fromPointer = (event: PointerEvent<HTMLElement>) => {
    const box = wipe.current?.getBoundingClientRect();
    if (box) set(((event.clientX - box.left) / box.width) * 100);
  };
  const [a, b] = tags;
  // Both sides show the same window, so the wipe lines up: the one around the after side's mark, or the before's.
  const anchor = after.boxes[0] ?? before.boxes[0];
  return (
    <div className="wipe" ref={wipe}>
      <div className="wipe-before">
        <Shot shot={before} eager={interactive} anchor={anchor} />
      </div>
      <div className="wipe-after">
        <Shot shot={after} eager={interactive} anchor={anchor} />
      </div>
      <span className="div" />
      <span
        ref={handle}
        className="handle"
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-label={`Compare ${a.toLowerCase()} and ${b.toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at.current)}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => dragging.current && fromPointer(event)}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          const step = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[event.key];
          if (step === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          set(at.current + step);
        }}
      >
        <Glyph name="arrows" />
      </span>
      <span className={`wtag l tone-${TAG_TONE[a]}`}>
        <span className="dot" />
        {a} · {shortVersion(before.version)}
      </span>
      <span className={`wtag r tone-${TAG_TONE[b]}`}>
        <span className="dot" />
        {b} · {shortVersion(after.version)}
      </span>
    </div>
  );
}

/** Pages that look exactly as they did, in a strip of their own screenshots. */
function Unchanged({ pages }: { pages: Screenshot[] }) {
  const url = useArtifactUrl();
  if (!pages.length) return null;
  return (
    <div className="unchanged">
      <span className="thumbs" aria-hidden="true">
        {pages.map((page) => (
          <img key={page.hash} src={url(page.hash)} alt="" loading="lazy" />
        ))}
      </span>
      <span>No visible change: {plural(pages.length, 'page')} match the version before, 0.0% of pixels</span>
    </div>
  );
}

interface Series {
  values: (number | null)[];
  tone: 'signal' | 'attn' | 'muted';
  label: string;
}

const TICKS = ['none', 'half', 'all'] as const;

/** A line chart: one axis, thin lines, the last value labelled where it ends. */
function LineChart(props: {
  series: Series[];
  unit: string;
  xLabels: [index: number, text: string][];
  /** A moment to mark, labelled inside the plot or, `above` it, clear of the lines and their end labels. */
  marker?: { index: number; label: string; above?: boolean } | undefined;
  objective?: number | undefined;
  label: string;
}) {
  const { series, unit, xLabels, marker, objective, label } = props;
  // A label above the plot takes a line of its own over it, and the plot keeps its height.
  const lift = marker?.above ? 12 : 0;
  const [w, h, l, r, t, b] = [600, 210 + lift, 40, 104, 14 + lift, 24];
  const n = Math.max(...series.map((s) => s.values.length));
  const top = Math.max(objective ?? 0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const { max: yMax, ticks } = axis(top);
  const x = (i: number) => l + (i / Math.max(1, n - 1)) * (w - l - r);
  const y = (v: number) => t + (1 - v / yMax) * (h - t - b);
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      {ticks.map((v, i) => (
        <g key={TICKS[i]}>
          <line className="grid" x1={l} x2={w - r} y1={y(v)} y2={y(v)} />
          <text className="axis" x={l - 8} y={y(v) + 3.5} textAnchor="end">
            {figure(v)}
          </text>
        </g>
      ))}
      {objective !== undefined && (
        <g>
          <line className="objective" x1={l} x2={w - r} y1={y(objective)} y2={y(objective)} />
          <text className="axis" x={w - r + 8} y={y(objective) + 3.5}>
            objective
          </text>
        </g>
      )}
      {marker && (
        <g>
          <line className="marker" x1={x(marker.index)} x2={x(marker.index)} y1={t - 6} y2={h - b} />
          {marker.above ? (
            <text className="axis" x={x(marker.index)} y={t - 10} textAnchor="middle">
              {marker.label}
            </text>
          ) : (
            <text className="axis" x={x(marker.index) + 6} y={t + 2}>
              {marker.label}
            </text>
          )}
        </g>
      )}
      {series.map((s) => {
        const points = s.values.flatMap((v, i) => (v === null ? [] : [[x(i), y(v), v] as const]));
        const end = points.at(-1);
        if (!end) return null;
        return (
          <g key={s.label} className={`series ${s.tone}`}>
            <path d={`M${points.map(([px, py]) => `${px} ${py}`).join(' L')}`} />
            <circle cx={end[0]} cy={end[1]} r="3.5" />
            <text className="end" x={end[0] + 8} y={end[1] + 3.5}>
              {s.label} · {figure(end[2])} {unit}
            </text>
          </g>
        );
      })}
      {xLabels.map(([i, text]) => (
        <text key={i} className="axis" x={x(i)} y={h - 6} textAnchor="middle">
          {text}
        </text>
      ))}
    </svg>
  );
}

type Metric = Extract<Evidence, { kind: 'metric' }>;

function MetricPicture({ evidence, unchanged, seen }: { evidence: Metric; unchanged: Screenshot[]; seen: boolean }) {
  const values = evidence.values;
  const at = (i: number) => Date.parse(evidence.start) + i * evidence.stepSeconds * 1000;
  // Before is the middle of the values before the release, so one odd sample cannot move it.
  const split = evidence.marker?.index ?? values.length;
  const earlier = values
    .slice(0, split)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const before = earlier[Math.floor(earlier.length / 2)] ?? 0;
  const after = values.filter((v): v is number => v !== null).at(-1) ?? before;
  const quarters = [0, 1, 2, 3].map((q) => Math.round((q * (values.length - 1)) / 3));
  return (
    <div className="pad">
      <div className="row spread">
        <div>
          <div className="cap">{evidence.name}</div>
          {/* A sense's series shows the problem: where it is now, against its objective. Only a fix is drawn in green. */}
          {seen ? (
            <div className="big">
              <span className="bad">
                {figure(after)} {evidence.unit}
              </span>
              {evidence.objective !== undefined && (
                <small>
                  {' '}
                  objective {figure(evidence.objective)} {evidence.unit}
                </small>
              )}
            </div>
          ) : (
            <div className="big">
              <s>{figure(before)}</s> →{' '}
              <span className="ok">
                {figure(after)} {evidence.unit}
              </span>
            </div>
          )}
        </div>
        <div className="cap right">
          {clock(at(0))} – {clock(at(values.length - 1))}
        </div>
      </div>
      <LineChart
        label={`${evidence.name} over time, from ${figure(before)} to ${figure(after)} ${evidence.unit}`}
        series={[{ values, tone: 'signal', label: evidence.name.split(' ')[0] ?? '' }]}
        unit={evidence.unit}
        objective={evidence.objective}
        marker={evidence.marker}
        xLabels={quarters.map((i) => [i, clock(at(i))])}
      />
      <Unchanged pages={unchanged} />
    </div>
  );
}

type Logs = Extract<Evidence, { kind: 'logs' }>;

function Terminal({ logs, title }: { logs: Logs; title: string }) {
  return (
    <div className="term">
      <span className="t-dim">
        {title} · {shortVersion(logs.version)}
      </span>
      {'\n'}
      {logs.lines.length === 0 ? (
        <span className="t-bad">
          no log record for {logs.requests} requests to {logs.route}
        </span>
      ) : (
        logs.lines.map((line) => (
          <span key={line.ts}>
            <span className="t-dim">{clock(Date.parse(line.ts))}</span> {line.level} {line.message}{' '}
            {line.traceId ? (
              <span className="t-good">trace {line.traceId.slice(0, 16)}</span>
            ) : (
              <span className="t-bad">trace ∅</span>
            )}
            {'\n'}
          </span>
        ))
      )}
    </div>
  );
}

function LogsPicture({ before, after, seen }: { before: Logs | undefined; after: Logs; seen: boolean }) {
  const spans = after.trace?.spans ?? [];
  const total = Math.max(1, ...spans.map((s) => s.offsetMs + s.durationMs));
  return (
    <div className="pad">
      <div className="row cap">
        <LogoMark name="otel" className="logo small" />
        Log lines from {after.route}
        {before ? ', before and after' : ''}
      </div>
      <div className="logs">
        {before && <Terminal logs={before} title="before" />}
        <Terminal logs={after} title={seen ? 'seen' : 'after'} />
      </div>
      {spans.length > 0 && (
        <div className="wf" role="img" aria-label={`The trace a log line now links to, ${spans.length} spans`}>
          {spans.map((span) => (
            <div className="wf-row" key={span.name}>
              <span>{span.name}</span>
              <span className="wf-track">
                <b
                  style={{
                    marginLeft: `${(span.offsetMs / total) * 100}%`,
                    width: `${Math.max(1, (span.durationMs / total) * 100)}%`,
                  }}
                />
              </span>
              <span>
                {span.durationMs} ms{span.note ? ` · ${span.note}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Dependency = NonNullable<PayloadOf<'work-item.opened'>['dependency']>;

function Package({ dependency, small = false }: { dependency: Dependency; small?: boolean }) {
  const logo = logoFor(dependency.name);
  return (
    <div className={`pkg ${small ? 'small' : ''}`}>
      {logo ? <LogoMark name={logo} /> : <Glyph name="dependency" className="glyph pkg-glyph" />}
      <div>
        <div className="name">{dependency.name}</div>
        <div className="bump">
          <s>{dependency.from}</s>→<span>{dependency.to}</span>
          {dependency.security && <span className="cap">security release</span>}
        </div>
      </div>
    </div>
  );
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

function ScanPicture({ dependency, findings, unchanged }: Extract<PictureData, { type: 'scan' }>) {
  const most = Math.max(1, ...SEVERITIES.flatMap((s) => [findings.before[s], findings.after[s]]));
  return (
    <div className="pad">
      <Package dependency={dependency} />
      <div>
        <div className="row cap">
          <LogoMark name="trivy" className="logo small" />
          Image scan, before and after
        </div>
        <div className="sev">
          {SEVERITIES.map((s) => (
            <div className="sev-row" key={s}>
              <span>{capital(s)}</span>
              <span className="bars" aria-hidden="true">
                <i style={{ width: `${(findings.before[s] / most) * 100}%` }} />
                {findings.after[s] ? (
                  <i className="after" style={{ width: `${(findings.after[s] / most) * 100}%` }} />
                ) : (
                  <i className="after zero" />
                )}
              </span>
              <span className="n">
                {findings.before[s]} → {findings.after[s]}
              </span>
            </div>
          ))}
        </div>
      </div>
      <Unchanged pages={unchanged} />
    </div>
  );
}

function RollbackPicture({ dependency, weight, restored, series }: Extract<PictureData, { type: 'rollback' }>) {
  const time = (i: number) => {
    const s = i * series.stepSeconds;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const n = Math.max(series.canary.length, series.baseline.length);
  const minutes = [0, 1, 2, 3, 4].map((m) => Math.round((m * 60) / series.stepSeconds)).filter((i) => i < n);
  return (
    <div className="pad">
      <div className="row spread">
        {dependency ? <Package dependency={dependency} small /> : <span />}
        <div className="cap right">
          {series.label}, {series.unit}
          <br />
          canary at {weight}%
        </div>
      </div>
      <LineChart
        label={`${series.label} on the canary against the baseline, rolled back at ${time(series.at)}`}
        series={[
          { values: series.canary, tone: 'attn', label: 'canary' },
          { values: series.baseline, tone: 'muted', label: 'baseline' },
        ]}
        unit={series.unit}
        // As the release worker reads it, the rollback is the last point of both lines, where their labels are: its
        // own goes over the plot. Its time is left to the x axis only where the axis labels that point.
        marker={{
          index: series.at,
          label: minutes.includes(series.at) ? 'rolled back' : `rolled back · ${time(series.at)}`,
          above: true,
        }}
        xLabels={minutes.map((i) => [i, time(i)])}
      />
      <div className="unchanged">
        <Glyph name="check" />
        <span>
          Baseline traffic never saw it: {100 - weight}% stayed on {restored} throughout.
        </span>
      </div>
    </div>
  );
}

/**
 * Items each with a key of their own, even where the same one repeats: a line of output, a hop, a path cut to what an
 * event records (`recordedPath`), which can read the same as another.
 */
export function keyed<T>(list: readonly T[], name: (value: T) => string): { value: T; key: string }[] {
  const seen = new Map<string, number>();
  return list.map((value) => {
    const text = name(value);
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return { value, key: `${count}:${text}` };
  });
}

/** Lines of output, each with a key of its own, even where the same text repeats. */
const keyedLines = (output: string) => keyed(output.split('\n'), (text) => text);

function RefusalPicture({ mechanism, output }: Extract<PictureData, { type: 'refusal' }>) {
  return (
    <div className="pad">
      <div className="row cap">
        <Glyph name="red-team" />
        {mechanism}: its own output, as recorded
      </div>
      <pre className="term">
        {/* Shown verbatim; the lines that say no, in the alarm colour. */}
        {keyedLines(output).map(({ value: text, key }) => (
          <span
            key={key}
            className={/✕|denied|failed|blocked/.test(text) ? 't-bad' : text.startsWith('→') ? 't-dim' : ''}
          >
            {text}
            {'\n'}
          </span>
        ))}
      </pre>
      <div className="unchanged">
        <Glyph name="check" />
        <span>The site never changed.</span>
      </div>
    </div>
  );
}

/** Jev's questions, in a few words each: the event holds them in full. */
const QUESTION: Record<string, string> = {
  category: 'What kind of report?',
  symptom: 'How does it show?',
  severity: 'How badly does it hurt?',
  injection: 'Orders for a system?',
  repeat: 'Repeats an open ticket?',
  passage: 'Which passage?',
};

/** The answers a judgement picture shows, in this order: the ones routing reads first. */
const SHOWN = ['category', 'severity', 'injection'];

type Answers = PayloadOf<'judgement.made'>['answers'];

/** The answers to show, in order, leaving out the ones the picture has no room for. */
function shown(answers: Answers, first?: string): Answers {
  const order = first ? [first, ...SHOWN.filter((key) => key !== first)] : SHOWN;
  const picked = order.flatMap((key) => answers.find((a) => a.key === key) ?? []);
  return picked.length ? picked : answers;
}

function AnswerRows({ answers }: { answers: Answers }) {
  return (
    <div className="jev">
      {answers.map((answer) => {
        const { text, p } = answerOf(answer);
        return (
          <div className="jev-row" key={answer.key}>
            <span className="q" title={answer.question}>
              {QUESTION[answer.key] ?? answer.question}
            </span>
            <span className="p" aria-hidden="true">
              <i style={{ width: `${p * 100}%` }} />
            </span>
            <span className="jev-answer">
              {text} {p.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const ROUTE: Record<NonNullable<PayloadOf<'judgement.made'>['route']>, string> = {
  ticket: 'a ticket',
  repeat: 'added to the open ticket it repeats',
  park: 'parked for Martin',
  quarantine: 'quarantined',
  discard: 'closed, no ticket',
};

type Answer = PayloadOf<'judgement.made'>['answers'][number];

/** One typed answer as words and the probability behind them. */
export function answerOf(answer: Answer): { text: string; p: number } {
  if (answer.type === 'choice') {
    return { text: answer.answer.replaceAll(/[_-]/g, ' '), p: answer.probabilities[answer.answer] ?? 0 };
  }
  if (answer.type === 'score') {
    const level = Math.max(0, Math.min(answer.levels.length - 1, Math.round(answer.expected)));
    return { text: answer.levels[level] ?? '', p: answer.probabilities[level] ?? 0 };
  }
  return answer.probability >= 0.5 ? { text: 'yes', p: answer.probability } : { text: 'no', p: 1 - answer.probability };
}

function JudgementPicture({ page, judgement }: Extract<PictureData, { type: 'judgement' }>) {
  return (
    <div className="pad">
      <div className="split">
        {page && (
          <div className="thumb">
            <Shot shot={page} />
          </div>
        )}
        <div className="verdict">
          <div className="row cap">
            <LogoMark name="jev" className="logo small" />
            Jev · {judgement.questionSet} · {judgement.model}
          </div>
          <AnswerRows answers={shown(judgement.answers)} />
          {judgement.route && (
            <div className="routing">
              Routing: <b>{ROUTE[judgement.route]}.</b> A report’s text is untrusted: no generative agent ever reads it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A quarantined report: the one answer that decided it, first and large, against the threshold that routes it,
 * and the others below it, unused. No page: the page has nothing to do with an attack. Never the report's words.
 */
function QuarantinePicture({ judgement }: Extract<PictureData, { type: 'quarantine' }>) {
  const injection = judgement.answers.find((a) => a.key === 'injection');
  const p = injection?.type === 'noul' ? injection.probability : 0;
  const others = shown(judgement.answers).filter((a) => a.key !== 'injection');
  return (
    <div className="pad quarantine">
      <div className="row cap">
        <LogoMark name="jev" className="logo small" />
        Jev · {judgement.questionSet} · {judgement.model}
      </div>
      <div className="decider">
        <div className="row spread">
          <span className="q">Does it give orders to a system that reads it?</span>
          <span className="big">
            <small>{p >= QUARANTINE_AT ? 'yes' : 'no'}</small> {p.toFixed(2)}
          </span>
        </div>
        <div
          className="gauge"
          role="img"
          aria-label={`Probability ${p.toFixed(2)}, against the threshold of ${QUARANTINE_AT.toFixed(2)} that quarantines a report`}
        >
          <i style={{ width: `${p * 100}%` }} />
          <b style={{ left: `${QUARANTINE_AT * 100}%` }} />
          <span style={{ left: `${QUARANTINE_AT * 100}%` }}>quarantined at {QUARANTINE_AT.toFixed(2)}</span>
        </div>
      </div>
      <div className="row spread">
        <span className="stamp">
          <Glyph name="red-team" />
          Quarantined
        </span>
        <span className="cap right">
          decided first
          <br />
          other answers unused
        </span>
      </div>
      <div className="unused">
        {others.map((answer) => {
          const { text, p: q } = answerOf(answer);
          return (
            <div key={answer.key}>
              <span>{QUESTION[answer.key] ?? answer.question}</span>
              <span className="unused-answer">
                {text} {q.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="withheld-note">
        The report’s text is shown to nobody but Martin and its sender. No agent reads it.
      </div>
    </div>
  );
}

/** A visitor's suggestion: it waits for Martin, the only one who asks for improvements. */
function SuggestionPicture({ page, judgement }: Extract<PictureData, { type: 'suggestion' }>) {
  return (
    <div className="pad">
      <div className="spec suggestion">
        <div className="cap attn">Suggestion · waiting for Martin</div>
        <div className="split">
          {page && (
            <div className="thumb">
              <Shot shot={page} />
            </div>
          )}
          <AnswerRows answers={shown(judgement.answers)} />
        </div>
        <div className="ask-quiet">
          Parked for Martin: <b>only he asks for improvements.</b> He can make it one, or close it.
        </div>
      </div>
    </div>
  );
}

/** Who captured it: the sense, its check, and the version, as a picture's cap. */
function SourceCap({ source, children }: { source: Source; children?: ReactNode }) {
  return (
    <div className="row spread source-cap">
      <span className="cap">
        {SENSE[source.sense].name} · {source.every ? 'every page' : source.check} · {shortVersion(source.version)}
      </span>
      {children}
    </div>
  );
}

/** A problem on every page: four of the pages, each with its mark, and how many more the sheet has. */
function PagesPicture({ shots, more }: Extract<PictureData, { type: 'pages' }>) {
  return (
    <div className="pages">
      <div className="pages-grid">
        {shots.map((shot) => (
          <div className="page" key={`${shot.hash}-${shot.route}`}>
            <span className="page-route">{shot.route}</span>
            <div className="page-shot">
              <Shot shot={shot} numbered />
            </div>
          </div>
        ))}
      </div>
      <span className="wtag r tone-attn">
        <span className="dot" />
        EVERY PAGE{more > 0 ? ` · +${more} MORE` : ''}
      </span>
    </div>
  );
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  301: 'Moved',
  304: 'Not modified',
  308: 'Moved',
  404: 'Not found',
  500: 'Server error',
};

/** The shortest run of redirects the whole list repeats, if it repeats at all. */
function cycleOf(hops: readonly { status: number; location: string }[]): number | undefined {
  for (let length = 1; length <= hops.length / 2; length++) {
    if (
      hops.every((hop, i) => hop.location === hops[i % length]?.location && hop.status === hops[i % length]?.status)
    ) {
      return length;
    }
  }
  return undefined;
}

/**
 * An HTTP exchange, as the sense summarised it: the request, the status (or none), each redirect followed, the
 * headers the check read with a tick or a cross, and the timings. A loop is drawn once, with an arrow back.
 */
function HttpPicture({ exchange, source }: Extract<PictureData, { type: 'http' }>) {
  const { method, url, status, headers, timings, redirects } = exchange;
  const cycle = cycleOf(redirects);
  const hops = cycle ? redirects.slice(0, cycle) : redirects.slice(0, 4);
  const rest = cycle ? redirects.length / cycle - 1 : redirects.length - hops.length;
  const word = (n: number) => ['', 'one', 'two', 'three', 'four'][n] ?? String(n);
  return (
    <div className="pad http">
      <SourceCap source={source}>
        {status === null ? (
          <span className="status-pill none">
            <Glyph name="cross" />
            No response{redirects.length ? ` · ${plural(redirects.length, 'redirect')}` : ''}
          </span>
        ) : (
          <span className={`status-pill ${status >= 400 ? 'bad' : ''}`}>
            {status} {STATUS_TEXT[status] ?? ''}
          </span>
        )}
      </SourceCap>
      <div className="row spread request">
        <span className="big">
          {method} <b>{url}</b>
        </span>
        {/* With no response there is no bar to draw: the timings go beside the request instead. */}
        {status === null && (
          <span className="cap right secondary">
            first byte {timings.firstByteMs} ms · gave up at {timings.totalMs} ms
          </span>
        )}
      </div>
      {hops.length > 0 && (
        <div className="hops">
          {keyed(hops, (hop) => `${hop.status} ${hop.location}`).map(({ value: hop, key }, i) => (
            <div key={key} className={i > 1 ? 'secondary' : ''}>
              <span className="code">{hop.status}</span>
              <span>→ {hop.location}</span>
              {cycle && i === hops.length - 1 && hop.location === url && (
                <span className="back">
                  <Glyph name="back" /> back to the start
                </span>
              )}
            </div>
          ))}
          {rest > 0 && (
            <p className="more">
              {cycle
                ? `… and the same ${word(cycle)}, ${plural(rest, 'more time')}.`
                : `… and ${plural(rest, 'more redirect')}.`}
              {status === null && ` The ${SENSE[source.sense].name.toLowerCase()} gave up after ${redirects.length}.`}
            </p>
          )}
        </div>
      )}
      {Object.keys(headers).length > 0 && (
        <div className="headers">
          {Object.entries(headers).map(([name, value]) => (
            <div key={name} className={value === null ? 'absent' : ''}>
              <Glyph name={value === null ? 'cross' : 'check'} />
              <span className="name">{name}</span>
              <span className="value">{value ?? 'absent'}</span>
            </div>
          ))}
        </div>
      )}
      {status !== null && timings.totalMs > 0 && (
        <div className="timing secondary" aria-hidden="true">
          <span>first byte {timings.firstByteMs} ms</span>
          <span className="track">
            <i style={{ width: `${(timings.firstByteMs / timings.totalMs) * 100}%` }} />
          </span>
          <span>total {timings.totalMs} ms</span>
        </div>
      )}
    </div>
  );
}

type ConsoleEvidence = Extract<Evidence, { kind: 'console' }>;

/** The browser's console, word for word, on the terminal face; the page beside it, unmarked, since an error has no place on it. */
function ConsolePicture({ console: logged, shot, source }: Extract<PictureData, { type: 'console' }>) {
  const errors = logged.messages.filter((m) => m.level === 'error').length;
  const warnings = logged.messages.length - errors;
  return (
    <div className="pad">
      <SourceCap source={source}>
        <span className="cap right">
          {[errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(' · ')}
        </span>
      </SourceCap>
      <div className="split console">
        {shot && (
          <div className="thumb">
            <Shot shot={shot} />
          </div>
        )}
        <ConsoleLines messages={logged.messages} />
      </div>
    </div>
  );
}

function ConsoleLines({ messages }: { messages: ConsoleEvidence['messages'] }) {
  return (
    <pre className="term">
      {keyed(messages, (message) => message.text).map(({ value: message, key }) => (
        <span key={key}>
          <span className={message.level === 'error' ? 't-bad' : ''}>
            {message.level === 'error' ? '✕ error' : '! warning'}
          </span>{' '}
          {message.text}
          {'\n'}
          {message.source && (
            <>
              <span className="t-dim">{message.source}</span>
              {'\n'}
            </>
          )}
        </span>
      ))}
    </pre>
  );
}

/** What an accessibility check found: each element it named numbered on the screenshot and in the list beside it. */
function AccessibilityPicture({ findings, shot, source }: Extract<PictureData, { type: 'accessibility' }>) {
  let n = 0;
  const numbered = findings.findings.map((finding) => ({
    finding,
    elements: finding.elements.map((element) => ({ ...element, n: ++n })),
  }));
  const marks: Mark[] = numbered.flatMap(({ elements }) =>
    elements.flatMap((element) => (element.box ? [{ ...element.box, kind: 'problem' as const, n: element.n }] : [])),
  );
  return (
    <div className="pad">
      <SourceCap source={source}>
        <span className="cap right">{plural(n, 'element')}</span>
      </SourceCap>
      <div className="split a11y">
        {shot && (
          <div className="thumb">
            <Shot shot={shot} marks={marks} />
          </div>
        )}
        <div className="findings">
          {numbered.map(({ finding, elements }) => (
            <div key={finding.rule} className="finding">
              <div className="finding-rule">
                <b>{finding.rule}</b>
                <span className="impact">{finding.impact}</span>
              </div>
              <p className="secondary">{finding.help}</p>
              <ol>
                {elements.map((element) => (
                  <li key={element.selector} className={element.box ? '' : 'away'}>
                    <span className="n">{element.n}</span>
                    <span>
                      {element.selector}
                      {!element.box && ' · out of view'}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A spec: with the `attn` rule and the planner's question while it holds for Martin, and otherwise plain. */
function SpecPicture({ spec, waiting, question }: Extract<PictureData, { type: 'spec' }>) {
  return (
    <div className="pad">
      <div className={waiting ? 'spec' : 'spec settled'}>
        <div className={waiting ? 'cap attn' : 'cap'}>{waiting ? 'Spec · waiting for Martin' : 'Spec'}</div>
        <div className="outcome">{spec.outcome}</div>
        <div className="gwt">
          {spec.criteria.map((c) => (
            <div key={c.given + c.when}>
              <b>GIVEN</b> {c.given} <b>WHEN</b> {c.when} <b>THEN</b> {c.expect}
            </div>
          ))}
        </div>
        {question && <div className="ask">The planner asks: {question}</div>}
      </div>
    </div>
  );
}

/** One line of a waiting panel: a tick or a cross, or a hollow ring for what comes after, what it says, and its figure. */
function Tick({ ok, children, num }: { ok: boolean | undefined; children: ReactNode; num?: string | undefined }) {
  return (
    <div className={ok ? '' : ok === undefined ? 'to' : 'x'}>
      <Glyph name={ok ? 'check' : ok === undefined ? 'ring' : 'cross'} />
      <span>{children}</span>
      <span className="num">{num}</span>
    </div>
  );
}

/** Output printed as it came, each line toned by a test of its own: the lines that say no, in the alarm colour. */
function Output({ lines, bad, dim }: { lines: string; bad: RegExp; dim?: RegExp }) {
  return keyedLines(lines).map(({ value: text, key }) => (
    <span key={key} className={bad.test(text) ? 't-bad' : dim?.test(text) ? 't-dim' : ''}>
      {text}
      {'\n'}
    </span>
  ));
}

/**
 * A fix waiting for Martin's merge: the decision he is asked to make, in the waiting-on-Martin panel. Its title in
 * mono, because it is a commit title, and three ticks that answer "is it safe to merge?".
 */
function MergePicture(picture: Extract<PictureData, { type: 'merge' }>) {
  const { checks, testsFirst, review } = picture;
  // No check finished is not every check passed.
  const passed = checks.total > 0 && checks.passed === checks.total;
  return (
    <div className="pad">
      <div className="waits">
        <div className="cap attn">PR #{picture.pullRequest} · waiting for Martin’s merge</div>
        <div className="head mono">{picture.title}</div>
        <div className="ticks">
          <Tick ok={passed} num={`${checks.passed} of ${checks.total}`}>
            {passed ? 'Every required check passed' : 'Not every required check passed'}
          </Tick>
          {testsFirst && (
            <Tick ok={testsFirst.failedOnBase} num={testsFirst.figure}>
              {testsFirst.failedOnBase ? 'Its tests fail without the fix' : 'Its tests pass without the fix'}
            </Tick>
          )}
          {review && (
            <Tick ok num={`review ${review.number}`}>
              The reviewer approved{review.suggestions ? `, ${inWords(review.suggestions, 'suggestion')}` : ''}
            </Tick>
          )}
        </div>
        <div className="foot">
          <span>
            {plural(picture.files, 'file')} · <span className="plus">+{picture.added}</span>{' '}
            <span className="minus">−{picture.removed}</span>
          </span>
          <span>{picture.inScope ? 'in scope · ' : ''}signed by the App</span>
        </div>
      </div>
    </div>
  );
}

/**
 * A merged fix held for the deploy pull request that will carry it, in the waiting-on-Martin panel: the merge done,
 * the release that carried it crossed when it rolled back or was stopped, the deploy pull request as the line last
 * recorded it, and hollow rings for what comes after. Its caption takes the `attn` rule only once the deploy waits for
 * Martin, its checks passed (or his retry, after a stop); before that it says what it waits for.
 */
function DeployPicture({
  pullRequest,
  title,
  merged,
  ended,
  deploy,
  waitsForMartin,
}: Extract<PictureData, { type: 'deploy' }>) {
  const [done, waiting] = deployCaption(ended, deploy, waitsForMartin);
  const caption = `${capital(done)} · ${waiting}`;
  const words = deployWords(deploy);
  return (
    <div className="pad">
      <div className="waits">
        <div className={waitsForMartin ? 'cap attn' : 'cap'}>{caption}</div>
        {pullRequest && (
          <div className="head mono">
            PR #{pullRequest}
            {title && ` · ${title}`}
          </div>
        )}
        <div className="ticks">
          {merged && (
            <Tick ok num={merged.commit.slice(0, 7)}>
              Merged by {merged.byMartin ? 'Martin' : 'the factory'} at {clock(merged.at)}
            </Tick>
          )}
          {ended && (
            <Tick ok={false} num={shortVersion(ended.version)}>
              The release that carried it {ended.stopped ? `was ${done}` : done} at {clock(ended.at)}
            </Tick>
          )}
          {deploy ? (
            <Tick ok={words.ok}>{words.tick}</Tick>
          ) : (
            <Tick ok={undefined}>
              {ended
                ? 'Martin’s retry carries it on, or the next deploy pull request, with its ticket and issue'
                : words.tick}
            </Tick>
          )}
          <Tick ok={undefined}>Then a canary against the version before, and Verify</Tick>
        </div>
        <div className="foot">
          <span>
            While the factory is Supervised, merging the deploy is Martin’s. Everything after it is unattended.
          </span>
        </div>
      </div>
    </div>
  );
}

/** Held: the scope fence refused the coder's patch again. Its own output, and what became of the patch before. */
function ScopePicture({ patch, refusals, output, earlier, reachedGitHub }: Extract<PictureData, { type: 'scope' }>) {
  return (
    <div className="pad">
      <div className="waits">
        <div className="cap attn">Held at Build · patch outside its scope, {times(refusals)}</div>
        <pre className="term">
          {`scope fence · patch ${patch} refused\n`}
          <Output lines={output} bad={/^refused /} dim={/^scope: /} />
          {earlier && (
            <span className="t-dim">
              patch {earlier.patch} was sent back {earlier.same ? 'with the same path' : 'too'}
            </span>
          )}
        </pre>
        <div className="foot">
          <span>{reachedGitHub ? 'the refused patches never reached GitHub' : 'nothing reached GitHub'}</span>
          <span>refused by the line</span>
        </div>
      </div>
    </div>
  );
}

/** Held: the change's new tests pass on the base. Ember on a pass reads oddly, so the foot says why it is the fault. */
function TestsPassPicture({ output }: Extract<PictureData, { type: 'tests-pass' }>) {
  return (
    <div className="pad">
      <div className="waits">
        <div className="cap attn">Held at Gates · its tests pass without the fix</div>
        <pre className="term">
          <Output lines={output} bad={/✓|passes/} dim={/^\d+ of \d+/} />
        </pre>
        <div className="foot">
          <span>a test that passes before the fix proves nothing about it</span>
        </div>
      </div>
    </div>
  );
}

const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

/** Held: the work item reached its spend cap. What it cost, and which agent spent it, in ink: money is not the fault. */
function SpendPicture({ stage, spent, cap, agents, stopped }: Extract<PictureData, { type: 'spend' }>) {
  return (
    <div className="pad">
      <div className="waits">
        <div className="cap attn">Held at {capital(stage)} · its spend cap reached</div>
        <div className="figure-big">
          {money(spent)} <small>spent on this work item</small>
        </div>
        <div className="spendbar" aria-hidden="true">
          {agents.map((a) => (
            <i key={a.agent} style={{ width: `${(a.cost / Math.max(spent, 0.01)) * 100}%` }} />
          ))}
        </div>
        <div className="spendkey">
          {agents.map((a) => (
            <span key={a.agent}>
              {AGENT_NAME[a.agent] ?? a.agent} {money(a.cost)}
              {a.steps > 1 ? ` · ${a.steps} steps` : ''}
            </span>
          ))}
        </div>
        <div className="foot">
          <span>
            {stopped
              ? `the ${(AGENT_NAME[stopped.agent] ?? stopped.agent).toLowerCase()}’s ${ORDINAL[stopped.step] ?? `${stopped.step}th`} step stopped part way`
              : ''}
          </span>
          <span>cap {money(cap)}</span>
        </div>
      </div>
    </div>
  );
}

/** Held: findings still blocking after the last review. The open finding turns ember here, and only here. */
function BlockingPicture({ reviews, findings }: Extract<PictureData, { type: 'blocking' }>) {
  const [first] = findings;
  return (
    <div className="pad">
      <div className="waits">
        <div className="cap attn">Held at Review · still blocking after {inWords(reviews, 'review')}</div>
        <div className="ticks">
          {findings.map((f) => (
            <Tick
              key={f.where}
              ok={false}
              num={`${f.reviews.length > 1 ? 'reviews' : 'review'} ${f.reviews.join(', ')}`}
            >
              {f.where}
              {f.cites ? ` · ${f.cites}` : ''}
            </Tick>
          ))}
        </div>
        {first && <div className="head comment">{first.comment}</div>}
        <div className="foot">
          <span>
            {plural(reviews, 'review')} · {plural(findings.length, 'finding')} open
          </span>
          <span>Martin decides: merge, close or send back</span>
        </div>
      </div>
    </div>
  );
}

export function Picture({ picture, interactive }: { picture: PictureData; interactive: boolean }) {
  return (
    <div className={`vis vis-${picture.type}`}>
      {picture.type === 'wipe' && <Wipe {...picture} interactive={interactive} />}
      {picture.type === 'screenshot' && (
        <>
          <Shot shot={picture.shot} numbered={picture.shot.boxes.length > 1} />
          <span className={`wtag l tone-${TAG_TONE[picture.tag]}`}>
            <span className="dot" />
            {picture.tag} · {shortVersion(picture.shot.version)}
          </span>
        </>
      )}
      {picture.type === 'pages' && <PagesPicture {...picture} />}
      {picture.type === 'http' && <HttpPicture {...picture} />}
      {picture.type === 'console' && <ConsolePicture {...picture} />}
      {picture.type === 'accessibility' && <AccessibilityPicture {...picture} />}
      {picture.type === 'quarantine' && <QuarantinePicture {...picture} />}
      {picture.type === 'suggestion' && <SuggestionPicture {...picture} />}
      {picture.type === 'metric' && (
        <MetricPicture evidence={picture.evidence} unchanged={picture.unchanged} seen={Boolean(picture.seen)} />
      )}
      {picture.type === 'logs' && (
        <LogsPicture before={picture.before} after={picture.after} seen={Boolean(picture.seen)} />
      )}
      {picture.type === 'package' && (
        <div className="pad">
          <Package dependency={picture.dependency} />
          <div className="lockfile">
            {picture.files.map((file) => (
              <div key={file.path}>
                <span>{file.path}</span>
                <span className="plus">+{file.added}</span>
                <span className="minus">−{file.removed}</span>
              </div>
            ))}
          </div>
          {picture.checks && (
            <div className="row checks">
              <Glyph name="check" />
              {picture.checks.passed === picture.checks.total
                ? `All ${picture.checks.total} required checks passed`
                : `${picture.checks.passed} of ${picture.checks.total} required checks passed`}
            </div>
          )}
          <Unchanged pages={picture.unchanged} />
        </div>
      )}
      {picture.type === 'scan' && <ScanPicture {...picture} />}
      {picture.type === 'rollback' && <RollbackPicture {...picture} />}
      {picture.type === 'refusal' && <RefusalPicture {...picture} />}
      {picture.type === 'judgement' && <JudgementPicture {...picture} />}
      {picture.type === 'spec' && <SpecPicture {...picture} />}
      {picture.type === 'merge' && <MergePicture {...picture} />}
      {picture.type === 'deploy' && <DeployPicture {...picture} />}
      {picture.type === 'scope' && <ScopePicture {...picture} />}
      {picture.type === 'tests-pass' && <TestsPassPicture {...picture} />}
      {picture.type === 'spend' && <SpendPicture {...picture} />}
      {picture.type === 'blocking' && <BlockingPicture {...picture} />}
      {picture.type === 'none' && (
        <div className="pad empty-picture">
          <span className="cap">Nothing captured yet</span>
        </div>
      )}
    </div>
  );
}
