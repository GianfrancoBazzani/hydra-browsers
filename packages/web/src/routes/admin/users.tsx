import type { UserSummary } from '@hydra/shared';
import { IconDots } from '@tabler/icons-react';
import { useRef, useState, type RefObject } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import {
  useCreateUser,
  useResetPassword,
  useUnlockUser,
  useUpdateUser,
  useUsers,
} from '../../api/users';
import {
  Banner,
  Button,
  Checkbox,
  CodeBlock,
  ContentPane,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  OsIcon,
  Sheet,
  SheetBody,
  SheetFooter,
  Table,
  TextField,
  Toolbar,
  type Column,
} from '../../components/os';
import { formatDateTime } from '../../lib/format';
import { useCurrentUser } from '../guards';

interface OneTimePassword {
  email: string;
  password: string;
}

/** The message of a validation error for one form field, or null. */
function fieldError(error: unknown, field: string): string | null {
  return error instanceof ApiError ? (error.fields?.[field] ?? null) : null;
}

function userState(user: UserSummary): string {
  if (user.status === 'disabled') return 'Disabled';
  return user.locked ? 'Locked' : 'Active';
}

function CreateUserSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: OneTimePassword) => void;
}) {
  const create = useCreateUser();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [admin, setAdmin] = useState(false);

  function close() {
    onOpenChange(false);
    setEmail('');
    setDisplayName('');
    setAdmin(false);
    create.reset();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // While the request is pending, Escape and the backdrop do not close the sheet: a
        // reset now would orphan the one-time password that the server is creating.
        if (!next && !create.isPending) close();
      }}
      title="Create user"
      description="Hydra creates a one-time password. The user must change it at the first login."
    >
      <form
        noValidate
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              email: email.trim(),
              displayName: displayName.trim(),
              role: admin ? 'admin' : 'member',
            },
            {
              onSuccess: (result) => {
                close();
                onCreated({ email: result.user.email, password: result.oneTimePassword });
              },
            },
          );
        }}
      >
        <SheetBody>
          <TextField
            label="Email"
            type="email"
            value={email}
            error={fieldError(create.error, 'email')}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <TextField
            label="Name"
            value={displayName}
            maxLength={64}
            error={fieldError(create.error, 'displayName')}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
          <Checkbox label="Administrator" checked={admin} onCheckedChange={setAdmin} />
          {create.error &&
          fieldError(create.error, 'email') === null &&
          fieldError(create.error, 'displayName') === null ? (
            <Banner variant="warning" role="alert">
              {errorMessage(create.error)}
            </Banner>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={close} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || email.trim() === '' || displayName.trim() === ''}
          >
            Create
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}

