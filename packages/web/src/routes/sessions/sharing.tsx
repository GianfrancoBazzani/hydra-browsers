import { MEMBER_ROLES, type Member, type MemberRole } from '@hydra/shared';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { errorMessage, isApiError } from '../../api/client';
import { useAddMember, useMembers, useRemoveMember, useUpdateMember } from '../../api/members';
import {
  Banner,
  Button,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuTrigger,
  OsIcon,
  RadioGroup,
  Table,
  TextField,
  type Column,
} from '../../components/os';
import { useSessionResource } from './outlet';

const ROLE_LABELS: Record<Member['role'], string> = {
  owner: 'Owner',
  operator: 'Operator',
  viewer: 'Viewer',
};

const ROLE_OPTIONS = MEMBER_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

function isMemberRole(role: Member['role']): role is MemberRole {
  return role !== 'owner';
}

/** The Sharing view: owner and members, role menu, Remove, and Add (spec section 10.2). */
export function SharingView() {
  const session = useSessionResource();
  const members = useMembers(session.id);
  const add = useAddMember(session.id);
  const update = useUpdateMember(session.id);
  const remove = useRemoveMember(session.id);
  const canShare = session.rights.includes('session.share');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');

  const rows = members.data ? [members.data.owner, ...members.data.members] : [];

  // A validation_failed answer for the email shows at the field. Any other error, including a
  // conflict or a not_found for an unknown email, shows in a banner.
  const emailError =
    isApiError(add.error, 'validation_failed') && add.error.fields?.email
      ? add.error.fields.email
      : null;
  const addBannerText = add.error && !emailError ? errorMessage(add.error) : null;

  const columns: Column<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (m) => (
        <span className="flex flex-col">
          <span>{m.displayName}</span>
          <span className="text-os-xs text-os-gray-accessible">{m.email}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      cell: (m) =>
        canShare && isMemberRole(m.role) ? (
          <Menu>
            <MenuTrigger asChild>
              <Button size="small" aria-label={`Role of ${m.displayName}: ${ROLE_LABELS[m.role]}`}>
                {ROLE_LABELS[m.role]}
                <OsIcon icon={IconChevronDown} size={16} />
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuRadioGroup
                label="Role"
                value={m.role}
                options={ROLE_OPTIONS}
                onValueChange={(next) => {
                  update.mutate({ userId: m.userId, role: next });
                }}
              />
            </MenuContent>
          </Menu>
        ) : (
          ROLE_LABELS[m.role]
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (m) =>
        canShare && isMemberRole(m.role) ? (
          <Button
            size="small"
            aria-label={`Remove ${m.displayName}`}
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate(m.userId);
            }}
          >
            Remove
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="text-os-base font-semibold">People with access</h2>
      {members.isError ? (
        <Banner variant="warning" role="alert">
          {errorMessage(members.error)}
        </Banner>
      ) : null}
      {update.error ? (
        <Banner variant="warning" role="alert">
          {errorMessage(update.error)}
        </Banner>
      ) : null}
      {remove.error ? (
        <Banner variant="warning" role="alert">
          {errorMessage(remove.error)}
        </Banner>
      ) : null}
      <Table
        label="People with access"
        columns={columns}
        rows={rows}
        rowKey={(m) => m.userId}
        empty={members.isPending ? 'Loading…' : 'No people'}
      />
      {canShare ? (
        <form
          noValidate
          className="flex flex-col gap-3 rounded-os-menu border border-os-separator p-4"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(
              { email: email.trim(), role },
              {
                onSuccess: () => {
                  setEmail('');
                },
              },
            );
          }}
        >
          <h3 className="text-os-base font-semibold">Add a member</h3>
          <TextField
            label="Email"
            type="email"
            value={email}
            error={emailError}
            aria-invalid={add.isError || undefined}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <RadioGroup label="Role" value={role} options={ROLE_OPTIONS} onValueChange={setRole} />
          {addBannerText ? (
            <Banner variant="warning" role="alert">
              {addBannerText}
            </Banner>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={add.isPending || email.trim() === ''}>
              Add
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
