import { useId, type ComponentPropsWithRef } from 'react';
import { cx } from './cx';

/** Classes of the text input of STYLE.md section 5. */
export const INPUT_CLASS =
  'h-(--os-control-height) w-full min-w-0 rounded-os-control border border-os-separator bg-os-surface px-2 text-os-base text-os-foreground placeholder:text-os-gray-accessible disabled:opacity-40 aria-invalid:border-os-red-accessible';

export interface TextFieldProps extends Omit<ComponentPropsWithRef<'input'>, 'id'> {
  label: string;
  /** Error text under the input. It replaces the hint. */
  error?: string | null | undefined;
  hint?: string | undefined;
}

export function TextField({ label, error, hint, className, ...props }: TextFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-os-base text-os-foreground">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={INPUT_CLASS}
        {...props}
      />
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
