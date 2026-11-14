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
import { Component, type ReactNode, Suspense } from 'react';

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

/** The notice in a part's place: what couldn't be shown, and how it may come back. */
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
  return (
    <p className={onDismiss ? 'notice over' : 'notice'} role="status">
      <span className="label">Not loaded</span>
      {what} couldn’t be shown. {again}
      {onDismiss && (
        <button type="button" className="linkish" onClick={onDismiss}>
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
