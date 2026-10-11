// The MCP endpoint in front of a fake pod: checks, limits, deny list, headers, streaming, closing.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions } from '../../src/db/schema.js';
import { runMcpConnectionCheck } from '../../src/mcp-proxy/index.js';
import {
  BODY_TOO_LARGE_MESSAGE,
  POD_DISPATCHER_OPTIONS,
  SESSION_NOT_RUNNING_BODY,
} from '../../src/mcp-proxy/routes.js';
import { seedSession } from '../helpers/seed.js';
import {
  MCP_ACCEPT,
  apiRequest,
  createAgentToken,
  eventually,
  listAudit,
  mcpGet,
  mcpPost,
  seedOwnerSession,
  startGateway,
  type Gateway,
  type SeededOwner,
} from '../helpers/mcp-gateway.js';

interface PodRequest {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface FakePod {
  url: string;
  requests: PodRequest[];
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;
  close(): Promise<void>;
}

/** A fake pod: records each request and answers with `handler` (default: 202, as for a notification). */
async function startFakePod(): Promise<FakePod> {
  const server = http.createServer();
  const pod: FakePod = {
    url: '',
    requests: [],
    handler: (_req, res) => {
      res.writeHead(202, { 'content-type': 'text/plain; charset=UTF-8' });
      res.end();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      pod.requests.push({ method: req.method ?? '', headers: req.headers, body });
      pod.handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  pod.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return pod;
}

const ping = (id: number): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
const toolCall = (id: number, name: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('MCP endpoint in front of a fake pod', { timeout: 30_000 }, () => {
  let pod: FakePod;
  let gw: Gateway;
  let owner: SeededOwner;
  let token: { id: string; secret: string };

  const path = (): string => `/s/${owner.sessionId}/mcp`;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    host: gw.deps.config.publicUrl.host,
    authorization: `Bearer ${token.secret}`,
    accept: MCP_ACCEPT,
    'content-type': 'application/json',
    ...extra,
  });
  const post = (payload: string | Buffer, extra: Record<string, string> = {}) =>
    gw.app.inject({ method: 'POST', url: path(), headers: headers(extra), payload });
  const toolCallAudits = () => listAudit(gw, owner.cookie, owner.sessionId, 'mcp.tool_call');

  beforeEach(async () => {
    pod = await startFakePod();
    gw = await startGateway(pod.url);
    owner = await seedOwnerSession(gw);
    token = await createAgentToken(gw, owner.cookie, owner.sessionId);
  });

  afterEach(async () => {
    await gw.close();
    await pod.close();
  });

  describe('checks before the pod (spec section 8.2 steps 1 to 3)', () => {
    async function expect401(authorization: string | undefined): Promise<void> {
      const base = headers();
      const sent: Record<string, string> = { ...base };
      if (authorization === undefined) delete sent.authorization;
      else sent.authorization = authorization;
      const res = await gw.app.inject({
        method: 'POST',
        url: path(),
        headers: sent,
        payload: ping(1),
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="hydra"');
      expect(res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    }

    it('answers 401 with WWW-Authenticate without a token and with an unknown token', async () => {
      await expect401(undefined);
      await expect401('Bearer hyd_unknown');
      await expect401(`Basic ${token.secret}`);
      expect(pod.requests).toHaveLength(0);
    });

    it('answers 401 for a token of another session, a revoked token, and an expired token', async () => {
      const other = seedSession(gw.deps, { ownerId: owner.userId, state: 'running' });
      const otherToken = await createAgentToken(gw, owner.cookie, other.id);
      await expect401(`Bearer ${otherToken.secret}`);

      const revoked = await createAgentToken(gw, owner.cookie, owner.sessionId);
      const revoke = await apiRequest(
        gw,
        owner.cookie,
        'DELETE',
        `/api/sessions/${owner.sessionId}/tokens/${revoked.id}`,
        {},
      );
      expect(revoke.statusCode).toBeLessThan(300);
      await expect401(`Bearer ${revoked.secret}`);

      gw.clock.advance(31 * 24 * 60 * 60 * 1000);
      await expect401(`Bearer ${token.secret}`);
      expect(pod.requests).toHaveLength(0);
    });

    it('answers 401 for a token of a session with desired_state deleted, also while its state is running', async () => {
      gw.deps.db
        .update(sessions)
        .set({ desiredState: 'deleted' })
        .where(eq(sessions.id, owner.sessionId))
        .run();
      const res = await post(ping(1));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
      expect(pod.requests).toHaveLength(0);
    });

    it('answers 404 on a host other than HYDRA_PUBLIC_URL', async () => {
      const res = await gw.app.inject({
        method: 'POST',
        url: path(),
        headers: headers({ host: 'other.example' }),
        payload: ping(1),
      });
      expect(res.statusCode).toBe(404);
      expect(pod.requests).toHaveLength(0);
    });

    it('answers 503 with the exact JSON-RPC body when the session is not running', async () => {
      for (const state of ['stopped', 'starting', 'error'] as const) {
        const session = seedSession(gw.deps, { ownerId: owner.userId, state });
        const sessionToken = await createAgentToken(gw, owner.cookie, session.id);
        const res = await gw.app.inject({
          method: 'POST',
          url: `/s/${session.id}/mcp`,
          headers: headers({ authorization: `Bearer ${sessionToken.secret}` }),
          payload: ping(1),
        });
        expect(res.statusCode).toBe(503);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.body).toBe(
          '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Session is not running. Start it in the dashboard."},"id":null}',
        );
        expect(res.body).toBe(SESSION_NOT_RUNNING_BODY);
      }
      expect(pod.requests).toHaveLength(0);
    });

    it('answers 429 rate_limited after 20 requests in one second, and accepts the next second', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await post(INITIALIZED);
        expect(res.statusCode).toBe(202);
      }
      const limited = await post(ping(21));
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
      expect(limited.headers['retry-after']).toBe('1');
      expect(pod.requests).toHaveLength(20);
      gw.clock.advance(1_000);
      expect((await post(INITIALIZED)).statusCode).toBe(202);
    });

    it('answers 413 for a body larger than 1 MiB and accepts a body of exactly 1 MiB', async () => {
      const big = await post(Buffer.alloc(1024 * 1024 + 1, 0x20));
      expect(big.statusCode).toBe(413);
      expect(big.json()).toEqual({
        error: { code: 'body_too_large', message: BODY_TOO_LARGE_MESSAGE },
      });
      const notification = Buffer.from(INITIALIZED);
      const exact = Buffer.concat([
        notification,
        Buffer.alloc(1024 * 1024 - notification.length, 0x20),
      ]);
      expect((await post(exact)).statusCode).toBe(202);
      expect(pod.requests).toHaveLength(1);
    });
  });

  describe('inspection (spec section 8.2 step 4)', () => {
    it('answers 400 with a JSON-RPC parse error for a body that is not JSON', async () => {
      const res = await post('{"jsonrpc":');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
      expect(pod.requests).toHaveLength(0);
    });

    it('answers 400 for a batch with more than 100 messages', async () => {
      const batch = Array.from({ length: 101 }, (_, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: 'ping',
      }));
      const res = await post(JSON.stringify(batch));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: -32600 } });
      expect(pod.requests).toHaveLength(0);
    });

    it('rejects a batch with a denied tool call, answers each request, and audits each tool call', async () => {
      const batch = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'browser_run_code_unsafe', arguments: { code: 'async () => 1' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'browser_type', arguments: { target: 'e1', text: 'secret' } },
        },
        { jsonrpc: '2.0', id: 3, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ];
      const res = await post(JSON.stringify(batch));
      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: number; error: { code: number; message: string } }[]>();
      expect(body.map((entry) => [entry.id, entry.error.code])).toEqual([
        [1, -32602],
        [2, -32602],
        [3, -32602],
      ]);
      expect(body[0]?.error.message).toContain('browser_run_code_unsafe');
      expect(body[1]?.error.message).toContain('Batch rejected');
      expect(pod.requests).toHaveLength(0);
      const audits = await toolCallAudits();
      expect(audits.map((event) => [event.data.tool, event.status])).toEqual([
        ['browser_run_code_unsafe', 'error'],
        ['browser_type', 'error'],
      ]);
      expect(audits[1]?.data.arguments).toEqual({ target: 'e1', text: '[redacted: 6 chars]' });
    });

    it('stores the tool name, the request id, and the MCP session id of a rejected call cut to 200 characters', async () => {
      const batch = [
        {
          jsonrpc: '2.0',
          id: 'i'.repeat(5000),
          method: 'tools/call',
          params: { name: 't'.repeat(5000) },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_run_code' } },
      ];
      const res = await post(JSON.stringify(batch), { 'mcp-session-id': 'm'.repeat(5000) });
      expect(res.statusCode).toBe(200);
      const [long] = await toolCallAudits();
      for (const key of ['tool', 'rpcId', 'mcpSessionId']) {
        expect((long?.data[key] as string).length).toBe(200);
      }
    });

    it('also rejects the old tool name browser_run_code', async () => {
      const res = await post(toolCall(7, 'browser_run_code'));
      expect(res.json()).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32602 } });
      expect(pod.requests).toHaveLength(0);
    });
  });

  describe('proxy (spec section 8.2 steps 5 and 6)', () => {
    it('sends the exact body and the MCP headers, and returns the response without hop-by-hop headers and Set-Cookie', async () => {
      pod.handler = (_req, res, body) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'm-1',
          'set-cookie': 'pod=1',
          connection: 'x-internal',
          'x-internal': 'secret',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { bytes: body.length } }));
      };
      const raw = '{ "jsonrpc" : "2.0",\n "id": 1, "method": "ping" }';
      const res = await post(raw, {
        'mcp-session-id': 'm-1',
        'mcp-protocol-version': '2025-06-18',
        cookie: 'a=b',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { bytes: Buffer.byteLength(raw) },
      });
      const seen = pod.requests[0];
      expect(seen?.body.toString('utf8')).toBe(raw);
      expect(seen?.headers).toMatchObject({
        host: 'localhost:8931',
        'mcp-session-id': 'm-1',
        'mcp-protocol-version': '2025-06-18',
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
      });
      expect(seen?.headers.authorization).toBeUndefined();
      expect(seen?.headers.cookie).toBeUndefined();
      expect(res.headers['mcp-session-id']).toBe('m-1');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-internal']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('keeps the gateway security headers when the pod sends headers of the same name', async () => {
      pod.handler = (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'referrer-policy': 'unsafe-url',
          'x-content-type-options': 'x',
          'strict-transport-security': 'max-age=0',
        });
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      };
      const res = await post(ping(1));
      expect(res.statusCode).toBe(200);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
    });

    it('sends GET and DELETE without a body and returns the pod status', async () => {
      pod.handler = (_req, res) => {
        res.writeHead(405);
        res.end();
      };
      const get = await gw.app.inject({
        method: 'GET',
        url: path(),
        headers: headers({ 'mcp-session-id': 'm-1' }),
      });
      const del = await gw.app.inject({
        method: 'DELETE',
        url: path(),
        headers: headers({ 'mcp-session-id': 'm-1' }),
      });
      expect([get.statusCode, del.statusCode]).toEqual([405, 405]);
      expect(pod.requests.map((r) => [r.method, r.body.length])).toEqual([
        ['GET', 0],
        ['DELETE', 0],
      ]);
    });

    it('does not send the body of a DELETE to the pod', async () => {
      pod.handler = (_req, res) => {
        res.writeHead(200);
        res.end();
      };
      const del = await gw.app.inject({
        method: 'DELETE',
        url: path(),
        headers: headers({ 'mcp-session-id': 'm-1' }),
        payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      });
      expect(del.statusCode).toBe(200);
      expect(pod.requests.map((r) => [r.method, r.body.length])).toEqual([['DELETE', 0]]);
    });

    it('does not proxy HEAD /s/:sid/mcp', async () => {
      const head = await gw.app.inject({
        method: 'HEAD',
        url: path(),
        headers: headers({ 'mcp-session-id': 'm-1' }),
      });
      expect([404, 405]).toContain(head.statusCode);
      expect(pod.requests).toHaveLength(0);
    });

    it('sends each SSE event to the client at once, before the pod sends the next one', async () => {
      let secondSent = false;
      pod.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"n":1}}\n\n',
        );
        setTimeout(() => {
          secondSent = true;
          res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
        }, 500);
      };
      const res = await mcpPost(gw, owner.sessionId, token.secret, ping(1));
      expect(res.headers['content-type']).toBe('text/event-stream');
      const chunks: { text: string; secondSent: boolean }[] = [];
      for await (const chunk of res.body) {
        chunks.push({ text: (chunk as Buffer).toString('utf8'), secondSent });
      }
      expect(chunks[0]?.text).toContain('"n":1');
      expect(chunks[0]?.secondSent).toBe(false);
      expect(chunks.map((c) => c.text).join('')).toContain('"result":{}');
    });

    it('sends the response headers at once, before the first event', async () => {
      pod.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        setTimeout(() => {
          res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
        }, 1_000);
      };
      const started = Date.now();
      const res = await mcpPost(gw, owner.sessionId, token.secret, ping(1));
      expect(Date.now() - started).toBeLessThan(500);
      await res.body.text();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });

    it('answers 502 with a JSON-RPC error when the pod does not answer, and marks the tool call', async () => {
      await pod.close();
      const res = await post(toolCall(4, 'browser_snapshot'));
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
      const [audit] = await toolCallAudits();
      expect(audit).toMatchObject({ status: 'error', data: { error: 'MCP server not reachable' } });
    });
  });

  describe('open MCP streams (spec section 8.3)', () => {
    async function openGetStream(): Promise<{ closed: Promise<void> }> {
      pod.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
      };
      const res = await mcpGet(gw, owner.sessionId, token.secret, 'm-1');
      expect(res.statusCode).toBe(200);
      const closed = new Promise<void>((resolve) => {
        res.body.on('error', () => {
          resolve();
        });
        res.body.on('end', () => {
          resolve();
        });
        res.body.resume();
      });
      return { closed };
    }

    it('keeps the stream on starting and running, and closes it on another state', async () => {
      const stream = await openGetStream();
      expect(gw.deps.mcpStreams.size()).toBe(1);
      const event = {
        type: 'session.state',
        sessionId: owner.sessionId,
        errorReason: null,
      } as const;
      gw.deps.bus.publish({ ...event, state: 'starting', previous: 'running' });
      gw.deps.bus.publish({ ...event, state: 'running', previous: 'starting' });
      expect(gw.deps.mcpStreams.size()).toBe(1);
      gw.deps.bus.publish({ ...event, state: 'stopping', previous: 'running' });
      expect(gw.deps.mcpStreams.size()).toBe(0);
      await stream.closed;
    });

    it('closes the stream of an expired token in the connection check', async () => {
      const stream = await openGetStream();
      expect(runMcpConnectionCheck(gw.deps)).toBe(0);
      gw.clock.advance(31 * 24 * 60 * 60 * 1000);
      expect(runMcpConnectionCheck(gw.deps)).toBe(1);
      await stream.closed;
    });

    it('removes the entry when the client closes the stream', async () => {
      pod.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
      };
      const controller = new AbortController();
      const res = await mcpGet(gw, owner.sessionId, token.secret, 'm-1', controller.signal);
      res.body.on('error', () => undefined);
      expect(gw.deps.mcpStreams.size()).toBe(1);
      controller.abort();
      await eventually(() => {
        expect(gw.deps.mcpStreams.size()).toBe(0);
      });
    });
  });

  describe('review focus', () => {
    it('marks a tool call "stream closed" and aborts the pod request when the agent cancels it', async () => {
      let podSawClose = false;
      pod.handler = (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        req.socket.on('close', () => {
          podSawClose = true;
        });
      };
      const controller = new AbortController();
      const call = toolCall(9, 'browser_wait_for', { time: 5 });
      const res = await mcpPost(gw, owner.sessionId, token.secret, call, {}, controller.signal);
      res.body.on('error', () => undefined);
      expect(gw.deps.mcpStreams.size()).toBe(1);
      controller.abort();
      await eventually(() => {
        expect(gw.deps.mcpStreams.size()).toBe(0);
        expect(podSawClose).toBe(true);
      });
      const [audit] = await toolCallAudits();
      expect(audit).toMatchObject({ status: 'error', data: { error: 'stream closed' } });
    });

    it('ends the client stream and marks the call "stream closed" when the pod dies during the stream', async () => {
      pod.handler = (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
        setTimeout(() => req.socket.destroy(), 100);
      };
      const res = await mcpPost(
        gw,
        owner.sessionId,
        token.secret,
        toolCall(10, 'browser_wait_for', { time: 5 }),
      );
      const outcome = await res.body.text().then(
        () => 'ended',
        () => 'aborted',
      );
      expect(outcome).toBe('aborted');
      await eventually(() => {
        expect(gw.deps.mcpStreams.size()).toBe(0);
      });
      const [audit] = await toolCallAudits();
      expect(audit).toMatchObject({ status: 'error', data: { error: 'stream closed' } });
    });

    it('passes a 5 MiB result event byte for byte and records ok', async () => {
      const image = 'A'.repeat(5 * 1024 * 1024);
      const result = { content: [{ type: 'image', data: image, mimeType: 'image/png' }] };
      const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 11, result })}\n\n`;
      pod.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(event);
      };
      const res = await mcpPost(
        gw,
        owner.sessionId,
        token.secret,
        toolCall(11, 'browser_take_screenshot'),
      );
      const text = await res.body.text();
      expect(text.length).toBe(event.length);
      expect(text === event).toBe(true);
      const [audit] = await toolCallAudits();
      expect(audit).toMatchObject({
        status: 'ok',
        data: { tool: 'browser_take_screenshot', error: null },
      });
    });

    it('answers 500, does not call the pod, and finishes the earlier pending rows when an audit write fails in a batch', async () => {
      const write = gw.deps.audit.write.bind(gw.deps.audit);
      let toolCallWrites = 0;
      vi.spyOn(gw.deps.audit, 'write').mockImplementation((input) => {
        if (input.kind === 'mcp.tool_call') {
          toolCallWrites += 1;
          if (toolCallWrites === 2) throw new Error('audit write failed');
        }
        return write(input);
      });
      const batch = [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_snapshot' } },
      ];
      const res = await post(JSON.stringify(batch));
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: { code: 'internal' } });
      expect(pod.requests).toHaveLength(0);
      const audits = await toolCallAudits();
      expect(audits.map((event) => [event.status, event.data.error])).toEqual([
        ['error', 'stream closed'],
      ]);
    });

    it('finishes the pending call when the pod answers with an error status and an empty body', async () => {
      pod.handler = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      const res = await post(toolCall(12, 'browser_snapshot'));
      expect(res.statusCode).toBe(500);
      const [audit] = await toolCallAudits();
      expect(audit).toMatchObject({ status: 'error', data: { error: 'HTTP 500' } });
    });

    it('uses no headers timeout and no body timeout for the requests to the pod', () => {
      expect(POD_DISPATCHER_OPTIONS).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
    });
  });
});
