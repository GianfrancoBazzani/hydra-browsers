export const SESSION_COOKIE = '__Host-hydra_session';

// RFC 6265 section 4.1.1: token characters for the name, cookie-octet for the value.
const NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

export interface CookieOptions {
  sameSite: 'Strict' | 'Lax';
  /** Seconds. Omit for a cookie that lives until the browser closes. */
  maxAge?: number;
  /** Default '/'. `__Host-` cookies need '/'. */
  path?: string;
  /** Default true. */
  httpOnly?: boolean;
  /** Default true. `__Host-` cookies need it. */
  secure?: boolean;
}

/** Parses a `Cookie` request header. The first value of a name wins. Values are not decoded. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies = Object.create(null) as Record<string, string>;
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    let value = part.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name !== '' && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

/** Builds a `Set-Cookie` header value. Throws for a name or a value that RFC 6265 does not permit. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Cookie name is not valid: ${name}`);
  if (!VALUE_PATTERN.test(value)) throw new Error(`Cookie value is not valid for ${name}`);
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (options.secure ?? true) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

/** Spec section 6.4: HttpOnly, Secure, SameSite=Lax, Path=/. */
export function sessionCookie(value: string): string {
  return serializeCookie(SESSION_COOKIE, value, { sameSite: 'Lax' });
}

export function clearedSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, '', { sameSite: 'Lax', maxAge: 0 });
}
