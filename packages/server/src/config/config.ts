import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { LanguageSchema, TimezoneSchema } from '@hydra/shared';
import { z } from 'zod';
import { siteOf } from './public-suffix.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export const SESSION_TRANSPORTS = ['cluster-dns', 'port-forward'] as const;

export interface Config {
  dataDir: string;
  secretKey: Buffer;
  publicUrl: URL;
  liveUrl: URL;
  publicIp: string;
  mediaPortRange: { first: number; last: number };
  maxRunning: number;
  sessionNamespace: string;
  sessionTransport: 'cluster-dns' | 'port-forward';
  sessionImage: string;
  mcpImage: string;
  trustedProxies: string[];
  defaultTimezone: string;
  defaultLanguage: string;
  auditRetentionDays: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  port: number;
}

/** A missing or wrong variable. The message names the variable (spec section 4). */
export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

/** Defaults of spec section 4. The other variables are necessary. */
export const CONFIG_DEFAULTS = {
  HYDRA_DATA_DIR: './.data',
  HYDRA_MEDIA_PORT_RANGE: '52000-52099',
  HYDRA_MAX_RUNNING: '10',
  HYDRA_SESSION_NAMESPACE: 'hydra-sessions',
  HYDRA_SESSION_TRANSPORT: 'cluster-dns',
  HYDRA_TRUSTED_PROXIES: '10.42.0.0/16',
  HYDRA_DEFAULT_TIMEZONE: 'UTC',
  HYDRA_DEFAULT_LANGUAGE: 'en-US',
  HYDRA_AUDIT_RETENTION_DAYS: '90',
  HYDRA_LOG_LEVEL: 'info',
  PORT: '8080',
} as const;

const VARIABLES = [
  'HYDRA_DATA_DIR',
  'HYDRA_SECRET_KEY',
  'HYDRA_SECRET_KEY_FILE',
  'HYDRA_PUBLIC_URL',
  'HYDRA_LIVE_URL',
  'HYDRA_PUBLIC_IP',
  'HYDRA_MEDIA_PORT_RANGE',
  'HYDRA_MAX_RUNNING',
  'HYDRA_SESSION_NAMESPACE',
  'HYDRA_SESSION_TRANSPORT',
  'HYDRA_SESSION_IMAGE',
  'HYDRA_MCP_IMAGE',
  'HYDRA_TRUSTED_PROXIES',
  'HYDRA_DEFAULT_TIMEZONE',
  'HYDRA_DEFAULT_LANGUAGE',
  'HYDRA_AUDIT_RETENTION_DAYS',
  'HYDRA_LOG_LEVEL',
  'PORT',
] as const;

type Ctx = z.RefinementCtx;

/** Adds a validation issue. `variable` is needed only in the object-level checks. */
function addIssue(ctx: Ctx, message: string, variable?: string): void {
  ctx.addIssue({ code: 'custom', message, ...(variable ? { path: [variable] } : {}) });
}

export function isLocalhostName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/** An origin with https, or http for localhost names (browsers treat them as secure contexts). */
function parseOrigin(value: string, ctx: Ctx): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    addIssue(ctx, 'must be a URL such as https://hydra.example.com');
    return z.NEVER;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    addIssue(ctx, 'must be an origin (scheme, host, port) without path, query, or credentials');
    return z.NEVER;
  }
  if (url.hostname.endsWith('.')) {
    addIssue(ctx, 'must not end with a dot');
    return z.NEVER;
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhostName(url.hostname));
  if (!secure) {
    addIssue(ctx, 'must use https (http only for localhost and *.localhost)');
    return z.NEVER;
  }
  return new URL(url.origin);
}

function parseInteger(min: number, max: number) {
  return (value: string, ctx: Ctx): number => {
    const number = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      addIssue(ctx, `must be an integer from ${String(min)} to ${String(max)}`);
      return z.NEVER;
    }
    return number;
  };
}

/**
 * The lowest first media port (spec sections 4 and 11.6). The node port range starts at 30000, and
 * Kubernetes keeps its lowest 128 ports (30000-30127) for fixed node ports such as Traefik's.
 */
const MEDIA_PORT_MIN = 30128;

