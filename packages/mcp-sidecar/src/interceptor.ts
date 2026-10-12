// The transport that the embedded Playwright MCP server connects to (spec section 8.8.3). It sits between the
// HTTP transport of one MCP session and that server: it adds the vault tools to tools/list, handles vault_fill
// itself, answers vault_list with an error, and sends internal calls with reserved IDs.
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { VAULT_TEXTS, VAULT_TOOL_DEFINITIONS, VAULT_TOOL_NAMES } from '@hydra/shared';

export const INTERNAL_ID_PREFIX = 'hydra-internal-';
const INTERNAL_TIMEOUT_MS = 30_000;
/**
 * The heartbeat of the playwright-mcp CLI, which createConnection does not run: after the first tool call
 * and the first GET stream, a ping each 3 s; a ping without an answer in 5 s closes the MCP session.
 */
export const HEARTBEAT_INTERVAL_MS = 3_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;

export interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface InternalCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export type FillHandler = (args: unknown, internal: InternalCaller) => Promise<ToolResult>;

export function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

type Id = string | number;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idKey(id: Id): string {
  return `${typeof id}:${String(id)}`;
}

function requestOf(message: JSONRPCMessage): { id: Id; method: string; params: unknown } | null {
  const value = message as Record<string, unknown>;
  const id = value.id;
  if (typeof value.method !== 'string' || (typeof id !== 'string' && typeof id !== 'number'))
    return null;
  return { id, method: value.method, params: value.params };
}

function responseId(message: JSONRPCMessage): Id | null {
  const value = message as Record<string, unknown>;
  if (!('result' in value) && !('error' in value)) return null;
  return typeof value.id === 'string' || typeof value.id === 'number' ? value.id : null;
}

function withVaultTools(message: JSONRPCMessage): JSONRPCMessage {
  const value = message as { result?: unknown };
  if (!isObject(value.result) || !Array.isArray(value.result.tools)) return message;
  const names = new Set<string>(VAULT_TOOL_NAMES);
  const tools = (value.result.tools as unknown[]).filter(
    (tool) => !(isObject(tool) && typeof tool.name === 'string' && names.has(tool.name)),
  );
  return {
    ...message,
    result: { ...value.result, tools: [...tools, ...VAULT_TOOL_DEFINITIONS] },
  } as JSONRPCMessage;
}

function resultOf(message: JSONRPCMessage): ToolResult {
  const value = message as { result?: unknown; error?: unknown };
  if (isObject(value.error))
    return toolError(typeof value.error.message === 'string' ? value.error.message : 'error');
  return isObject(value.result) && Array.isArray(value.result.content)
    ? (value.result as ToolResult)
    : toolError('invalid result');
}

export class InterceptingTransport implements Transport, InternalCaller {
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  readonly #outer: Transport;
  readonly #fill: FillHandler;
  readonly #toolsListIds = new Set<string>();
  readonly #internal = new Map<string, (result: ToolResult) => void>();
  readonly #clientPings = new Map<string, (answered: boolean) => void>();
  #counter = 0;
  #toolCalled = false;
  #streamOpen = false;
  #beating = false;
  #closed = false;
  #beatTimer: NodeJS.Timeout | null = null;

  constructor(outer: Transport, fill: FillHandler) {
    this.#outer = outer;
    this.#fill = fill;
  }

