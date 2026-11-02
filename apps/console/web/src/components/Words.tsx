/**
 * What Martin's writes say and ask in words: what the admin service refused, or warned of, where he pressed
 * (`Refusal`), and a reason in his words, counted (`ReasonField`).
 */
import { MARTIN_REASON_CHARS } from '@software-factory/events';
import type { ReactNode, Ref } from 'react';

/** What the admin service refused, or warned of, where Martin pressed: nothing when it said nothing. */
export function Refusal({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p className="write-refusal" role="alert">
      {text}
    </p>
  );
}

/**
 * A reason in Martin's words: its label, the field, and a line of help with how many characters of how many. The most
 * is a reason's, as the events package says, unless the words have a limit of their own. With `children` (a Send
 * button), the help and they share a row.
 */
export function ReasonField({
  id,
  label,
  labelHidden = false,
  limit = MARTIN_REASON_CHARS,
  rows = 2,
  required = false,
  value,
  onChange,
  placeholder,
  help,
  helpId,
  field,
  children,
}: {
  id: string;
  label: ReactNode;
  /** Named for a screen reader alone, where the card around it says what it is. */
  labelHidden?: boolean;
  limit?: number;
  rows?: number;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Who sees the words, and how. */
  help: ReactNode;
  /** The help's id, when the field is described by it. */
  helpId?: string;
  field?: Ref<HTMLTextAreaElement>;
  children?: ReactNode;
}) {
  const line = (
    <span className="help" id={helpId}>
      {help}{' '}
      <span className="chars">
        {value.length} / {limit}
      </span>
    </span>
  );
  return (
    <>
      <label className={labelHidden ? 'sr' : 'label'} htmlFor={id}>
        {label}
      </label>
      <textarea
        ref={field ?? null}
        id={id}
        className="field"
        maxLength={limit}
        rows={rows}
        required={required || undefined}
        value={value}
        placeholder={placeholder}
        aria-describedby={helpId}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {children ? (
        <div className="row">
          {line}
          {children}
        </div>
      ) : (
        line
      )}
    </>
  );
}
