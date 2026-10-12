// The Streamable HTTP server of hydra-mcp on /mcp (spec section 8.8.3).
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Log } from './browser.js';

/** An MCP session without a request for 30 min is ended; its client initializes again (spec section 8.8.3). */
export const SESSION_IDLE_MS = 30 * 60_000;
const SWEEP_MS = 60_000;
export const NOT_CONNECTED_BODY = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'The browser of the session is not connected. Try again.' },
  id: null,
});

/** What the server tells an MCP session. */
export interface SessionHooks {
  /** The client opened its GET stream (the heartbeat starts after it, as in the playwright-mcp CLI). */
  streamOpened(): void;
}

export interface SidecarServerOptions {
  allowedHosts: string[];
  /** Connects the Playwright MCP server (through the interceptor) to the transport of a new MCP session. */
  connectSession: (transport: StreamableHTTPServerTransport) => Promise<SessionHooks | void>;
  log: Log;
  now?: () => number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  hooks: SessionHooks | null;
  lastUsed: number;
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(text);
}

export class SidecarServer {
  readonly #options: SidecarServerOptions;
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #http: Server;
  readonly #now: () => number;
  #allowedHosts = new Set<string>();
  #connected = false;
  #sweep: NodeJS.Timeout | null = null;

  constructor(options: SidecarServerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#http = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        options.log.error('request failed', err);
        if (!res.headersSent) sendText(res, 500, 'Internal error');
        else res.destroy();
      });
    });
  }

  /** While not connected, each request gets 503. A disconnect ends all MCP sessions. */
  setConnected(connected: boolean): void {
    this.#connected = connected;
    if (!connected) this.closeAllSessions();
  }

  closeAllSessions(): void {
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const entry of entries) void entry.transport.close();
  }

  async listen(host: string, port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(port, host, () => {
        this.#http.off('error', reject);
        resolve();
      });
    });
    const actual = (this.#http.address() as AddressInfo).port;
    const hosts =
      this.#options.allowedHosts.length > 0
        ? this.#options.allowedHosts
        : [`localhost:${String(actual)}`, `${host}:${String(actual)}`];
    this.#allowedHosts = new Set(hosts);
    this.#sweep = setInterval(() => {
      const now = this.#now();
      for (const [id, entry] of this.#sessions) {
        if (now - entry.lastUsed < SESSION_IDLE_MS) continue;
        this.#sessions.delete(id);
        void entry.transport.close();
      }
    }, SWEEP_MS);
    this.#sweep.unref();
    return actual;
  }

  async close(): Promise<void> {
    if (this.#sweep !== null) clearInterval(this.#sweep);
    this.closeAllSessions();
    this.#http.closeAllConnections();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#allowedHosts.has(req.headers.host ?? '')) {
      sendText(res, 403, `Access is only allowed at ${[...this.#allowedHosts].join(', ')}`);
      return;
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      sendText(res, 404, 'Not found');
      return;
    }
    if (!this.#connected) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(NOT_CONNECTED_BODY);
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const entry = this.#sessions.get(sessionId);
      if (entry === undefined) {
        sendText(res, 404, 'Session not found'); // the client initializes again (spec section 8.2 step 7)
        return;
      }
      entry.lastUsed = this.#now();
      if (req.method === 'GET') entry.hooks?.streamOpened();
      await entry.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      sendText(res, 400, 'Invalid request');
      return;
    }
    let hooks: SessionHooks | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.#sessions.set(id, { transport, hooks, lastUsed: this.#now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) this.#sessions.delete(transport.sessionId);
    };
    hooks = (await this.#options.connectSession(transport)) ?? null;
    await transport.handleRequest(req, res);
    // A first request that was not a valid initialize leaves a transport without a session: close it.
    if (transport.sessionId === undefined) await transport.close();
  }
}
