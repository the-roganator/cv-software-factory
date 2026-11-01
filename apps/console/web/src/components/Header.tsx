import { useEffect, useId, useRef, useState } from 'react';
import { LINE_STEP_UP } from '../access.ts';
import type { Admin } from '../admin.ts';
import { AUTONOMY, duration } from '../format.ts';
import type { Header as LineState, Score } from '../projection/index.ts';
import type { Theme } from '../settings.ts';
import type { Connection } from '../source.ts';
import { Account } from './Account.tsx';
import { Dialog } from './Dialog.tsx';
import { Glyph } from './Glyph.tsx';
import { Mark } from './Mark.tsx';
import { Key, StepUpPill, useStepUp } from './StepUp.tsx';
import { ReasonField, Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

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
      {sample && <span className="pill-sample">Sample</span>}
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

/**
 * Stop the line, in `attn`, always one press away; while it is stopped, Start the line in its place, in `signal`, with
 * the key while the passkey is not fresh. Each opens its dialog, which asks for a reason, for the audit log.
 */
function LineButton({ line, token }: { line: LineState; token: string }) {
  const stopped = line.stopped !== undefined;
  const stepUp = useStepUp();
  const [open, setOpen] = useState<'stop' | 'start' | undefined>(undefined);
  return (
    <>
      <button
        type="button"
        className={`btn line-btn ${stopped ? 'primary' : 'attn'}`}
        onClick={() => setOpen(stopped ? 'start' : 'stop')}
      >
        {stopped ? (
          <>
            Start<span className="line-word"> the line</span>
            {LINE_STEP_UP['line.start'] && !stepUp.fresh && <Key />}
          </>
        ) : (
          <>
            <Glyph name="cord" />
            Stop<span className="line-word"> the line</span>
          </>
        )}
      </button>
      {open && <LineDialog kind={open} stopped={stopped} token={token} onClose={() => setOpen(undefined)} />}
    </>
  );
}

/**
 * Stopping or starting the line, with Martin's reason. Stopping never asks for the passkey; starting does, and its
 * button runs the passkey sheet itself ("Use your passkey and start") when the service asks for it. What the service
 * says shows here, where he pressed: a refusal, or, once the line has stopped, that a canary in flight was not aborted.
 */
function LineDialog({
  kind,
  stopped,
  token,
  onClose,
}: {
  kind: 'stop' | 'start';
  /** Whether the line is stopped now, as the events say. */
  stopped: boolean;
  token: string;
  onClose: () => void;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const writes = useWrite(token);
  const { busy, fresh } = writes;
  // Stopped, with a canary in flight it could not abort: what the service warned of is said, and only Close is left.
  const [done, setDone] = useState(false);
  const stop = kind === 'stop';
  const asks = LINE_STEP_UP[`line.${kind}`];
  // Stopped or started from elsewhere while it was open (`make stop-the-line`, another tab): it would do nothing now.
  // Not while it acts, or once it has something to say, which the line's own change brings.
  const moot = stop === stopped && !busy && writes.refusal === undefined;
  useEffect(() => {
    if (moot) onClose();
  }, [moot, onClose]);

  const act = async () => {
    const why = reason.trim();
    if (!why) return field.current?.focus();
    await writes.send(
      `/admin/line/${kind}`,
      { reason: why },
      {
        passkey: asks ? 'prove' : undefined,
        done: (got) => {
          // Stopped, with a canary in flight it could not abort: Martin must know, and that `make stop-the-line` will.
          if (typeof got.body?.warning === 'string') {
            setDone(true);
            return got.body.warning;
          }
          onClose();
          return undefined;
        },
      },
    );
  };

  const label = stop ? 'Stop the line' : asks && !fresh ? 'Use your passkey and start' : 'Start the line';
  return (
    <Dialog
      title={stop ? 'Stop the line' : 'Start the line'}
      onClose={onClose}
      actions={
        done ? undefined : (
          <button
            type="button"
            className={`btn ${stop ? 'attn' : 'primary'}`}
            disabled={!reason.trim()}
            aria-disabled={busy || undefined}
            onClick={() => void act()}
          >
            {label}
            {asks && !fresh && <Glyph name="key" className="glyph key" />}
          </button>
        )
      }
    >
      {stop ? (
        <p>
          Every agent stops at the end of its step, nothing new is taken, and a canary in flight is aborted: the version
          before takes all the traffic. <code>make stop-the-line</code> does the same when the console can’t.
        </p>
      ) : (
        <p>
          Agents take work again, as What the line takes says. A release stopped with the line stays stopped until you
          retry it.
        </p>
      )}
      {!done && (
        <div className="reason">
          <ReasonField
            id={`${id}-reason`}
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            placeholder="Why, for the audit log"
            help="Visitors see your reason, with anything shaped like a secret left out."
            field={field}
          />
        </div>
      )}
      {asks && !fresh && !done && <p className="help">Starting the line asks for your passkey again.</p>}
      <Refusal text={writes.refusal} />
    </Dialog>
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
          <span className="rule" aria-hidden="true" />
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
          {admin.kind === 'martin' && previewing && <span className="pill-visitor">VISITOR VIEW</span>}
          {admin.kind === 'martin' && !previewing && (
            <>
              <StepUpPill />
              <LineButton line={line} token={admin.session.token} />
              <Account session={admin.session} onPreview={onPreview} switches={<Switches {...switches} named />} />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
