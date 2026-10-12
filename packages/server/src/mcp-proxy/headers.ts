// Header rules of the MCP proxy (spec section 8.2 step 5).
import type { IncomingHttpHeaders } from 'node:http';

export { SHARED_SECURITY_HEADERS as SECURITY_HEADERS } from '../static/headers.js';

/** The sidecar accepts only this Host, as the default host check of Playwright MCP does (spec section 7.4). */
export const UPSTREAM_HOST = 'localhost:8931';

/**
 * Request headers that go to the pod, without changes. All other client headers stay at the gateway:
 * Authorization, Cookie, hop-by-hop headers, and also Accept-Encoding (the audit copy needs plain bytes),
 * Origin, and X-Forwarded-*.
 */
export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

export function upstreamRequestHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = { host: UPSTREAM_HOST };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
}

/** Response headers that go to the client: all pod headers except hop-by-hop headers and Set-Cookie. */
export function clientResponseHeaders(
  upstream: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const listed = connectionTokens(upstream.connection);
  const headers: Record<string, string | string[]> = {};
  for (const [rawName, value] of Object.entries(upstream)) {
    const name = rawName.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name) || name === 'set-cookie')
      continue;
    headers[name] = value;
  }
  return headers;
}