/** The parent gives it a new `key` for each open, so the form starts with the current name. */
function RenameUserSheet({
  user,
  onClose,
  returnFocusRef,
}: {
  user: UserSummary | null;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const update = useUpdateUser();
  const [name, setName] = useState(user?.displayName ?? '');

  return (
    <Sheet
      open={user !== null}
      onOpenChange={(next) => {
        // While the request is pending, Escape and the backdrop do not close the sheet, so that
        // its error cannot get lost.
        if (!next && !update.isPending) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title="Change name"
      description={user ? `The name of ${user.email} in Hydra and in the live view.` : undefined}
    >
      <form
        noValidate
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!user) return;
          update.mutate(
            { userId: user.id, patch: { displayName: name.trim() } },
            { onSuccess: onClose },
          );
        }}
      >
        <SheetBody>
          <TextField
            label="Name"
            value={name}
            maxLength={64}
            error={fieldError(update.error, 'displayName')}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {update.error && fieldError(update.error, 'displayName') === null ? (
            <Banner variant="warning" role="alert">
              {errorMessage(update.error)}
            </Banner>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={update.isPending || name.trim() === ''}>
            Save
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}

function OneTimePasswordSheet({
  value,
  onClose,
  returnFocusRef,
}: {
  value: OneTimePassword | null;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Sheet
      open={value !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title="One-time password"
      description={`Give this password to ${value?.email ?? ''}. Hydra shows it only one time. The user must change it at the first login.`}
    >
      <SheetBody>
        {value ? <CodeBlock label="One-time password" code={value.password} /> : null}
      </SheetBody>
      <SheetFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </SheetFooter>
    </Sheet>
  );
}

/** Admin → Users (spec sections 6.3 and 10.2). */
export function AdminUsersPage() {
  const users = useUsers();
  const me = useCurrentUser();
  const update = useUpdateUser();
  const reset = useResetPassword();
  const unlock = useUnlockUser();
  const [createOpen, setCreateOpen] = useState(false);
  const [oneTime, setOneTime] = useState<OneTimePassword | null>(null);
  const [renaming, setRenaming] = useState<UserSummary | null>(null);
  const [renameKey, setRenameKey] = useState(0);
  const [actionError, setActionError] = useState<unknown>(null);
  // Where the focus goes after a sheet closes: the Create user button, or the "Actions for" button
  // of the row whose menu item opened the sheet (the menu item is gone by then).
  const createButton = useRef<HTMLButtonElement>(null);
  const rowTriggers = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<HTMLElement | null>(null);
  // The mutate-level callbacks of an observer fire only for its latest request. Thus the items
  // of an observer stay disabled while its request is pending: a second request would make the
  // first error silent.
  const busy = update.isPending || unlock.isPending;

  /** Each row action clears the error of the last one, and shows its own error at the top. */
  const failed = (error: Error) => {
    setActionError(error);
  };

  const columns: Column<UserSummary>[] = [
    { key: 'email', header: 'Email', cell: (u) => u.email },
    { key: 'name', header: 'Name', cell: (u) => u.displayName },
    { key: 'role', header: 'Role', cell: (u) => (u.role === 'admin' ? 'Admin' : 'Member') },
    { key: 'state', header: 'State', cell: userState },
    { key: 'login', header: 'Last login', cell: (u) => formatDateTime(u.lastLoginAt) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (u) => {
        // The server refuses a change of the own role or status (409). The own password has its own screen.
        const own = u.id === me.id;
        return (
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                aria-label={`Actions for ${u.email}`}
                ref={(element) => {
                  if (element) rowTriggers.current.set(u.id, element);
                  else rowTriggers.current.delete(u.id);
                }}
              >
                <OsIcon icon={IconDots} />
              </IconButton>
            </MenuTrigger>
            <MenuContent>
              <MenuItem
                disabled={own || busy}
                onSelect={() => {
                  setActionError(null);
                  update.mutate(
                    { userId: u.id, patch: { role: u.role === 'admin' ? 'member' : 'admin' } },
                    { onError: failed },
                  );
                }}
              >
                {u.role === 'admin' ? 'Make member' : 'Make admin'}
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  returnFocus.current = rowTriggers.current.get(u.id) ?? null;
                  setRenaming(u);
                  setRenameKey((key) => key + 1);
                }}
              >
                Change name
              </MenuItem>
              <MenuItem
                disabled={own || reset.isPending}
                onSelect={() => {
                  returnFocus.current = rowTriggers.current.get(u.id) ?? null;
                  setActionError(null);
                  reset.mutate(u.id, {
                    onSuccess: (result) => {
                      setOneTime({ email: u.email, password: result.oneTimePassword });
                      // The password now lives only in this state, not in the mutation cache.
                      reset.reset();
                    },
                    onError: failed,
                  });
                }}
              >
                Reset password
              </MenuItem>
              {u.locked ? (
                <MenuItem
                  disabled={busy}
                  onSelect={() => {
                    setActionError(null);
                    unlock.mutate(u.id, { onError: failed });
                  }}
                >
                  Unlock
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                destructive={u.status === 'active'}
                disabled={own || busy}
                onSelect={() => {
                  setActionError(null);
                  update.mutate(
                    {
                      userId: u.id,
                      patch: { status: u.status === 'active' ? 'disabled' : 'active' },
                    },
                    { onError: failed },
                  );
                }}
              >
                {u.status === 'active' ? 'Disable' : 'Enable'}
              </MenuItem>
            </MenuContent>
          </Menu>
        );
      },
    },
  ];

  return (
    <>
      <Toolbar
        title="Users"
        actions={
          <Button
            ref={createButton}
            variant="primary"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            Create user
          </Button>
        }
      />
      <ContentPane className="gap-4 p-6">
        {users.isError ? (
          <Banner variant="warning" role="alert">
            {errorMessage(users.error)}
          </Banner>
        ) : null}
        {actionError ? (
          <Banner variant="warning" role="alert">
            {errorMessage(actionError)}
          </Banner>
        ) : null}
        <Table
          label="Users"
          columns={columns}
          rows={users.data ?? []}
          rowKey={(u) => u.id}
          empty={users.isPending ? 'Loading…' : 'No users'}
        />
      </ContentPane>
      <CreateUserSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(result) => {
          returnFocus.current = createButton.current;
          setOneTime(result);
        }}
      />
      <RenameUserSheet
        key={renameKey}
        user={renaming}
        returnFocusRef={returnFocus}
        onClose={() => {
          setRenaming(null);
        }}
      />
      <OneTimePasswordSheet
        value={oneTime}
        returnFocusRef={returnFocus}
        onClose={() => {
          setOneTime(null);
        }}
      />
    </>
  );
}
