/**
 * The doors: signing in, and enrolling a passkey, each a page of its own (`?view=sign-in`, `?view=enrol`) with a single
 * card in the middle and nothing of the console behind it. Their code, and the passkey ceremonies', arrive only when a
 * door is opened.
 *
 * Each ceremony asks the admin service for its options, has the browser's own passkey sheet answer them, and sends the
 * answer back; the service checks it and sets the session's cookie, which this code never sees.
 */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { SESSION_MINUTES } from '../access.ts';
import { type Answer, type Door, doorHref, type Ended, post, said } from '../admin.ts';
import { clock } from '../format.ts';
import { Glyph } from './Glyph.tsx';
import { Mark } from './Mark.tsx';

export function Doors({ door }: { door: Door }) {
  // The page's title says which door, and the card's heading takes focus, so a screen reader starts there.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${door === 'enrol' ? 'Enrol a passkey' : 'Sign in'} · Software Factory`;
    heading.current?.focus();
  }, [door]);
  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="brand" href="/" aria-label="Software Factory: Martin Rogan, a live CV, home">
            <Mark />
            <span className="brand-rule" aria-hidden="true" />
            <span>
              <b>Software Factory</b> <small>Martin Rogan · a live CV</small>
            </span>
          </a>
          <div className="top-right">
            <a className="btn" href="/">
              Back to the console
            </a>
          </div>
        </div>
      </header>
      <main id="top">
        <div className="wrap">{door === 'enrol' ? <Enrol heading={heading} /> : <SignIn heading={heading} />}</div>
      </main>
    </>
  );
}

type Heading = { heading: RefObject<HTMLHeadingElement | null> };

