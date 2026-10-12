// The MCP proxy against a real @playwright/mcp 0.0.83 process with a local Chromium (spec section 15.2).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { request } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDACTION_RULES } from '../../src/audit/index.js';
import { SseParser } from '../../src/mcp-proxy/sse.js';
import { TOOL_DENY_LIST } from '../../src/mcp-proxy/index.js';
import {
  PROTOCOL_VERSION,
  apiRequest,
  createAgentToken,
  eventually,
  listAudit,
  mcpClient,
  mcpGet,
  mcpInitialize,
  mcpPost,
  seedOwnerSession,
  startGateway,
  type Gateway,
  type SeededOwner,
} from '../helpers/mcp-gateway.js';
import {
  ALL_CAPS,
  POD_HOST,
  startMcpSidecar,
  type PlaywrightMcp,
} from '../helpers/playwright-mcp.js';

const PAGE = 'data:text/html,<title>Hydra test</title><label>Secret <input id="secret"></label>';

interface TapRecord {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Tap {
  url: string;
  records: TapRecord[];
  close(): Promise<void>;
}

/** Records each request that reaches the "pod" and forwards it to Playwright MCP without changes. */
async function startTap(target: string, timeline: string[]): Promise<Tap> {
  const records: TapRecord[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');
      records.push({ method: req.method ?? '', headers: req.headers, body: text });
      if (text.includes('"tools/call"')) timeline.push('pod:tools/call');
      const upstream = http.request(
        new URL(req.url ?? '/', target),
        { method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          res.flushHeaders();
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      res.on('close', () => upstream.destroy());
      upstream.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    records,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('MCP proxy against Playwright MCP', { timeout: 60_000 }, () => {
  let pw: PlaywrightMcp;
  let tap: Tap;
  let gw: Gateway;
  let owner: SeededOwner;
  let token: { id: string; secret: string };
  const timeline: string[] = [];
  const clients: Client[] = [];

  async function connect(): Promise<ReturnType<typeof mcpClient>> {
    const agent = mcpClient(gw, owner.sessionId, token.secret);
    clients.push(agent.client);
    await agent.client.connect(agent.transport);
    return agent;
  }

  beforeAll(async () => {
    pw = await startMcpSidecar(); // the first run downloads Chromium (up to a few minutes)
  }, 600_000);

  afterAll(async () => {
    await pw.stop();
  });

  beforeEach(async () => {
    timeline.length = 0;
    tap = await startTap(pw.url, timeline);
    gw = await startGateway(tap.url);
    owner = await seedOwnerSession(gw);
    token = await createAgentToken(gw, owner.cookie, owner.sessionId);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    await gw.close();
    await tap.close();
  });

  it('connects an MCP SDK client and writes mcp.connect', async () => {
    const { client, transport } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('browser_navigate');
    const connects = await listAudit(gw, owner.cookie, owner.sessionId, 'mcp.connect');
    expect(connects).toHaveLength(1);
    expect(connects[0]).toMatchObject({
      actorType: 'token',
      actorId: token.id,
      sessionId: owner.sessionId,
      data: {
        mcpSessionId: transport.sessionId,
        clientInfo: { name: 'hydra-test', version: '1.0.0' },
        ip: '127.0.0.1',
      },
    });
    expect(await listAudit(gw, owner.cookie, owner.sessionId, 'mcp.tool_call')).toHaveLength(0);
  });

  it('writes the pending record before the pod gets the call, then ok, with redacted arguments', async () => {
    gw.deps.bus.subscribe('audit', ({ event }) => {
      if (event.kind === 'mcp.tool_call')
        timeline.push(`audit:${event.status ?? ''}:${String(event.data.tool)}`);
    });
    const { client, transport } = await connect();
    await client.callTool({ name: 'browser_navigate', arguments: { url: PAGE } });
    const typed = await client.callTool({
      name: 'browser_type',
      arguments: { target: '#secret', text: 'hunter2' },
    });
    expect(typed.isError).not.toBe(true);
    expect(timeline.slice(0, 3)).toEqual([
      'audit:pending:browser_navigate',
      'pod:tools/call',
      'audit:ok:browser_navigate',
    ]);
    const calls = await listAudit(gw, owner.cookie, owner.sessionId, 'mcp.tool_call');
    expect(calls.map((call) => [call.data.tool, call.status])).toEqual([
      ['browser_navigate', 'ok'],
      ['browser_type', 'ok'],
    ]);
    expect(calls[1]?.data).toMatchObject({
      mcpSessionId: transport.sessionId,
      tool: 'browser_type',
      arguments: { target: '#secret', text: '[redacted: 7 chars]' },
      error: null,
    });
    expect(typeof calls[1]?.data.durationMs).toBe('number');
    expect(typeof calls[1]?.data.rpcId).toBe('number');
  });

  it('records an isError result as error, and writes nothing for tools/list and ping', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'browser_click',
      arguments: { target: '#missing' },
    });
    expect(result.isError).toBe(true);
    await client.listTools();
    await client.ping();
    const calls = await listAudit(gw, owner.cookie, owner.sessionId, 'mcp.tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('error');
    const error = String(calls[0]?.data.error);
    expect(error.length).toBeGreaterThan(0);
    expect(error.length).toBeLessThanOrEqual(500);
  });

  it('answers a denied tool with a JSON-RPC error and does not send it to the pod', async () => {
    const { client } = await connect();
    const before = tap.records.length;
    const call = client.callTool({
      name: 'browser_run_code_unsafe',
      arguments: { code: 'async (page) => process.env' },
    });
    await expect(call).rejects.toBeInstanceOf(McpError);
    await expect(call).rejects.toMatchObject({ code: -32602 });
    const sent = tap.records.slice(before).map((record) => record.body);
    expect(sent.some((body) => body.includes('browser_run_code_unsafe'))).toBe(false);
    const [audit] = await listAudit(gw, owner.cookie, owner.sessionId, 'mcp.tool_call');
    expect(audit).toMatchObject({
      status: 'error',
      data: {
        tool: 'browser_run_code_unsafe',
        arguments: { code: 'async (page) => process.env' },
        durationMs: 0,
      },
    });
    expect(String(audit?.data.error)).toContain('blocked by the Hydra gateway');
  });

  it('removes Authorization, Cookie, and hop-by-hop headers, sets Host, and keeps the MCP headers', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: gw.port,
          method: 'POST',
          path: `/s/${owner.sessionId}/mcp`,
          headers: {
            host: gw.deps.config.publicUrl.host,
            authorization: `Bearer ${token.secret}`,
            cookie: '__Host-hydra_session=abc',
            connection: 'keep-alive, x-hop',
            'x-hop': '1',
            'keep-alive': 'timeout=5',
            te: 'trailers',
            'proxy-authorization': 'Basic eA==',
            'accept-encoding': 'gzip',
            origin: 'http://evil.example',
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': PROTOCOL_VERSION,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'raw', version: '0' },
          },
        }),
      );
    });
    expect(status).toBe(200);
    const seen = tap.records.at(-1)?.headers ?? {};
    expect(seen.host).toBe(POD_HOST);
    expect(seen.accept).toBe('application/json, text/event-stream');
    expect(seen['content-type']).toBe('application/json');
    expect(seen['mcp-protocol-version']).toBe(PROTOCOL_VERSION);
    for (const name of [
      'authorization',
      'cookie',
      'x-hop',
      'keep-alive',
      'te',
      'proxy-authorization',
      'accept-encoding',
      'origin',
    ]) {
      expect(seen[name], name).toBeUndefined();
    }
  });

  it('needs the Host rewrite: Playwright MCP rejects other Host values', async () => {
    const res = await request(`${pw.url}/mcp`, {
      method: 'POST',
      headers: {
        host: gw.deps.config.publicUrl.host,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(await res.body.text()).toBe(`Access is only allowed at ${POD_HOST}`);
  });

  it('passes the 404 of an unknown Mcp-Session-Id without changes (pod restart)', async () => {
    const res = await mcpPost(
      gw,
      owner.sessionId,
      token.secret,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'mcp-session-id': '00000000-0000-4000-8000-000000000000' },
    );
    expect(res.statusCode).toBe(404);
    expect(await res.body.text()).toBe('Session not found');
    expect(tap.records.at(-1)?.headers['mcp-session-id']).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
  });

  it('streams the GET stream without a buffer: the server ping arrives while the stream is open', async () => {
    const mcpSessionId = await mcpInitialize(gw, owner.sessionId, token.secret);
    const get = await mcpGet(gw, owner.sessionId, token.secret, mcpSessionId);
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('text/event-stream');
    const parser = new SseParser();
    let ended = false;
    get.body.on('end', () => {
      ended = true;
    });
    const ping = new Promise<string>((resolve) => {
      get.body.on('data', (chunk: Buffer) => {
        for (const event of parser.push(chunk))
          if (event.data.includes('"ping"')) resolve(event.data);
      });
    });
    // Playwright MCP starts its heartbeat (a ping every 3 s) after the first tool call.
    const call = await mcpPost(
      gw,
      owner.sessionId,
      token.secret,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: PAGE } },
      },
      { 'mcp-session-id': mcpSessionId },
    );
    await call.body.text();
    expect(JSON.parse(await ping)).toMatchObject({ jsonrpc: '2.0', method: 'ping' });
    expect(ended).toBe(false);
    get.body.destroy();
  });

  it('closes the MCP streams of a revoked token at once; a pending call gets "stream closed"; then 401', async () => {
    const mcpSessionId = await mcpInitialize(gw, owner.sessionId, token.secret);
    const sessionHeader = { 'mcp-session-id': mcpSessionId };
    const navigate = await mcpPost(
      gw,
      owner.sessionId,
      token.secret,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: PAGE } },
      },
      sessionHeader,
    );
    await navigate.body.text();
    const get = await mcpGet(gw, owner.sessionId, token.secret, mcpSessionId);
    const getClosed = new Promise<void>((resolve) => {
      get.body.on('error', () => {
        resolve();
      });
      get.body.on('end', () => {
        resolve();
      });
      get.body.resume();
    });
    const slow = await mcpPost(
      gw,
      owner.sessionId,
      token.secret,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'browser_wait_for', arguments: { time: 5 } },
      },
      sessionHeader,
    );
    const slowOutcome = slow.body.text().then(
      () => 'ended',
      () => 'aborted',
    );
    await eventually(() => {
      expect(gw.deps.mcpStreams.size()).toBe(2);
    });
    const revoke = await apiRequest(
      gw,
      owner.cookie,
      'DELETE',
      `/api/sessions/${owner.sessionId}/tokens/${token.id}`,
      {},
    );
    expect(revoke.statusCode).toBeLessThan(300);
    expect(gw.deps.mcpStreams.size()).toBe(0);
    await getClosed;
    expect(await slowOutcome).toBe('aborted');
    const calls = await listAudit(gw, owner.cookie, owner.sessionId, 'mcp.tool_call');
    const waitFor = calls.find((call) => call.data.tool === 'browser_wait_for');
    expect(waitFor).toMatchObject({ status: 'error', data: { error: 'stream closed' } });
    const after = await mcpPost(
      gw,
      owner.sessionId,
      token.secret,
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      sessionHeader,
    );
    expect(after.statusCode).toBe(401);
    expect(after.headers['www-authenticate']).toBe('Bearer realm="hydra"');
    await after.body.text();
  });

  it('has a redaction rule for each tool that Playwright MCP lists with all capabilities', async () => {
    const all = await startMcpSidecar({ caps: ALL_CAPS });
    const allGw = await startGateway(all.url);
    try {
      const allOwner = await seedOwnerSession(allGw);
      const allToken = await createAgentToken(allGw, allOwner.cookie, allOwner.sessionId);
      const { client, transport } = mcpClient(allGw, allOwner.sessionId, allToken.secret);
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      await client.close();
      expect(names).toHaveLength(74);
      expect(names.filter((name) => !Object.hasOwn(REDACTION_RULES, name))).toEqual([]);
      expect(names.filter((name) => TOOL_DENY_LIST.has(name))).toEqual(['browser_run_code_unsafe']);
    } finally {
      await allGw.close();
      await all.stop();
    }
  }, 120_000);
});
