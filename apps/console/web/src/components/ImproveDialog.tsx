/**
 * The "+" on Plan: Martin asks for an improvement in his own words, one field, and the line takes it from there. Its
 * code arrives when the dialog first opens.
 *
 * For Martin it is a form: his words (600 characters, counted), the title they will give the work item until the
 * planner names it (`requestTitle`, the admin service's own rule), what happens to it, and **Request**, with the key
 * while his passkey is not fresh. Requesting is one write, `POST /admin/improvements` with his words and an id made
 * for them, so the same words sent again (a press after a lost answer) open nothing more, and the service's word that
 * they were made already closes the dialog as a success would; when the service asks for the passkey, the browser's
 * own sheet opens from the same button, as a flag's widening does, and the request is sent again.
 *
 * For everyone else it is the same dialog, read-only, titled How Martin asks: his latest request, disabled, with when
 * he asked, and only Close.
 */
import { REQUEST_WORDS, requestTitle } from '@software-factory/events';
import { useId, useState } from 'react';
import { IMPROVEMENT_STEP_UP } from '../access.ts';
import type { Admin } from '../admin.ts';
import { when } from '../format.ts';
import type { ImproveView } from '../projection/index.ts';
import { Dialog } from './Dialog.tsx';
import { Glyph } from './Glyph.tsx';
import { Key } from './StepUp.tsx';
import { ReasonField, Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

const KICKER = (
  <>
    <Glyph name="improvement" />
    <span className="label">An improvement</span>
  </>
);

/** What happens to a request, in three facts: for Martin, or about him. */
function Facts({ improve, martin }: { improve: ImproveView; martin: boolean }) {
  const tickets = improve.tickets === 1 ? 'one now' : `${improve.tickets} now`;
  return (
    <ul className="dialog-what plain">
      <li>
        It waits behind every open ticket, {tickets}, oldest first.{' '}
        {martin ? 'To take it at once, choose Just one in Controls.' : 'Martin can take it at once with Just one.'}
      </li>
      <li>
        It ships behind a flag of its own, off, and {martin ? 'you widen' : 'he widens'} it a stage at a time from
        Controls.
      </li>
      <li>
        {martin
          ? 'Visitors see your words, with anything shaped like a secret left out.'
          : 'A suggestion you send from the app reaches Martin, and never starts work by itself.'}
      </li>
    </ul>
  );
}

export function ImproveDialog({
  admin,
  improve,
  onClose,
}: {
  admin: Admin;
  improve: ImproveView;
  onClose: () => void;
}) {
  return admin.kind === 'martin' ? (
    <MartinsForm token={admin.session.token} improve={improve} onClose={onClose} />
  ) : (
    <HowMartinAsks improve={improve} onClose={onClose} />
  );
}

function MartinsForm({ token, improve, onClose }: { token: string; improve: ImproveView; onClose: () => void }) {
  const id = useId();
  // One id for these words, however many times they are sent: the service opens one work item for them, and refuses
  // the id again (409) once it has. Words changed are another request, with an id of their own.
  const [request, setRequest] = useState(() => crypto.randomUUID());
  const [words, setWords] = useState('');
  const writes = useWrite(token);
  const asked = words.trim();
  const keyed = IMPROVEMENT_STEP_UP['improvement.request'] && !writes.fresh;

  const send = async () => {
    if (!asked) return;
    await writes.send(
      '/admin/improvements',
      { id: request, words: asked },
      {
        passkey: 'prove',
        // Made already: the answer to an earlier press was lost, and these words opened their work item then.
        accept: (got) => got.status === 200 || (got.status === 409 && got.body?.refused === 'request'),
        // Asked: its row at Plan and its card on the reel arrive with its events. Nothing else announces it.
        done: () => {
          onClose();
          return undefined;
        },
      },
    );
  };

  return (
    <Dialog
      title="Request an improvement"
      kicker={KICKER}
      onClose={onClose}
      actions={
        <button
          type="button"
          className="btn primary"
          disabled={!asked}
          aria-disabled={writes.busy || undefined}
          onClick={() => void send()}
        >
          Request
          {keyed && <Key />}
        </button>
      }
    >
      <p>
        Say what should change, in your own words. The planner turns it into a spec, which waits for you before any code
        is written.
      </p>
      <div className="reason">
        <ReasonField
          id={`${id}-words`}
          label="What you want"
          limit={REQUEST_WORDS}
          rows={4}
          required
          value={words}
          onChange={(value) => {
            setWords(value);
            setRequest(crypto.randomUUID());
          }}
          placeholder="What should change, for whom, and why"
          help={
            asked ? (
              <>Titled “{requestTitle(asked)}” until the planner names it in the spec.</>
            ) : (
              'Its first sentence titles it until the planner names it in the spec.'
            )
          }
          helpId={`${id}-title`}
        />
      </div>
      <Facts improve={improve} martin />
      <p className="help">
        {keyed
          ? 'Requesting widens what the line does, so it asks for your passkey again, and tells your phone.'
          : 'Requesting widens what the line does, so it tells your phone.'}
      </p>
      <Refusal text={writes.refusal} />
    </Dialog>
  );
}

function HowMartinAsks({ improve, onClose }: { improve: ImproveView; onClose: () => void }) {
  const id = useId();
  const { latest } = improve;
  return (
    <Dialog title="How Martin asks" kicker={KICKER} onClose={onClose}>
      <p>
        Martin asks here, in his own words. The planner turns it into a spec, which waits for him before any code is
        written.
      </p>
      <div className="reason">
        <label className="label" htmlFor={`${id}-words`}>
          What he wants
        </label>
        <textarea id={`${id}-words`} className="field" rows={4} disabled value={latest?.words ?? ''} />
        <span className="help">
          {latest ? `His latest request, ${when(latest.at)}, #${latest.workItem}.` : 'He has asked for none yet.'}
        </span>
      </div>
      <Facts improve={improve} martin={false} />
      <div className="answers">
        <div className="answer">
          <span className="ro">
            Request
            <Glyph name="key" className="glyph key" />
          </span>
          <p>Martin requests it signed in, with his passkey again: it widens what the line does.</p>
        </div>
      </div>
    </Dialog>
  );
}
