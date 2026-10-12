// Test harness of the MCP proxy: createTestApp on a real port, clients that send Host: hydra.localhost.
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  AuditPageSchema,
  CreateTokenResponseSchema,
  type AuditEvent,
  type AuditKind,
  type SessionState,
} from '@hydra/shared';
import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  request,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import type { AppDeps } from '../../src/app.js';
import type { PodEndpointResolver } from '../../src/orchestrator/index.js';
import { SseParser, type SseEvent } from '../../src/mcp-proxy/sse.js';
import { createTestApp } from './app.js';
import { loginAs, seedSession, seedUser } from './seed.js';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export const MCP_ACCEPT = 'application/json, text/event-stream';
export const PROTOCOL_VERSION = '2025-06-18';

export interface Gateway {
  app: TestApp['app'];
  deps: TestApp['deps'];
  clock: TestApp['clock'];
  /** The port of the gateway on 127.0.0.1. */
  port: number;
  /** Connects to the gateway port. The Host header stays the host of HYDRA_PUBLIC_URL. */
  dispatcher: Agent;
  /** Absolute URL on HYDRA_PUBLIC_URL, for example url('/s/x/mcp'). */
  url(path: string): string;
  close(): Promise<void>;
}

/** createTestApp with podEndpoints → podUrl (the MCP server of the test), listening on a real port. */
export async function startGateway(
  podUrl: string,
  overrides: Partial<AppDeps> = {},
): Promise<Gateway> {
  const podEndpoints: PodEndpointResolver = {
    endpoint: () => Promise.resolve(podUrl),
    close: () => Promise.resolve(),
  };
  const testApp = await createTestApp({ ...overrides, podEndpoints });
  const { app, deps, clock } = testApp;
  if (deps.podEndpoints !== podEndpoints) throw new Error('createTestApp ignored podEndpoints');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const connect = buildConnector({});
  const dispatcher = new Agent({
    connect: (options, callback) => {
      connect({ ...options, hostname: '127.0.0.1', port: String(port) }, callback);
    },
  });
  return {
    app,
    deps,
    clock,
    port,
    dispatcher,
    url: (path) => new URL(path, deps.config.publicUrl).toString(),
    close: async () => {
      deps.mcpStreams.closeWhere(() => true, 'test end');
      await dispatcher.destroy();
      await testApp.close();
    },
  };
}

export interface SeededOwner {
  userId: string;
  email: string;
  password: string;
  cookie: string;
  sessionId: string;
}

/** A user, a login session, and a session of this user in the given state (default running). */
export async function seedOwnerSession(
  gw: Gateway,
  options: { email?: string; state?: SessionState } = {},
): Promise<SeededOwner> {
  const email = options.email ?? 'owner@example.com';
  const { user, password } = await seedUser(gw.deps, { email });
  const session = seedSession(gw.deps, { ownerId: user.id, state: options.state ?? 'running' });
  const cookie = await loginAs(gw.app, email, password);
  return { userId: user.id, email, password, cookie, sessionId: session.id };
}

/** A dashboard API request with the login cookie (and the CSRF headers for other methods than GET). */
export function apiRequest(
  gw: Gateway,
  cookie: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
) {
  const { host, origin } = gw.deps.config.publicUrl;
  if (method === 'GET') return gw.app.inject({ method, url: path, headers: { host, cookie } });
  return gw.app.inject({
    method,
    url: path,
    headers: { host, cookie, origin, 'content-type': 'application/json' },
    payload: JSON.stringify(payload ?? {}),
  });
}

export async function createAgentToken(
  gw: Gateway,
  cookie: string,
  sessionId: string,
): Promise<{ id: string; secret: string }> {
  const res = await apiRequest(gw, cookie, 'POST', `/api/sessions/${sessionId}/tokens`, {
    name: 'agent',
    expiresInDays: 30,
  });
  if (res.statusCode >= 300) {
    throw new Error(`token create failed: ${String(res.statusCode)} ${res.body}`);
  }
  const { token, secret } = CreateTokenResponseSchema.parse(res.json());
  return { id: token.id, secret };
}

