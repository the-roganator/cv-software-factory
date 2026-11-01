/**
 * The reel: every work item as a card, oldest on the left and now on the right, and the timeline beneath.
 *
 * Per-frame work stays out of rendering (ADR 0007). Dragging, flicking and scrubbing the timeline move a position
 * held in a ref and write each card's transform directly; state hears only where the reel settles. A test counts renders
 * during a drag and fails if they grow with the number of frames.
 *
 * The timeline shows a window of itself around the playhead, the same on every screen: each work item's mark has at
 * least `MARK_ROOM` pixels, and when the whole timeline does not fit at that, it slides under a window that follows the
 * playhead, written like the cards on every frame of a drag.
 */
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { dayLabel, isCommit, shortVersion, when } from '../format.ts';
import type { Card as CardData, View } from '../projection/index.ts';
import { backWords } from '../projection/release.ts';
import { renders } from '../renders.ts';
import { Card, OUTCOME } from './Card.tsx';
import { CATEGORY_NAME, Glyph } from './Glyph.tsx';

/** The least room a work item's mark has along the timeline: a mark is 26px across, and 32px at the centre. */
const MARK_ROOM = 40;
/** Room at each end of the timeline's window, so the first and last marks, and their version labels, are drawn whole. */
const EDGE = 26;

interface ReelProps {
  view: View;
  /** The card at the centre, when the reel is at rest. */
  centre: number;
  onCentre: (index: number) => void;
  onOpen: (index: number) => void;
  motion: boolean;
}

const phone = () => innerWidth <= 720;

/** Where a position falls along the timeline, from 0 to 1, between the cards either side of it. */
function railAt(positions: readonly number[], p: number): number {
  const n = positions.length;
  const i = Math.max(0, Math.min(n - 1, Math.floor(p)));
  const [a, b] = [positions[i] ?? 0, positions[Math.min(n - 1, i + 1)] ?? 0];
  return a + (b - a) * (Math.max(0, Math.min(n - 1, p)) - i);
}

/** The app's version at a work item, in words: "b5702d4", or "its first version". */
const appWords = (card: CardData) => (card.appVersion ? shortVersion(card.appVersion) : 'its first version');

/**
 * What became of the work item's own release when the app went back from it, in words: "c41d2e9 was rolled back", "c41d2e9
 * was aborted by Martin". On the timeline that version is struck through; this says it to everyone else.
 */
function wentBack(card: CardData): string | undefined {
  const { to, rolledBack, stopped } = card.versions;
  if (!to || !(rolledBack || stopped)) return undefined;
  return `${shortVersion(to)} was ${backWords(stopped)}`;
}

interface Drag {
  x: number;
  p0: number;
  moved: boolean;
  card: number | undefined;
  /** The last pointer position and time, for the speed of a flick. */
  lx: number;
  lt: number;
  v: number;
}

