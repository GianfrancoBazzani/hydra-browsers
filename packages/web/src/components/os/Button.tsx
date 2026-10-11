import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'default' | 'primary' | 'destructive' | 'ghost';
export type ButtonSize = 'default' | 'small';

// No horizontal padding here: a text button adds PADDING_TEXT, an icon button has none.
const BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-os-control text-os-base font-medium whitespace-nowrap select-none transition-colors duration-(--os-duration-fast) ease-os-out disabled:pointer-events-none disabled:opacity-40';

const PADDING_TEXT = 'px-3';

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-os-tone text-os-foreground hover:bg-os-tone-strong active:bg-os-tone-strong',
  primary: 'bg-os-accent-fill text-os-on-fill hover:bg-os-accent-fill-hover',
  destructive: 'bg-os-danger-fill text-os-on-fill hover:bg-os-danger-fill-hover',
  ghost: 'bg-transparent text-os-foreground hover:bg-os-tone active:bg-os-tone-strong',
};

const SIZES: Record<ButtonSize, string> = {
  default: 'h-(--os-control-height)',
  small: 'h-(--os-control-height-sm)',
};

/** A square icon button has the height of its size and the same width. */
const SQUARE: Record<ButtonSize, string> = {
  default: 'w-(--os-control-height)',
  small: 'w-(--os-control-height-sm)',
};

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'default',
  size = 'default',
  type = 'button',
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(BASE, PADDING_TEXT, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label'> {
  /** Icon-only buttons need a label (STYLE.md section 3). */
  'aria-label': string;
}

/** A square button that holds one icon. Small (24px) by default. */
export function IconButton({
  size = 'small',
  variant = 'ghost',
  type = 'button',
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(BASE, VARIANTS[variant], SIZES[size], SQUARE[size], className)}
      {...props}
    />
  );
}
