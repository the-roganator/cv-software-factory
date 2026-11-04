/**
 * The passkey, again (step-up). Every action `policy/access.ts` marks as loosening a control, raising spend, promoting
 * something or overriding a guardrail needs Martin's passkey given in the last five minutes, which the admin service
 * enforces. The console draws a key after such an action's label while the passkey is not fresh; pressing it opens
 * "Your passkey, again", with the action's name as its title, what will happen in a ruled box, and why it asks. Once
 * given, the header shows a pill, "Passkey given · 5min", counting down (in the account menu on a phone), the keys
 * disappear, and those actions act at once until it runs out. Pressing the pill ends it there and then: the service
 * forgets it, and the next action that asks asks again.
 *
 * The page's own count is a convenience: the service decides. A write it refuses for want of the passkey asks for it
 * here and is sent again (`write` in `admin.ts`), however fresh the page thought it was.
 */
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FRESH_MINUTES } from '../access.ts';
import { MARTINS_PARTS, post, type Session, said } from '../admin.ts';
import { Glyph } from './Glyph.tsx';

/**
 * The dialog and its ceremony, which only Martin uses: the session check fetches them before the page draws him signed
 * in (`useAdmin`), so the dialog opens at once when an action asks.
 */
const StepUpDialog = lazy(() => MARTINS_PARTS.stepUp().then((module) => ({ default: module.StepUpDialog })));

/** What an action that asks is told when the dialog's code cannot be fetched, so it never waits on it for ever. */
export const UNFETCHED = 'The passkey’s code could not be fetched: reload the page and try again.';

/** The ceremony, or why not in words if its code cannot be fetched. */
const ceremony = async (token: string, live: () => boolean) => {
  let code: Awaited<ReturnType<typeof MARTINS_PARTS.stepUp>>;
  try {
    code = await MARTINS_PARTS.stepUp();
  } catch {
    return UNFETCHED;
  }
  return code.ceremony(token, live);
};

/** What the step-up dialog says of an action: its name, what will happen, and why it asks ("Promoting ships to everyone"). */
export interface Asked {
  title: string;
  what: ReactNode;
  why: string;
}

export interface StepUp {
  /** Whether the passkey was given in the last five minutes, as far as the page knows. */
  fresh: boolean;
  /** Until when, if it is: the pill counts down to it on a clock of its own. */
  until: number | undefined;
  /**
   * Asks for the passkey, for this action: true once given, false if Martin cancels, or why it could not ask, in words
   * (the dialog's code could not be fetched).
   */
  ask(asked: Asked): Promise<boolean | string>;
  /**
   * The passkey sheet itself, for a dialog that says already that it asks (Start the line's "Use your passkey and
   * start"): nothing once given, or why not, in words. It opens no sheet once `live` says the dialog has gone.
   */
  prove(live: () => boolean): Promise<string | undefined>;
  /**
   * Ends the passkey's five minutes now, on the service and on the page: whether the service ended them (false when
   * they had run out there already, or were ended from another tab), or why not, in words.
   */
  end(): Promise<{ ended: boolean } | string>;
}

const NONE: StepUp = {
  fresh: false,
  until: undefined,
  ask: async () => false,
  prove: async (_live: () => boolean) => 'Sign in first.',
  end: async () => 'Sign in first.',
};
const StepUpContext = createContext<StepUp>(NONE);

/** The passkey's freshness, and the way to ask for it, anywhere under Martin's console. */
export const useStepUp = () => useContext(StepUpContext);

/**
 * Holds the passkey's freshness for Martin's session, and draws the step-up dialog when an action asks for it. With no
 * session (a visitor, the replay site) it holds nothing and asks nothing: it is always there, so the page under it is
 * never made again when the session check answers.
 */
