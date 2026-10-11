import type { SessionResource } from '@hydra/shared';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { useSessions } from '../../api/sessions';
import { Banner, ContentPane, StatusDot, Table, Toolbar, type Column } from '../../components/os';
import { formatDateTime } from '../../lib/format';

const COLUMNS: Column<SessionResource>[] = [
  {
    key: 'name',
    header: 'Name',
    cell: (s) => (
      <Link to={`/sessions/${s.id}`} className="text-os-blue-accessible hover:underline">
        {s.name}
      </Link>
    ),
  },
  {
    key: 'owner',
    header: 'Owner',
    cell: (s) => (
      <span className="flex flex-col">
        <span>{s.owner.displayName}</span>
        <span className="text-os-xs text-os-gray-accessible">{s.owner.email}</span>
      </span>
    ),
  },
  { key: 'state', header: 'State', cell: (s) => <StatusDot state={s.state} showLabel /> },
  {
    key: 'agents',
    header: 'Agents',
    align: 'right',
    cell: (s) => s.agentActivity.activeAgentCount,
  },
  { key: 'created', header: 'Created', cell: (s) => formatDateTime(s.createdAt) },
];

/** Admin → All sessions: all sessions with their owner and state (spec section 10.2). */
export function AdminSessionsPage() {
  const sessions = useSessions({ all: true });
  return (
    <>
      <Toolbar title="All sessions" />
      <ContentPane className="gap-4 p-6">
        {sessions.isError ? (
          <Banner variant="warning" role="alert">
            {errorMessage(sessions.error)}
          </Banner>
        ) : null}
        <Table
          label="All sessions"
          columns={COLUMNS}
          rows={sessions.data ?? []}
          rowKey={(s) => s.id}
          empty={sessions.isPending ? 'Loading…' : 'No sessions'}
        />
      </ContentPane>
    </>
  );
}
