import { z } from 'zod';
import {
  ACTIONS,
  ALLOWLIST_MAX_ENTRIES,
  AUDIT_STATUSES,
  LOG_CONTAINERS,
  SCREENS,
  SESSION_NAME_MAX_LENGTH,
  SESSION_ROLES,
  SESSION_STATES,
} from '../constants.js';
import { TimestampSchema } from './common.js';

// ---------------------------------------------------------------------------------------------
// Validation helpers (spec section 7.2)
// ---------------------------------------------------------------------------------------------

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_PART = /^(?:0|[1-9][0-9]{0,2})$/;

function isIPv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => IPV4_PART.test(part) && Number(part) <= 255);
}

/**
 * One allowlist entry in the Chrome URL filter format for hosts: `example.com` (the host and all
 * its subdomains) or `.example.com` (only this host). Lowercase ASCII only (write an IDN in
 * punycode). No scheme, port, path, or wildcard. An IPv4 address is a valid host.
 */
export function isValidHostPattern(entry: string): boolean {
  const host = entry.startsWith('.') ? entry.slice(1) : entry;
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (!labels.every((label) => HOST_LABEL.test(label))) return false;
  // As in the URL standard: a host that ends in a number must be an IPv4 address.
  const last = labels[labels.length - 1] ?? '';
  return /^[0-9]+$/.test(last) ? isIPv4(host) : true;
}

const IANA_NAME = /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)+$/;
let knownZones: { exact: Set<string>; lower: Set<string> } | undefined;

function zones(): { exact: Set<string>; lower: Set<string> } {
  if (!knownZones) {
    const list = Intl.supportedValuesOf('timeZone');
    knownZones = { exact: new Set(list), lower: new Set(list.map((zone) => zone.toLowerCase())) };
  }
  return knownZones;
}

/**
 * Words of IANA names that are not `Capitalized` (`Port-au-Prince`, `Dar_es_Salaam`, `US/Pacific`, `Etc/UTC`,
 * `Brazil/DeNoronha`). The key is the lowercase word, the value its only valid spelling. The
 * names that the engine lists need no entry here (see `isValidTimezone`).
 */
const IRREGULAR_WORDS = new Map(
  [
    'au',
    'of',
    'es',
    'US',
    'ACT',
    'LHI',
    'NSW',
    'IN',
    'GMT',
    'GMT0',
    'UCT',
    'UTC',
    'ComodRivadavia',
    'DeNoronha',
    'McMurdo',
    'DumontDUrville',
    'EasterIsland',
    'BajaNorte',
    'BajaSur',
  ].map((word) => [word.toLowerCase(), word]),
);
const GMT_OFFSET = /^gmt[+-]\d{1,2}$/i;

/** True if every segment of the name is spelled the way IANA spells names (`Europe/Kyiv`). */
function isSpelledLikeIana(name: string): boolean {
  return name.split('/').every((segment) => {
    if (GMT_OFFSET.test(segment)) return segment.startsWith('GMT');
    return segment.split(/[_-]/).every((word) => {
      const irregular = IRREGULAR_WORDS.get(word.toLowerCase());
      return irregular === undefined ? /^[A-Z][a-z0-9]*$/.test(word) : word === irregular;
    });
  });
}

/**
 * An IANA timezone name. The `TZ` variable of the pod is case-sensitive, but
 * `Intl.DateTimeFormat` ignores case and returns an alias name (`Europe/Kiev` for `Europe/Kyiv`),
 * so the engine cannot tell us the correct spelling of a name. Rules, in order:
 * 1. `UTC` and every name in `Intl.supportedValuesOf('timeZone')` (exact match) are valid.
 * 2. A name that differs from a listed name only in case is invalid.
 * 3. Any other name must be IANA-shaped, accepted by `Intl.DateTimeFormat`, and spelled like an
 *    IANA name: every word is `Capitalized`, or is one of the few irregular words (`au`, `US`,
 *    `UTC`, `GMT+1`, ...) in its exact spelling. This accepts names that the engine omits or
 *    lists under an older name (`Europe/Kyiv`, `Asia/Kolkata`, `Etc/GMT+1`) and rejects
 *    `Europe/KYIV`, `Etc/Gmt+1`, `utc`.
 */
export function isValidTimezone(name: string): boolean {
  const known = zones();
  if (name === 'UTC' || known.exact.has(name)) return true;
  if (!IANA_NAME.test(name) || known.lower.has(name.toLowerCase())) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
  } catch {
    return false;
  }
  return isSpelledLikeIana(name);
}

