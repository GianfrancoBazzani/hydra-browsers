import type { ReactNode } from 'react';
import { cx } from './cx';

export interface AppWindowProps {
  sidebar: ReactNode;
  children: ReactNode;
}

/** The one app window over the wallpaper (STYLE.md section 4). */
export function AppWindow({ sidebar, children }: AppWindowProps) {
  return (
    <div className="absolute inset-(--os-window-inset) flex overflow-hidden rounded-xl bg-os-surface/70 shadow-os-window backdrop-blur-2xl">
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** The opaque content pane under the toolbar. */
export function ContentPane({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <main className={cx('flex min-h-0 flex-1 flex-col overflow-auto bg-os-surface', className)}>
      {children}
    </main>
  );
}