function parsePortRange(value: string, ctx: Ctx): { first: number; last: number } {
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(value);
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (!match || first < 1 || last > 65535 || first > last) {
    addIssue(ctx, 'must be "<first>-<last>" with 1 <= first <= last <= 65535');
    return z.NEVER;
  }
  if (first < MEDIA_PORT_MIN) {
    addIssue(
      ctx,
      `first port must be ${String(MEDIA_PORT_MIN)} or more ` +
        '(the lower node ports are for the fixed node ports of other Services)',
    );
    return z.NEVER;
  }
  return { first, last };
}

function isIpOrCidr(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

function parseProxies(value: string, ctx: Ctx): string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0 || !entries.every(isIpOrCidr)) {
    addIssue(ctx, 'must be a comma-separated list of IP addresses or CIDR ranges');
    return z.NEVER;
  }
  return entries;
}

/** `name:tag@sha256:<digest>`: the image rule of spec section 3.4.1 (tag and digest). */
export function isPinnedImage(reference: string): boolean {
  const at = reference.indexOf('@');
  if (at < 0 || !/^sha256:[a-f0-9]{64}$/.test(reference.slice(at + 1))) return false;
  const nameAndTag = reference.slice(0, at);
  const colon = nameAndTag.lastIndexOf(':');
  if (colon <= nameAndTag.lastIndexOf('/')) return false;
  const name = nameAndTag.slice(0, colon);
  const tag = nameAndTag.slice(colon + 1);
  return /^[a-z0-9]+(?:[._/:-]+[a-z0-9]+)*$/.test(name) && /^\w[\w.-]{0,127}$/.test(tag);
}

/** A problem with the root key: the variable that is wrong, and what is wrong with it. */
interface SecretKeyProblem {
  variable: string;
  message: string;
}

type SecretKeyResult = { key: Buffer } | { problem: SecretKeyProblem };

function decodeSecretKey(text: string, variable: string): SecretKeyResult {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    return { problem: { variable, message: 'must be base64 (hydra keygen prints a valid key)' } };
  }
  const key = Buffer.from(text, 'base64');
  if (key.length < 32) {
    return {
      problem: { variable, message: `must decode to 32 bytes or more, not ${String(key.length)}` },
    };
  }
  return { key };
}

/**
 * The root key from HYDRA_SECRET_KEY, or from the file in HYDRA_SECRET_KEY_FILE. It works on the
 * trimmed values of `loadConfig`, outside the zod object, so that a problem with the key is
 * reported together with the problems of the other variables. A message never has key material.
 */
function resolveSecretKey(inline: string | undefined, file: string | undefined): SecretKeyResult {
  if (inline !== undefined && file !== undefined) {
    return {
      problem: {
        variable: 'HYDRA_SECRET_KEY_FILE',
        message: 'set HYDRA_SECRET_KEY or HYDRA_SECRET_KEY_FILE, not both',
      },
    };
  }
  if (file !== undefined) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8').trim();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        problem: { variable: 'HYDRA_SECRET_KEY_FILE', message: `cannot read the file: ${reason}` },
      };
    }
    return decodeSecretKey(text, 'HYDRA_SECRET_KEY_FILE');
  }
  if (inline === undefined) {
    return {
      problem: {
        variable: 'HYDRA_SECRET_KEY',
        message: 'is required (or set HYDRA_SECRET_KEY_FILE)',
      },
    };
  }
  return decodeSecretKey(inline, 'HYDRA_SECRET_KEY');
}

const required = z.string({ error: 'is required' });
const image = required.refine(isPinnedImage, 'must be "name:tag@sha256:<64 hex digits>"');

