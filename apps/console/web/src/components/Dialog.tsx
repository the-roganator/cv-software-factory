/**
 * A dialog over the console: a `raised` card on the scrim, 480px wide in the middle of a laptop's screen and a bottom
 * sheet on a phone. It is the browser's own modal `<dialog>`, so the page behind it cannot be reached and focus stays
 * in it; its title takes focus as it opens, and the control that opened it gets it back as it closes. Escape, the
 * scrim or Cancel close it. Every write that asks before it acts uses one: the passkey again (`StepUp.tsx`), aborting
 * a canary, and the actions to come. It draws its Cancel itself, first in the row at its foot, as `onClose` implies;
 * a dialog with nothing to do has only Close.
 */
import { type ReactNode, useEffect, useId, useRef } from 'react';

interface DialogProps {
  title: string;
  /** A line above the title: what kind of dialog it is. */
  kicker?: ReactNode;
  children: ReactNode;
  /** What it does, after its Cancel, in the row at its foot; with none, the row has only Close. */
  actions?: ReactNode;
  onClose: () => void;
}

export function Dialog({ title, kicker, children, actions, onClose }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    if (el && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    }
    heading.current?.focus();
    // Escape: the browser cancels the dialog, and the page closes it, as Cancel would.
    const cancel = (event: Event) => {
      event.preventDefault();
      close.current();
    };
    el?.addEventListener('cancel', cancel);
    return () => {
      el?.removeEventListener('cancel', cancel);
      if (el?.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, through the dialog's own cancel event
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={id}
      // The dialog's own box is its backdrop's edge: a press on it, and not on the card inside, is on the scrim.
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="dialog-card">
        {kicker && <div className="kickline">{kicker}</div>}
        <h2 id={id} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {children}
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            {actions ? 'Cancel' : 'Close'}
          </button>
          {actions}
        </div>
      </div>
    </dialog>
  );
}
