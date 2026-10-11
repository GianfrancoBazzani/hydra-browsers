import {
  CreateSessionRequestSchema,
  SCREENS,
  UpdateSessionRequestSchema,
  type CreateSessionRequest,
  type Screen,
  type SessionResource,
  type UpdateSessionRequest,
} from '@hydra/shared';
import { useId } from 'react';
import { ChipInput, RadioGroup, TextField } from '../../components/os';
import { ALLOWLIST_HELP } from '../../lib/allowlist-help';

export interface SessionForm {
  name: string;
  allowlist: string[];
  timezone: string;
  language: string;
  screen: Screen;
}

export type SessionFormErrors = Partial<Record<keyof SessionForm, string>>;

export type FormResult<T> = { ok: true; data: T } | { ok: false; errors: SessionFormErrors };

export const EMPTY_SESSION_FORM: SessionForm = {
  name: '',
  allowlist: [],
  timezone: '',
  language: '',
  screen: '1920x1080',
};

export const SCREEN_OPTIONS = SCREENS.map((screen) => ({
  value: screen,
  label: screen.replace('x', ' × '),
}));

const FIELD_MESSAGES: Record<keyof SessionForm, string> = {
  name: 'Use 1 to 64 characters.',
  allowlist: 'Add 1 to 100 hosts, for example example.com or .example.com, or only *.',
  timezone: 'Use an IANA timezone, for example Europe/Rome.',
  language: 'Use a language tag, for example en-US.',
  screen: 'Choose a screen size.',
};

const TIMEZONES = Intl.supportedValuesOf('timeZone');

function isField(key: PropertyKey | undefined): key is keyof SessionForm {
  return typeof key === 'string' && key in FIELD_MESSAGES;
}

/** Field errors from the zod issues of the client check. */
export function issuesToErrors(
  issues: readonly { path: readonly PropertyKey[] }[],
): SessionFormErrors {
  const errors: SessionFormErrors = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (isField(key)) errors[key] = FIELD_MESSAGES[key];
  }
  return errors;
}

/** Field errors from `fields` of a validation_failed answer (spec section 12.2). */
export function serverFieldErrors(fields: Readonly<Record<string, string>>): SessionFormErrors {
  const errors: SessionFormErrors = {};
  for (const [key, message] of Object.entries(fields)) {
    const field = key.split('.')[0];
    if (isField(field)) errors[field] = message;
  }
  return errors;
}

/** The New session request. An empty timezone or language uses the server default. */
export function toCreateRequest(
  form: SessionForm,
  start: boolean,
): FormResult<CreateSessionRequest> {
  const request = {
    name: form.name.trim(),
    allowlist: form.allowlist,
    screen: form.screen,
    start,
    ...(form.timezone.trim() === '' ? {} : { timezone: form.timezone.trim() }),
    ...(form.language.trim() === '' ? {} : { language: form.language.trim() }),
  };
  const parsed = CreateSessionRequestSchema.safeParse(request);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

export function formFromSession(session: SessionResource): SessionForm {
  return { name: session.name, ...session.settings, allowlist: [...session.settings.allowlist] };
}

/** The PATCH body with only the changed fields. */
export function toUpdateRequest(
  form: SessionForm,
  session: SessionResource,
): FormResult<UpdateSessionRequest> {
  const current = formFromSession(session);
  const request: UpdateSessionRequest = {};
  const name = form.name.trim();
  if (name !== current.name) request.name = name;
  if (form.allowlist.join('\n') !== current.allowlist.join('\n'))
    request.allowlist = form.allowlist;
  if (form.timezone.trim() !== current.timezone) request.timezone = form.timezone.trim();
  if (form.language.trim() !== current.language) request.language = form.language.trim();
  if (form.screen !== current.screen) request.screen = form.screen;
  const parsed = UpdateSessionRequestSchema.safeParse(request);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

export interface SessionFieldsProps {
  value: SessionForm;
  onChange: (value: SessionForm) => void;
  errors: SessionFormErrors;
  disabled?: boolean;
  /** New session: an empty timezone or language means the server default. */
  serverDefaults?: boolean;
}

/** Name, allowlist, timezone, language, and screen (spec sections 7.2 and 10.2). */
export function SessionFields({
  value,
  onChange,
  errors,
  disabled = false,
  serverDefaults = false,
}: SessionFieldsProps) {
  const timezones = useId();
  const set = <K extends keyof SessionForm>(key: K, next: SessionForm[K]) => {
    onChange({ ...value, [key]: next });
  };
  return (
    <>
      <TextField
        label="Name"
        value={value.name}
        maxLength={64}
        disabled={disabled}
        error={errors.name}
        onChange={(event) => {
          set('name', event.target.value);
        }}
      />
      <ChipInput
        label="Allowlist"
        value={value.allowlist}
        placeholder="example.com"
        hint={ALLOWLIST_HELP}
        disabled={disabled}
        error={errors.allowlist}
        onChange={(next) => {
          set('allowlist', next);
        }}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Timezone"
          list={timezones}
          value={value.timezone}
          placeholder={serverDefaults ? 'Server default' : undefined}
          disabled={disabled}
          error={errors.timezone}
          onChange={(event) => {
            set('timezone', event.target.value);
          }}
        />
        <TextField
          label="Language"
          value={value.language}
          placeholder={serverDefaults ? 'Server default' : undefined}
          disabled={disabled}
          error={errors.language}
          onChange={(event) => {
            set('language', event.target.value);
          }}
        />
      </div>
      <datalist id={timezones}>
        {TIMEZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <RadioGroup
        label="Screen"
        value={value.screen}
        options={SCREEN_OPTIONS}
        disabled={disabled}
        onValueChange={(next) => {
          set('screen', next);
        }}
      />
    </>
  );
}
