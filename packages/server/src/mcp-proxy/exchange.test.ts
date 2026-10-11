import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@hydra/shared';
import { FakeClock } from '../../test/helpers/clock.js';
import type { AuditInput, AuditWriter } from '../audit/index.js';
import { createLogger } from '../lib/logger.js';
import { McpExchange, STREAM_CLOSED } from './exchange.js';
import { parseJsonRpcBody, type JsonRpcMessage } from './jsonrpc.js';

const principal = { tokenId: 'tok1', userId: 'user1', sessionId: 'sess1' };

/** In-memory AuditWriter: the same write() and update() as plan 02, without a database. */
class MemoryAudit implements Pick<AuditWriter, 'write' | 'update'> {
  readonly events: AuditEvent[] = [];
  readonly #clock: FakeClock;

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  write(input: AuditInput): AuditEvent {
    const event: AuditEvent = {
      id: this.events.length + 1,
      ts: this.#clock.now(),
      kind: input.kind,
      actorType: input.actorType,
      actorId: input.actorId,
      actorName: null,
      sessionId: input.sessionId,
      status: input.status ?? null,
      data: structuredClone(input.data),
    };
    this.events.push(event);
    return structuredClone(event);
  }

  update(
    id: number,
    patch: { status?: 'ok' | 'error'; data?: Record<string, unknown> },
  ): AuditEvent {
    const event = this.events.find((candidate) => candidate.id === id);
    if (event === undefined) throw new Error(`no audit event ${String(id)}`);
    if (patch.status !== undefined) event.status = patch.status;
    if (patch.data !== undefined) event.data = structuredClone(patch.data);
    return structuredClone(event);
  }
}

function setup(
  mcpSessionId: string | null = 'mcp-1',
  wrapAudit: (memory: MemoryAudit) => Pick<AuditWriter, 'write' | 'update'> = (memory) => memory,
) {
  const clock = new FakeClock(1_000_000);
  const memory = new MemoryAudit(clock);
  const exchange = new McpExchange(
    { audit: wrapAudit(memory), clock, logger: createLogger('fatal') },
    { principal, mcpSessionId, ip: '203.0.113.7' },
  );
  return { clock, exchange, events: () => memory.events };
}

function messages(body: unknown): JsonRpcMessage[] {
  const parsed = parseJsonRpcBody(new TextEncoder().encode(JSON.stringify(body)));
  if (!parsed.ok) throw new Error('bad body');
  return parsed.messages;
}

