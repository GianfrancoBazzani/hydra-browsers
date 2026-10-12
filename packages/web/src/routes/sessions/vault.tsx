import type { Credential } from '@hydra/shared';
import { IconKey, IconShieldLock } from '@tabler/icons-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { useCredentials } from '../../api/vault';
import { Banner, Button, OsIcon, Table, type Column } from '../../components/os';
import { formatDateTime } from '../../lib/format';
import { useSessionResource } from './outlet';
import { CredentialFormSheet, CredentialSheet, type CredentialForm } from './vault-sheets';

export const VAULT_EMPTY =
  'No credentials. An agent fills the values of a credential with the vault_fill tool, and never sees them.';

/** The Vault view (spec section 10.2). The route needs `vault.read`. */
export function VaultView() {
  const session = useSessionResource();
  const credentials = useCredentials(session.id);
  const canManage = session.rights.includes('vault.manage');
  const canReveal = session.rights.includes('vault.reveal');
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<CredentialForm | null>(null);
  const open = credentials.data?.find((credential) => credential.id === openId) ?? null;

  const columns: Column<Credential>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (c) => (
        <button
          type="button"
          className="rounded-os-control text-left font-medium"
          onClick={(event) => {
            event.stopPropagation();
            setOpenId(c.id);
          }}
        >
          {c.name}
        </button>
      ),
    },
    { key: 'website', header: 'Website', cell: (c) => c.website },
    { key: 'username', header: 'Login', cell: (c) => c.username ?? '—' },
    {
      key: 'values',
      header: 'Values',
      cell: (c) => (
        <span className="flex items-center gap-2 text-os-gray-accessible">
          {c.hasPassword ? (
            <span className="flex items-center" title="Password">
              <OsIcon icon={IconKey} />
              <span className="sr-only">Password</span>
            </span>
          ) : null}
          {c.hasTotp ? (
            <span className="flex items-center" title="Two-factor code">
              <OsIcon icon={IconShieldLock} />
              <span className="sr-only">Two-factor code</span>
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'updated', header: 'Updated', cell: (c) => formatDateTime(c.updatedAt) },
  ];

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-os-base font-semibold">Vault</h2>
        {canManage ? (
          <Button
            variant="primary"
            onClick={() => {
              setForm({ mode: 'new' });
            }}
          >
            New credential
          </Button>
        ) : null}
      </div>
      {credentials.isError ? (
        <Banner variant="warning" role="alert">
          {errorMessage(credentials.error)}
        </Banner>
      ) : null}
      <Table
        label="Credentials"
        columns={columns}
        rows={credentials.data ?? []}
        rowKey={(c) => c.id}
        onRowClick={(c) => {
          setOpenId(c.id);
        }}
        empty={credentials.isPending ? 'Loading…' : VAULT_EMPTY}
      />
      <CredentialSheet
        key={openId ?? 'closed'}
        sid={session.id}
        credential={open}
        canManage={canManage}
        canReveal={canReveal}
        onClose={() => {
          setOpenId(null);
        }}
        onEdit={(credential) => {
          setOpenId(null);
          setForm({ mode: 'edit', credential });
        }}
      />
      <CredentialFormSheet
        key={form === null ? 'closed' : form.mode === 'edit' ? form.credential.id : 'new'}
        sid={session.id}
        form={form}
        onClose={() => {
          setForm(null);
        }}
      />
    </div>
  );
}