export function Reel({ view, centre, onCentre, onOpen, motion }: ReelProps) {
  renders.reel++;
  const { cards, timeline } = view;
  /** The version the app is on: the last mark not struck through. */
  const appNow = timeline.versions.findLastIndex((v) => !v.rolledBack);
  const n = cards.length;
  const reel = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  /** The timeline's window, and the strip of marks that slides under it. */
  const shown = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  /** The window's width and the strip's length, in pixels: measured when either changes, never on a frame of a drag. */
  const extent = useRef({ width: 0, length: 0 });
  const playhead = useRef<HTMLSpanElement>(null);
  const elements = useRef<(HTMLElement | null)[]>([]);
  /** Where the reel is, in cards: a whole number at rest, anything between while moving. */
  const position = useRef(centre);
  const [announcement, setAnnouncement] = useState('');
  /** Set while a finger or pointer is moving the reel or the timeline: nothing else moves it then. */
  const drag = useRef<Drag | undefined>(undefined);
  const scrubbing = useRef(false);
  // A live console's clock ticks every ten seconds, and each tick brings a new timeline with the same positions.
  // Keyed on the positions themselves, the drawing changes only when a card is added or a release takes a place.
  const positionsKey = timeline.positions.join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the positions
  const positions = useMemo(() => timeline.positions, [positionsKey]);
  const { span } = timeline;

  /**
   * Sizes the strip: the window's width when every mark has its room in it, and longer, a mark's room for each card
   * width it spans, when not.
   */
  const measure = useCallback(() => {
    const width = shown.current?.clientWidth ?? 0;
    const length = Math.max(width - 2 * EDGE, span * MARK_ROOM);
    if (strip.current) strip.current.style.width = `${length}px`;
    extent.current = { width, length };
  }, [span]);

  /**
   * Writes every card's place for a position, and the playhead's. No rendering: this runs on every frame of a drag.
   * The timeline's strip slides to keep the playhead in the middle of its window, as far as it goes, unless `follow`
   * is off: while the timeline itself is scrubbed, it holds still under the pointer.
   */
  const layout = useCallback(
    (p: number, animate = false, follow = true) => {
      const box = reel.current;
      if (!box) return;
      box.classList.toggle('anim', animate && motion);
      const width = Math.min(620, box.clientWidth - (phone() ? 40 : 200));
      const step = width * 0.9 + (phone() ? 12 : 28);
      box.style.setProperty('--card-w', `${width}px`);
      elements.current.forEach((el, i) => {
        if (!el) return;
        const d = i - p;
        const ad = Math.abs(d);
        el.style.transform = `translateX(${d * step - width / 2}px) scale(${1 - Math.min(ad, 1) * 0.1})`;
        el.style.opacity = String(ad > 2.6 ? 0 : Math.max(0, 1 - Math.min(ad, 1) * 0.3 - Math.max(0, ad - 1) * 0.4));
        el.style.zIndex = String(50 - Math.round(ad * 10));
        el.style.visibility = ad > 2.8 ? 'hidden' : 'visible';
        const atCentre = ad < 0.5;
        el.dataset.place = atCentre ? 'centre' : 'side';
        el.setAttribute('aria-hidden', String(!atCentre));
        for (const handle of el.querySelectorAll<HTMLElement>('.handle')) handle.tabIndex = atCentre ? 0 : -1;
      });
      const along = railAt(positions, p);
      if (playhead.current) playhead.current.style.left = `${along * 100}%`;
      const { width: room, length } = extent.current;
      if (follow && strip.current && shown.current && room) {
        const x = Math.max(room - EDGE - length, Math.min(EDGE, room / 2 - along * length));
        strip.current.style.transform = `translateX(${x}px)`;
        // A fade at an end says the timeline goes on past it.
        shown.current.classList.toggle('before', x < EDGE - 0.5);
        shown.current.classList.toggle('after', x + length > room - EDGE + 0.5);
      }
      position.current = p;
    },
    [motion, positions],
  );

  /** The position nearest a point along the timeline. */
  const positionFromRail = (f: number) => {
    for (let i = 0; i < n - 1; i++) {
      const [a, b] = [positions[i] ?? 0, positions[i + 1] ?? 1];
      if (f <= b) return i + Math.max(0, (f - a) / (b - a || 1));
    }
    return n - 1;
  };

  // Before the reel is drawn where it rests: the strip's length is what the playhead's place is measured along.
  useLayoutEffect(measure, [measure]);

  // State decides where the reel rests; this draws it there, sliding unless motion is off. Mid-gesture it waits:
  // letting go settles the reel from wherever the gesture left it.
  useLayoutEffect(() => {
    if (!drag.current && !scrubbing.current) layout(centre, true);
  }, [centre, layout]);

  const { title, outcome } = cards[centre] ?? {};
  useEffect(() => {
    if (title && outcome) setAnnouncement(`${centre + 1} of ${n}: ${title}. ${OUTCOME[outcome][0]}.`);
  }, [centre, n, title, outcome]);

  /**
   * Labels that would touch are thinned to a hairline. Of the versions, the centre card's keeps its label, then the one
   * the app is on now, then rollbacks and stops, then those nearest the centre; of the days, the centre card's, then
   * those nearest it. Measured where the reel rests and when the width changes.
   */
  const thin = useCallback(() => {
    const here = positions[centre] ?? 0;
    const at = (m: HTMLElement) => Number(m.dataset.at);
    const labels = (kind: string) => [...(rail.current?.querySelectorAll<HTMLElement>(kind) ?? [])];
    // Every label is measured whole before any is thinned: one layout, not one for each label.
    for (const mark of labels('.thin')) mark.classList.remove('thin');
    const thinOut = (marks: HTMLElement[], rank: (m: HTMLElement) => number) => {
      const boxes = new Map(marks.map((m) => [m, m.getBoundingClientRect()]));
      const kept: DOMRect[] = [];
      for (const mark of marks.sort((a, b) => rank(a) - rank(b))) {
        const box = boxes.get(mark);
        if (!box?.width) continue;
        if (kept.some((k) => box.left < k.right + 4 && k.left < box.right + 4)) mark.classList.add('thin');
        else kept.push(box);
      }
    };
    const has = (m: HTMLElement, name: string) => m.classList.contains(name);
    thinOut(
      labels('.ver'),
      (m) => (has(m, 'here') ? 0 : has(m, 'now') ? 1 : has(m, 'burnt') ? 2 : 4) + Math.abs(at(m) - here),
    );
    const today = Math.max(
      ...labels('.day')
        .map(at)
        .filter((a) => a <= here),
    );
    thinOut(labels('.day'), (m) => (at(m) === today ? 0 : 1) + Math.abs(at(m) - here));
  }, [centre, positions]);
  // After every render, which a drag never causes.
  useLayoutEffect(thin);

  // The tallest card sets the reel's height, once fonts have loaded and whenever the width changes.
  useEffect(() => {
    const fit = () => {
      const tallest = Math.max(0, ...elements.current.map((el) => el?.offsetHeight ?? 0));
      if (reel.current) reel.current.style.height = `${tallest + 12}px`;
      measure();
      // Mid-scrub, the strip stays under the pointer.
      layout(position.current, false, !scrubbing.current);
      thin();
    };
    fit();
    void document.fonts?.ready.then(fit);
    let timer = 0;
    const resize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(fit, 80);
    };
    // The timeline's window changes width with the page's, and with a scrollbar coming or going.
    const observer = 'ResizeObserver' in window ? new ResizeObserver(resize) : undefined;
    if (shown.current) observer?.observe(shown.current);
    addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      removeEventListener('resize', resize);
    };
  }, [layout, measure, thin]);

  const settle = useCallback(
    (p: number) => {
      const index = Math.max(0, Math.min(n - 1, Math.round(p)));
      if (index === centre) layout(index, true);
      else onCentre(index);
    },
    [centre, layout, n, onCentre],
  );

  // Dragging the cards: a click on the centre card opens it, on a neighbour brings it to the centre.
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('.handle')) return;
    const card = (event.target as Element).closest<HTMLElement>('.card')?.dataset.index;
    drag.current = {
      x: event.clientX,
      p0: position.current,
      moved: false,
      card: card === undefined ? undefined : Number(card),
      lx: event.clientX,
      lt: performance.now(),
      v: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !reel.current) return;
    const dx = event.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 6) return;
    if (!d.moved) {
      d.moved = true;
      reel.current.classList.add('dragging');
    }
    const now = performance.now();
    d.v = (event.clientX - d.lx) / Math.max(1, now - d.lt);
    d.lx = event.clientX;
    d.lt = now;
    const width = Math.min(620, reel.current.clientWidth - (phone() ? 40 : 200));
    const step = width * 0.9 + (phone() ? 12 : 28);
    layout(Math.max(-0.35, Math.min(n - 0.65, d.p0 - dx / step)));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    reel.current?.classList.remove('dragging');
    if (!d) return;
    if (!d.moved) {
      if (d.card === undefined) return;
      if (d.card === centre) onOpen(d.card);
      else onCentre(d.card);
      return;
    }
    // A flick carries the reel half a card further.
    settle(position.current + (Math.abs(d.v) > 0.5 ? -Math.sign(d.v) * 0.5 : 0));
  };

  // Scrubbing the timeline: the strip holds still under the pointer, and follows the playhead once it is let go.
  // A pointer beyond the window's ends counts as at them, so it never lands on a mark out of sight.
  const fromRail = (event: React.PointerEvent<HTMLElement>) => {
    const [box, frame] = [strip.current?.getBoundingClientRect(), shown.current?.getBoundingClientRect()];
    if (!box?.width || !frame) return;
    const x = Math.max(frame.left + EDGE, Math.min(frame.right - EDGE, event.clientX));
    layout(positionFromRail(Math.max(0, Math.min(1, (x - box.left) / box.width))), false, false);
  };
  /** Stops the strip where it is drawn, part way through a slide or not, before a scrub measures against it. */
  const hold = () => {
    const [box, frame] = [strip.current?.getBoundingClientRect(), shown.current?.getBoundingClientRect()];
    if (box && frame && strip.current) strip.current.style.transform = `translateX(${box.left - frame.left}px)`;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -3, PageDown: 3 }[event.key];
    const to = step !== undefined ? centre + step : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : undefined;
    if (to !== undefined) {
      event.preventDefault();
      onCentre(Math.max(0, Math.min(n - 1, to)));
    } else if (event.key === 'Enter' && event.currentTarget === reel.current) {
      onOpen(centre);
    }
  };

  const current = cards[centre];
  const back = current && wentBack(current);
  return (
    <section className="history" aria-labelledby="history-title">
      <div className="history-head">
        <div>
          <h2 id="history-title">The app, change by change</h2>
          <p>
            Every work item, oldest on the left. Drag the cards or the timeline to watch the app change; open one to see
            how it was done.
          </p>
        </div>
        <div className="transport">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous work item"
            disabled={centre === 0}
            onClick={() => onCentre(centre - 1)}
          >
            <Glyph name="left" />
          </button>
          <span className="count">
            {centre + 1} of {n}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next work item"
            disabled={centre >= n - 1}
            onClick={() => onCentre(centre + 1)}
          >
            <Glyph name="right" />
          </button>
          <button type="button" className="now-btn" aria-pressed={centre === n - 1} onClick={() => onCentre(n - 1)}>
            <span className="dot tone-signal blink" aria-hidden="true" />
            NOW
          </button>
        </div>
      </div>
      <section
        className="reel"
        ref={reel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the reel takes the arrow keys, as a carousel does
        tabIndex={0}
        aria-roledescription="carousel"
        aria-label="Work items, oldest first. Left and right arrows move; Enter opens one."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = undefined;
          settle(position.current);
        }}
        onKeyDown={onKeyDown}
      >
        {cards.map((card, i) => (
          <Card
            key={card.number}
            card={card}
            index={i}
            count={n}
            ref={(el) => {
              elements.current[i] = el;
            }}
          />
        ))}
      </section>
      <div
        className="rail"
        ref={rail}
        role="slider"
        tabIndex={0}
        aria-label="Timeline of work items"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={centre + 1}
        aria-valuetext={
          current
            ? `${centre + 1} of ${n}: ${current.title}, ${when(current.startedAt)}. The app at ${appWords(current)}${back ? `; ${back}` : ''}.`
            : undefined
        }
        onPointerDown={(event) => {
          scrubbing.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          hold();
          fromRail(event);
        }}
        onPointerMove={(event) => scrubbing.current && fromRail(event)}
        onPointerUp={() => {
          scrubbing.current = false;
          settle(position.current);
        }}
        onPointerCancel={() => {
          scrubbing.current = false;
          settle(position.current);
        }}
        onKeyDown={onKeyDown}
      >
        <div className="window" ref={shown}>
          <div className="strip" ref={strip}>
            <span className="track" />
            {timeline.days.map(({ at, day }) => (
              <span
                key={day}
                className="label day"
                data-at={at}
                style={{ left: `calc(${at * 100}% - 20px)` } as CSSProperties}
              >
                {dayLabel(day)}
              </span>
            ))}
            {cards.map((card, i) => (
              <span
                key={card.number}
                className={`tick tone-${OUTCOME[card.outcome][1]} ${i === centre ? 'here' : ''}`}
                style={{ left: `${(positions[i] ?? 0) * 100}%` }}
                title={`${CATEGORY_NAME[card.category]}: ${card.title}`}
              >
                <Glyph name={card.category} />
              </span>
            ))}
            {timeline.versions.map(({ at, card, version, rolledBack }, i) => (
              <span
                key={`${version}-${at}`}
                className={`ver ${rolledBack ? 'burnt' : ''} ${card === centre ? 'here' : ''} ${i === appNow ? 'now' : ''}`}
                data-at={at}
                style={{ left: `${at * 100}%` }}
              >
                {shortVersion(version)}
              </span>
            ))}
            <span className="playhead" ref={playhead} />
          </div>
        </div>
      </div>
      {current && (
        <div className="at-line">
          <span>
            <b>{when(current.startedAt)}</b> · #{current.number} {current.title}
          </span>
          <span>
            The app at{' '}
            <b
              className="mono"
              title={current.appVersion && isCommit(current.appVersion) ? current.appVersion : undefined}
            >
              {appWords(current)}
            </b>
            {back && <span className="attn-text"> · {back}</span>}
            {current.outcome === 'in-progress' && current.versions.onCanary && (
              <span className="attn-text"> · broken now; the fix is on the canary</span>
            )}
          </span>
        </div>
      )}
      <p className="sr" aria-live="polite">
        {announcement}
      </p>
      <p className="help reel-help">
        <b>What am I looking at?</b> Each card is one work item: what was wrong or wanted, what changed on the site, and
        what it cost. Where nothing visible changed, the card shows what did: a graph, a package, a log line or the
        refusal that stopped an attack. Open a card for every stage, screenshot and model call.
      </p>
    </section>
  );
}
