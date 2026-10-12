import {
  CreateCredentialRequestSchema,
  TOTP_ALGORITHMS,
  TOTP_DIGITS,
  TOTP_PERIODS,
  UpdateCredentialRequestSchema,
  describeSiteMatch,
  parseOtpauthUri,
  type CreateCredentialInput,
  type Credential,
  type RevealField,
  type RevealResponse,
  type TotpAlgorithm,
  type UpdateCredentialInput,
} from '@hydra/shared';
import { IconCheck, IconCopy, IconEye, IconEyeOff } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import {
  useCreateCredential,
  useDeleteCredential,
  useRevealCredential,
  useUpdateCredential,
} from '../../api/vault';
import {
  Banner,
  Button,
  CountdownRing,
  IconButton,
  OsIcon,
  RadioGroup,
  Sheet,
  SheetBody,
  SheetFooter,
  TextField,
} from '../../components/os';

const MASK = '••••••••••••';
const CODE_MASK = '••• •••';

export type CredentialForm = { mode: 'new' } | { mode: 'edit'; credential: Credential };

function Field({
  label,
  actions,
  children,
}: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-os-xs font-semibold text-os-gray-accessible">{label}</span>
      <div className="flex min-h-(--os-control-height) items-center justify-between gap-2 border-b border-os-separator pb-1">
        <div className="min-w-0 break-all">{children}</div>
        {actions !== undefined ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

interface RevealActionsProps {
  noun: string;
  shown: boolean;
  copied: boolean;
  disabled: boolean;
  onToggle: () => void;
  onCopy: () => void;
}

/** Show or hide, and copy, for one hidden value. */
function RevealActions({ noun, shown, copied, disabled, onToggle, onCopy }: RevealActionsProps) {
  return (
    <>
      <IconButton
        aria-label={shown ? `Hide ${noun}` : `Show ${noun}`}
        disabled={disabled}
        onClick={onToggle}
      >
        <OsIcon icon={shown ? IconEyeOff : IconEye} />
      </IconButton>
      <IconButton aria-label={`Copy ${noun}`} disabled={disabled} onClick={onCopy}>
        <OsIcon icon={copied ? IconCheck : IconCopy} />
      </IconButton>
    </>
  );
}

export interface CredentialSheetProps {
  sid: string;
  credential: Credential | null;
  canManage: boolean;
  canReveal: boolean;
  onClose: () => void;
  onEdit: (credential: Credential) => void;
}

/** A credential like the screenshot of the spec request: values hidden until a reveal (spec section 10.2). */
export function CredentialSheet({
  sid,
  credential,
  canManage,
  canReveal,
  onClose,
  onEdit,
}: CredentialSheetProps) {
  const reveal = useRevealCredential(sid);
  const remove = useDeleteCredential(sid);
  const [password, setPassword] = useState<string | null>(null);
  const [code, setCode] = useState<Extract<RevealResponse, { field: 'totp' }> | null>(null);
  const [now, setNow] = useState(Date.now);
  const [copied, setCopied] = useState<RevealField | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (code === null) return undefined;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= code.validUntil) setCode(null); // the code hides at the end of its period
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [code]);

  if (credential === null) return null;
  const id = credential.id;

  async function show(field: RevealField): Promise<void> {
    const result = await reveal.mutateAsync({ id, field });
    if (result.field === 'password') setPassword(result.value);
    else {
      setNow(Date.now());
      setCode(result);
    }
  }

  async function copy(field: RevealField): Promise<void> {
    const result = await reveal.mutateAsync({ id, field });
    await navigator.clipboard.writeText(result.field === 'password' ? result.value : result.code);
    setCopied(field);
  }

  const failure = reveal.error ?? remove.error;
  const secondsLeft = code === null ? 0 : Math.max(0, Math.ceil((code.validUntil - now) / 1000));
  const where = describeSiteMatch(credential);

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={credential.name}
      description={`Agents can fill these values only on ${where}.`}
    >
      <SheetBody>
        <Field label="Login">{credential.username ?? '—'}</Field>
        {credential.hasPassword ? (
          <Field
            label="Password"
            actions={
              canReveal ? (
                <RevealActions
                  noun="password"
                  shown={password !== null}
                  copied={copied === 'password'}
                  disabled={reveal.isPending}
                  onToggle={() => {
                    if (password === null) void show('password');
                    else setPassword(null);
                  }}
                  onCopy={() => void copy('password')}
                />
              ) : undefined
            }
          >
            <span className="font-mono text-os-sm">{password ?? MASK}</span>
          </Field>
        ) : null}
        <Field label="Website">
          <a
            href={credential.website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-os-blue-accessible underline"
          >
            {credential.website}
          </a>
        </Field>
        {credential.hasTotp ? (
          <Field
            label="Two-factor code"
            actions={
              canReveal ? (
                <RevealActions
                  noun="code"
                  shown={code !== null}
                  copied={copied === 'totp'}
                  disabled={reveal.isPending}
                  onToggle={() => {
                    if (code === null) void show('totp');
                    else setCode(null);
                  }}
                  onCopy={() => void copy('totp')}
                />
              ) : undefined
            }
          >
            {code === null ? (
              <span className="font-mono text-os-sm">{CODE_MASK}</span>
            ) : (
              <span className="flex items-center gap-2">
                <CountdownRing
                  fraction={(code.validUntil - now) / (code.period * 1000)}
                  label={`${String(secondsLeft)} seconds left`}
                />
                <span className="font-mono text-os-sm">{code.code}</span>
              </span>
            )}
          </Field>
        ) : null}
        <span role="status" className="sr-only">
          {copied === null ? '' : 'Copied'}
        </span>
        {failure ? (
          <Banner variant="warning" role="alert">
            {errorMessage(failure)}
          </Banner>
        ) : null}
      </SheetBody>
      <SheetFooter>
        {canManage && confirmDelete ? (
          <>
            <span className="mr-auto text-os-base text-os-foreground">
              Delete this credential? Agents can no longer fill it.
            </span>
            <Button
              onClick={() => {
                setConfirmDelete(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(id, { onSuccess: onClose })}
            >
              Delete
            </Button>
          </>
        ) : (
          <>
            {canManage ? (
              <>
                <Button
                  variant="destructive"
                  className="mr-auto"
                  onClick={() => {
                    setConfirmDelete(true);
                  }}
                >
                  Delete
                </Button>
                <Button
                  onClick={() => {
                    onEdit(credential);
                  }}
                >
                  Edit
                </Button>
              </>
            ) : null}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )}
      </SheetFooter>
    </Sheet>
  );
}

type Digits = `${(typeof TOTP_DIGITS)[number]}`;
type Period = `${(typeof TOTP_PERIODS)[number]}`;

interface FormValues {
  name: string;
  website: string;
  username: string;
  password: string;
  totp: string;
  algorithm: TotpAlgorithm;
  digits: Digits;
  period: Period;
  removeUsername: boolean;
  removePassword: boolean;
  removeTotp: boolean;
}

function initialValues(credential: Credential | null): FormValues {
  return {
    name: credential?.name ?? '',
    website: credential?.website ?? '',
    username: credential?.username ?? '',
    password: '',
    totp: '',
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
    removeUsername: false,
    removePassword: false,
    removeTotp: false,
  };
}

/** The issues of a zod error (the web package does not depend on zod directly). */
interface ValidationError {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

function fieldErrors(error: ValidationError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] ??= issue.message;
  }
  return errors;
}

function totpInput(values: FormValues): CreateCredentialInput['totp'] {
  const text = values.totp.trim();
  if (text === '') return undefined;
  if (text.toLowerCase().startsWith('otpauth:')) return { uri: text };
  return {
    secret: text,
    algorithm: values.algorithm,
    digits: Number(values.digits),
    period: Number(values.period),
  };
}

export interface CredentialFormSheetProps {
  sid: string;
  form: CredentialForm | null;
  onClose: () => void;
}

/** New credential and Edit credential (spec section 10.2). */
export function CredentialFormSheet({ sid, form, onClose }: CredentialFormSheetProps) {
  const create = useCreateCredential(sid);
  const update = useUpdateCredential(sid);
  const editing = form?.mode === 'edit' ? form.credential : null;
  const [values, setValues] = useState<FormValues>(() => initialValues(editing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  function onTotpChange(text: string) {
    set('totp', text);
    if (!text.trim().toLowerCase().startsWith('otpauth:')) return;
    const parsed = parseOtpauthUri(text);
    if (parsed.ok) {
      setValues((current) => ({
        ...current,
        totp: text,
        algorithm: parsed.params.algorithm,
        digits: String(parsed.params.digits) as Digits,
        period: String(parsed.params.period) as Period,
      }));
    }
  }

  function onError(error: unknown) {
    if (error instanceof ApiError && error.fields !== undefined) setErrors({ ...error.fields });
  }

  function submit() {
    const totp = totpInput(values);
    if (editing === null) {
      const input: CreateCredentialInput = {
        name: values.name,
        website: values.website,
        ...(values.username !== '' ? { username: values.username } : {}),
        ...(values.password !== '' ? { password: values.password } : {}),
        ...(totp !== undefined ? { totp } : {}),
      };
      const parsed = CreateCredentialRequestSchema.safeParse(input);
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error));
        return;
      }
      setErrors({});
      create.mutate(input, { onSuccess: onClose, onError });
      return;
    }
    const input: UpdateCredentialInput = {};
    if (values.name !== editing.name) input.name = values.name;
    if (values.website !== editing.website) input.website = values.website;
    if (values.removeUsername) input.username = null;
    else if (values.username !== (editing.username ?? ''))
      input.username = values.username === '' ? null : values.username;
    if (values.removePassword) input.password = null;
    else if (values.password !== '') input.password = values.password;
    if (values.removeTotp) input.totp = null;
    else if (totp !== undefined) input.totp = totp;
    const parsed = UpdateCredentialRequestSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    update.mutate({ id: editing.id, input }, { onSuccess: onClose, onError });
  }

  const removeButton = (
    key: 'removeUsername' | 'removePassword' | 'removeTotp',
    label: string,
    has: boolean,
  ) =>
    editing !== null && has ? (
      <Button
        size="small"
        aria-label={values[key] ? `Keep ${label}` : `Remove ${label}`}
        onClick={() => {
          set(key, !values[key]);
        }}
      >
        {values[key] ? 'Keep' : 'Remove'}
      </Button>
    ) : null;

  return (
    <Sheet
      open={form !== null}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      title={editing === null ? 'New credential' : 'Edit credential'}
      description="Agents fill these values with the vault_fill tool and never see them."
    >
      <form
        noValidate
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SheetBody>
          <TextField
            label="Name"
            value={values.name}
            error={errors.name}
            onChange={(e) => {
              set('name', e.target.value);
            }}
          />
          <TextField
            label="Website"
            placeholder="https://www.google.com"
            hint="Agents can fill the values only on this site and its subdomains."
            value={values.website}
            error={errors.website}
            onChange={(e) => {
              set('website', e.target.value);
            }}
          />
          <div className="flex items-end gap-2">
            <TextField
              className="flex-1"
              label="Login"
              autoComplete="off"
              disabled={values.removeUsername}
              value={values.username}
              error={errors.username}
              onChange={(e) => {
                set('username', e.target.value);
              }}
            />
            {removeButton('removeUsername', 'login', editing !== null && editing.username !== null)}
          </div>
          <div className="flex items-end gap-2">
            <TextField
              className="flex-1"
              label="Password"
              type="password"
              autoComplete="new-password"
              placeholder={editing?.hasPassword === true ? 'Unchanged' : undefined}
              disabled={values.removePassword}
              value={values.password}
              error={errors.password}
              onChange={(e) => {
                set('password', e.target.value);
              }}
            />
            {removeButton('removePassword', 'password', editing?.hasPassword === true)}
          </div>
          <div className="flex items-end gap-2">
            <TextField
              className="flex-1"
              label="Two-factor secret"
              autoComplete="off"
              placeholder={
                editing?.hasTotp === true ? 'Unchanged' : 'Base32 secret or otpauth:// URI'
              }
              disabled={values.removeTotp}
              value={values.totp}
              error={errors.totp}
              onChange={(e) => {
                onTotpChange(e.target.value);
              }}
            />
            {removeButton('removeTotp', 'two-factor secret', editing?.hasTotp === true)}
          </div>
          <Button
            variant="ghost"
            aria-expanded={advanced}
            onClick={() => {
              setAdvanced(!advanced);
            }}
          >
            Advanced
          </Button>
          {advanced ? (
            <>
              <RadioGroup
                label="Algorithm"
                orientation="horizontal"
                value={values.algorithm}
                options={TOTP_ALGORITHMS.map((value) => ({ value, label: value }))}
                onValueChange={(value) => {
                  set('algorithm', value);
                }}
              />
              <RadioGroup
                label="Digits"
                orientation="horizontal"
                value={values.digits}
                options={TOTP_DIGITS.map((value) => ({
                  value: String(value) as Digits,
                  label: String(value),
                }))}
                onValueChange={(value) => {
                  set('digits', value);
                }}
              />
              <RadioGroup
                label="Period"
                orientation="horizontal"
                value={values.period}
                options={TOTP_PERIODS.map((value) => ({
                  value: String(value) as Period,
                  label: `${String(value)} s`,
                }))}
                onValueChange={(value) => {
                  set('period', value);
                }}
              />
            </>
          ) : null}
          {failure !== null && !(failure instanceof ApiError && failure.fields !== undefined) ? (
            <Banner variant="warning" role="alert">
              {errorMessage(failure)}
            </Banner>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {editing === null ? 'Create' : 'Save'}
          </Button>
        </SheetFooter>
      </form>
    </Sheet>
  );
}