  get sessionId(): string | undefined {
    return this.#outer.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.#outer.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    const ownerClose = this.#outer.onclose;
    this.#outer.onmessage = (message, extra) => {
      this.#fromClient(message, extra);
    };
    this.#outer.onclose = () => {
      this.#closed = true;
      if (this.#beatTimer !== null) clearTimeout(this.#beatTimer);
      ownerClose?.();
      for (const resolve of this.#internal.values()) resolve(toolError('The MCP session closed.'));
      this.#internal.clear();
      this.onclose?.();
    };
    this.#outer.onerror = (error) => {
      this.onerror?.(error);
    };
    await this.#outer.start();
  }

  /** A message from the Playwright MCP server. */
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const id = responseId(message);
    if (id !== null) {
      const key = idKey(id);
      if (this.#internal.has(key)) {
        this.#settle(this.#internal, key, resultOf(message));
        return;
      }
      if (this.#toolsListIds.delete(key)) {
        await this.#outer.send(withVaultTools(message), options);
        return;
      }
    }
    await this.#outer.send(message, options);
  }

  close(): Promise<void> {
    return this.#outer.close();
  }

  /** The client opened its GET stream: the pings of the heartbeat go on it. */
  streamOpened(): void {
    this.#streamOpen = true;
    this.#maybeStartHeartbeat();
  }

  #maybeStartHeartbeat(): void {
    if (!this.#toolCalled || !this.#streamOpen || this.#beating || this.#closed) return;
    this.#beating = true;
    void this.#beat();
  }

  async #beat(): Promise<void> {
    if (this.#closed) return;
    if (!(await this.#ping())) {
      void this.close();
      return;
    }
    if (this.#closed) return;
    this.#beatTimer = setTimeout(() => {
      void this.#beat();
    }, HEARTBEAT_INTERVAL_MS);
    this.#beatTimer.unref();
  }

  #ping(): Promise<boolean> {
    this.#counter += 1;
    const id = `${INTERNAL_ID_PREFIX}ping-${String(this.#counter)}`;
    const key = idKey(id);
    const answered = this.#awaitReply(this.#clientPings, key, HEARTBEAT_TIMEOUT_MS, false);
    // No relatedRequestId: the SDK sends it on the GET stream of the session.
    this.#outer.send({ jsonrpc: '2.0', id, method: 'ping' } as JSONRPCMessage).catch(() => {
      this.#settle(this.#clientPings, key, false);
    });
    return answered;
  }

  /** A tools/call to Playwright MCP whose response does not go to the client. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.#counter += 1;
    const id = `${INTERNAL_ID_PREFIX}${String(this.#counter)}`;
    const result = this.#awaitReply(
      this.#internal,
      idKey(id),
      INTERNAL_TIMEOUT_MS,
      toolError(`${name} did not answer.`),
    );
    this.onmessage?.({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return result;
  }

  /** Waits for the reply of `key`. After `timeoutMs` it settles with `onTimeout`. */
  #awaitReply<T>(
    pending: Map<string, (value: T) => void>,
    key: string,
    timeoutMs: number,
    onTimeout: T,
  ): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#settle(pending, key, onTimeout);
      }, timeoutMs);
      timer.unref();
      pending.set(key, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  /** Removes the pending reply of `key` and settles it with `value`. False if there is none. */
  #settle<T>(pending: Map<string, (value: T) => void>, key: string, value: T): boolean {
    const resolve = pending.get(key);
    if (resolve === undefined) return false;
    pending.delete(key);
    resolve(value);
    return true;
  }

  #fromClient(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    const answered = responseId(message);
    if (answered !== null) {
      // The answer to a heartbeat ping: not for Playwright MCP.
      if (this.#settle(this.#clientPings, idKey(answered), true)) return;
    }
    const request = requestOf(message);
    if (request?.method === 'tools/call') {
      this.#toolCalled = true;
      this.#maybeStartHeartbeat();
    }
    if (request !== null) {
      if (typeof request.id === 'string' && request.id.startsWith(INTERNAL_ID_PREFIX)) {
        void this.#reply(request.id, {
          error: { code: -32600, message: VAULT_TEXTS.internalIdRejected },
        });
        return;
      }
      if (request.method === 'tools/list') this.#toolsListIds.add(idKey(request.id));
      if (request.method === 'tools/call' && isObject(request.params)) {
        if (request.params.name === 'vault_fill') {
          void this.#runFill(request.id, request.params.arguments);
          return;
        }
        if (request.params.name === 'vault_list') {
          void this.#reply(request.id, { result: toolError(VAULT_TEXTS.listOnlyThroughGateway) });
          return;
        }
      }
    }
    this.onmessage?.(message, extra);
  }

  async #runFill(id: Id, args: unknown): Promise<void> {
    let result: ToolResult;
    try {
      result = await this.#fill(args, this);
    } catch {
      result = toolError('vault_fill failed.'); // never the error text: it can contain the value
    }
    await this.#reply(id, { result });
  }

  async #reply(
    id: Id,
    body: { result: ToolResult } | { error: { code: number; message: string } },
  ): Promise<void> {
    try {
      await this.#outer.send({ jsonrpc: '2.0', id, ...body } as JSONRPCMessage, {
        relatedRequestId: id,
      });
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
