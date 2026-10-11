import http from 'node:http';
import https from 'node:https';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { parseSseData } from './sse.js';

/**
 * A small Streamable HTTP client on node:http. The tests use it where they need the exact status,
 * the exact body, or the life of one MCP stream. node:http has no body timeout, so a stream can stay
 * open for the 10 min of the long test.
 */

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RawMcpSession {
  endpoint: string;
  token: string;
  id: string;
  protocolVersion: string;
}

function send(
  url: URL,
  method: 'GET' | 'POST' | 'DELETE',
  headers: Record<string, string>,
  body?: string,
  headersTimeoutMs = 30_000,
): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    // agent: false gives each request its own connection, so one stream never shares a socket.
    const request = client.request(url, { method, headers, agent: false }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    // Only the response headers have a time limit. An open stream has none.
    const timer = setTimeout(() => {
      request.destroy(
        new Error(`No response headers for ${method} ${url.href} after ${headersTimeoutMs} ms`),
      );
    }, headersTimeoutMs);
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}

async function readBody(response: http.IncomingMessage): Promise<string> {
  response.setEncoding('utf8');
  let body = '';
  for await (const chunk of response) {
    body += String(chunk);
  }
  return body;
}

function sessionHeaders(session: RawMcpSession): Record<string, string> {
  return {
    authorization: `Bearer ${session.token}`,
    'mcp-session-id': session.id,
    'mcp-protocol-version': session.protocolVersion,
  };
}

export function initializeMessage(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'hydra-e2e-raw', version: '1.0.0' },
    },
  };
}

/** POSTs one JSON-RPC message and reads the whole response. */
export async function mcpPost(
  endpoint: string,
  token: string,
  message: Record<string, unknown>,
  session?: RawMcpSession,
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(session === undefined ? {} : sessionHeaders(session)),
  };
  const response = await send(new URL(endpoint), 'POST', headers, JSON.stringify(message));
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: await readBody(response),
  };
}

/** The JSON-RPC messages of a response body (application/json or text/event-stream). */
export function rpcMessages(response: RawResponse): unknown[] {
  const type = response.headers['content-type'] ?? '';
  if (type.startsWith('text/event-stream')) {
    return parseSseData(response.body).map((data) => JSON.parse(data) as unknown);
  }
  return [JSON.parse(response.body) as unknown];
}

/** initialize, then notifications/initialized. */
export async function openRawSession(endpoint: string, token: string): Promise<RawMcpSession> {
  const init = await mcpPost(endpoint, token, initializeMessage());
  if (init.status !== 200) {
    throw new Error(`initialize returned ${init.status}: ${init.body}`);
  }
  const id = init.headers['mcp-session-id'];
  if (typeof id !== 'string') {
    throw new Error('initialize returned no Mcp-Session-Id header');
  }
  const first = rpcMessages(init)[0] as { result?: { protocolVersion?: unknown } } | undefined;
  const negotiated = first?.result?.protocolVersion;
  const session: RawMcpSession = {
    endpoint,
    token,
    id,
    protocolVersion: typeof negotiated === 'string' ? negotiated : LATEST_PROTOCOL_VERSION,
  };
  const note = await mcpPost(
    endpoint,
    token,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    session,
  );
  if (note.status !== 202) {
    throw new Error(`notifications/initialized returned ${note.status}: ${note.body}`);
  }
  return session;
}

export interface McpStream {
  status: number;
  isOpen(): boolean;
  /** Resolves when the stream ends, for any reason. */
  closed: Promise<void>;
  close(): void;
}

/** Opens the GET stream of an MCP session and watches its end. */
export async function openGetStream(
  session: RawMcpSession,
  headersTimeoutMs = 30_000,
): Promise<McpStream> {
  const response = await send(
    new URL(session.endpoint),
    'GET',
    { ...sessionHeaders(session), accept: 'text/event-stream' },
    undefined,
    headersTimeoutMs,
  );
  let open = response.statusCode === 200;
  const closed = new Promise<void>((resolve) => {
    const end = (): void => {
      open = false;
      resolve();
    };
    response.on('end', end);
    response.on('close', end);
    response.on('error', end);
  });
  response.resume();
  return {
    status: response.statusCode ?? 0,
    isOpen: () => open,
    closed,
    close: () => response.destroy(),
  };
}

export async function deleteRawSession(session: RawMcpSession): Promise<number> {
  const response = await send(new URL(session.endpoint), 'DELETE', sessionHeaders(session));
  await readBody(response);
  return response.statusCode ?? 0;
}
