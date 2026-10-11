import { describe, expect, it } from 'vitest';
import {
  SECURITY_HEADERS,
  UPSTREAM_HOST,
  clientResponseHeaders,
  upstreamRequestHeaders,
} from './headers.js';

describe('upstreamRequestHeaders', () => {
  it('sets Host: localhost:8931 and sends the MCP headers without changes', () => {
    const headers = upstreamRequestHeaders({
      host: 'hydra.example.com',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': '3b3a6447-dde2-4314-9531-74fbb72096be',
      'mcp-protocol-version': '2025-06-18',
      'last-event-id': '42',
    });
    expect(headers).toEqual({
      host: UPSTREAM_HOST,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': '3b3a6447-dde2-4314-9531-74fbb72096be',
      'mcp-protocol-version': '2025-06-18',
      'last-event-id': '42',
    });
    expect(UPSTREAM_HOST).toBe('localhost:8931');
  });

  it('removes Authorization, Cookie, hop-by-hop headers, and all other client headers', () => {
    const headers = upstreamRequestHeaders({
      host: 'hydra.example.com',
      authorization: 'Bearer hyd_secret',
      cookie: '__Host-hydra_session=abc',
      connection: 'keep-alive, x-hop',
      'x-hop': '1',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      trailer: 'x-checksum',
      upgrade: 'websocket',
      'proxy-authorization': 'Basic eA==',
      'accept-encoding': 'gzip',
      origin: 'https://evil.example',
      'x-forwarded-for': '203.0.113.9',
      accept: 'text/event-stream',
    });
    expect(headers).toEqual({ host: UPSTREAM_HOST, accept: 'text/event-stream' });
  });
});

describe('clientResponseHeaders', () => {
  it('keeps the MCP response headers', () => {
    expect(
      clientResponseHeaders({
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'mcp-session-id': 'abc',
        'content-length': '209',
        date: 'Sat, 10 Oct 2026 16:54:07 GMT',
      }),
    ).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'mcp-session-id': 'abc',
      'content-length': '209',
      date: 'Sat, 10 Oct 2026 16:54:07 GMT',
    });
  });

  it('removes hop-by-hop headers, headers that Connection names, and Set-Cookie', () => {
    expect(
      clientResponseHeaders({
        connection: 'keep-alive, X-Internal',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'x-internal': 'pod',
        'set-cookie': ['a=b', 'c=d'],
        'content-type': 'text/plain; charset=UTF-8',
        'proxy-authenticate': 'Basic',
        upgrade: 'h2c',
        trailer: 'x-checksum',
      }),
    ).toEqual({ 'content-type': 'text/plain; charset=UTF-8' });
  });

  it('defines the security headers of spec section 6.8', () => {
    expect(SECURITY_HEADERS).toEqual({
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
  });
});
