import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../test/helpers/config.js';
import {
  filterResponseHeaders,
  forwardRequestHeaders,
  liveSecurityHeaders,
  upgradeResponseHead,
} from './headers.js';

describe('liveSecurityHeaders', () => {
  it('gives the live origin headers of spec section 6.8', () => {
    expect(liveSecurityHeaders(testConfig())).toEqual({
      'content-security-policy': 'frame-ancestors http://hydra.localhost',
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
  });
});

describe('forwardRequestHeaders', () => {
  it('removes credentials, the host, hop-by-hop headers, and headers that Connection lists', () => {
    expect(
      forwardRequestHeaders({
        host: 'live.hydra.localhost',
        cookie: '__Host-hydra_live_abcdefgh2345=secret',
        authorization: 'Bearer x',
        connection: 'keep-alive, x-private',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        expect: '100-continue',
        te: 'trailers',
        'x-private': '1',
        accept: 'text/html',
        'accept-language': 'en',
        'content-length': '2',
      }),
    ).toEqual({ accept: 'text/html', 'accept-language': 'en', 'content-length': '2' });
  });
});

describe('filterResponseHeaders', () => {
  it('removes Set-Cookie, the security headers of the pod, and hop-by-hop headers', () => {
    expect(
      filterResponseHeaders({
        'set-cookie': ['a=1', 'b=2'],
        'content-security-policy': "default-src 'none'",
        'content-security-policy-report-only': 'x',
        'strict-transport-security': 'max-age=1',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'unsafe-url',
        'x-frame-options': 'DENY',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'content-type': 'text/html',
        'content-length': '10',
        etag: '"x"',
        'x-neko': undefined,
      }),
    ).toEqual({ 'content-type': 'text/html', 'content-length': '10', etag: '"x"' });
  });
});

describe('upgradeResponseHead', () => {
  it('keeps the handshake headers and removes Set-Cookie', () => {
    const response = {
      rawHeaders: [
        'Upgrade',
        'websocket',
        'Connection',
        'Upgrade',
        'Sec-WebSocket-Accept',
        'abc=',
        'Set-Cookie',
        'NEKO_SESSION=x',
        'Content-Security-Policy',
        "default-src 'none'",
      ],
    } as unknown as IncomingMessage;
    expect(upgradeResponseHead(response)).toBe(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc=\r\n\r\n',
    );
  });
});
