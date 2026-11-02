/**
 * The slider's confirmation (`Flags.tsx`), from a stop, a drag or a flag's card, in Controls, Needs you or a work
 * item's sheet. Only Martin opens one, so its code arrives when he first does.
 */

import { SHARES } from '@software-factory/policy/flags';
import { useId, useRef, useState } from 'react';
import { FLAG_STEP_UP } from '../access.ts';
import { type Answer, said } from '../admin.ts';
import {
  type FlagRow,
  type FlagStage,
  type Move,
  moveTo,
  type Share,
  STAGE_NAME,
  stageAt,
  stageSays,
} from '../projection/index.ts';
import { Dialog } from './Dialog.tsx';
import { stageWords } from './Flags.tsx';
import { Glyph } from './Glyph.tsx';
import { ReasonField, Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

/**
 * What the admin service said when it did not make the move, in its own words, and what that means here: Kubernetes
 * refused or failed the write, and nothing was done (502); or its answer was lost, and whether it was made can't be
 * told (504), so the slider and the line under the flags say, once they know.
 */
function refusalWords(got: Answer): string {
  const words = said(got);
  if (got.body?.refused !== 'kubernetes') return words;
  if (got.status === 502) return `${words} The flag stands where it was: try again in a moment.`;
  if (got.status === 504)
    return `${words} If it was made, the slider moves to it, and the line under the flags says when the app has it.`;
  return words;
}

/** What a move is, in the confirmation's words: its title, and its button. */
function moveWords(row: FlagRow, move: Move): { title: string; button: string } {
  const to = stageWords(move.to);
  if (move.refused) return { title: `${STAGE_NAME[move.to.stage]} can’t be taken now`, button: 'Close' };
  switch (move.action) {
    case 'flag.off':
      return { title: `Turn off ${row.name}`, button: 'Turn off' };
    case 'flag.back-on':
      return { title: `Turn ${row.name} back on`, button: 'Turn back on' };
    case 'flag.narrow':
      return { title: `Narrow ${row.name} to ${to}`, button: 'Narrow' };
    default:
      return { title: `Widen ${row.name} to ${STAGE_NAME[move.to.stage]}`, button: 'Widen' };
  }
}

/**
 * The slider's confirmation, from a stop, a drag or a card in Needs you: the move ("PREVIEW → SHARE") and who gets the
 * flag on there, and its one button; or, for a stop that can't be taken now, why, and only Close. Share asks how big a
 * share; Off asks why. A widening past Checks asks for the passkey again, through the browser's own sheet, when the
 * service asks for it.
 */
export function FlagDialog({
  row,
  to,
  token,
  onClose,
  onMoved,
}: {
  row: FlagRow;
  to: FlagStage;
  token: string;
  onClose: () => void;
  onMoved?: (() => void) | undefined;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [share, setShare] = useState<Share>(to.stage === 'share' ? to.share : 50);
  const [reason, setReason] = useState('');
  const writes = useWrite(token);
  const { busy, fresh } = writes;
  const chosen = stageAt(to.stage, share);
  const move = moveTo(row.moves, chosen) ?? { to: chosen, action: undefined };
  const { title, button } = moveWords(row, move);
  const off = move.action === 'flag.off';
  const keyed = move.action !== undefined && FLAG_STEP_UP[move.action] && !move.refused;
  const skipsPreview = row.stage.stage === 'checks' && to.stage === 'share';

  const act = async () => {
    const why = reason.trim();
    if (off && !why) return field.current?.focus();
    const body = { from: row.stage, to: chosen, ...(off && { reason: why }) };
    const written = await writes.send(`/admin/flags/${encodeURIComponent(row.name)}/stage`, body, {
      passkey: keyed ? 'prove' : undefined,
      words: refusalWords,
      done: () => {
        onMoved?.();
        onClose();
        return undefined;
      },
    });
    // Kubernetes's answer was lost, and the service could not read `flags` back: the move may have been made. The
    // page asks again soon whether the app holds the flags, and the slider moves if its event arrives.
    if (written.kind === 'refused' && written.got.status === 504) onMoved?.();
  };

  return (
    <Dialog
      title={title}
      kicker={
        keyed && !fresh ? (
          <>
            <Glyph name="key" className="glyph key" />
            <span className="label">Your passkey, again</span>
          </>
        ) : undefined
      }
      onClose={onClose}
      actions={
        move.refused || move.action === undefined ? undefined : (
          <button
            type="button"
            className={`btn ${off ? 'attn' : 'primary'}`}
            disabled={off && !reason.trim()}
            aria-disabled={busy || undefined}
            onClick={() => void act()}
          >
            {button}
            {keyed && !fresh && <Glyph name="key" className="glyph key" />}
          </button>
        )
      }
    >
      <div className="what">
        <span className="fromto">
          {row.turnedOff ? 'Off' : stageWords(row.stage)} <span aria-hidden="true">→</span>
          <span className="sr"> to </span> {stageWords(chosen)}
        </span>
        {move.refused ? (
          <p>{move.refused}</p>
        ) : off ? (
          <p>
            Off for everyone within seconds, a preview too, with no deploy and no rollback.{' '}
            {row.open &&
              `#${row.workItem} closes as turned off${row.justOne ? ` once the line takes more than #${row.justOne} alone` : ''}; its code stays in the app, off. `}
            {row.done && `#${row.workItem} stays done. `}
            {row.stage.stage === 'everyone'
              ? 'It can be turned straight back on here, with your passkey.'
              : !row.open && 'Its code stays in the app, off.'}
          </p>
        ) : (
          <p>
            {stageSays(chosen)}
            {skipsPreview && ' Preview is skipped: no probe checks a preview first, and anyone can still ask for one.'}
          </p>
        )}
      </div>
      {!move.refused && to.stage === 'share' && (
        <>
          <span className="label" id={`${id}-share`}>
            Share of the generator’s requests
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset needs a legend, and the choice's label is above it */}
          <div className="seg" role="group" aria-labelledby={`${id}-share`}>
            {SHARES.map((n) => (
              <button key={n} type="button" aria-pressed={n === share} onClick={() => setShare(n)}>
                {n}%
              </button>
            ))}
          </div>
          <p className="help">Half and half fills both sides soonest, so Verify can judge them sooner.</p>
        </>
      )}
      {!move.refused && off && (
        <div className="reason">
          <ReasonField
            id={`${id}-reason`}
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            placeholder="Why, for the audit log and the work item"
            help="Visitors see your reason, with anything shaped like a secret left out."
            field={field}
          />
        </div>
      )}
      {!move.refused && move.action === 'flag.narrow' && (
        <p className="help">Narrowing acts at once, and never asks for the passkey.</p>
      )}
      {!move.refused && off && (
        <p className="help">
          The admin service asks the app for the flags it holds, and tells your phone if it hasn’t taken this within a
          minute.
        </p>
      )}
      {!move.refused && move.action !== undefined && !off && move.action !== 'flag.narrow' && (
        <p className="help">
          The admin service then checks the app has it.
          {keyed && !fresh && ' Widening shows a change to more people, so it asks for your passkey again.'}
        </p>
      )}
      <Refusal text={writes.refusal} />
    </Dialog>
  );
}
