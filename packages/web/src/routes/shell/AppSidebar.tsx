import type { SessionResource } from '@hydra/shared';
import { IconLayoutGrid, IconPlus, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';
import { useSessions } from '../../api/sessions';
import {
  IconButton,
  OsIcon,
  Sidebar,
  SidebarItem,
  SidebarNote,
  SidebarSection,
} from '../../components/os';
import { useCurrentUser } from '../guards';
import { NewSessionSheet } from './NewSessionSheet';
import { UserMenu } from './UserMenu';

function SessionItems({
  sessions,
  empty,
}: {
  sessions: readonly SessionResource[] | undefined;
  empty: string;
}) {
  if (sessions === undefined) return null;
  if (sessions.length === 0) return <SidebarNote>{empty}</SidebarNote>;
  return sessions.map((session) => (
    <SidebarItem
      key={session.id}
      to={`/sessions/${session.id}`}
      label={session.name}
      state={session.state}
      agentConnected={session.agentActivity.activeAgentCount >= 1}
    />
  ));
}

/** "My sessions", "Shared with me", "Admin", and the user menu (spec section 10.2). */
export function AppSidebar() {
  const me = useCurrentUser();
  const sessions = useSessions();
  const [newOpen, setNewOpen] = useState(false);
  const mine = sessions.data?.filter((s) => s.myRole === 'owner');
  const shared = sessions.data?.filter((s) => s.myRole === 'operator' || s.myRole === 'viewer');

  return (
    <Sidebar footer={<UserMenu />}>
      <SidebarSection
        title="My sessions"
        action={
          <IconButton
            aria-label="New session"
            onClick={() => {
              setNewOpen(true);
            }}
          >
            <OsIcon icon={IconPlus} />
          </IconButton>
        }
      >
        {sessions.isPending ? <SidebarNote>Loading…</SidebarNote> : null}
        {sessions.isError ? <SidebarNote>The sessions cannot be loaded.</SidebarNote> : null}
        <SessionItems sessions={mine} empty="No sessions" />
      </SidebarSection>
      <SidebarSection title="Shared with me">
        <SessionItems sessions={shared} empty="Nothing is shared with you" />
      </SidebarSection>
      {me.role === 'admin' ? (
        <SidebarSection title="Admin">
          <SidebarItem to="/admin/users" label="Users" icon={IconUsers} />
          <SidebarItem to="/admin/sessions" label="All sessions" icon={IconLayoutGrid} />
        </SidebarSection>
      ) : null}
      <NewSessionSheet open={newOpen} onOpenChange={setNewOpen} />
    </Sidebar>
  );
}
