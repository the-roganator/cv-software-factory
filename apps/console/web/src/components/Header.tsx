import { lazy, Suspense } from 'react';
import type { Admin } from '../admin.ts';
import { AUTONOMY, duration } from '../format.ts';
import type { Header as LineState, Score } from '../projection/index.ts';
import type { Theme } from '../settings.ts';
import type { Connection } from '../source.ts';
import { Mark } from './Mark.tsx';
import { StepUpPill } from './StepUp.tsx';

/**
 * Martin's own parts of the header, which a visitor never loads: the session check fetches them before the page draws
 * him signed in (`useAdmin`), so they arrive with the rest of his header rather than after it.
 */
const Account = lazy(() => import('./Account.tsx').then((module) => ({ default: module.Account })));
const LineButton = lazy(() => import('./LineButton.tsx').then((module) => ({ default: module.LineButton })));

/** Whether the line runs, in words and a dot that never carries the meaning alone. */
export function LineStatus({ line, connection }: { line: LineState; connection: Connection }) {
  if (connection === 'loading' || connection === 'failed') {
    return (
      <>
        <span className="dot tone-faint" aria-hidden="true" />
        {connection === 'loading' ? 'Connecting to the factory' : 'Can’t reach the factory'}
      </>
    );
  }
  if (connection === 'reconnecting') {
    return (
      <>
        <span className="dot tone-signal blink" aria-hidden="true" />
        Reconnecting
      </>
    );
  }
  if (line.stopped !== undefined) {
    // Martin's reason, as everyone reads it: in full on a hover, and cut short where the header has no room.
    return (
      <>
        <span className="dot tone-attn ring" aria-hidden="true" />
        <span>
          Line stopped · “
          <span className="why" title={line.stopped}>
            {line.stopped}
          </span>
          ”
        </span>
      </>
    );
  }
  if (!line.running) {
    return (
      <>
        <span className="dot tone-faint" aria-hidden="true" />
        Line not started
      </>
    );
  }
  // A spend cap is a guardrail at work: the header says it first, by the ember ring that asks a person to look.
  if (line.capped) {
    return (
      <>
        <span className="dot tone-attn ring" aria-hidden="true" />
        Line running · <b className="capped">spend cap reached</b>
      </>
    );
  }
  if (line.waiting) {
    return (
      <>
        <span className="dot tone-attn ring" aria-hidden="true" />
        Line running · <b className="capped">agents waiting for a model</b>
      </>
    );
  }
  return (
    <>
      <span className="dot tone-ok blink" aria-hidden="true" />
      Line running · {AUTONOMY[line.autonomy]}
    </>
  );
}

/**
 * The scoreboard beside the app's name: its three figures as it last published them, or that it is off. It never
 * names a ticket, and draws nothing when it has never published.
 */
export function Scoreboard({ score, sample }: { score: Score | undefined; sample: boolean }) {
  if (!score) return null;
  if (!score.keyed) {
    return (
      <p className="score-off">
        <b>Scoreboard off</b> <span>This copy of the factory has no answer key, so it counts nothing.</span>
      </p>
    );
  }
  return (
    <div className="score-wrap">
      {sample && <span className="pill pill-sample">Sample</span>}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset holds a form's controls, and these are figures */}
      <div className="score" role="group" aria-label="Scoreboard: seeded and injected defects">
        <div>
          <b>{score.found}</b>
          <span>found</span>
        </div>
        <div>
          <b className={score.verified ? 'ok' : undefined}>{score.verified}</b>
          <span>verified fixed</span>
        </div>
        <div>
          {score.medianMs === null ? (
            <b className="none">
              <span aria-hidden="true">—</span>
              <span className="sr">none yet</span>
            </b>
          ) : (
            <b>{duration(score.medianMs)}</b>
          )}
          <span>median to verified</span>
        </div>
      </div>
    </div>
  );
}

interface HeaderProps {
  line: LineState;
  connection: Connection;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  motion: boolean;
  onMotion: (on: boolean) => void;
  admin: Admin;
  /** Martin, signed in, sees the console as a visitor does (`Preview.tsx`). */
  previewing: boolean;
  onPreview: () => void;
  /** On a page of its own (the settings, the audit log, privacy), the brand goes to the console; on it, to its top. */
  away?: boolean;
}

/**
 * Paper or Ink, and Motion or Still: in the header for a visitor, and in Martin's account menu for him, where each
 * has its name beside it (`named`), as the menu's rows have words.
 */
export function Switches({
  theme,
  onTheme,
  motion,
  onMotion,
  named = false,
}: Pick<HeaderProps, 'theme' | 'onTheme' | 'motion' | 'onMotion'> & { named?: boolean }) {
  const themes = (
    <fieldset className="seg" aria-label="Theme">
      <button type="button" aria-pressed={theme === 'paper'} onClick={() => onTheme('paper')}>
        PAPER
      </button>
      <button type="button" aria-pressed={theme === 'ink'} onClick={() => onTheme('ink')}>
        INK
      </button>
    </fieldset>
  );
  const motions = (
    <fieldset className="seg" aria-label="Motion">
      <button type="button" aria-pressed={motion} onClick={() => onMotion(true)}>
        MOTION
      </button>
      <button type="button" aria-pressed={!motion} onClick={() => onMotion(false)}>
        STILL
      </button>
    </fieldset>
  );
  if (!named) {
    return (
      <>
        {themes}
        {motions}
      </>
    );
  }
  // The fieldsets are named already; the words are for the eye.
  return (
    <>
      <div className="switch-row">
        <span aria-hidden="true">Theme</span>
        {themes}
      </div>
      <div className="switch-row">
        <span aria-hidden="true">Motion</span>
        {motions}
      </div>
    </>
  );
}

export function Header({
  line,
  connection,
  theme,
  onTheme,
  motion,
  onMotion,
  admin,
  previewing,
  onPreview,
  away = false,
}: HeaderProps) {
  const switches = { theme, onTheme, motion, onMotion };
  const martin = admin.kind === 'martin' && !previewing;
  return (
    <header className="top">
      <div className="wrap">
        {/* The way home from any page: one link for the mark and the name, named once, in the words it shows, in order,
            at a width that shows its byline and at one that hides it. On the console itself it goes to the top, so
            nothing there is lost to a reload: a preview, a pinned theme or time, an open sheet. */}
        <a className="brand" href={away ? '/' : '#top'} aria-label="Software Factory: Martin Rogan, a live CV, home">
          <Mark />
          <span className="brand-rule" aria-hidden="true" />
          <span>
            <b>Software Factory</b> <small>Martin Rogan · a live CV</small>
          </span>
        </a>
        <div className="top-right">
          <span className="status">
            <LineStatus line={line} connection={connection} />
          </span>
          {/* Martin's are in his account menu, where the header has room for what he does. */}
          {!martin && <Switches {...switches} />}
          {admin.kind === 'martin' && previewing && <span className="pill pill-visitor">VISITOR VIEW</span>}
          {admin.kind === 'martin' && !previewing && (
            <>
              <StepUpPill />
              <Suspense fallback={null}>
                <LineButton line={line} token={admin.session.token} />
                <Account session={admin.session} onPreview={onPreview} switches={<Switches {...switches} named />} />
              </Suspense>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
