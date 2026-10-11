const LIVE_COOKIE_PREFIX = '__Host-hydra_live_';

/** The name of the live grant cookie of one session (spec section 9.2). */
export function liveCookieName(sessionId: string): string {
  return `${LIVE_COOKIE_PREFIX}${sessionId}`;
}

/** The Set-Cookie value of a new grant. The __Host- prefix needs Secure, Path=/, and no Domain. */
export function serializeLiveCookie(sessionId: string, value: string): string {
  return `${liveCookieName(sessionId)}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** The value of the first cookie with this name in a Cookie request header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}
