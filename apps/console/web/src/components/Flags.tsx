/**
 * The feature flags in Controls: a row per flag, with its name, its work item's link, the preview eye from Preview up,
 * and its stages as a slider of five stops, Off to Everyone. Martin sets a stage by clicking a stop, or by dragging the
 * handle and letting go on one; either opens one confirmation, which says the move and who gets the flag on there, or
 * why that stop can't be taken now. Under the flags, whether the app holds them as set, from the admin service's last
 * check of it.
 *
 * Every stop is judged by `policy/flag-moves.ts`, the rules the admin service refuses a move by (`projection/flags.ts`),
 * but the service decides: it judges the move again from the stage `flags` holds, asks for the passkey again where the
 * move widens past Checks, and says why when it refuses. A move shows as its event arrives: the slider moves.
 *
 * The drag never renders: each frame of it moves the handle through its element's style, and the slider's state
 * changes only when the drag ends, as the reel's does (`renders.ts` counts, and a test reads the count). A visitor
 * sees every slider read-only, with no handle and nothing to press, and the same line about the app.
 */
import { stageWords } from '@software-factory/policy/flag-moves';
import { FLAGS_HELD } from '@software-factory/policy/flags';
import { type CSSProperties, lazy, type PointerEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Admin } from '../admin.ts';
import { clock, duration } from '../format.ts';
import { type HeldAnswer, heldFlags } from '../held.ts';
import { previewHref } from '../profile.ts';
import { type FlagRow, type FlagStage, type FlagsView, STAGE_NAME, type Stop } from '../projection/index.ts';
import { renders } from '../renders.ts';
import { Glyph } from './Glyph.tsx';

/** The slider's confirmation, which only Martin opens: its code arrives when he first does. */
export const FlagDialog = lazy(() => import('./FlagDialog.tsx').then((module) => ({ default: module.FlagDialog })));

/** How often the page asks again whether the app holds the flags, while it is shown. */
const HELD_EVERY_MS = 15_000;

/** A stage in the console's words, as the admin service says it: "Share 50%". */
export { stageWords };

/**
 * Whether the app holds the flags as set, asked of the admin service now and every 15 seconds while the page is shown,
 * and soon after Martin moves one (`refresh`). Only where there is an admin service to ask.
 */
export function useHeld(enabled: boolean): { answer: HeldAnswer; refresh: () => void } {
  const [answer, setAnswer] = useState<HeldAnswer>({ kind: 'unknown' });
  const again = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const ask = () => {
      if (document.visibilityState !== 'visible') return;
      void heldFlags().then((got) => {
        if (live) setAnswer(got);
      });
    };
    ask();
    again.current = ask;
    const timer = setInterval(ask, HELD_EVERY_MS);
    document.addEventListener('visibilitychange', ask);
    return () => {
      live = false;
      again.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [enabled]);
  // A move is checked within seconds of its write: asked again a little after it, as well as on the minute.
  const refresh = useCallback(() => {
    setTimeout(() => again.current(), 3000);
  }, []);
  return { answer, refresh };
}

/** What a stop's button says to a screen reader: the move, and that it can't be taken now. */
function stopName(stop: Stop, row: FlagRow): string {
  const { move } = stop;
  const words = stageWords(stop.to);
  const name =
    move.action === 'flag.off'
      ? 'Turn off'
      : move.action === 'flag.back-on'
        ? 'Turn back on for everyone'
        : move.action === 'flag.narrow'
          ? `Narrow to ${words}`
          : `Widen to ${words}`;
  return `${name}${move.refused ? ': can’t be taken now' : ''}, ${row.name}`;
}

/**
 * A flag's stages as a slider: the stops passed filled, the one it stands at ringed, the rest hollow; a stop that
 * can't be taken now dashed. Martin's, in Controls and on the sheet, has a button for each other stop and a handle he
 * can drag; a visitor's, and a closed flag's, neither.
 */
