/**
 * What arrives after the first view, in a chunk of its own, and what shows if it can't be drawn: its chunk never came
 * (a fetch that failed on a poor connection, or a page older than the console's last deploy asking for a chunk no
 * longer served), or it threw as it drew. The rest of the page stays as it is, a notice says what is missing, and the
 * error goes to the browser's console, where a thrown one can be told from a chunk that never came.
 *
 * A part that arrives `along` with what is around it has no wait of its own: it draws when they do, so nothing moves as
 * it arrives, and only its failure is its own. A sheet's notice stands over the page, where the sheet would have risen,
 * with Close.
 */
import {
  Component,
  type ComponentType,
  createElement,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react';

/** A part whose code arrives in a chunk of its own: `load` asks for it, once, and settles when it came or didn't. */
export type Chunk<P> = ComponentType<P> & { load: () => Promise<void> };

/**
 * A part in a chunk of its own, drawn once its code is in. Unlike `lazy`, its code can be asked for before it is drawn
 * (`load`, or `useChunks` for several), so a part drawn after that never suspends; one drawn before suspends as a
 * lazy part does. A chunk that never came throws what its fetch failed with as the part draws, which its `Later`
 * shows as not loaded.
 *
 * Parts that arrive together are asked for this way, not left to suspend together under one boundary: Preact, which
 * runs the console, unmounts the parts parked under a boundary if what is around it draws again while they wait,
 * counts them as arrived, and draws them again detached from the page, each throwing an error nothing catches.
 */
export function chunk<P extends object>(loader: () => Promise<ComponentType<P>>): Chunk<P> {
  let code: ComponentType<P> | undefined;
  let failed: { error: unknown } | undefined;
  let asked: Promise<void> | undefined;
  const load = () =>
    (asked ??= loader().then(
      (loaded) => {
        code = loaded;
      },
      (error: unknown) => {
        failed = { error };
      },
    ));
  // biome-ignore lint/correctness/noComponentHookFactories: made once for each chunk, at the module's top, as `lazy` makes its part
  function Part(props: P) {
    if (failed) throw failed.error;
    if (!code) throw load();
    return createElement(code, props);
  }
  return Object.assign(Part, { load });
}

/** Whether every one of these parts' chunks has arrived or failed, asking for them once `now` is true. */
export function useChunks(parts: readonly { load: () => Promise<void> }[], now: boolean): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!now || done) return;
    let current = true;
    void Promise.all(parts.map((part) => part.load())).then(() => {
      if (current) setDone(true);
    });
    return () => {
      current = false;
    };
  }, [parts, now, done]);
  return done;
}

interface LaterProps {
  /** What the part is, in the notice's words: "Needs you, Controls, Flags, Patching, Guardrails and Spend". */
  what: string;
  /** Whether it is one thing ("it") rather than several ("them"). */
  one?: boolean;
  /** Arrives with what is around it, under that part's wait, rather than after it. */
  along?: boolean;
  /** For a sheet: its notice stands over the page, and Close takes it away. */
  onDismiss?: () => void;
  children: ReactNode;
}

/**
 * The notice in a part's place: what couldn't be shown, and how it may come back. A sheet's stands over the page with
 * Close, which takes focus as it appears, so the keyboard and a screen reader are on it; Close or Escape takes it away
 * and gives focus back to where it was.
 */
export function NotLoaded({
  what,
  again,
  onDismiss,
}: {
  what: string;
  /** How it may come back: "Reloading the page may bring them back." */
  again: string;
  /** For a sheet: the notice stands over the page, and Close takes it away. */
  onDismiss?: (() => void) | undefined;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!onDismiss) return;
    const back = document.activeElement;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [onDismiss]);
  return (
    <p className={onDismiss ? 'notice over' : 'notice'} role="status">
      <span className="label">Not loaded</span>
      {what} couldn’t be shown. {again}
      {onDismiss && (
        <button type="button" className="linkish" ref={close} onClick={onDismiss}>
          Close
        </button>
      )}
    </p>
  );
}

export class Later extends Component<LaterProps, { failed: boolean }> {
  override state = { failed: false };

  static override getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(`${this.props.what}:`, error);
  }

  override render() {
    const { what, one = false, along = false, onDismiss, children } = this.props;
    if (this.state.failed)
      return (
        <NotLoaded
          what={what}
          again={`Reloading the page may bring ${one ? 'it' : 'them'} back.`}
          onDismiss={onDismiss}
        />
      );
    if (along) return children;
    // Nothing holds their place while their chunks arrive: they draw under everything above them, so nothing moves.
    return <Suspense fallback={null}>{children}</Suspense>;
  }
}
