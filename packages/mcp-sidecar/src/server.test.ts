import { request } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SidecarServer } from './server.js';

let server: SidecarServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function call(
  port: number,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  });
}

function post(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: 'localhost:8931',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const log = { info: () => undefined, error: () => undefined };

describe('SidecarServer', () => {
  it('checks the Host, answers 503 while not connected, and 404 for an unknown MCP session', async () => {
    server = new SidecarServer({
      allowedHosts: ['localhost:8931'],
      connectSession: () => Promise.resolve(),
      log,
    });
    const port = await server.listen('127.0.0.1', 0);
    expect((await call(port, 'evil.example:8931')).status).toBe(403);
    expect((await call(port, 'localhost:8931')).status).toBe(503);
    server.setConnected(true);
    const unknown = await call(port, 'localhost:8931', { 'mcp-session-id': 'nope' });
    expect(unknown.status).toBe(404);
  });

  it('ends all MCP sessions at a disconnect: after the reconnect, an old session ID gets 404', async () => {
    server = new SidecarServer({
      allowedHosts: ['localhost:8931'],
      log,
      connectSession: async (transport) => {
        const mcp = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });
        await mcp.connect(transport);
      },
    });
    const port = await server.listen('127.0.0.1', 0);
    server.setConnected(true);
    const init = await post(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
    const headers = { 'mcp-session-id': String(sessionId), 'mcp-protocol-version': '2025-06-18' };
    expect((await post(port, ping, headers)).status).toBe(200);
    server.setConnected(false);
    server.setConnected(true);
    expect((await post(port, ping, headers)).status).toBe(404);
  });
});
