/**
 * The passkey, again (step-up). Every action `policy/access.ts` marks as loosening a control, raising spend, promoting
 * something or overriding a guardrail needs Martin's passkey given in the last five minutes, which the admin service
 * enforces. The console draws a key after such an action's label while the passkey is not fresh; pressing it opens
 * "Your passkey, again", with the action's name as its title, what will happen in a ruled box, and why it asks. Once
 * given, the header shows a pill, "Passkey given · 5min", counting down (in the account menu on a phone), the keys
 * disappear, and those actions act at once until it runs out.
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
  useMemo,
  useRef,
  useState,
} from 'react';
import { FRESH_MINUTES } from '../access.ts';
import type { Session } from '../admin.ts';
import { Glyph } from './Glyph.tsx';

/**
 * The dialog and its ceremony, which only Martin uses: the session check fetches them before the page draws him signed
 * in (`useAdmin`), so the dialog opens at once when an action asks.
 */
const StepUpDialog = lazy(() => import('./StepUpDialog.tsx').then((module) => ({ default: module.StepUpDialog })));
const ceremony = async (token: string, live: () => boolean) =>
  (await import('./StepUpDialog.tsx')).ceremony(token, live);

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
  /** Asks for the passkey, for this action: true once given, false if Martin cancels. */
  ask(asked: Asked): Promise<boolean>;
  /**
   * The passkey sheet itself, for a dialog that says already that it asks (Start the line's "Use your passkey and
   * start"): nothing once given, or why not, in words. It opens no sheet once `live` says the dialog has gone.
   */
  prove(live: () => boolean): Promise<string | undefined>;
}

const NONE: StepUp = {
  fresh: false,
  until: undefined,
  ask: async () => false,
  prove: async (_live: () => boolean) => 'Sign in first.',
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
  // Fresh from the session's own step-up, as the service said, or from one given on this page since.
  const steppedUpAt = session?.steppedUp && session.steppedUpAt ? Date.parse(session.steppedUpAt) : undefined;
  const until = Math.max(given ?? 0, steppedUpAt ?? 0) + FRESH_MINUTES * 60_000;
  // The time the provider last looked: when the passkey was given, and when it runs out. Only the pill counts down in
  // between, so nothing that asks for a step-up is drawn again while it does.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= until) return;
    const timer = setTimeout(() => setNow(Date.now()), until - now);
    return () => clearTimeout(timer);
  }, [until, now]);
  const [asking, setAsking] = useState<{ id: number; asked: Asked; answer: (given: boolean) => void } | undefined>(
    undefined,
  );
  const asks = useRef(0);
  const hasSession = session !== undefined;
  const ask = useCallback(
    (asked: Asked) =>
      new Promise<boolean>((resolve) => {
        if (!hasSession) return resolve(false);
        asks.current += 1;
        const id = asks.current;
        // One dialog at a time: an action that asks while another is asking takes its place, and the other's answer is
        // no, so nothing waits for an answer that never comes.
        setAsking((before) => {
          before?.answer(false);
          return { id, asked, answer: resolve };
        });
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
  const value = useMemo(() => ({ fresh, until: fresh ? until : undefined, ask, prove }), [fresh, until, ask, prove]);
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
  useEffect(() => {
    if (until === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

/** The header's pill while the passkey is fresh: "Passkey given · 5min", counting down. Nothing otherwise. */
export function StepUpPill() {
  const { until } = useStepUp();
  const now = useNow(until);
  if (until === undefined) return null;
  return (
    <span className="pill fresh" role="status">
      <Glyph name="key" className="glyph key" />
      <span className="long">Passkey given · </span>
      {left(until, now)}
      <span className="sr"> left</span>
    </span>
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
