import { useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { useCreateSession } from '../../api/sessions';
import { Banner, Button, Sheet, SheetBody, SheetFooter, Switch } from '../../components/os';
import {
  EMPTY_SESSION_FORM,
  SessionFields,
  serverFieldErrors,
  toCreateRequest,
  type SessionFormErrors,
} from '../sessions/session-form';

export interface NewSessionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Name, allowlist, timezone, language, screen, and "Start now" (spec section 10.2). */
export function NewSessionSheet({ open, onOpenChange }: NewSessionSheetProps) {
  const create = useCreateSession();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY_SESSION_FORM);
  const [start, setStart] = useState(true);
  const [errors, setErrors] = useState<SessionFormErrors>({});

  function close() {
    onOpenChange(false);
    setForm(EMPTY_SESSION_FORM);
    setStart(true);
    setErrors({});
    create.reset();
  }

  // A validation_failed answer shows at its fields. Any other error, and a validation_failed
  // answer whose keys match no field of the form, shows in the banner.
  const mapped =
    isApiError(create.error, 'validation_failed') && create.error.fields
      ? serverFieldErrors(create.error.fields)
      : {};
  const bannerText =
    create.error && Object.keys(mapped).length === 0 ? errorMessage(create.error) : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="New session"
    >
      <form
        noValidate
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          // A banner from an earlier attempt must not stay next to new field errors.
          create.reset();
          const result = toCreateRequest(form, start);
          if (!result.ok) {
            setErrors(result.errors);
            return;
          }
          setErrors({});
          create.mutate(result.data, {
            onSuccess: (session) => {
              close();
              void navigate(`/sessions/${session.id}/live`);
            },
            onError: (error) => {
              if (isApiError(error, 'validation_failed') && error.fields) {
                setErrors(serverFieldErrors(error.fields));
              }
            },
          });
        }}
      >
        <SheetBody>
          <SessionFields value={form} onChange={setForm} errors={errors} serverDefaults />
          <Switch label="Start now" checked={start} onCheckedChange={setStart} />
          {bannerText ? (
            <Banner variant="warning" role="alert">
              {bannerText}
            </Banner>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}
