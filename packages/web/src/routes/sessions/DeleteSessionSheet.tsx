import type { SessionResource } from '@hydra/shared';
import { useState, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { useDeleteSession } from '../../api/sessions';
import { Button, Sheet, SheetBody, SheetFooter, TextField } from '../../components/os';

export interface DeleteSessionSheetProps {
  session: SessionResource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** The user types the exact session name (spec sections 7.9 and 10.2). */
export function DeleteSessionSheet({
  session,
  open,
  onOpenChange,
  returnFocusRef,
}: DeleteSessionSheetProps) {
  const remove = useDeleteSession(session.id);
  const navigate = useNavigate();
  const [confirmName, setConfirmName] = useState('');
  const matches = confirmName === session.name;

  function close() {
    onOpenChange(false);
    setConfirmName('');
    remove.reset();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={`Delete “${session.name}”?`}
      description="Hydra stops the browser, revokes all agent tokens, and deletes the profile with its logins. You cannot undo this."
      returnFocusRef={returnFocusRef}
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!matches) return;
          remove.mutate(confirmName, {
            onSuccess: () => {
              onOpenChange(false);
              void navigate('/', { replace: true });
            },
          });
        }}
      >
        <SheetBody>
          <TextField
            label="Type the session name to confirm"
            autoComplete="off"
            value={confirmName}
            error={remove.error ? errorMessage(remove.error) : null}
            onChange={(event) => {
              setConfirmName(event.target.value);
            }}
          />
        </SheetBody>
        <SheetFooter>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="destructive" disabled={!matches || remove.isPending}>
            Delete
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}