/** The audit events of one kind of a session, oldest first (GET /api/sessions/:sid/audit). */
export async function listAudit(
  gw: Gateway,
  cookie: string,
  sessionId: string,
  kind: AuditKind,
): Promise<AuditEvent[]> {
  const res = await apiRequest(
    gw,
    cookie,
    'GET',
    `/api/sessions/${sessionId}/audit?kind=${kind}&limit=200`,
  );
  if (res.statusCode !== 200) {
    throw new Error(`audit list failed: ${String(res.statusCode)} ${res.body}`);
  }
  return AuditPageSchema.parse(res.json()).events.sort((a, b) => a.id - b.id);
}

export function mcpPost(
  gw: Gateway,
  sessionId: string,
  secret: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Dispatcher.ResponseData> {
  return request(gw.url(`/s/${sessionId}/mcp`), {
    method: 'POST',
    dispatcher: gw.dispatcher,
    signal,
    headers: {
      authorization: `Bearer ${secret}`,
      accept: MCP_ACCEPT,
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Opens the GET stream of an MCP session. */
export function mcpGet(
  gw: Gateway,
  sessionId: string,
  secret: string,
  mcpSessionId: string,
  signal?: AbortSignal,
): Promise<Dispatcher.ResponseData> {
  return request(gw.url(`/s/${sessionId}/mcp`), {
    method: 'GET',
    dispatcher: gw.dispatcher,
    signal,
    headers: {
      authorization: `Bearer ${secret}`,
      accept: 'text/event-stream',
      'mcp-session-id': mcpSessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
    },
  });
}

/** initialize and notifications/initialized without the SDK. Returns the Mcp-Session-Id. */
export async function mcpInitialize(
  gw: Gateway,
  sessionId: string,
  secret: string,
): Promise<string> {
  const res = await mcpPost(gw, sessionId, secret, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'raw-client', version: '0.0.1' },
    },
  });
  await res.body.text();
  const mcpSessionId = res.headers['mcp-session-id'];
  if (res.statusCode !== 200 || typeof mcpSessionId !== 'string') {
    throw new Error(`initialize failed: ${String(res.statusCode)}`);
  }
  const initialized = await mcpPost(
    gw,
    sessionId,
    secret,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'mcp-session-id': mcpSessionId },
  );
  await initialized.body.text();
  return mcpSessionId;
}

/** An MCP TypeScript SDK client for the session, through the gateway. It does not reconnect. */
export function mcpClient(
  gw: Gateway,
  sessionId: string,
  secret: string,
): { client: Client; transport: StreamableHTTPClientTransport } {
  // undici's own fetch: the global fetch of Node.js 24 cannot use an undici 8 Agent.
  const fetchViaGateway = (input: string | URL, init?: UndiciRequestInit) =>
    undiciFetch(input, { ...init, dispatcher: gw.dispatcher });
  const transport = new StreamableHTTPClientTransport(new URL(gw.url(`/s/${sessionId}/mcp`)), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
    fetch: fetchViaGateway as unknown as FetchLike,
    reconnectionOptions: {
      initialReconnectionDelay: 60_000,
      maxReconnectionDelay: 60_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  return { client: new Client({ name: 'hydra-test', version: '1.0.0' }), transport };
}

/** Calls check until it does not throw (every 50 ms, at most timeoutMs). */
export async function eventually(check: () => void, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > end) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Reads an SSE response body until an event matches. */
export function readSseUntil(
  body: Dispatcher.ResponseData['body'],
  match: (event: SseEvent) => boolean,
  timeoutMs = 10_000,
): Promise<SseEvent> {
  const parser = new SseParser();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      body.off('data', onData);
      body.off('end', onEnd);
      body.off('error', onEnd);
    };
    const onData = (chunk: Buffer): void => {
      for (const event of parser.push(chunk)) {
        if (match(event)) {
          cleanup();
          resolve(event);
          return;
        }
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('the SSE stream ended before the event'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no matching SSE event in ${String(timeoutMs)} ms`));
    }, timeoutMs);
    body.on('data', onData);
    body.on('end', onEnd);
    body.on('error', onEnd);
  });
}
