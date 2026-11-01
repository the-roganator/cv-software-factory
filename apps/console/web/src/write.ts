/**
 * Martin's writes, one way: busy while one is under way, his passkey asked for when the admin service asks for it,
 * what came back said where he pressed, and nothing said of a write he cancelled or a dialog he closed. Every component
 * that changes something writes through `useWrite` (`components/Write.tsx`), which keeps this state for it.
 *
 * The passkey is asked for one of two ways, as the component's place says:
 * - in a dialog of its own ("Your passkey, again", `StepUp.tsx`), naming the action, for a press in a panel; cancelled
 *   there, nothing changed and nothing is said;
 * - within the dialog that is open, which says already that it asks ("Use your passkey and start"): the browser's own
 *   sheet opens from its button, and why the passkey was not given is said in that dialog.
 */
import type { Answer } from './admin.ts';
import { said, write } from './admin.ts';
import type { Asked, StepUp } from './components/StepUp.tsx';

/** What the page shows of a write: whether one is under way, and what the admin service refused, or warned of. */
export interface WriteState {
  busy: boolean;
  refusal: string | undefined;
}

export const IDLE: WriteState = { busy: false, refusal: undefined };

export interface WriteOptions {
  /**
   * How the passkey is asked for when the service asks: what its own dialog says of the action, or `prove` within the
   * dialog that is open. With neither, the service's refusal stands.
   */
  passkey?: Asked | 'prove' | undefined;
  /** Whether an answer is the write made: a 200, unless the write says more (words made already, say). */
  accept?: (got: Answer) => boolean;
  /** A refusal in words: the service's own, unless the write says more of what it means. */
  words?: (got: Answer) => string;
  /**
   * What follows the write made, as it is: words to say where a refusal would be (something left undone), or nothing.
   * It runs before the page shows the write ended, so whatever it changes is drawn with it.
   */
  done?: (got: Answer) => string | undefined;
}

/**
 * How a write ended:
 * - `unsent`: one was under way already, or there is no session to write with;
 * - `cancelled`: Martin cancelled at the passkey's own dialog, so nothing changed;
 * - `gone`: what asked has gone (the dialog closed) while it was under way, so nothing more was sent;
 * - `refused`: the service did not make it, and why is said;
 * - `done`: made.
 */
export type Written =
  | { kind: 'unsent' | 'cancelled' | 'gone' }
  | { kind: 'refused'; got: Answer; text: string }
  | { kind: 'done'; got: Answer };

export interface Writer {
  /** One write: a `POST` of `body` to `path`, with the session's token. */
  send(path: string, body: object, options?: WriteOptions): Promise<Written>;
  /** Says something where a refusal shows, or clears it. */
  say(text: string | undefined): void;
}

export interface WriterDeps {
  /** The session's token, as it is now: none for a visitor. */
  token: () => string | undefined;
  /** The passkey's ways, as they are now. */
  stepUp: () => Pick<StepUp, 'ask' | 'prove'>;
  /** Whether what asked is still there. */
  live: () => boolean;
  /** Draws the write's state. */
  show: (state: WriteState) => void;
}

/** The write flow, apart from the page that draws it, so it can be tried on its own. */
export function writer({ token, stepUp, live, show }: WriterDeps): Writer {
  let state = IDLE;
  const set = (next: WriteState) => {
    state = next;
    show(next);
  };
  return {
    say: (refusal) => set({ ...state, refusal }),
    async send(path, body, { passkey, accept = (got: Answer) => got.status === 200, words = said, done } = {}) {
      const session = token();
      if (!session || state.busy) return { kind: 'unsent' };
      set({ busy: true, refusal: undefined });
      let cancelled = false;
      let unproved: string | undefined;
      const again =
        passkey === undefined
          ? undefined
          : passkey === 'prove'
            ? async () => {
                unproved = await stepUp().prove(live);
                return unproved === undefined && live();
              }
            : async () => {
                cancelled = !(await stepUp().ask(passkey));
                return !cancelled;
              };
      const got = await write(path, body, session, again);
      // Gone while it asked: nothing more is sent, and nothing to say.
      if (!live()) {
        state = IDLE;
        return { kind: 'gone' };
      }
      // Cancelled at the passkey: nothing changed, and nothing to say.
      if (cancelled) {
        set(IDLE);
        return { kind: 'cancelled' };
      }
      if (accept(got)) {
        set({ busy: false, refusal: done?.(got) });
        return { kind: 'done', got };
      }
      const text = unproved ?? words(got);
      set({ busy: false, refusal: text });
      return { kind: 'refused', got, text };
    },
  };
}
