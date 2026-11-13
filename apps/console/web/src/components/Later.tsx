/**
 * What arrives after the first view, in a chunk of its own, and what shows if its chunk never does: a fetch that failed
 * on a poor connection, or a page older than the console's last deploy asking for a chunk that is no longer served.
 * The rest of the page stays as it is, and a notice says what is missing and that reloading fetches it.
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

  override render() {
    if (this.state.failed)
      return (
        <p className="notice" role="status">
          <span className="label">Not loaded</span>
          {this.props.what} didn’t load. Reloading the page fetches them again.
        </p>
      );
    // Nothing holds their place while their chunks arrive: they draw under everything above them, so nothing moves.
    return <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}
