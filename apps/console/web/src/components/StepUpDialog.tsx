/**
 * The step-up dialog, "Your passkey, again", and the ceremony behind it. Only Martin asks for his passkey, so this
 * loads once the session says he is signed in (`admin.ts`), never on a visitor's first view; `StepUp.tsx` holds the
 * freshness and asks.
 */
import { useEffect, useRef, useState } from 'react';
import { post, said } from '../admin.ts';
import { Dialog } from './Dialog.tsx';
import { Glyph } from './Glyph.tsx';
import type { Asked } from './StepUp.tsx';
import { Refusal } from './Words.tsx';

/**
 * The admin service's step-up ceremony: its options, the browser's own passkey sheet for the session's passkey, and
 * the answer sent back. Nothing once the service has taken it, or why not, in words. It stops before the sheet if the
 * page that asked has gone (`live`). The ceremony's code arrives when it is first asked for.
 */
export async function ceremony(token: string, live: () => boolean): Promise<string | undefined> {
  const options = await post('/admin/step-up/options', {}, token);
  if (options.status !== 200 || !options.body) return said(options);
  if (!live()) return 'Closed.';
  let response: Awaited<ReturnType<typeof import('@simplewebauthn/browser').startAuthentication>>;
  try {
    const { startAuthentication } = await import('@simplewebauthn/browser');
    if (!live()) return 'Closed.';
    response = await startAuthentication({ optionsJSON: options.body as never });
  } catch (error) {
    // The sheet was closed, or this device holds no passkey for the factory: the browser does not say which.
    return error instanceof Error && error.name === 'NotAllowedError'
      ? 'No passkey was used: the sheet was closed, or this device has none for the factory.'
      : 'The browser could not use a passkey here.';
  }
  const got = await post('/admin/step-up', { response }, token);
  return got.status === 200 ? undefined : said(got);
}

/** "Your passkey, again": the browser's own passkey sheet, for the session's own passkey, through the ceremony. */
export function StepUpDialog({
  asked,
  token,
  onAnswer,
}: {
  asked: Asked;
  token: string;
  onAnswer: (given: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const give = async () => {
    setBusy(true);
    setRefusal(undefined);
    const refusal = await ceremony(token, () => live.current);
    // Closed while it asked: nothing to say to a dialog that is gone.
    if (!live.current) return;
    if (refusal === undefined) return onAnswer(true);
    setRefusal(refusal);
    setBusy(false);
  };

  return (
    <Dialog
      title={asked.title}
      kicker={
        <>
          <Glyph name="key" className="glyph key" />
          <span className="label">Your passkey, again</span>
        </>
      }
      onClose={() => onAnswer(false)}
      actions={
        <button type="button" className="btn primary" disabled={busy} onClick={() => void give()}>
          Use your passkey
        </button>
      }
    >
      <div className="dialog-what">{asked.what}</div>
      <p>
        {asked.why}, so it needs your passkey again. Once given, it stays fresh for five minutes, for this and anything
        else that asks.
      </p>
      <Refusal text={refusal} />
    </Dialog>
  );
}