/** A box above a door's button: a refusal in `attn`, a fact in `line-strong`, or something done in `ok`. */
function Note({ tone, children }: { tone: 'refusal' | 'fact' | 'done'; children: ReactNode }) {
  return (
    <div className={`door-note ${tone}`} role={tone === 'refusal' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** The name of the error the browser's passkey sheet ended with: `NotAllowedError` when it was closed or found none. */
const failure = (error: unknown) => (error instanceof Error ? error.name : '');

const ENDED: Record<Ended, (at: number) => string> = {
  here: () => 'Signed out. This browser holds no session now.',
  everywhere: () => 'Signed out everywhere: every session on every device has ended, this one too.',
  expired: (at) =>
    `Your session ended${Number.isNaN(at) ? '' : ` at ${clock(at)}`}. A session lasts ${SESSION_MINUTES} minutes from signing in, however busy.`,
};

type SignInNote = { kind: 'ended'; ended: Ended; at: number } | { kind: 'none' } | { kind: 'refused'; text: string };

function SignIn({ heading }: Heading) {
  const [note, setNote] = useState<SignInNote | undefined>(() => {
    const params = new URLSearchParams(location.search);
    const ended = params.get('ended');
    return ended === 'here' || ended === 'everywhere' || ended === 'expired'
      ? { kind: 'ended', ended, at: Date.parse(params.get('at') ?? '') }
      : undefined;
  });
  const [busy, setBusy] = useState(false);

  const refuse = (text: string) => {
    setNote({ kind: 'refused', text });
    setBusy(false);
  };

  const signIn = async () => {
    setBusy(true);
    setNote(undefined);
    const options = await post('/admin/sign-in/options');
    if (options.status !== 200 || !options.body) return refuse(said(options));
    let response: Awaited<ReturnType<typeof startAuthentication>>;
    try {
      response = await startAuthentication({ optionsJSON: options.body as never });
    } catch (error) {
      // The sheet was closed, or this device holds no passkey for the factory: the browser does not say which.
      if (failure(error) === 'NotAllowedError') {
        setNote({ kind: 'none' });
        setBusy(false);
        return;
      }
      return refuse(error instanceof Error ? error.message : 'The browser could not use a passkey here.');
    }
    const got = await post('/admin/sign-in', { response });
    if (got.status === 200) return location.assign('/');
    refuse(said(got));
  };

  return (
    <div className="door raised">
      <span className="label">Admin</span>
      <h1 ref={heading} tabIndex={-1}>
        Sign in
      </h1>
      <p>Sign in with the passkey on this device to answer holds, change settings and run the line.</p>
      {note?.kind === 'ended' && <Note tone="fact">{ENDED[note.ended](note.at)}</Note>}
      {note?.kind === 'none' && (
        <Note tone="refusal">
          No passkey was used.
          <small>
            Either the passkey sheet was closed, or this device has no passkey for the factory. Each device is enrolled
            once, from the command line: <code>factory admin enrol</code> prints a one-time code for the{' '}
            <a href={doorHref('enrol')}>enrolment page</a>.
          </small>
        </Note>
      )}
      {note?.kind === 'refused' && <Note tone="refusal">{note.text}</Note>}
      <button type="button" className="btn primary" disabled={busy} onClick={() => void signIn()}>
        <Glyph name="key" />
        Sign in with a passkey
      </button>
      <p className="aside">
        Visiting? Everything Martin can change is on the console already, read-only. <a href="/">Back to the console</a>
      </p>
    </div>
  );
}

/** A name for this device's passkey, from what the browser says it is, for Martin to keep or change. */
function deviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad/.test(agent)) return 'iPad';
  if (/Android/.test(agent)) return 'Android';
  if (/Macintosh/.test(agent)) return 'Mac';
  if (/Windows/.test(agent)) return 'Windows';
  return '';
}

/** The code's state: being entered, wrong with tries left, or no longer usable. */
type CodeNote = { kind: 'wrong'; left: number } | { kind: 'spent' } | { kind: 'refused'; text: string };

function Enrol({ heading }: Heading) {
  const [step, setStep] = useState<2 | 3 | 4>(2);
  const [code, setCode] = useState('');
  const [name, setName] = useState(deviceName);
  const [options, setOptions] = useState<Record<string, unknown> | undefined>(undefined);
  const [note, setNote] = useState<CodeNote | undefined>(undefined);
  const [passkeyNote, setPasskeyNote] = useState<ReactNode>(undefined);
  const [busy, setBusy] = useState(false);

  const codeRefused = (got: Answer): CodeNote =>
    got.status === 403 && got.body?.refused === 'code' && typeof got.body.left === 'number'
      ? got.body.left > 0
        ? { kind: 'wrong', left: got.body.left }
        : { kind: 'spent' }
      : { kind: 'refused', text: said(got) };

  const check = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNote(undefined);
    const got = await post('/admin/enrol/options', { code });
    setBusy(false);
    if (got.status !== 200 || !got.body) return setNote(codeRefused(got));
    setOptions(got.body);
    setStep(3);
  };

  const make = async (event: FormEvent) => {
    event.preventDefault();
    if (!options) return;
    setBusy(true);
    setPasskeyNote(undefined);
    let response: Awaited<ReturnType<typeof startRegistration>>;
    try {
      response = await startRegistration({ optionsJSON: options as never });
    } catch (error) {
      setBusy(false);
      const why = failure(error);
      return setPasskeyNote(
        why === 'InvalidStateError' ? (
          <>
            This device already holds a passkey for the factory.
            <small>
              <a href={doorHref('sign-in')}>Sign in with it</a>.
            </small>
          </>
        ) : why === 'NotAllowedError' ? (
          <>
            No passkey was made.
            <small>The browser’s sheet was closed, or ran out of time. Try again.</small>
          </>
        ) : (
          (error as Error).message
        ),
      );
    }
    const got = await post('/admin/enrol', { response, name: name.trim() });
    setBusy(false);
    if (got.status === 200) return setStep(4);
    // Refused, the ceremony is spent whatever the reason (the service spends a challenge before it checks the answer),
    // so it starts again from the code, saying why.
    setOptions(undefined);
    setStep(2);
    setNote({ kind: 'refused', text: said(got) });
  };

  const item = (n: number, children: ReactNode) => (
    <li className={n < step ? 'past' : n === step ? 'now' : undefined}>
      <span>{children}</span>
      {n < step && <span className="sr"> (done)</span>}
    </li>
  );

  return (
    <div className="door raised">
      <span className="label">Admin · enrolment</span>
      <h1 ref={heading} tabIndex={-1}>
        Enrol a passkey
      </h1>
      <p>
        Do this once on each device you sign in from. A passkey is added only with a one-time code from the command
        line, never from a signed-in session.
      </p>
      <ol className="steps-list">
        {item(
          1,
          <>
            On the command line, run <code>factory admin enrol</code>. It prints a code that lasts ten minutes and
            allows five tries.
          </>,
        )}
        {item(2, 'Enter the code here.')}
        {item(3, 'Make a passkey on this device.')}
      </ol>
      {step === 2 && (
        <form className="door-form" onSubmit={(event) => void check(event)}>
          {note?.kind === 'wrong' && (
            <Note tone="refusal">
              That code isn’t right.
              <small>{note.left === 1 ? '1 try' : `${note.left} tries`} left for it, across every browser.</small>
            </Note>
          )}
          {note?.kind === 'spent' && (
            <Note tone="refusal">
              That code can’t be used any more.
              <small>
                It has expired, been used, or had its five tries. Run <code>factory admin enrol</code> again for a new
                one.
              </small>
            </Note>
          )}
          {note?.kind === 'refused' && <Note tone="refusal">{note.text}</Note>}
          <label className="label" htmlFor="code">
            One-time code
          </label>
          <input
            className="field code"
            id="code"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellcheck={false}
            placeholder="XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            maxLength={64}
            required
            value={code}
            disabled={note?.kind === 'spent'}
            onInput={(event) => setCode(event.currentTarget.value)}
          />
          <button type="submit" className="btn primary" disabled={busy || note?.kind === 'spent' || !code.trim()}>
            Check the code
          </button>
        </form>
      )}
      {step === 3 && (
        <form className="door-form" onSubmit={(event) => void make(event)}>
          {passkeyNote && <Note tone="refusal">{passkeyNote}</Note>}
          <label className="label" htmlFor="passkey-name">
            Name this passkey
          </label>
          <input
            className="field"
            id="passkey-name"
            maxLength={40}
            required
            placeholder="iPhone"
            value={name}
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            <Glyph name="key" />
            Make a passkey
          </button>
          <p className="help">
            Your browser or phone asks where to keep it. The name is for the settings, where you can revoke it.
          </p>
        </form>
      )}
      {step === 4 && (
        <>
          <Note tone="done">Passkey made, and you are signed in on this device. Sign in with it from now on.</Note>
          <a className="btn primary" href="/">
            Go to the console
          </a>
        </>
      )}
      <p className="aside">
        Lost a device? <code>factory admin enrol --revoke-others</code> revokes every other passkey and ends every
        session.
      </p>
    </div>
  );
}
