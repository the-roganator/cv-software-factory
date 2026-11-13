/**
 * What arrives after the first view, in a chunk of its own, and what shows if it can't be drawn: its chunk never came
 * (a fetch that failed on a poor connection, or a page older than the console's last deploy asking for a chunk no
 * longer served), or it threw as it drew. The rest of the page stays as it is, a notice says what is missing, and the
 * error goes to the browser's console, where a thrown one can be told from a chunk that never came.
 */
import { Component, type ReactNode, Suspense } from 'react';

interface LaterProps {
  /** What the part is, in the notice's words: "Needs you, Controls, Flags and Spend". */
  what: string;
  children: ReactNode;
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
    if (this.state.failed)
      return (
        <p className="notice" role="status">
          <span className="label">Not loaded</span>
          {this.props.what} couldn’t be shown. Reloading the page may bring them back.
        </p>
      );
    // Nothing holds their place while their chunks arrive: they draw under everything above them, so nothing moves.
    return <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}
