import { MESSAGES, type SessionResource } from '@hydra/shared';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { errorMessage, isApiError } from '../../api/client';
import { useLogs, useUpdateSession } from '../../api/sessions';
import {
  Banner,
  Button,
  CodeBlock,
  IconButton,
  OsIcon,
  SegmentedControl,
} from '../../components/os';
import { permitsAllDomains } from '../../lib/format';
import { useSessionResource } from './outlet';
import {
  formFromSession,
  SessionFields,
  serverFieldErrors,
  toUpdateRequest,
  type SessionForm,
  type SessionFormErrors,
} from './session-form';

const CONTAINERS = [
  { value: 'neko', label: 'neko' },
  { value: 'mcp', label: 'mcp' },
] as const;

/** Diagnostics: the last 50 log lines of the neko and the mcp container (`session.logs`). */
function Diagnostics({ sid }: { sid: string }) {
  const [container, setContainer] = useState<'neko' | 'mcp'>('neko');
  const logs = useLogs(sid, container, true);
  return (
    <section aria-labelledby="diagnostics" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 id="diagnostics" className="text-os-base font-semibold">
          Diagnostics
        </h2>
        <SegmentedControl
          label="Container"
          value={container}
          segments={CONTAINERS}
          onValueChange={setContainer}
        />
        <IconButton
          aria-label="Refresh logs"
          disabled={logs.isFetching}
          onClick={() => {
            void logs.refetch();
          }}
        >
          <OsIcon icon={IconRefresh} />
        </IconButton>
      </div>
      {logs.isError ? (
        <Banner variant="warning" role="alert">
          {errorMessage(logs.error)}
        </Banner>
      ) : null}
      {logs.data ? (
        <CodeBlock
          label={`Last log lines of ${logs.data.container}`}
          code={logs.data.lines.length > 0 ? logs.data.lines.join('\n') : '(no log lines)'}
        />
      ) : null}
      {logs.isPending ? (
        <p role="status" className="text-os-base text-os-gray-accessible">
          Loading…
        </p>
      ) : null}
    </section>
  );
}

function SettingsForm({ session }: { session: SessionResource }) {
  const update = useUpdateSession(session.id);
  const editable = session.rights.includes('session.update');
  const [form, setForm] = useState<SessionForm>(() => formFromSession(session));
  const [errors, setErrors] = useState<SessionFormErrors>({});
  const [saved, setSaved] = useState(false);

  // A validation_failed answer shows at its fields. Any other error, and a validation_failed
  // answer whose keys match no field of the form, shows in the banner (same rule as NewSessionSheet).
  const mapped =
    isApiError(update.error, 'validation_failed') && update.error.fields
      ? serverFieldErrors(update.error.fields)
      : {};
  const bannerText =
    update.error && Object.keys(mapped).length === 0 ? errorMessage(update.error) : null;

  return (
    <form
      noValidate
      className="flex max-w-140 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        // A banner from an earlier attempt must not stay next to new field errors.
        update.reset();
        const result = toUpdateRequest(form, session);
        if (!result.ok) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        setSaved(false);
        if (Object.keys(result.data).length === 0) return;
        update.mutate(result.data, {
          onSuccess: (next) => {
            setForm(formFromSession(next));
            setSaved(true);
          },
          onError: (error) => {
            if (isApiError(error, 'validation_failed') && error.fields) {
              setErrors(serverFieldErrors(error.fields));
            }
          },
        });
      }}
    >
      <SessionFields
        value={form}
        onChange={(next) => {
          setForm(next);
          setSaved(false);
        }}
        errors={errors}
        disabled={!editable}
      />
      {bannerText ? (
        <Banner variant="warning" role="alert">
          {bannerText}
        </Banner>
      ) : null}
      {editable ? (
        <div className="flex items-center justify-end gap-3">
          {saved ? (
            <span role="status" className="text-os-base text-os-gray-accessible">
              Saved
            </span>
          ) : null}
          <Button type="submit" variant="primary" disabled={update.isPending}>
            Save
          </Button>
        </div>
      ) : (
        <p className="text-os-base text-os-gray-accessible">
          Only the owner and admins can change the settings.
        </p>
      )}
    </form>
  );
}

/** The Settings view (spec section 10.2). */
export function SettingsView() {
  const session = useSessionResource();
  return (
    <div className="flex flex-col gap-6 p-6">
      {session.restartRequired ? <Banner variant="info">{MESSAGES.restartRequired}</Banner> : null}
      {permitsAllDomains(session.settings.allowlist) ? (
        <Banner variant="warning">{MESSAGES.allowAll}</Banner>
      ) : null}
      <SettingsForm key={session.id} session={session} />
      {session.rights.includes('session.logs') ? <Diagnostics sid={session.id} /> : null}
    </div>
  );
}