const sse = (...payloads: unknown[]): Buffer =>
  Buffer.from(
    payloads.map((payload) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`).join(''),
  );

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'mcp-session-id': 'mcp-1' };

const typeCall = {
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'browser_type', arguments: { target: 'e1', text: 'hunter2' } },
};

describe('McpExchange', () => {
  it('writes a pending record with redacted arguments before anything is sent', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    expect(events()).toEqual([
      expect.objectContaining({
        kind: 'mcp.tool_call',
        actorType: 'token',
        actorId: 'tok1',
        sessionId: 'sess1',
        status: 'pending',
        data: {
          mcpSessionId: 'mcp-1',
          rpcId: 7,
          tool: 'browser_type',
          arguments: { target: 'e1', text: '[redacted: 7 chars]' },
          durationMs: null,
          error: null,
        },
      }),
    ]);
    expect(exchange.pendingCalls).toBe(1);
  });

  it('sets ok and durationMs when the result arrives in the SSE stream', () => {
    const { exchange, events, clock } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, SSE_HEADERS);
    clock.advance(230);
    const chunk = sse({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'done' }] },
    });
    exchange.data(chunk.subarray(0, 20));
    expect(events()[0]?.status).toBe('pending');
    exchange.data(chunk.subarray(20));
    expect(events()[0]).toMatchObject({ status: 'ok', data: { durationMs: 230, error: null } });
    exchange.end();
    expect(events()[0]?.status).toBe('ok');
  });

  it('sets error with the text of a result with isError = true, cut to 500 characters', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, SSE_HEADERS);
    exchange.data(
      sse({
        jsonrpc: '2.0',
        id: 7,
        result: {
          content: [{ type: 'text', text: `### Error\n${'e'.repeat(900)}` }],
          isError: true,
        },
      }),
    );
    const event = events()[0];
    expect(event?.status).toBe('error');
    const error = event?.data.error as string;
    expect(error.length).toBeLessThanOrEqual(500);
    expect(error.startsWith('### Error\neee')).toBe(true);
  });

  describe('typed text in error texts (spec section 8.6)', () => {
    function failWith(call: unknown, text: string, id = 7) {
      const { exchange, events } = setup();
      exchange.begin(messages(call));
      exchange.response(200, SSE_HEADERS);
      exchange.data(
        sse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }),
      );
      return events()[0];
    }

    it('replaces the typed text of browser_type in the error text with [redacted]', () => {
      const event = failWith(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'browser_type', arguments: { target: '#d', text: 'hunter2-SECRET' } },
        },
        '### Error\nError: Element is not editable\nCall log:\n  - fill("hunter2-SECRET")\n  - retry: hunter2-SECRET',
      );
      const error = event?.data.error as string;
      expect(error).not.toContain('hunter2-SECRET');
      expect(error).toContain('fill("[redacted]")');
      expect(error).toContain('retry: [redacted]');
    });

    it('replaces each typed value of browser_fill_form', () => {
      const event = failWith(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'browser_fill_form',
            arguments: {
              fields: [
                { name: 'user', type: 'textbox', target: 'e1', value: 'alice-login' },
                { name: 'pass', type: 'textbox', target: 'e2', value: 'p4ss-w0rd' },
              ],
            },
          },
        },
        '### Error\nCall log:\n  - fill("alice-login")\n  - fill("p4ss-w0rd")',
      );
      const error = event?.data.error as string;
      expect(error).not.toContain('alice-login');
      expect(error).not.toContain('p4ss-w0rd');
      expect(error).toContain('[redacted]');
    });

    it('replaces the JSON escaped form of a typed value, and the longer value first', () => {
      const event = failWith(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'browser_fill_form',
            arguments: {
              fields: [
                { target: 'e1', value: 'ab' },
                { target: 'e2', value: 'ab"cdef' },
              ],
            },
          },
        },
        '### Error\nfill("ab\\"cdef") then fill("ab")',
      );
      expect(event?.data.error).toBe('### Error\nfill("[redacted]") then fill("[redacted]")');
    });

    it('strips ANSI escape sequences', () => {
      const esc = String.fromCharCode(27);
      const event = failWith(
        typeCall,
        `### Error\n${esc}[31mError${esc}[39m: failed ${esc}[2mhunter2${esc}[22m`,
      );
      expect(event?.data.error).toBe('### Error\nError: failed [redacted]');
    });

    it('drops the "Ran Playwright code" section and everything after it', () => {
      const event = failWith(
        typeCall,
        "### Error\nError: failed\n### Ran Playwright code\n```js\nawait page.fill('hunter2');\n```\n### Page state\n- heading",
      );
      expect(event?.data.error).toBe('### Error\nError: failed');
    });

    it('also cleans the message of a JSON-RPC error', () => {
      const { exchange, events } = setup();
      exchange.begin(messages(typeCall));
      exchange.response(200, { 'content-type': 'application/json' });
      exchange.data(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            error: { code: -32603, message: 'cannot fill "hunter2"' },
          }),
        ),
      );
      exchange.end();
      expect(events()[0]?.data.error).toBe('cannot fill "[redacted]"');
    });

    it('keeps only the first line of the error of browser_press_key', () => {
      const event = failWith(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'browser_press_key', arguments: { key: 'q' } },
        },
        '### Error\nError: Element is not focusable\nCall log:\n  - press("q")',
      );
      expect(event?.data.error).toBe('Error: Element is not focusable');
    });

    describe('with a one character typed value', () => {
      const typeS = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'browser_type', arguments: { target: 'e1', text: 's' } },
      };
      const pressE = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'browser_press_key', arguments: { key: 'e' } },
      };

      it.each([
        ['browser_type', typeS],
        ['browser_press_key', pressE],
      ])('%s: keeps "stream closed" after close() and after an SSE end', (_tool, call) => {
        const closed = setup();
        closed.exchange.begin(messages(call));
        closed.exchange.close();
        expect(closed.events()[0]?.data.error).toBe(STREAM_CLOSED);

        const ended = setup();
        ended.exchange.begin(messages(call));
        ended.exchange.response(200, SSE_HEADERS);
        ended.exchange.end();
        expect(ended.events()[0]?.data.error).toBe(STREAM_CLOSED);
      });

      it('keeps the internal reasons: the other reasons of close(), duplicate id, invalid response, too large', () => {
        const unreachable = setup();
        unreachable.exchange.begin(messages(typeS));
        unreachable.exchange.close('MCP server not reachable');
        expect(unreachable.events()[0]?.data.error).toBe('MCP server not reachable');

        const duplicate = setup();
        duplicate.exchange.begin(messages(typeS));
        duplicate.exchange.begin(messages(typeS));
        expect(duplicate.events()[0]?.data.error).toBe('duplicate request id');

        const invalid = setup();
        invalid.exchange.begin(messages(typeS));
        invalid.exchange.response(200, { 'content-type': 'application/json' });
        invalid.exchange.data(Buffer.from('{"jsonrpc":"2.0","id":7,"error":"boom"}'));
        invalid.exchange.end();
        expect(invalid.events()[0]?.data.error).toBe('invalid response');
      });

      it('keeps the HTTP prefix and redacts only the pod body', () => {
        const { exchange, events } = setup();
        exchange.begin(messages(typeS));
        exchange.response(500, { 'content-type': 'text/plain' });
        exchange.data(Buffer.from('fill("s") failed'));
        exchange.end();
        expect(events()[0]?.data.error).toBe('HTTP 500: fill("[redacted]") failed');

        const empty = setup();
        empty.exchange.begin(messages(typeS));
        empty.exchange.response(500, {});
        empty.exchange.end();
        expect(empty.events()[0]?.data.error).toBe('HTTP 500');
      });

      it('still redacts the text of the pod for the same value', () => {
        const event = failWith(typeS, '### Error\nCall log:\n  - fill("s")');
        expect(event?.data.error).toBe('### Error\nCall log:\n  - fill("[redacted]")');
        const rpc = setup();
        rpc.exchange.begin(messages(typeS));
        rpc.exchange.response(200, { 'content-type': 'application/json' });
        rpc.exchange.data(
          Buffer.from(
            JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'fill s' } }),
          ),
        );
        rpc.exchange.end();
        expect(rpc.events()[0]?.data.error).toBe('fill [redacted]');
      });
    });

    it('does not replace anything of a tool that keeps its arguments, and keeps the Error section', () => {
      const event = failWith(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
        },
        '### Error\nnet::ERR_FAILED at https://example.com',
      );
      expect(event?.data.error).toBe('### Error\nnet::ERR_FAILED at https://example.com');
    });
  });

  it('stores a tool name, a string request id, and an MCP session id cut to 200 characters', () => {
    const { exchange, events } = setup('s'.repeat(5000));
    exchange.begin(
      messages({
        jsonrpc: '2.0',
        id: 'i'.repeat(5000),
        method: 'tools/call',
        params: { name: 't'.repeat(5000), arguments: {} },
      }),
    );
    const data = events()[0]?.data;
    for (const key of ['tool', 'rpcId', 'mcpSessionId']) {
      expect((data?.[key] as string).length).toBe(200);
      expect(data?.[key]).toMatch(/… \[cut, 5000 chars\]$/);
    }
  });

  it('sets error with the message of a JSON-RPC error in a JSON response', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, { 'content-type': 'application/json' });
    exchange.data(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          error: { code: -32602, message: 'Invalid params' },
        }),
      ),
    );
    expect(events()[0]?.status).toBe('pending');
    exchange.end();
    expect(events()[0]).toMatchObject({ status: 'error', data: { error: 'Invalid params' } });
  });

  it('matches the results of a batch by id, also when the order changes', () => {
    const { exchange, events } = setup();
    exchange.begin(
      messages([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'browser_snapshot', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'tools/call',
          params: { name: 'browser_click', arguments: { target: 'e2' } },
        },
      ]),
    );
    exchange.response(200, SSE_HEADERS);
    exchange.data(
      sse(
        { jsonrpc: '2.0', id: '1', result: { content: [] } },
        { jsonrpc: '2.0', id: 1, error: { code: -1, message: '' } },
      ),
    );
    const byTool = Object.fromEntries(events().map((event) => [event.data.tool as string, event]));
    expect(byTool.browser_click?.status).toBe('ok');
    expect(byTool.browser_snapshot).toMatchObject({
      status: 'error',
      data: { error: 'JSON-RPC error -1' },
    });
  });

  it('sets "stream closed" when the stream closes before the result', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, SSE_HEADERS);
    exchange.close();
    expect(events()[0]).toMatchObject({ status: 'error', data: { error: STREAM_CLOSED } });
    exchange.data(sse({ jsonrpc: '2.0', id: 7, result: { content: [] } }));
    expect(events()[0]?.status).toBe('error');
  });

  it('sets "stream closed" when the SSE stream ends without the result', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, SSE_HEADERS);
    exchange.data(
      Buffer.from('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n'),
    );
    exchange.end();
    expect(events()[0]).toMatchObject({ status: 'error', data: { error: STREAM_CLOSED } });
  });

  it('records the HTTP status and body when the pod rejects the request', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(404, { 'content-length': '17' });
    exchange.data(Buffer.from('Session not found'));
    exchange.end();
    expect(events()[0]).toMatchObject({
      status: 'error',
      data: { error: 'HTTP 404: Session not found' },
    });
  });

  it('writes mcp.connect when an initialize result arrives', () => {
    const { exchange, events } = setup(null);
    exchange.begin(
      messages({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '2.1.0', title: 'x' },
        },
      }),
    );
    expect(events()).toEqual([]);
    exchange.response(200, {
      'content-type': 'text/event-stream',
      'mcp-session-id': 'new-session',
    });
    exchange.data(
      sse({
        jsonrpc: '2.0',
        id: 0,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'Playwright', version: '1' },
        },
      }),
    );
    expect(events()).toEqual([
      expect.objectContaining({
        kind: 'mcp.connect',
        actorType: 'token',
        actorId: 'tok1',
        sessionId: 'sess1',
        status: null,
        data: {
          mcpSessionId: 'new-session',
          clientInfo: { name: 'claude-code', version: '2.1.0' },
          ip: '203.0.113.7',
        },
      }),
    ]);
  });

  it('does not write mcp.connect for a failed initialize', () => {
    const { exchange, events } = setup(null);
    exchange.begin(messages({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }));
    exchange.response(200, { 'content-type': 'application/json' });
    exchange.data(
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32600, message: 'Bad' } }),
      ),
    );
    exchange.end();
    expect(events()).toEqual([]);
  });

  it('writes nothing for tools/list, ping, notifications, and responses of the client', () => {
    const { exchange, events } = setup();
    exchange.begin(
      messages([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 0, result: {} },
      ]),
    );
    exchange.response(200, SSE_HEADERS);
    exchange.data(
      sse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }, { jsonrpc: '2.0', id: 2, result: {} }),
    );
    exchange.end();
    expect(events()).toEqual([]);
  });

  it('ignores SSE data that is not JSON', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, SSE_HEADERS);
    exchange.data(Buffer.from('data: not json\n\n'));
    exchange.data(sse({ jsonrpc: '2.0', id: 7, result: { content: [] } }));
    expect(events()[0]?.status).toBe('ok');
  });

  it('finishes the earlier of two calls with the same id as an error, and the later one can still finish', () => {
    const { exchange, events } = setup();
    exchange.begin(
      messages([
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'browser_click', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'browser_hover', arguments: {} },
        },
      ]),
    );
    expect(events()[0]).toMatchObject({ status: 'error', data: { error: 'duplicate request id' } });
    expect(events()[1]?.status).toBe('pending');
    expect(exchange.pendingCalls).toBe(1);
    exchange.response(200, SSE_HEADERS);
    exchange.data(sse({ jsonrpc: '2.0', id: 7, result: { content: [] } }));
    expect(events()[1]?.status).toBe('ok');
    expect(exchange.pendingCalls).toBe(0);
  });

  it('keeps the earlier calls pending when begin() throws on a later call of a batch', () => {
    const { exchange, events } = setup('mcp-1', (memory) => ({
      write: (input) => {
        if (input.data.rpcId === 2) throw new Error('audit down');
        return memory.write(input);
      },
      update: (id, patch) => memory.update(id, patch),
    }));
    expect(() =>
      exchange.begin(
        messages([
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'browser_click', arguments: {} },
          },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'browser_hover', arguments: {} },
          },
        ]),
      ),
    ).toThrow('audit down');
    expect(exchange.pendingCalls).toBe(1);
    exchange.close();
    expect(events()[0]).toMatchObject({ status: 'error', data: { error: STREAM_CLOSED } });
  });

  it('records ok for a 5 MiB result event fed in several chunks', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, SSE_HEADERS);
    const payload = Buffer.alloc(5 * 1024 * 1024, 7).toString('base64');
    const chunk = sse({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'image', data: payload, mimeType: 'image/png' }] },
    });
    for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
      exchange.data(chunk.subarray(offset, offset + 64 * 1024));
    }
    expect(events()[0]).toMatchObject({ status: 'ok', data: { error: null } });
    expect(exchange.pendingCalls).toBe(0);
  });

  it('does not throw when an audit update fails, and still finishes the other calls', () => {
    const { exchange, events } = setup('mcp-1', (memory) => ({
      write: (input) => memory.write(input),
      update: (id, patch) => {
        if (id === 1) throw new Error('update failed');
        return memory.update(id, patch);
      },
    }));
    exchange.begin(
      messages([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'browser_click', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'browser_hover', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'browser_snapshot', arguments: {} },
        },
      ]),
    );
    exchange.response(200, SSE_HEADERS);
    expect(() =>
      exchange.data(
        sse(
          { jsonrpc: '2.0', id: 1, result: { content: [] } },
          { jsonrpc: '2.0', id: 2, result: { content: [] } },
        ),
      ),
    ).not.toThrow();
    expect(() => exchange.end()).not.toThrow();
    expect(events()[1]?.status).toBe('ok');
    expect(events()[2]).toMatchObject({ status: 'error', data: { error: STREAM_CLOSED } });
    expect(exchange.pendingCalls).toBe(0);
  });

  it('does not throw from close() when an audit update fails', () => {
    const { exchange } = setup('mcp-1', (memory) => ({
      write: (input) => memory.write(input),
      update: () => {
        throw new Error('update failed');
      },
    }));
    exchange.begin(messages(typeCall));
    expect(() => exchange.close()).not.toThrow();
    expect(exchange.pendingCalls).toBe(0);
  });

  it('records "invalid response" for a response whose error is not an object', () => {
    const { exchange, events } = setup();
    exchange.begin(messages(typeCall));
    exchange.response(200, { 'content-type': 'application/json' });
    exchange.data(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, error: 'boom' })));
    exchange.end();
    expect(events()[0]).toMatchObject({ status: 'error', data: { error: 'invalid response' } });
  });
});
