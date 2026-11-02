/**
 * Stop the line, and start it again: the header's button and its dialog. Only Martin has them, so they load once the
 * session says he is signed in (`admin.ts`), never on a visitor's first view.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { LINE_STEP_UP } from '../access.ts';
import type { Header as LineState } from '../projection/index.ts';
import { Dialog } from './Dialog.tsx';
import { Glyph } from './Glyph.tsx';
import { Key, useStepUp } from './StepUp.tsx';
import { ReasonField, Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

/**
 * Stop the line, in `attn`, always one press away; while it is stopped, Start the line in its place, in `signal`, with
 * the key while the passkey is not fresh. Each opens its dialog, which asks for a reason, for the audit log.
 */
export function LineButton({ line, token }: { line: LineState; token: string }) {
  const stopped = line.stopped !== undefined;
  const stepUp = useStepUp();
  const [open, setOpen] = useState<'stop' | 'start' | undefined>(undefined);
  return (
    <>
      <button
        type="button"
        className={`btn small line-btn ${stopped ? 'primary' : 'attn'}`}
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
