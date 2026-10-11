import type { CreateTokenResponse, Token } from '@hydra/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { useRevokeToken, useTokens } from '../../api/tokens';
import { Banner, Button, Table, type Column } from '../../components/os';
import { formatDateTime } from '../../lib/format';
import { useCurrentUser } from '../guards';
import { useSessionResource } from './outlet';
import { NewTokenSheet, TokenCreatedSheet } from './token-sheets';

/** The Tokens view (spec section 10.2). The route needs `token.create`. */
export function TokensView() {
  const session = useSessionResource();
  const me = useCurrentUser();
  const tokens = useTokens(session.id);
  const revoke = useRevokeToken(session.id);
  const [newOpen, setNewOpen] = useState(false);
  const [created, setCreated] = useState<CreateTokenResponse | null>(null);
  const [now] = useState(Date.now);

  const canRevoke = (token: Token) =>
    token.revokedAt === null &&
    (session.rights.includes('token.revoke_any') ||
      (session.rights.includes('token.revoke_own') && token.createdBy.id === me.id));

  const columns: Column<Token>[] = [
    { key: 'name', header: 'Name', cell: (t) => t.name },
    {
      key: 'prefix',
      header: 'Prefix',
      cell: (t) => <span className="font-mono text-os-sm">{t.prefix}</span>,
    },
    { key: 'creator', header: 'Creator', cell: (t) => t.createdBy.displayName },
    { key: 'created', header: 'Created', cell: (t) => formatDateTime(t.createdAt) },
    {
      key: 'expires',
      header: 'Expires',
      cell: (t) =>
        t.revokedAt !== null
          ? 'Revoked'
          : t.expiresAt <= now
            ? 'Expired'
            : formatDateTime(t.expiresAt),
    },
    { key: 'used', header: 'Last used', cell: (t) => formatDateTime(t.lastUsedAt) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (t) =>
        canRevoke(t) ? (
          <Button
            size="small"
            aria-label={`Revoke ${t.name}`}
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate(t.id);
            }}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-os-base font-semibold">Agent tokens</h2>
        <Button
          variant="primary"
          onClick={() => {
            setNewOpen(true);
          }}
        >
          New token
        </Button>
      </div>
      {tokens.isError ? (
        <Banner variant="warning" role="alert">
          {errorMessage(tokens.error)}
        </Banner>
      ) : null}
      {revoke.error ? (
        <Banner variant="warning" role="alert">
          {errorMessage(revoke.error)}
        </Banner>
      ) : null}
      <Table
        label="Agent tokens"
        columns={columns}
        rows={tokens.data ?? []}
        rowKey={(t) => t.id}
        empty={tokens.isPending ? 'Loading…' : 'No tokens'}
      />
      <NewTokenSheet
        sid={session.id}
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={setCreated}
      />
      <TokenCreatedSheet
        session={session}
        created={created}
        onClose={() => {
          setCreated(null);
        }}
      />
    </div>
  );
}
