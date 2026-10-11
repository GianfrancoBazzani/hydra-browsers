import { IconX } from '@tabler/icons-react';
import { useId, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { cx } from './cx';
import { OsIcon } from './icon';

export interface ChipInputProps {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null | undefined;
  disabled?: boolean;
}

function addEntries(current: readonly string[], raw: string): string[] {
  const next = [...current];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry !== '' && !next.includes(entry)) next.push(entry);
  }
  return next;
}

/**
 * The allowlist editor (STYLE.md section 5). Enter or "," adds a chip. Backspace in an empty
 * input removes the last chip. Leaving the input also adds the typed text.
 */
export function ChipInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  disabled = false,
}: ChipInputProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const [draft, setDraft] = useState('');
  const message = error ?? hint;

  function commit(raw: string) {
    const next = addEntries(value, raw);
    if (next.length !== value.length) onChange(next);
    setDraft('');
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const text = event.target.value;
    const lastComma = text.lastIndexOf(',');
    if (lastComma < 0) {
      setDraft(text);
      return;
    }
    const next = addEntries(value, text.slice(0, lastComma));
    if (next.length !== value.length) onChange(next);
    setDraft(text.slice(lastComma + 1));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && draft.trim() !== '') {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-os-base text-os-foreground">
        {label}
      </label>
      <div
        className={cx(
          'flex min-h-(--os-control-height) flex-wrap items-center gap-1 rounded-os-control border bg-os-surface px-1 py-0.5',
          error ? 'border-os-red-accessible' : 'border-os-separator',
          disabled && 'opacity-40',
        )}
      >
        <ul aria-label={`${label} entries`} className="contents">
          {value.map((entry) => (
            <li
              key={entry}
              className="flex h-5.5 items-center gap-1 rounded-os-control bg-os-tone pr-0.5 pl-2 text-os-sm"
            >
              <span>{entry}</span>
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                disabled={disabled}
                onClick={() => {
                  onChange(value.filter((v) => v !== entry));
                }}
                className="flex size-4 items-center justify-center rounded-os-checkbox hover:bg-os-tone-strong"
              >
                <OsIcon icon={IconX} size={12} />
              </button>
            </li>
          ))}
        </ul>
        <input
          id={id}
          value={draft}
          disabled={disabled}
          placeholder={value.length === 0 ? placeholder : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (draft.trim() !== '') commit(draft);
          }}
          className="h-5.5 min-w-24 flex-1 bg-transparent px-1 text-os-base text-os-foreground placeholder:text-os-gray-accessible"
        />
      </div>
      {message ? (
        <p
          id={messageId}
          className={cx(
            'text-os-base',
            error ? 'text-os-red-accessible' : 'text-os-gray-accessible',
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
