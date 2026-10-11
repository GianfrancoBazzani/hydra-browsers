import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { liveCookieName, liveStatus, wsUpgradeStatus } from './live.js';

let server: http.Server | undefined;
const sockets = new Set<Socket>();

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current !== undefined) {
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
      current.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });
  }
});

describe('liveStatus', () => {
  it('sends only the grant cookie of the session and returns the status', async () => {
    const seen: Array<{ url: string | undefined; cookie: string | undefined }> = [];
    const created = http.createServer((request, response) => {
      seen.push({ url: request.url, cookie: request.headers.cookie });
      response.writeHead(401);
      response.end();
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
    const { port } = created.address() as AddressInfo;

    expect(await liveStatus('abc', 'grant-1', `http://127.0.0.1:${port}`)).toBe(401);
    expect(seen).toEqual([{ url: '/s/abc/', cookie: `${liveCookieName('abc')}=grant-1` }]);
  });

  it('returns 0 when the request fails, so that expect.poll keeps polling', async () => {
    expect(await liveStatus('abc', 'grant-1', 'http://127.0.0.1:1')).toBe(0);
  });
});

describe('wsUpgradeStatus', () => {
  it('returns 101 for an accepted upgrade and the refusal status otherwise', async () => {
    const seen: Array<string | undefined> = [];
    const created = http.createServer();
    // The close of the server waits for upgraded sockets, which it does not track.
    created.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    });
    created.on('upgrade', (request, socket) => {
      seen.push(request.headers.origin);
      if (request.headers.origin === 'http://evil.example') {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
    const { port } = created.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/s/abc/api/ws`;

    expect(await wsUpgradeStatus(url, { origin: `http://127.0.0.1:${port}` })).toBe(101);
    expect(await wsUpgradeStatus(url, { origin: 'http://evil.example' })).toBe(403);
    expect(seen).toEqual([`http://127.0.0.1:${port}`, 'http://evil.example']);
  });

  it('returns 0 when the request fails', async () => {
    expect(await wsUpgradeStatus('ws://127.0.0.1:1/', {})).toBe(0);
  });
});
