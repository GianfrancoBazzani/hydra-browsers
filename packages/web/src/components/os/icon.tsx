import type { TablerIcon } from '@tabler/icons-react';

/** Stroke width of all Tabler icons (STYLE.md section 6). */
export const ICON_STROKE = 1.75;

export interface OsIconProps {
  icon: TablerIcon;
  /** 16px in controls, 18px in the toolbar and the sidebar, 14px for the agent icon. */
  size?: 12 | 14 | 16 | 18;
  className?: string;
}

/** A decorative icon. Screen readers ignore it, so the control around it needs a label. */
export function OsIcon({ icon: Icon, size = 16, className }: OsIconProps) {
  return (
    <Icon
      size={size}
      stroke={ICON_STROKE}
      aria-hidden="true"
      focusable="false"
      className={className}
    />
  );
}
