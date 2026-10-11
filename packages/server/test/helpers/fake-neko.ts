import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface FakeNekoUpgrade {
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
}

export interface FakeNeko {
  url: string;
  upgrades: FakeNekoUpgrade[];
  /**
   * What the next upgrades get: 'accept' (101, the default), 'refuse' (a plain 403 HTTP response)
   * or 'hold' (no answer at all, the connection stays open).
   */
  upgradeMode: 'accept' | 'refuse' | 'hold';
  stop(): Promise<void>;
}

/** An unmasked text frame (server to client), payload shorter than 126 bytes. */
export function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** A masked text frame (client to server), payload shorter than 126 bytes. */
export function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

/**
 * A fake Neko server (HTTP and WebSocket) for the live proxy tests.
 * - GET / and GET /?…: an HTML page with the headers that the proxy must remove.
 * - Other HTTP requests: JSON echo of { method, url, headers, body }.
 * - WebSocket upgrade: records path, query, and headers, answers 101 (with a Set-Cookie header that
 *   the proxy must remove), sends the text frame "hello", and then echoes all bytes unparsed.
 *   With upgradeMode 'refuse' it answers 403, with 'hold' it records the upgrade and stays silent.
 */
export async function startFakeNeko(): Promise<FakeNeko> {
  const upgrades: FakeNekoUpgrade[] = [];
  const sockets = new Set<Socket>();
  const state: Pick<FakeNeko, 'upgradeMode'> = { upgradeMode: 'accept' };
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.url === '/' || request.url?.startsWith('/?') === true) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'NEKO_SESSION=abc; Path=/',
          'content-security-policy': "default-src 'none'",
          'x-frame-options': 'DENY',
          'strict-transport-security': 'max-age=1',
          'referrer-policy': 'unsafe-url',
          'x-neko': 'fake',
        });
        response.end('<!doctype html><title>neko</title>');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        }),
      );
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', 'http://neko.invalid');
    upgrades.push({ path: url.pathname, query: url.searchParams, headers: request.headers });
    if (state.upgradeMode === 'hold') return;
    if (state.upgradeMode === 'refuse') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${String(request.headers['sec-websocket-key'])}${WS_GUID}`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        'Set-Cookie: NEKO_SESSION=abc; Path=/',
        '',
        '',
      ].join('\r\n'),
    );
    socket.write(serverTextFrame('hello'));
    socket.on('data', (chunk: Buffer) => socket.write(chunk));
    socket.on('end', () => socket.end());
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    upgrades,
    get upgradeMode() {
      return state.upgradeMode;
    },
    set upgradeMode(mode) {
      state.upgradeMode = mode;
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

export interface TestWebSocket {
  statusCode: number;
  headers: IncomingHttpHeaders;
  /** The upgraded socket, or null when the gateway refused the upgrade. */
  socket: Socket | null;
  /** All bytes received after the handshake. */
  received(): Buffer;
  /** Resolves when the socket closes. */
  closed: Promise<void>;
}

/** Opens a WebSocket to the gateway (handshake only, no frame parsing) with this Host header. */
export function openLiveWebSocket(options: {
  port: number;
  host: string;
  path: string;
  cookie?: string;
  /** The Origin header; a browser always sends it, so it is absent unless given. */
  origin?: string;
}): Promise<TestWebSocket> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: options.port,
      path: options.path,
      headers: {
        host: options.host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
    });
    request.on('upgrade', (response, socket, head) => {
      const chunks: Buffer[] = [head];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', () => socket.destroy());
      const closed = new Promise<void>((done) => {
        socket.once('close', () => {
          done();
        });
      });
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        socket,
        received: () => Buffer.concat(chunks),
        closed,
      });
    });
    request.on('response', (response) => {
      response.resume();
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        socket: null,
        received: () => Buffer.alloc(0),
        closed: Promise.resolve(),
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/** Polls the condition every 10 ms until it is true. Fails after the timeout. */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
