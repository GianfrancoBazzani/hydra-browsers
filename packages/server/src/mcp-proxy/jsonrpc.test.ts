import { describe, expect, it } from 'vitest';
import {
  classifyMessage,
  idKey,
  jsonRpcErrorBody,
  parseJsonRpcBody,
  parseServerPayload,
  toolCallArguments,
  toolCallName,
} from './jsonrpc.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOM = String.fromCharCode(0xfeff);

describe('parseJsonRpcBody', () => {
  it('parses a single request', () => {
    const parsed = parseJsonRpcBody(
      bytes('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'),
    );
    expect(parsed).toEqual({
      ok: true,
      batch: false,
      messages: [{ kind: 'request', id: 1, method: 'tools/list', params: {} }],
    });
  });

  it('parses a batch with a request, a notification, and a response', () => {
    const parsed = parseJsonRpcBody(
      bytes(
        JSON.stringify([
          {
            jsonrpc: '2.0',
            id: 'a',
            method: 'tools/call',
            params: { name: 'browser_click', arguments: { target: 'e1' } },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 0, result: {} },
        ]),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.batch).toBe(true);
    expect(parsed.messages.map((message) => message.kind)).toEqual([
      'request',
      'notification',
      'response',
    ]);
  });

  it('parses an empty batch as a batch without messages', () => {
    expect(parseJsonRpcBody(bytes('[]'))).toEqual({ ok: true, batch: true, messages: [] });
  });

  it('rejects a body that is not JSON', () => {
    expect(parseJsonRpcBody(bytes('{"jsonrpc":'))).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseJsonRpcBody(bytes(''))).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('rejects a body that is not UTF-8', () => {
    expect(parseJsonRpcBody(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      reason: 'invalid_utf8',
    });
  });

  it('accepts a UTF-8 byte order mark, as the pod does', () => {
    const parsed = parseJsonRpcBody(bytes(`${BOM}{"jsonrpc":"2.0","id":2,"method":"ping"}`));
    expect(parsed).toEqual({
      ok: true,
      batch: false,
      messages: [{ kind: 'request', id: 2, method: 'ping', params: undefined }],
    });
  });

  it('uses the last value of a duplicate key, as JSON.parse in the pod does', () => {
    const parsed = parseJsonRpcBody(
      bytes(
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_click","name":"browser_run_code_unsafe"}}',
      ),
    );
    if (!parsed.ok) throw new Error('expected a parsed body');
    const [message] = parsed.messages;
    expect(message && toolCallName(message)).toBe('browser_run_code_unsafe');
  });
});

describe('classifyMessage', () => {
  it('marks values that are not JSON-RPC 2.0 as invalid', () => {
    expect(classifyMessage(null)).toEqual({ kind: 'invalid', method: null, params: undefined });
    expect(classifyMessage([1])).toEqual({ kind: 'invalid', method: null, params: undefined });
    expect(classifyMessage({ id: 1, method: 'ping' })).toEqual({
      kind: 'invalid',
      method: 'ping',
      params: undefined,
    });
    expect(
      classifyMessage({ jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'x' } }),
    ).toEqual({
      kind: 'invalid',
      method: 'tools/call',
      params: { name: 'x' },
    });
    expect(classifyMessage({ jsonrpc: '2.0', id: 1.5, method: 'ping' }).kind).toBe('invalid');
    expect(classifyMessage({ jsonrpc: '2.0', id: 1 }).kind).toBe('invalid');
  });

  it('reads responses with result and with error', () => {
    expect(classifyMessage({ jsonrpc: '2.0', id: 'x', result: { content: [] } })).toEqual({
      kind: 'response',
      id: 'x',
      result: { content: [] },
      error: null,
    });
    expect(
      classifyMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
    ).toEqual({
      kind: 'response',
      id: null,
      result: undefined,
      error: { code: -32700, message: 'Parse error' },
    });
  });
});

describe('tool call helpers', () => {
  it('reads the tool name and the arguments of requests, notifications, and invalid messages', () => {
    const request = classifyMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_type', arguments: { text: 'x' } },
    });
    expect(toolCallName(request)).toBe('browser_type');
    expect(toolCallArguments(request)).toEqual({ text: 'x' });
    const notification = classifyMessage({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'browser_run_code_unsafe' },
    });
    expect(toolCallName(notification)).toBe('browser_run_code_unsafe');
    const invalid = classifyMessage({
      jsonrpc: '2.0',
      id: null,
      method: 'tools/call',
      params: { name: 'browser_run_code_unsafe' },
    });
    expect(toolCallName(invalid)).toBe('browser_run_code_unsafe');
  });

  it('returns null for other methods and for a name that is not a string', () => {
    expect(
      toolCallName(classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })),
    ).toBeNull();
    expect(
      toolCallName(
        classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 7 } }),
      ),
    ).toBeNull();
    expect(toolCallName(classifyMessage({ jsonrpc: '2.0', id: 1, result: {} }))).toBeNull();
  });

  it('keeps number ids and string ids apart', () => {
    expect(idKey(1)).not.toBe(idKey('1'));
  });
});

describe('parseServerPayload', () => {
  it('parses one message, a batch, and rejects text that is not JSON', () => {
    expect(parseServerPayload('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual([
      { kind: 'response', id: 1, result: {}, error: null },
    ]);
    expect(parseServerPayload('[{"jsonrpc":"2.0","method":"ping","id":0}]')).toEqual([
      { kind: 'request', id: 0, method: 'ping', params: undefined },
    ]);
    expect(parseServerPayload('not json')).toBeNull();
  });
});

describe('jsonRpcErrorBody', () => {
  it('writes the members in the order jsonrpc, error, id', () => {
    expect(
      jsonRpcErrorBody(null, -32000, 'Session is not running. Start it in the dashboard.'),
    ).toBe(
      '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Session is not running. Start it in the dashboard."},"id":null}',
    );
  });
});