export function FlagSlider({ row, onChoose }: { row: FlagRow; onChoose?: ((stop: Stop) => void) | undefined }) {
  renders.flags += 1;
  const slider = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const at = row.stops.findIndex((stop) => stop.place === 'now');
  const live = onChoose !== undefined && !row.closed;

  // Dragging the handle: it follows the pointer, written straight to its style each frame; letting go on another stop
  // chooses it, and the handle goes back to where the flag stands until the move is made.
  const down = (event: PointerEvent<HTMLSpanElement>) => {
    const handle = thumb.current;
    const box = slider.current;
    if (!handle || !box || !onChoose || event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    box.classList.add('dragging');
    const rect = box.getBoundingClientRect();
    const along = (x: number) => Math.max(0, Math.min(1, (x - rect.left - rect.width * 0.1) / (rect.width * 0.8)));
    const move = (e: globalThis.PointerEvent) => {
      handle.style.left = `calc(10% + ${along(e.clientX) * 80}%)`;
    };
    const end = (e: globalThis.PointerEvent, chosen: boolean) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      box.classList.remove('dragging');
      handle.style.left = '';
      const stop = row.stops[Math.round(along(e.clientX) * 4)];
      if (chosen && stop && stop.place !== 'now') onChoose(stop);
    };
    const up = (e: globalThis.PointerEvent) => end(e, true);
    const cancel = (e: globalThis.PointerEvent) => end(e, false);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset needs a legend, and the slider is named by its flag
    <div
      ref={slider}
      className={`fslider${live ? '' : ' is-ro'}${row.turnedOff ? ' is-off' : ''}`}
      style={{ '--at': String(Math.max(0, at)) } as CSSProperties}
      role="group"
      aria-label={`${row.name}: ${row.turnedOff ? 'turned off' : stageWords(row.stage)}`}
    >
      <span className="frail" aria-hidden="true" />
      <span className="fill" aria-hidden="true" />
      {live && <span ref={thumb} className="fthumb" aria-hidden="true" onPointerDown={down} />}
      {row.stops.map((stop) => {
        const cant = stop.place !== 'now' && stop.move.refused !== undefined;
        const className = `fstop ${stop.place}${cant ? ' cant' : ''}`;
        const inner = (
          <>
            <i aria-hidden="true" />
            <span>
              {STAGE_NAME[stop.stage]}
              {stop.stage === 'share' && <small> {row.share}%</small>}
            </span>
          </>
        );
        return live && stop.place !== 'now' ? (
          <button
            key={stop.stage}
            type="button"
            className={className}
            aria-label={stopName(stop, row)}
            onClick={() => onChoose?.(stop)}
          >
            {inner}
          </button>
        ) : (
          <span key={stop.stage} className={className} aria-current={stop.place === 'now' || undefined}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}

/** Seconds, then minutes and hours, since a time: "40s", "3min". */
const since = (at: number, now: number) => duration(Math.max(1000, now - at)).split(/\s/)[0];

/** What the app answered that is not the revision, in words. */
const HELD_WORDS: Record<string, string> = {
  none: 'no flag set',
  stale: 'a flag set it can no longer refresh',
  invalid: 'a revision no flag set has',
};

/** Under the flags, whether the app holds them as set, as the admin service last checked: nothing when it can't say. */
function HeldLine({ answer, martin, now }: { answer: HeldAnswer; martin: boolean; now: number }) {
  if (answer.kind === 'unknown') return null;
  const phone = martin ? 'your' : 'Martin’s';
  if (answer.kind === 'off') {
    return (
      <p className="sync">
        <Glyph name="dash" />
        <span>The admin service doesn’t check which flags the app holds here.</span>
      </p>
    );
  }
  const { held } = answer;
  const checked = held.checkedAt ? Date.parse(held.checkedAt) : undefined;
  const revision = held.revision ? `: ${held.revision}` : '';
  switch (held.state) {
    case 'held':
      return (
        <p className="sync">
          <Glyph name="check" className="glyph ok" />
          <span>
            The app holds every flag as set{revision}
            {checked !== undefined && `, checked ${since(checked, now)} ago`}.
          </span>
        </p>
      );
    case 'taking':
      return (
        <p className="sync tone-taking">
          <Glyph name="ring" />
          <span>
            The app is taking the change{held.revision ? ` to ${held.revision}` : ''}: {phone} phone hears if it hasn’t
            within a minute of a narrowing or Off, or {FLAGS_HELD.differMinutes} of a widening.
          </span>
        </p>
      );
    case 'lagging': {
      const others = held.held.filter((h) => h !== held.revision).map((h) => HELD_WORDS[h] ?? h);
      const from = held.since ? Date.parse(held.since) : undefined;
      return (
        <p className="sync tone-attn">
          <Glyph name="cross" />
          <span>
            The app still holds {others.length ? others.join(' and ') : 'another flag set'}
            {from !== undefined && `, ${since(from, now)}`} after {held.revision ?? 'the flags were set'}: {phone} phone
            hears at {FLAGS_HELD.differMinutes}min, or at a minute for a narrowing or Off.
          </span>
        </p>
      );
    }
    case 'unchecked':
      return (
        <p className="sync">
          <Glyph name="dash" />
          <span>
            {checked === undefined
              ? 'The app hasn’t been asked yet which flags it holds.'
              : `The admin service couldn’t ask every copy of the app which flags it holds, at ${clock(checked)}.`}
          </span>
        </p>
      );
  }
}

/** One flag's row: its name, its work item, the preview eye from Preview up, and the slider. */
function FlagLine({
  row,
  app,
  onOpen,
  onChoose,
}: {
  row: FlagRow;
  app: string | undefined;
  onOpen: (item: string) => void;
  onChoose: ((stop: Stop) => void) | undefined;
}) {
  const previewing = !row.turnedOff && ['preview', 'share', 'everyone'].includes(row.stage.stage);
  return (
    <div className="flag">
      <div className="flag-top">
        <code className="flagname">{row.name}</code>
        <button type="button" className="linkish" onClick={() => onOpen(row.workItem)}>
          #{row.workItem}
        </button>
        {previewing && app && (
          <a
            className="pv-icon"
            href={previewHref(app, row.name, row.page)}
            target="_blank"
            rel="noopener"
            title="Preview it on the app"
            aria-label={`Preview it on the app: ${row.name} (opens a new tab)`}
          >
            <Glyph name="eye" />
          </a>
        )}
      </div>
      <FlagSlider row={row} onChoose={onChoose} />
    </div>
  );
}

/**
 * Controls' Flags: a row per flag in the app, those turned off and closed folded at the foot, and whether the app holds
 * them as set. With no flag yet, a sentence on how one comes.
 */
export function FlagsGroup({
  flags,
  admin,
  app,
  held,
  now,
  onOpen,
  onMoved,
}: {
  flags: FlagsView;
  admin: Admin;
  app: string | undefined;
  held: HeldAnswer;
  /** The page's time, which "checked 40s ago" counts from. */
  now: number;
  onOpen: (item: string) => void;
  onMoved: () => void;
}) {
  const martin = admin.kind === 'martin';
  const [choosing, setChoosing] = useState<{ row: FlagRow; to: FlagStage } | undefined>(undefined);
  const choose = (row: FlagRow) => (martin ? (stop: Stop) => setChoosing({ row, to: stop.to }) : undefined);
  // The dialog follows the flag as its events arrive, so it judges the move from where the flag stands now.
  const current = choosing && flags.flags.find((row) => row.name === choosing.row.name);
  const count = flags.flags.length;
  return (
    <div className="ctl-group flags">
      <span className="label">
        <span>Flags</span>
        {count > 0 && <span>{count} in the app</span>}
      </span>
      {count === 0 && !flags.closed.length ? (
        <p className="help">
          No flag yet. An improvement ships behind one, off, and it shows here once its release is out.
        </p>
      ) : (
        flags.flags.map((row) => <FlagLine key={row.name} row={row} app={app} onOpen={onOpen} onChoose={choose(row)} />)
      )}
      {flags.closed.length > 0 && (
        <details className="flags-closed">
          <summary>Turned off and closed · {flags.closed.length}</summary>
          {flags.closed.map((row) => (
            <FlagLine key={row.name} row={row} app={app} onOpen={onOpen} onChoose={undefined} />
          ))}
        </details>
      )}
      <HeldLine answer={held} martin={martin} now={now} />
      {choosing && current && admin.kind === 'martin' && (
        <Suspense fallback={null}>
          <FlagDialog
            row={current}
            to={choosing.to}
            token={admin.session.token}
            onClose={() => setChoosing(undefined)}
            onMoved={onMoved}
          />
        </Suspense>
      )}
    </div>
  );
}
