import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openGetStream, openRawSession, rpcMessages, type RawMcpSession } from './mcp-raw.js';

let server: http.Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current !== undefined) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
});

/** Starts a local server and returns an MCP endpoint URL on it. */
async function listen(handler: http.RequestListener): Promise<string> {
  const created = http.createServer(handler);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  const { port } = created.address() as AddressInfo;
  return `http://127.0.0.1:${port}/s/abc/mcp`;
}

function session(endpoint: string): RawMcpSession {
  return { endpoint, token: 'hyd_test', id: 'mcp-1', protocolVersion: '2025-06-18' };
}

describe('openGetStream', () => {
  it('fails with a clear error when the response headers do not arrive', async () => {
    const endpoint = await listen(() => {
      // Never answers: a proxy that buffers the headers of an idle event stream.
    });
    await expect(openGetStream(session(endpoint), 200)).rejects.toThrow(
      `No response headers for GET ${endpoint} after 200 ms`,
    );
  });

  it('sends the session headers and reports the end of the stream', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const endpoint = await listen((request, response) => {
      seen.push(request.headers);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      setTimeout(() => response.end(), 300);
    });
    const stream = await openGetStream(session(endpoint));
    expect(stream.status).toBe(200);
    expect(stream.isOpen()).toBe(true);
    await stream.closed;
    expect(stream.isOpen()).toBe(false);
    expect(seen[0]).toMatchObject({
      authorization: 'Bearer hyd_test',
      accept: 'text/event-stream',
      'mcp-session-id': 'mcp-1',
      'mcp-protocol-version': '2025-06-18',
    });
  });
});

describe('openRawSession', () => {
  it('sends initialize, then notifications/initialized with the new session headers', async () => {
    const requests: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const endpoint = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({ headers: request.headers, body });
        if (requests.length === 1) {
          const result = {
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18', capabilities: {} },
          };
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'mcp-9',
          });
          response.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
        } else {
          response.writeHead(202);
          response.end();
        }
      });
    });
    const opened = await openRawSession(endpoint, 'hyd_test');
    expect(opened).toEqual({
      endpoint,
      token: 'hyd_test',
      id: 'mcp-9',
      protocolVersion: '2025-06-18',
    });
    expect(JSON.parse(requests[0]?.body ?? '')).toMatchObject({ method: 'initialize' });
    expect(requests[1]?.headers).toMatchObject({
      authorization: 'Bearer hyd_test',
      'mcp-session-id': 'mcp-9',
      'mcp-protocol-version': '2025-06-18',
    });
    expect(JSON.parse(requests[1]?.body ?? '')).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });
});

describe('rpcMessages', () => {
  it('reads a JSON body and an event-stream body', () => {
    const message = { jsonrpc: '2.0', id: 1, result: {} };
    expect(
      rpcMessages({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      }),
    ).toEqual([message]);
    expect(
      rpcMessages({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `event: message\ndata: ${JSON.stringify(message)}\n\n`,
      }),
    ).toEqual([message]);
  });
});
