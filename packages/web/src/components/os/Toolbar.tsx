import type { ReactNode } from 'react';

export interface ToolbarProps {
  title: ReactNode;
  /** Small text under the title, for example the session state. */
  subtitle?: ReactNode;
  /** For example the SegmentedControl of the views. */
  center?: ReactNode;
  /** Buttons on the right. */
  actions?: ReactNode;
}

/** The 52px bar on top of the main column (STYLE.md section 5). */
export function Toolbar({ title, subtitle, center, actions }: ToolbarProps) {
  return (
    <header className="grid h-(--os-toolbar-height) shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-os-separator px-4">
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-os-lg font-semibold text-os-foreground">{title}</h1>
        {subtitle ? <div className="text-os-xs text-os-gray-accessible">{subtitle}</div> : null}
      </div>
      <div className="justify-self-center">{center}</div>
      <div className="flex items-center justify-end gap-2">{actions}</div>
    </header>
  );
}
