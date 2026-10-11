import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { OsIcon } from './icon';

export type BannerVariant = 'info' | 'warning';

const VARIANTS = {
  info: {
    className:
      'text-os-blue-accessible bg-[color-mix(in_srgb,var(--os-blue)_12%,var(--os-surface))]',
    icon: IconInfoCircle,
  },
  warning: {
    className:
      'text-os-orange-accessible bg-[color-mix(in_srgb,var(--os-orange)_12%,var(--os-surface))]',
    icon: IconAlertTriangle,
  },
} as const;

export interface BannerProps {
  variant: BannerVariant;
  children: ReactNode;
  /** `alert` for errors that need attention now. Default `status`. */
  role?: 'status' | 'alert';
  className?: string;
}

export function Banner({ variant, children, role = 'status', className }: BannerProps) {
  const style = VARIANTS[variant];
  return (
    <div
      role={role}
      className={cx(
        'flex items-center gap-2 rounded-os-menu px-3 py-2 text-os-base',
        style.className,
        className,
      )}
    >
      <OsIcon icon={style.icon} size={16} className="shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