export function StepUpProvider({ session, children }: { session: Session | undefined; children: ReactNode }) {
  const [given, setGiven] = useState<number | undefined>(undefined);
  // Whether Martin ended it on this page: the session's own step-up, as the service said when the page opened, no
  // longer counts, and only one given since does.
  const [ended, setEnded] = useState(false);
  // Fresh from the session's own step-up, as the service said, or from one given on this page since.
  const steppedUpAt = !ended && session?.steppedUp && session.steppedUpAt ? Date.parse(session.steppedUpAt) : undefined;
  const until = Math.max(given ?? 0, steppedUpAt ?? 0) + FRESH_MINUTES * 60_000;
  // The time the provider last looked: when the passkey was given, and when it runs out. Only the pill counts down in
  // between, so nothing that asks for a step-up is drawn again while it does.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= until) return;
    // From the clock, not from `now`: the session's own step-up moves `until` while `now` is still when it last looked.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until, now]);
  const [asking, setAsking] = useState<
    { id: number; asked: Asked; answer: (given: boolean | string) => void } | undefined
  >(undefined);
  const asks = useRef(0);
  const hasSession = session !== undefined;
  const ask = useCallback(
    (asked: Asked) =>
      new Promise<boolean | string>((resolve) => {
        if (!hasSession) return resolve(false);
        asks.current += 1;
        const id = asks.current;
        // The dialog's code before the dialog: the session check fetched it already, unless that failed, and if it
        // cannot be fetched now either the action is told why, in words, rather than left waiting for a dialog that
        // never draws.
        MARTINS_PARTS.stepUp().then(
          () =>
            // One dialog at a time: an action that asks while another is asking takes its place, and the other's
            // answer is no, so nothing waits for an answer that never comes.
            setAsking((before) => {
              before?.answer(false);
              return { id, asked, answer: resolve };
            }),
          () => resolve(UNFETCHED),
        );
      }),
    [hasSession],
  );
  const token = session?.token;
  const prove = useCallback(
    async (live: () => boolean) => {
      if (!token) return 'Sign in first.';
      const refusal = await ceremony(token, live);
      if (refusal === undefined) {
        setGiven(Date.now());
        setNow(Date.now());
      }
      return refusal;
    },
    [token],
  );
  const end = useCallback(async () => {
    if (!token) return 'Sign in first.';
    const got = await post('/admin/step-up/end', {}, token);
    if (got.status !== 200) return said(got);
    // Ended now, or not fresh on the service already: either way the page's count is stale, and stops.
    setEnded(true);
    setGiven(undefined);
    setNow(Date.now());
    return { ended: got.body?.ended === true };
  }, [token]);
  /** An answer to one ask: it settles that ask alone, though a passkey given late still counts as given. */
  const answered = (id: number, yes: boolean) => {
    if (yes) {
      setGiven(Date.now());
      setNow(Date.now());
    }
    setAsking((current) => {
      if (current?.id !== id) return current;
      current.answer(yes);
      return undefined;
    });
  };
  const fresh = now < until;
  const value = useMemo(
    () => ({ fresh, until: fresh ? until : undefined, ask, prove, end }),
    [fresh, until, ask, prove, end],
  );
  return (
    <StepUpContext.Provider value={value}>
      {children}
      {asking && session && (
        <Suspense fallback={null}>
          <StepUpDialog
            key={asking.id}
            asked={asking.asked}
            token={session.token}
            onAnswer={(yes) => answered(asking.id, yes)}
          />
        </Suspense>
      )}
    </StepUpContext.Provider>
  );
}

/** The key after an action's label, while the passkey is not fresh: a screen reader hears that it asks for it. */
export function Key() {
  return (
    <>
      <Glyph name="key" className="glyph key" />
      <span className="sr"> (asks for your passkey)</span>
    </>
  );
}

/** Whole minutes left, never nought while any is: "5min". */
const left = (until: number, now: number) => `${Math.max(1, Math.ceil((until - now) / 60_000))}min`;

/**
 * The time, for a countdown to `until`: it counts in whole minutes, so a look every few seconds is enough, and none
 * once it has run out. Each countdown keeps its own, so its ticks draw it alone.
 */
function useNow(until: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  // Before the browser paints, so a countdown that starts or moves is never drawn from the time it last looked.
  useLayoutEffect(() => {
    if (until === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

/** What pressing the pill does, as its tooltip says it. */
export const END_NOW = 'End it now: the next action that asks for your passkey will ask again';

/**
 * The header's pill while the passkey is fresh: "Passkey given · 5min", counting down, and a button that ends it now,
 * its cross saying so. Nothing otherwise. A screen reader hears the count and what pressing it does from the button,
 * and from a status beside it that the passkey was given, or ended, or why it could not be.
 */
export function StepUpPill() {
  const { until, end } = useStepUp();
  const now = useNow(until);
  const [busy, setBusy] = useState(false);
  // What the last press came to, for the five minutes it was pressed in: ended, found already over, or refused.
  const [outcome, setOutcome] = useState<{ for: number | undefined; ended?: boolean; refusal?: string }>({
    for: undefined,
  });
  // A passkey given again after the press starts afresh: the status says how it ended only until then.
  useEffect(() => {
    if (until !== undefined && until !== outcome.for) setOutcome({ for: undefined });
  }, [until, outcome.for]);
  const press = async () => {
    setBusy(true);
    const pressed = until;
    const answer = await end();
    setBusy(false);
    setOutcome(typeof answer === 'string' ? { for: pressed, refusal: answer } : { for: pressed, ended: answer.ended });
    // Gone, the pill takes the focus with it: focus goes to the account button beside it, as Back to admin's does.
    if (typeof answer !== 'string') {
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.account-btn')?.focus());
    }
  };
  const refusal = outcome.for === until ? outcome.refusal : undefined;
  const over = outcome.for !== undefined && until === undefined && outcome.refusal === undefined;
  const status =
    until !== undefined
      ? (refusal ?? 'Passkey given')
      : over
        ? outcome.ended
          ? 'Passkey ended: the actions that ask for it will ask again'
          : 'Your passkey had run out already: the actions that ask for it will ask again'
        : '';
  return (
    <>
      {/* Only while there is something to say, as the pill was: an empty status would be a second one on the page
          while it leaves for a door, which says why in a status of its own. */}
      {status && (
        <span className="sr" role="status">
          {status}
        </span>
      )}
      {until !== undefined && (
        <button
          type="button"
          className="pill fresh"
          title={refusal ?? END_NOW}
          disabled={busy}
          onClick={() => void press()}
        >
          <Glyph name="key" className="glyph key" />
          <span className="long">Passkey given · </span>
          {left(until, now)}
          <span className="sr"> left. End it now</span>
          <Glyph name="cross" className="glyph end" />
        </button>
      )}
    </>
  );
}

/** The same, as a line in the account menu, where a phone shows it. */
export function StepUpLine() {
  const { until } = useStepUp();
  const now = useNow(until);
  if (until === undefined) return null;
  return (
    <>
      <br />
      Passkey given again: {left(until, now)} left
    </>
  );
}
