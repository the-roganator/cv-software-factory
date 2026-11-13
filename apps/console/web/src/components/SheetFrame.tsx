/**
 * The sheet's frame, raised from the bottom of the screen over most of it: a work item's (`Sheet.tsx`) and a panel's
 * opened whole from its summary (Patching's and Guardrails'), the same frame for each. It holds focus while it is open
 * and gives it back to what opened it when it closes; Escape, Close and the scrim close it.
 *
 * Its own small module, so the sheet a viewer opens first brings it, and a panel's sheet carries none of a work item's.
 */
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Glyph } from './Glyph.tsx';
import '../styles/sheet-frame.css';

interface SheetFrameProps {
  /** The kicker over the title. */
  kicker: ReactNode;
  /** The title, which takes focus as the sheet opens unless something in it already has. */
  title: ReactNode;
  /** What stands before Close in the head: a work item's previous and next. */
  nav?: ReactNode;
  /** The body, in the part that scrolls. */
  children: ReactNode;
  motion: boolean;
  /**
   * Whether it rises from the bottom as it opens: not when it takes the place of a sheet already open, as a work item's
   * does when a link in a panel's sheet opens it.
   */
  rise: boolean;
  onClose: () => void;
  /** The title's heading and the part that scrolls, for a sheet that moves them as what it holds changes. */
  titleRef?: RefObject<HTMLHeadingElement | null>;
  scrollerRef?: RefObject<HTMLDivElement | null>;
}

export function SheetFrame({
  kicker,
  title,
  nav,
  children,
  motion,
  rise,
  onClose,
  titleRef,
  scrollerRef,
}: SheetFrameProps) {
  const dialog = useRef<HTMLElement>(null);
  const ownTitle = useRef<HTMLHeadingElement>(null);
  const ownScroller = useRef<HTMLDivElement>(null);
  const heading = titleRef ?? ownTitle;
  const scroller = scrollerRef ?? ownScroller;
  const opener = useRef<Element | null>(null);
  const [risen, setRisen] = useState(!rise);

  // Rise on the next frame, so the move from below is drawn; give focus back on the way out.
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    document.body.classList.add('locked');
    const frame = requestAnimationFrame(() => setRisen(true));
    return () => {
      cancelAnimationFrame(frame);
      document.body.classList.remove('locked');
      const back = opener.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  // The title takes focus as it opens, unless what it holds has given it to a row already.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the sheet opens
  useEffect(() => {
    if (!dialog.current?.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
  }, []);

  const close = () => {
    if (!motion) return onClose();
    setRisen(false);
    setTimeout(onClose, 420);
  };

  // Escape closes; Tab stays inside while the sheet is open.
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // A dialog opened from the sheet (an answer's, a flag's, an attack's) keeps its own keys: Escape closes it, not the
    // sheet.
    if (event.target instanceof Element && event.target.closest('dialog')) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'),
    ];
    const [first, last] = [focusable[0], focusable.at(-1)];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <>
      <div className={`scrim ${risen ? 'open' : ''}`} onClick={close} aria-hidden="true" />
      <section
        ref={dialog}
        className={`sheet ${risen ? 'open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onKeyDown={onKeyDown}
      >
        <div className="grab" aria-hidden="true" />
        <div className="wrap sheet-wrap">
          <header className="sheet-head">
            <div className="sheet-title">
              <div className="kicker">{kicker}</div>
              <h2 id="sheet-title" tabIndex={-1} ref={heading}>
                {title}
              </h2>
            </div>
            <div className="sheet-nav">
              {nav}
              <button type="button" className="icon-btn close" aria-label="Close" onClick={close}>
                <Glyph name="cross" />
              </button>
            </div>
          </header>
        </div>
        <div className="sheet-scroll" ref={scroller}>
          {children}
        </div>
      </section>
    </>
  );
}

/**
 * Brings a row a panel's sheet opened at into view, just under the sheet's head, and gives it focus, as an address or a
 * card in Needs you asks: the sheet moves, not the page under it.
 */
export function bringIntoSheet(row: HTMLElement | null | undefined) {
  if (!row) return;
  const scroller = row.closest('.sheet-scroll');
  if (scroller) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
  row.focus({ preventScroll: true });
}
