// JSON-RPC 2.0 parsing for the MCP proxy (spec section 8.2 step 4).

export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'response'; id: JsonRpcId | null; result: unknown; error: JsonRpcErrorObject | null }
  | { kind: 'invalid'; method: string | null; params: unknown };

export type ParsedBody =
  | { ok: true; batch: boolean; messages: JsonRpcMessage[] }
  | { ok: false; reason: 'invalid_utf8' | 'invalid_json' };

const utf8 = new TextDecoder('utf-8', { fatal: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function errorObject(value: unknown): JsonRpcErrorObject | null {
  if (!isObject(value)) return null;
  const code = typeof value.code === 'number' ? value.code : 0;
  const message = typeof value.message === 'string' ? value.message : '';
  return value.data === undefined ? { code, message } : { code, message, data: value.data };
}

/** Classifies one decoded JSON value. A value that is not valid JSON-RPC 2.0 is 'invalid'. */
export function classifyMessage(value: unknown): JsonRpcMessage {
  if (!isObject(value)) return { kind: 'invalid', method: null, params: undefined };
  const method = typeof value.method === 'string' ? value.method : null;
  if (value.jsonrpc !== '2.0') return { kind: 'invalid', method, params: value.params };
  if (method !== null) {
    if (!('id' in value)) return { kind: 'notification', method, params: value.params };
    if (isId(value.id)) return { kind: 'request', id: value.id, method, params: value.params };
    return { kind: 'invalid', method, params: value.params };
  }
  if ('result' in value || 'error' in value) {
    const id = isId(value.id) ? value.id : null;
    return { kind: 'response', id, result: value.result, error: errorObject(value.error) };
  }
  return { kind: 'invalid', method: null, params: undefined };
}

/** Parses an MCP request body: one JSON-RPC message or a batch (JSON array). */
export function parseJsonRpcBody(raw: Uint8Array): ParsedBody {
  let text: string;
  try {
    text = utf8.decode(raw);
  } catch {
    return { ok: false, reason: 'invalid_utf8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (Array.isArray(value)) return { ok: true, batch: true, messages: value.map(classifyMessage) };
  return { ok: true, batch: false, messages: [classifyMessage(value)] };
}

/** Parses one server payload (the data of an SSE event, or a JSON response body). Null if it is not JSON. */
export function parseServerPayload(text: string): JsonRpcMessage[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(value) ? value.map(classifyMessage) : [classifyMessage(value)];
}

/** Map key for an id: 1 and "1" are different ids. */
export function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

/** The tool name of a tools/call message (any kind), or null. */
export function toolCallName(message: JsonRpcMessage): string | null {
  if (message.kind === 'response' || message.method !== 'tools/call') return null;
  const params = message.params;
  return isObject(params) && typeof params.name === 'string' ? params.name : null;
}

/** The arguments of a tools/call message. */
export function toolCallArguments(message: JsonRpcMessage): unknown {
  if (message.kind === 'response') return undefined;
  const params = message.params;
  return isObject(params) ? params.arguments : undefined;
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id };
}

export function jsonRpcErrorBody(id: JsonRpcId | null, code: number, message: string): string {
  return JSON.stringify(jsonRpcError(id, code, message));
}
