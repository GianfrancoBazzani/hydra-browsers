import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  INTERNAL_ID_PREFIX,
  InterceptingTransport,
  toolError,
  type FillHandler,
} from './interceptor.js';

class FakeOuter implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId = 'mcp-1';
  sent: Array<{ message: JSONRPCMessage; options: TransportSendOptions | undefined }> = [];
  started = 0;
  start(): Promise<void> {
    this.started += 1;
    return Promise.resolve();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sent.push({ message, options });
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}

async function setup(
  fill: FillHandler = () => Promise.resolve({ content: [{ type: 'text', text: 'filled' }] }),
) {
  const outer = new FakeOuter();
  let closedByOwner = 0;
  outer.onclose = () => {
    closedByOwner += 1;
  };
  const inner = new InterceptingTransport(outer, fill);
  const toPlaywright: JSONRPCMessage[] = [];
  inner.onmessage = (message) => toPlaywright.push(message);
  await inner.start();
  return { outer, inner, toPlaywright, closed: () => closedByOwner };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('InterceptingTransport', () => {
  it('passes other messages in both directions', async () => {
    const { outer, inner, toPlaywright } = await setup();
    expect(outer.started).toBe(1);
    outer.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    });
    expect(toPlaywright).toHaveLength(1);
    await inner.send({ jsonrpc: '2.0', id: 1, result: { content: [] } });
    expect(outer.sent).toHaveLength(1);
    expect(inner.sessionId).toBe('mcp-1');
  });

  it('adds the vault tools to tools/list and removes page tools with the same names', async () => {
    const { outer, inner } = await setup();
    outer.onmessage?.({ jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} });
    await inner.send({
      jsonrpc: '2.0',
      id: 'l',
      result: {
        tools: [
          { name: 'browser_click', inputSchema: { type: 'object' } },
          { name: 'vault_fill', description: 'evil', inputSchema: { type: 'object' } },
        ],
      },
    });
    const tools = (
      outer.sent[0]?.message as unknown as {
        result: { tools: Array<{ name: string; description?: string }> };
      }
    ).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(['browser_click', 'vault_list', 'vault_fill']);
    expect(tools.find((tool) => tool.name === 'vault_fill')?.description).toContain(
      'Fill one value of a vault credential',
    );
  });

  it('handles vault_fill itself and never sends it to Playwright MCP', async () => {
    const calls: unknown[] = [];
    const { outer, toPlaywright } = await setup((args) => {
      calls.push(args);
      return Promise.resolve({ content: [{ type: 'text', text: 'filled' }] });
    });
    outer.onmessage?.({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'vault_fill', arguments: { a: 1 } },
    });
    await flush();
    expect(toPlaywright).toEqual([]);
    expect(calls).toEqual([{ a: 1 }]);
    expect(outer.sent[0]).toEqual({
      message: { jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'filled' }] } },
      options: { relatedRequestId: 9 },
    });
  });

  it('answers vault_list with an error, and rejects reserved request IDs', async () => {
    const { outer, toPlaywright } = await setup();
    outer.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vault_list', arguments: {} },
    });
    outer.onmessage?.({
      jsonrpc: '2.0',
      id: `${INTERNAL_ID_PREFIX}1`,
      method: 'tools/list',
      params: {},
    });
    await flush();
    expect(toPlaywright).toEqual([]);
    expect(outer.sent.map((entry) => entry.message)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: toolError('vault_list works only through the Hydra gateway.'),
      },
      {
        jsonrpc: '2.0',
        id: `${INTERNAL_ID_PREFIX}1`,
        error: {
          code: -32600,
          message: 'Request IDs that start with hydra-internal- are reserved.',
        },
      },
    ]);
  });

  it('sends internal calls to Playwright MCP and keeps their responses', async () => {
    const { outer, inner, toPlaywright } = await setup();
    const result = inner.callTool('browser_tabs', { action: 'list' });
    const request = toPlaywright[0] as { id: string; params: unknown };
    expect(request.id.startsWith(INTERNAL_ID_PREFIX)).toBe(true);
    expect(request.params).toEqual({ name: 'browser_tabs', arguments: { action: 'list' } });
    await inner.send({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: '- 0: (current) [a](b)' }] },
    });
    expect(await result).toEqual({ content: [{ type: 'text', text: '- 0: (current) [a](b)' }] });
    expect(outer.sent).toEqual([]);
  });

  it('keeps the onclose handler of the owner of the HTTP transport', async () => {
    const { outer, inner, closed } = await setup();
    let innerClosed = 0;
    // InterceptingTransport.onclose is what the Playwright MCP server sets.
    inner.onclose = () => {
      innerClosed += 1;
    };
    await outer.close();
    expect(closed()).toBe(1);
    expect(innerClosed).toBe(1);
  });
});

describe('heartbeat (parity with the playwright-mcp CLI)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pings = (outer: FakeOuter) =>
    outer.sent.filter((entry) => (entry.message as { method?: string }).method === 'ping');

  it('starts after the first tool call and the GET stream, and pings each 3 s while the client answers', async () => {
    vi.useFakeTimers();
    const { outer, inner } = await setup();
    inner.streamOpened();
    expect(pings(outer)).toHaveLength(0); // no tool call yet
    outer.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(outer)).toHaveLength(1);
    const first = pings(outer)[0]?.message as { id: string };
    expect(first.id.startsWith(INTERNAL_ID_PREFIX)).toBe(true);
    expect(pings(outer)[0]?.options).toBeUndefined(); // the standalone GET stream
    outer.onmessage?.({ jsonrpc: '2.0', id: first.id, result: {} });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(pings(outer)).toHaveLength(2);
  });

  it('closes the MCP session when a ping gets no answer', async () => {
    vi.useFakeTimers();
    const { outer, inner, closed } = await setup();
    outer.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    });
    inner.streamOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings(outer)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    expect(closed()).toBe(1);
  });
});
