import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Config } from '../config/index.js';
import { SHARED_SECURITY_HEADERS } from '../static/headers.js';

type HeaderValue = string | string[] | undefined;

// Hop-by-hop headers (RFC 9110 section 7.6.1). undici also refuses most of them in a request.
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

// The pod never gets the live grant cookies or other credentials of the browser.
// undici refuses `expect`.
const REMOVED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'authorization',
  'expect',
]);

// A pod cannot set cookies or security headers on the live origin (spec sections 6.8 and 9.3).
const REMOVED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-content-type-options',
  'referrer-policy',
  'x-frame-options',
]);

/** The headers of the live origin (spec section 6.8). */
export function liveSecurityHeaders(config: Config): Record<string, string> {
  return {
    'content-security-policy': `frame-ancestors ${config.publicUrl.origin}`,
    ...SHARED_SECURITY_HEADERS,
  };
}

// Header names that the Connection header lists are hop-by-hop too.
function connectionTokens(value: HeaderValue): Set<string> {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
}

function withoutHeaders(
  headers: Record<string, HeaderValue>,
  removed: ReadonlySet<string>,
): Record<string, string | string[]> {
  const listed = connectionTokens(headers.connection);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || removed.has(lower) || listed.has(lower)) continue;
    result[lower] = value;
  }
  return result;
}

/** The browser request headers that the proxy sends to the pod. */
export function forwardRequestHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  return withoutHeaders(headers, REMOVED_REQUEST_HEADERS);
}

/** The pod response headers that the proxy sends to the browser. */
export function filterResponseHeaders(
  headers: Record<string, HeaderValue>,
): Record<string, string | string[]> {
  return withoutHeaders(headers, REMOVED_RESPONSE_HEADERS);
}

/**
 * The raw "101 Switching Protocols" head for the browser. It keeps the pod's Upgrade, Connection,
 * and Sec-WebSocket-* headers, and removes the REMOVED_RESPONSE_HEADERS (for example Set-Cookie).
 */
export function upgradeResponseHead(response: IncomingMessage): string {
  const lines = ['HTTP/1.1 101 Switching Protocols'];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index] ?? '';
    const lower = name.toLowerCase();
    const handshake = lower === 'upgrade' || lower === 'connection';
    if (!handshake && REMOVED_RESPONSE_HEADERS.has(lower)) continue;
    lines.push(`${name}: ${response.rawHeaders[index + 1] ?? ''}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}
