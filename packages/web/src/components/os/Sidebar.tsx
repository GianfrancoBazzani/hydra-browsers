import type { TablerIcon } from '@tabler/icons-react';
import { IconRobot } from '@tabler/icons-react';
import { useId, type ReactNode } from 'react';
import { NavLink } from 'react-router';
import type { SessionState } from '@hydra/shared';
import { cx } from './cx';
import { OsIcon } from './icon';
import { StatusDot } from './StatusDot';
import { TrafficLights } from './TrafficLights';

export interface SidebarProps {
  children: ReactNode;
  /** The user menu at the bottom (spec section 10.2). */
  footer?: ReactNode;
}

export function Sidebar({ children, footer }: SidebarProps) {
  return (
    <nav
      aria-label="Sidebar"
      className="flex h-full w-(--os-sidebar-width) shrink-0 flex-col border-r border-os-separator bg-os-surface/50 backdrop-blur-2xl"
    >
      <div className="flex h-(--os-toolbar-height) shrink-0 items-center pl-5">
        <TrafficLights />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">{children}</div>
      {footer ? <div className="shrink-0 border-t border-os-separator p-2">{footer}</div> : null}
    </nav>
  );
}

export interface SidebarSectionProps {
  title: string;
  /** For example the New-session button. */
  action?: ReactNode;
  children: ReactNode;
}

export function SidebarSection({ title, action, children }: SidebarSectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="flex h-6 items-center justify-between px-2">
        <h2 id={id} className="text-os-xs font-semibold text-os-gray-accessible">
          {title}
        </h2>
        {action}
      </div>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}

/** Secondary text inside a section, for example "No sessions". */
export function SidebarNote({ children }: { children: ReactNode }) {
  return <li className="px-2 py-1 text-os-xs text-os-gray-accessible">{children}</li>;
}

export interface SidebarItemProps {
  to: string;
  label: string;
  icon?: TablerIcon;
  state?: SessionState;
  /** Shows the agent icon (spec: when activeAgentCount is 1 or more). */
  agentConnected?: boolean;
}

export function SidebarItem({ to, label, icon, state, agentConnected = false }: SidebarItemProps) {
  return (
    <li>
      <NavLink
        to={to}
        className={({ isActive }) =>
          cx(
            'flex h-(--os-row-height) items-center gap-2 rounded-os-control px-2 text-os-base',
            isActive ? 'bg-os-accent-fill text-os-on-fill' : 'text-os-foreground hover:bg-os-tone',
          )
        }
      >
        {state ? <StatusDot state={state} /> : null}
        {icon ? <OsIcon icon={icon} size={18} /> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {agentConnected ? (
          <>
            <OsIcon icon={IconRobot} size={14} />
            <span className="sr-only">Agent connected</span>
          </>
        ) : null}
      </NavLink>
    </li>
  );
}
