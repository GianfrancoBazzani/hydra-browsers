import type { Action, SessionResource } from '@hydra/shared';
import { IconDots } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { useSessionAction } from '../../api/sessions';
import {
  Banner,
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  OsIcon,
  SegmentedControl,
  StatusDot,
  Toolbar,
} from '../../components/os';
import { DeleteSessionSheet } from './DeleteSessionSheet';
import type { SessionView, SessionViewDef } from './views';

export interface SessionToolbarProps {
  session: SessionResource;
  view: SessionView | null;
  views: readonly SessionViewDef[];
}

/** Name and state, the views, Start/Stop, Restart, and Delete (spec section 10.2). */
export function SessionToolbar({ session, view, views }: SessionToolbarProps) {
  const navigate = useNavigate();
  const action = useSessionAction(session.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const can = (right: Action) => session.rights.includes(right);
  const { state } = session;
  const startable = state === 'stopped' || state === 'error';
  const busy = action.isPending;

  return (
    <>
      <Toolbar
        title={session.name}
        subtitle={<StatusDot state={state} showLabel />}
        center={
          view ? (
            <SegmentedControl
              label="Views"
              value={view}
              segments={views}
              onValueChange={(next) => {
                void navigate(`/sessions/${session.id}/${next}`);
              }}
            />
          ) : null
        }
        actions={
          <>
            {can('session.lifecycle') ? (
              <>
                {startable ? (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => {
                      action.mutate('start');
                    }}
                  >
                    {state === 'error' ? 'Retry start' : 'Start'}
                  </Button>
                ) : (
                  <Button
                    disabled={busy || state === 'stopping' || state === 'deleting'}
                    onClick={() => {
                      action.mutate('stop');
                    }}
                  >
                    Stop
                  </Button>
                )}
                <Button
                  disabled={busy || (state !== 'starting' && state !== 'running')}
                  onClick={() => {
                    action.mutate('restart');
                  }}
                >
                  Restart
                </Button>
              </>
            ) : null}
            {can('session.delete') ? (
              <Menu>
                <MenuTrigger asChild>
                  <IconButton ref={moreRef} size="default" aria-label="More">
                    <OsIcon icon={IconDots} size={18} />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem
                    destructive
                    onSelect={() => {
                      setDeleteOpen(true);
                    }}
                  >
                    Delete
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </>
        }
      />
      {action.error ? (
        <div className="border-b border-os-separator px-4 py-2">
          <Banner variant="warning" role="alert">
            {errorMessage(action.error)}
          </Banner>
        </div>
      ) : null}
      {can('session.delete') ? (
        <DeleteSessionSheet
          session={session}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          returnFocusRef={moreRef}
        />
      ) : null}
    </>
  );
}