const envSchema = z
  .object({
    HYDRA_DATA_DIR: required.transform((dir) => resolve(dir)),
    HYDRA_PUBLIC_URL: required.transform(parseOrigin),
    HYDRA_LIVE_URL: required.transform(parseOrigin),
    HYDRA_PUBLIC_IP: required.refine((ip) => isIP(ip) !== 0, 'must be an IP address'),
    HYDRA_MEDIA_PORT_RANGE: required.transform(parsePortRange),
    HYDRA_MAX_RUNNING: required.transform(parseInteger(1, 65535)),
    HYDRA_SESSION_NAMESPACE: required.regex(
      /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/,
      'must be a Kubernetes namespace name',
    ),
    HYDRA_SESSION_TRANSPORT: z.enum(SESSION_TRANSPORTS, {
      error: 'must be cluster-dns or port-forward',
    }),
    HYDRA_SESSION_IMAGE: image,
    HYDRA_MCP_IMAGE: image,
    HYDRA_TRUSTED_PROXIES: required.transform(parseProxies),
    HYDRA_DEFAULT_TIMEZONE: required.pipe(TimezoneSchema),
    HYDRA_DEFAULT_LANGUAGE: required.pipe(LanguageSchema),
    HYDRA_AUDIT_RETENTION_DAYS: required.transform(parseInteger(1, 36500)),
    HYDRA_LOG_LEVEL: z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` }),
    PORT: required.transform(parseInteger(1, 65535)),
  })
  .transform((env, ctx): Omit<Config, 'secretKey'> => {
    const publicUrl = env.HYDRA_PUBLIC_URL;
    const liveUrl = env.HYDRA_LIVE_URL;
    if (publicUrl.hostname === liveUrl.hostname) {
      addIssue(ctx, 'must use another hostname than HYDRA_PUBLIC_URL', 'HYDRA_LIVE_URL');
    } else if (siteOf(publicUrl) !== siteOf(liveUrl)) {
      // The SameSite=Strict live grant cookie needs the same site (spec section 9.2).
      addIssue(
        ctx,
        `must be on the same site (scheme and registrable domain) as HYDRA_PUBLIC_URL: ` +
          `${siteOf(liveUrl)} is not ${siteOf(publicUrl)}`,
        'HYDRA_LIVE_URL',
      );
    }

    const range = env.HYDRA_MEDIA_PORT_RANGE;
    const size = range.last - range.first + 1;
    if (size < env.HYDRA_MAX_RUNNING) {
      addIssue(
        ctx,
        `has ${String(size)} ports, fewer than HYDRA_MAX_RUNNING ` +
          `(${String(env.HYDRA_MAX_RUNNING)})`,
        'HYDRA_MEDIA_PORT_RANGE',
      );
    }

    const localUrls = isLocalhostName(publicUrl.hostname) && isLocalhostName(liveUrl.hostname);
    if (env.HYDRA_SESSION_TRANSPORT === 'port-forward' && !localUrls) {
      addIssue(
        ctx,
        'port-forward is permitted only if both URLs use localhost hostnames',
        'HYDRA_SESSION_TRANSPORT',
      );
    }

    return {
      dataDir: env.HYDRA_DATA_DIR,
      publicUrl,
      liveUrl,
      publicIp: env.HYDRA_PUBLIC_IP,
      mediaPortRange: range,
      maxRunning: env.HYDRA_MAX_RUNNING,
      sessionNamespace: env.HYDRA_SESSION_NAMESPACE,
      sessionTransport: env.HYDRA_SESSION_TRANSPORT,
      sessionImage: env.HYDRA_SESSION_IMAGE,
      mcpImage: env.HYDRA_MCP_IMAGE,
      trustedProxies: env.HYDRA_TRUSTED_PROXIES,
      defaultTimezone: env.HYDRA_DEFAULT_TIMEZONE,
      defaultLanguage: env.HYDRA_DEFAULT_LANGUAGE,
      auditRetentionDays: env.HYDRA_AUDIT_RETENTION_DAYS,
      logLevel: env.HYDRA_LOG_LEVEL,
      port: env.PORT,
    };
  });

/**
 * Reads and validates the configuration (spec section 4). Values are trimmed, and an empty value
 * counts as missing. Throws ConfigError; its message has one line for each wrong variable.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const values: Record<string, string | undefined> = {};
  for (const name of VARIABLES) {
    const value = env[name]?.trim();
    values[name] = value === '' ? undefined : value;
  }
  for (const [name, fallback] of Object.entries(CONFIG_DEFAULTS)) values[name] ??= fallback;

  // Problems with the key come first, then the problems of the other variables (schema order).
  const secret = resolveSecretKey(values.HYDRA_SECRET_KEY, values.HYDRA_SECRET_KEY_FILE);
  const result = envSchema.safeParse(values);
  if (result.success && 'key' in secret) return { ...result.data, secretKey: secret.key };

  const problems: SecretKeyProblem[] = [];
  if ('problem' in secret) problems.push(secret.problem);
  if (!result.success) {
    for (const zodIssue of result.error.issues) {
      problems.push({
        variable: typeof zodIssue.path[0] === 'string' ? zodIssue.path[0] : 'configuration',
        message: zodIssue.message,
      });
    }
  }
  throw new ConfigError(
    problems[0]?.variable ?? 'configuration',
    problems.map((problem) => `${problem.variable}: ${problem.message}`).join('\n'),
  );
}