/** The canonical form of a BCP 47 language tag (`en-us` → `en-US`), or null if it is not valid. */
export function canonicalLanguage(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Field schemas (requests)
// ---------------------------------------------------------------------------------------------

const NAME_MESSAGE = `Name must have 1 to ${String(SESSION_NAME_MAX_LENGTH)} characters`;
const HOST_MESSAGE =
  'Use a host such as example.com or .example.com (no scheme, port, path, or wildcard)';

export const SessionNameSchema = z
  .string()
  .trim()
  .min(1, NAME_MESSAGE)
  .max(SESSION_NAME_MAX_LENGTH, NAME_MESSAGE);

/** 1 to 100 host patterns, or exactly `["*"]`. Entries are trimmed and lowercased. */
export const AllowlistSchema = z
  .array(z.string().trim().toLowerCase())
  .min(1, 'Add at least one host')
  .max(ALLOWLIST_MAX_ENTRIES, `Use at most ${String(ALLOWLIST_MAX_ENTRIES)} hosts`)
  .superRefine((entries, ctx) => {
    if (entries.includes('*')) {
      if (entries.length > 1) {
        ctx.addIssue({
          code: 'custom',
          message: '"*" must be the only entry',
          path: [entries.indexOf('*')],
        });
      }
      return;
    }
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (!isValidHostPattern(entry)) {
        ctx.addIssue({ code: 'custom', message: HOST_MESSAGE, path: [index] });
      } else if (seen.has(entry)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate host', path: [index] });
      }
      seen.add(entry);
    });
  });

export const TimezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, 'Use an IANA timezone such as Europe/Berlin');

/**
 * True if the canonical tag names a language that Chromium can use as `--lang`: the language
 * subtag is not `und`, and there is no extension (`-u-`, `-t-`, ...) or private-use (`-x-`)
 * singleton. In a valid tag, a one-character subtag is always such a singleton.
 */
function isPlainLanguageTag(canonical: string): boolean {
  const [language = '', ...rest] = canonical.split('-');
  return language.toLowerCase() !== 'und' && rest.every((subtag) => subtag.length > 1);
}

/**
 * A BCP 47 language tag. The output is the canonical form. The tag must be one that Chromium
 * takes as it is (spec section 7.6): not `und`, no extension, no private use.
 */
export const LanguageSchema = z
  .string()
  .trim()
  .transform((tag, ctx) => {
    const canonical = canonicalLanguage(tag);
    if (canonical === null || !isPlainLanguageTag(canonical)) {
      ctx.addIssue({ code: 'custom', message: 'Use a BCP 47 language tag such as en-US' });
      return z.NEVER;
    }
    return canonical;
  });

export const ScreenSchema = z.enum(SCREENS);

// ---------------------------------------------------------------------------------------------
// API shapes. Responses use loose field types: the server validated the values on input.
// ---------------------------------------------------------------------------------------------

export const SessionSettingsSchema = z.object({
  allowlist: z.array(z.string()),
  timezone: z.string(),
  language: z.string(),
  screen: ScreenSchema,
});
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

export const AgentActivitySchema = z.object({
  activeAgentCount: z.number().int().nonnegative(),
  lastToolCall: z
    .object({
      tool: z.string(),
      status: z.enum(AUDIT_STATUSES),
      durationMs: z.number().nonnegative().nullable(),
      startedAt: TimestampSchema,
    })
    .nullable(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

export const SessionResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.object({ id: z.string(), email: z.string(), displayName: z.string() }),
  /** 'admin': access only through the global admin role. */
  myRole: z.enum([...SESSION_ROLES, 'admin']),
  /** What the current user can do. */
  rights: z.array(z.enum(ACTIONS)),
  state: z.enum(SESSION_STATES),
  errorReason: z.string().nullable(),
  settings: SessionSettingsSchema,
  restartRequired: z.boolean(),
  agentActivity: AgentActivitySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type SessionResource = z.infer<typeof SessionResourceSchema>;

/** `GET /api/sessions?all=1` (admins). */
export const ListSessionsQuerySchema = z.object({
  all: z
    .enum(['0', '1'])
    .optional()
    .transform((value) => value === '1'),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

/** Missing fields take the defaults: config timezone and language, DEFAULT_SCREEN, start true. */
export const CreateSessionRequestSchema = z.object({
  name: SessionNameSchema,
  allowlist: AllowlistSchema,
  timezone: TimezoneSchema.optional(),
  language: LanguageSchema.optional(),
  screen: ScreenSchema.optional(),
  start: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const UpdateSessionRequestSchema = z.object({
  name: SessionNameSchema.optional(),
  allowlist: AllowlistSchema.optional(),
  timezone: TimezoneSchema.optional(),
  language: LanguageSchema.optional(),
  screen: ScreenSchema.optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

/** `confirmName` is not trimmed: it must be equal to the exact session name. */
export const DeleteSessionRequestSchema = z.object({ confirmName: z.string() });
export type DeleteSessionRequest = z.infer<typeof DeleteSessionRequestSchema>;

export const LogsQuerySchema = z.object({ container: z.enum(LOG_CONTAINERS) });
export type LogsQuery = z.infer<typeof LogsQuerySchema>;

export const LogsResponseSchema = z.object({
  container: z.enum(LOG_CONTAINERS),
  lines: z.array(z.string()),
});
export type LogsResponse = z.infer<typeof LogsResponseSchema>;

export const LiveTicketResponseSchema = z.object({ url: z.string() });
export type LiveTicketResponse = z.infer<typeof LiveTicketResponseSchema>;
