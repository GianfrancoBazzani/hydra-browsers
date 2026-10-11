import { AUDIT_KINDS, type AuditEvent, type AuditKind } from '@hydra/shared';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useAuditPages } from '../../api/audit';
import { errorMessage } from '../../api/client';
import type { AuditFilters } from '../../api/keys';
import { useTokens } from '../../api/tokens';
import {
  Banner,
  Button,
  CodeBlock,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuTrigger,
  OsIcon,
  Sheet,
  SheetBody,
  SheetFooter,
  Table,
  TextField,
  type Column,
} from '../../components/os';
import { useSessionEvents } from '../../lib/events';
import { formatEventTime } from '../../lib/format';
import { useSessionResource } from './outlet';

const ALL = 'all';
const STATUSES = ['pending', 'ok', 'error'] as const;

const STATUS_CLASS: Record<(typeof STATUSES)[number], string> = {
  pending: 'text-os-gray-accessible',
  ok: 'text-os-green-accessible',
  error: 'text-os-red-accessible',
};

function actorLabel(event: AuditEvent): string {
  if (event.actorType === 'system') return 'System';
  const name = event.actorName ?? event.actorId ?? 'Unknown';
  return event.actorType === 'token' ? `${name} (token)` : name;
}

/** One line about the event: the tool and its duration, or the data as short JSON. */
function summary(event: AuditEvent): string {
  const { tool, durationMs, error } = event.data;
  if (typeof tool === 'string') {
    const parts = [tool];
    if (typeof durationMs === 'number') parts.push(`${String(Math.round(durationMs))} ms`);
    if (typeof error === 'string') parts.push(error);
    return parts.join(' · ');
  }
  const json = JSON.stringify(event.data);
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

function FilterMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-os-base text-os-foreground">{label}</span>
      <Menu>
        <MenuTrigger asChild>
          <Button aria-label={`${label}: ${current}`} className="justify-between">
            {current}
            <OsIcon icon={IconChevronDown} size={16} />
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuRadioGroup label={label} value={value} options={options} onValueChange={onChange} />
        </MenuContent>
      </Menu>
    </div>
  );
}

/** The Activity view: audit table, filters, details, Load older, live updates (spec 10.2). */
export function ActivityView() {
  const session = useSessionResource();
  const [filters, setFilters] = useState<AuditFilters>({});
  const [toolDraft, setToolDraft] = useState('');
  // The snapshot of the opened event. `selected` follows the loaded copy of the same ID, so that a
  // live update (pending to ok) reaches the open sheet.
  const [snapshot, setSnapshot] = useState<AuditEvent | null>(null);
  const pages = useAuditPages(session.id, filters);
  const tokens = useTokens(session.id, session.rights.includes('token.create'));
  useSessionEvents(session.id);

  const events = pages.data?.pages.flatMap((page) => page.events) ?? [];
  const selected = snapshot ? (events.find((e) => e.id === snapshot.id) ?? snapshot) : null;

  // An undefined value removes the filter: the query key and the URL ignore undefined values.
  const setFilter = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K] | undefined) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const columns: Column<AuditEvent>[] = [
    {
      key: 'time',
      header: 'Time',
      cell: (e) => (
        <button
          type="button"
          aria-label={`Open ${e.kind} event at ${formatEventTime(e.ts)}`}
          className="text-left whitespace-nowrap hover:underline"
          onClick={() => {
            setSnapshot(e);
          }}
        >
          {formatEventTime(e.ts)}
        </button>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      cell: (e) => <span className="font-mono text-os-sm">{e.kind}</span>,
    },
    { key: 'actor', header: 'Actor', cell: actorLabel },
    {
      key: 'status',
      header: 'Status',
      cell: (e) => (e.status ? <span className={STATUS_CLASS[e.status]}>{e.status}</span> : '—'),
    },
    {
      key: 'details',
      header: 'Details',
      cell: (e) => (
        <span className="block max-w-120 truncate font-mono text-os-sm">{summary(e)}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-end gap-3">
        <FilterMenu<AuditKind | typeof ALL>
          label="Kind"
          value={filters.kind ?? ALL}
          options={[
            { value: ALL, label: 'All kinds' },
            ...AUDIT_KINDS.map((kind) => ({ value: kind, label: kind })),
          ]}
          onChange={(value) => {
            setFilter('kind', value === ALL ? undefined : value);
          }}
        />
        <form
          className="w-56"
          onSubmit={(event) => {
            event.preventDefault();
            const tool = toolDraft.trim();
            setFilter('tool', tool === '' ? undefined : tool);
          }}
        >
          <TextField
            label="Tool"
            placeholder="browser_click, then Enter"
            value={toolDraft}
            onChange={(event) => {
              setToolDraft(event.target.value);
            }}
          />
        </form>
        <FilterMenu<(typeof STATUSES)[number] | typeof ALL>
          label="Status"
          value={filters.status ?? ALL}
          options={[
            { value: ALL, label: 'Any status' },
            ...STATUSES.map((s) => ({ value: s, label: s })),
          ]}
          onChange={(value) => {
            setFilter('status', value === ALL ? undefined : value);
          }}
        />
        {tokens.data ? (
          <FilterMenu
            label="Token"
            value={filters.tokenId ?? ALL}
            options={[
              { value: ALL, label: 'Any token' },
              ...tokens.data.map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={(value) => {
              setFilter('tokenId', value === ALL ? undefined : value);
            }}
          />
        ) : null}
      </div>
      {pages.isError ? (
        <Banner variant="warning" role="alert">
          {errorMessage(pages.error)}
        </Banner>
      ) : null}
      <Table
        label="Activity"
        columns={columns}
        rows={events}
        rowKey={(e) => String(e.id)}
        empty={pages.isPending ? 'Loading…' : 'No events'}
        onRowClick={setSnapshot}
      />
      {pages.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            disabled={pages.isFetchingNextPage}
            onClick={() => {
              void pages.fetchNextPage();
            }}
          >
            Load older
          </Button>
        </div>
      ) : null}
      <Sheet
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSnapshot(null);
        }}
        title={selected ? `${selected.kind} · ${formatEventTime(selected.ts)}` : 'Event'}
        description={
          selected
            ? `${actorLabel(selected)}${selected.status ? ` · ${selected.status}` : ''}`
            : undefined
        }
        wide
      >
        <SheetBody>
          {selected ? (
            <CodeBlock label="Event data" code={JSON.stringify(selected.data, null, 2)} />
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button
            variant="primary"
            onClick={() => {
              setSnapshot(null);
            }}
          >
            Close
          </Button>
        </SheetFooter>
      </Sheet>
    </div>
  );
}
