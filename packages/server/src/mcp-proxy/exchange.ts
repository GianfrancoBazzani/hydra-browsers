// Audit records of one proxied MCP request (spec section 8.6).
import { redactArguments, truncateString, type AuditWriter } from '../audit/index.js';
import { redactedStrings, ruleFor } from '../audit/redaction.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { AgentPrincipal } from '../tokens/index.js';
import {
  idKey,
  isObject,
  parseServerPayload,
  toolCallArguments,
  toolCallName,
  type JsonRpcErrorObject,
  type JsonRpcMessage,
} from './jsonrpc.js';
import { bodyModeOf, type BodyMode } from './redact-stream.js';
import { SseParser } from './sse.js';

export const MAX_ERROR_CHARS = 500;
export const STREAM_CLOSED = 'stream closed';
const DUPLICATE_REQUEST_ID = 'duplicate request id';
const INVALID_RESPONSE = 'invalid response';
const MAX_JSON_BODY_CHARS = 64 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 2_000;
/** Client-controlled values (tool name, string request id, MCP session id, client info) are stored cut to this. */
export const MAX_CLIENT_FIELD_CHARS = 200;
const REDACTED = '[redacted]';
// ESC [ parameters final-byte: the color codes of Playwright error texts.
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** Cuts a client-controlled string to MAX_CLIENT_FIELD_CHARS; other values stay as they are. */
export function cutClientField<T extends string | number | null>(value: T): T {
  return typeof value === 'string' ? (truncateString(value, MAX_CLIENT_FIELD_CHARS) as T) : value;
}

export interface ExchangeDeps {
  audit: Pick<AuditWriter, 'write' | 'update'>;
  clock: Clock;
  logger: Logger;
}

export interface ExchangeContext {
  principal: AgentPrincipal;
  /** The Mcp-Session-Id header of the request (null for initialize). */
  mcpSessionId: string | null;
  ip: string;
}

interface PendingCall {
  auditId: number;
  startedAt: number;
  data: Record<string, unknown>;
  /** Raw strings of the arguments that the redaction rule replaces: they must not reach the error text. */
  secrets: readonly string[];
  /** browser_press_key: only the first line of the error text is kept. */
  firstLineOnly: boolean;
}

interface ClientInfo {
  name: string | null;
  version: string | null;
}

function clientInfoOf(params: unknown): ClientInfo {
  const info = isObject(params) && isObject(params.clientInfo) ? params.clientInfo : {};
  const text = (value: unknown): string | null =>
    typeof value === 'string' ? truncateString(value, MAX_CLIENT_FIELD_CHARS) : null;
  return { name: text(info.name), version: text(info.version) };
}

function rpcErrorText(error: JsonRpcErrorObject): string {
  return error.message !== '' ? error.message : `JSON-RPC error ${String(error.code)}`;
}

/** The error text of a tool result with isError = true, else null. */
function toolErrorText(result: unknown): string | null {
  if (!isObject(result) || result.isError !== true) return null;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isObject(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
  return text !== '' ? text : 'Tool returned an error';
}

/** Keeps the "### Error" section. "### Ran Playwright code" (it repeats the typed text) and later sections go. */
function errorSection(text: string): string {
  const headings = [...text.matchAll(/^### .*$/gm)];
  const ran = headings.find((heading) => /^### Ran Playwright code\b/.test(heading[0]));
  const withoutCode = ran === undefined ? text : text.slice(0, ran.index);
  const error = [...withoutCode.matchAll(/^### Error\b.*$/gm)][0];
  if (error === undefined) return withoutCode.trim();
  const next = [...withoutCode.matchAll(/^### .*$/gm)].find(
    (heading) => heading.index > error.index,
  );
  return withoutCode.slice(error.index, next?.index).trim();
}

/** The first line of the error message, without the "### Error" heading. */
function firstErrorLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('### ')) ?? ''
  );
}

/** Typed text must not reach the audit log through a text of the pod (spec section 8.6). */
function cleanError(call: Pick<PendingCall, 'secrets' | 'firstLineOnly'>, raw: string): string {
  let text = errorSection(raw.replace(ANSI_SEQUENCE, ''));
  if (call.firstLineOnly) text = firstErrorLine(text);
  // Longest first, so that a secret that contains another one is replaced as a whole. The JSON
  // escaped form is replaced too: Playwright prints strings as JavaScript literals.
  const secrets = new Set<string>();
  for (const secret of call.secrets) {
    if (secret === '') continue;
    secrets.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== '') secrets.add(escaped);
  }
  for (const secret of [...secrets].sort((x, y) => y.length - x.length))
    text = text.replaceAll(secret, REDACTED);
  return text;
}

/** The error of a call: `internal` is a text of the gateway, `pod` a text that the pod sent (it is cleaned). */
interface ErrorText {
  internal: string;
  pod?: string;
}

/** The stored error: the internal text stays as it is, the pod text goes through cleanError. */
function errorOf(call: Pick<PendingCall, 'secrets' | 'firstLineOnly'>, error: ErrorText): string {
  if (error.pod === undefined) return truncateString(error.internal, MAX_ERROR_CHARS);
  const cleaned = cleanError(call, error.pod);
  const text =
    error.internal === ''
      ? cleaned !== ''
        ? cleaned
        : 'Tool returned an error'
      : cleaned !== ''
        ? `${error.internal} ${cleaned}`
        : error.internal.replace(/:$/, '');
  return truncateString(text, MAX_ERROR_CHARS);
}

export class McpExchange {
  readonly #deps: ExchangeDeps;
  readonly #context: ExchangeContext;
  readonly #calls = new Map<string, PendingCall>();
  readonly #initializes = new Map<string, ClientInfo>();
  readonly #decoder = new TextDecoder('utf-8');
  #mode: BodyMode = 'other';
  #status = 0;
  #responseSessionId: string | null = null;
  #sse: SseParser | null = null;
  #json = '';
  #jsonTooLarge = false;
  #otherBody = '';
  #done = false;

  constructor(deps: ExchangeDeps, context: ExchangeContext) {
    this.#deps = deps;
    this.#context = context;
  }

  /** Number of tool calls without a final status. */
  get pendingCalls(): number {
    return this.#calls.size;
  }

  /**
   * Writes the pending mcp.tool_call record of each tools/call request, and remembers initialize requests.
   * Call it before the request goes to the pod. It throws if the audit write fails; then the request must not go out.
   */
  begin(messages: readonly JsonRpcMessage[]): void {
    for (const message of messages) {
      if (message.kind !== 'request') continue;
      if (message.method === 'initialize') {
        this.#initializes.set(idKey(message.id), clientInfoOf(message.params));
        continue;
      }
      const tool = toolCallName(message);
      if (tool === null) continue;
      const args = toolCallArguments(message);
      const data: Record<string, unknown> = {
        mcpSessionId: cutClientField(this.#context.mcpSessionId),
        rpcId: cutClientField(message.id),
        tool: cutClientField(tool),
        arguments: redactArguments(tool, args),
        durationMs: null,
        error: null,
      };
      const event = this.#deps.audit.write({
        kind: 'mcp.tool_call',
        actorType: 'token',
        actorId: this.#context.principal.tokenId,
        sessionId: this.#context.principal.sessionId,
        status: 'pending',
        data,
      });
      const key = idKey(message.id);
      const previous = this.#calls.get(key);
      if (previous !== undefined) {
        // A second call with the same id would make the first row unreachable; finish it now.
        this.#calls.delete(key);
        this.#finish(previous, 'error', { internal: DUPLICATE_REQUEST_ID });
      }
      this.#calls.set(key, {
        auditId: event.id,
        startedAt: this.#deps.clock.now(),
        data,
        secrets: redactedStrings(tool, args),
        firstLineOnly: ruleFor(tool).singleCharactersOnly === true,
      });
    }
  }

  /** The status line and the headers of the pod response. */
  response(status: number, headers: Record<string, string | string[] | undefined>): void {
    this.#status = status;
    const sessionHeader = headers['mcp-session-id'];
    this.#responseSessionId = typeof sessionHeader === 'string' ? sessionHeader : null;
    const contentTypeHeader = headers['content-type'];
    this.#mode = bodyModeOf(status, typeof contentTypeHeader === 'string' ? contentTypeHeader : '');
    if (this.#mode === 'sse') this.#sse = new SseParser();
  }

  /** A chunk of the response body. The proxy calls it before the chunk goes to the client. */
  data(chunk: Uint8Array): void {
    if (this.#done) return;
    if (this.#sse !== null) {
      for (const event of this.#sse.push(chunk)) this.#serverPayload(event.data);
      return;
    }
    const text = this.#decoder.decode(chunk, { stream: true });
    if (this.#mode === 'json') {
      if (this.#jsonTooLarge) return;
      this.#json += text;
      if (this.#json.length > MAX_JSON_BODY_CHARS) {
        this.#jsonTooLarge = true;
        this.#json = '';
      }
      return;
    }
    if (this.#otherBody.length < MAX_ERROR_BODY_CHARS) this.#otherBody += text;
  }

  /** The response body ended normally. */
  end(): void {
    if (this.#done) return;
    if (this.#sse !== null) {
      for (const event of this.#sse.end()) this.#serverPayload(event.data);
    } else if (this.#mode === 'json') {
      this.#json += this.#decoder.decode();
      if (!this.#jsonTooLarge) this.#serverPayload(this.#json);
    } else {
      this.#otherBody += this.#decoder.decode();
    }
    const body = this.#otherBody.trim();
    if (this.#status >= 400) {
      const prefix = `HTTP ${String(this.#status)}`;
      this.#finishAll(body === '' ? { internal: prefix } : { internal: `${prefix}:`, pod: body });
      return;
    }
    const reason =
      this.#sse?.overflowed === true || this.#jsonTooLarge
        ? 'response too large to inspect'
        : STREAM_CLOSED;
    this.#finishAll({ internal: reason });
  }

  /** The stream closed before its end (client, pod, or registry). Pending calls get the given error. */
  close(reason: string = STREAM_CLOSED): void {
    if (this.#done) return;
    this.#finishAll({ internal: reason });
  }

  #serverPayload(text: string): void {
    const messages = parseServerPayload(text);
    if (messages === null) return;
    for (const message of messages) {
      if (message.kind === 'response' && message.id !== null)
        this.#serverResponse(idKey(message.id), message);
    }
  }

  #serverResponse(key: string, message: Extract<JsonRpcMessage, { kind: 'response' }>): void {
    const call = this.#calls.get(key);
    if (call !== undefined) {
      this.#calls.delete(key);
      // A non-object "error" classifies as error null and result undefined: not a valid response.
      let error: ErrorText | null;
      if (message.error !== null) error = { internal: '', pod: rpcErrorText(message.error) };
      else if (message.result === undefined) error = { internal: INVALID_RESPONSE };
      else {
        const text = toolErrorText(message.result);
        error = text === null ? null : { internal: '', pod: text };
      }
      this.#finish(call, error === null ? 'ok' : 'error', error);
    }
    const clientInfo = this.#initializes.get(key);
    if (clientInfo !== undefined) {
      this.#initializes.delete(key);
      if (message.error === null && message.result !== undefined) this.#connect(clientInfo);
    }
  }

  #connect(clientInfo: ClientInfo): void {
    try {
      this.#deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'token',
        actorId: this.#context.principal.tokenId,
        sessionId: this.#context.principal.sessionId,
        data: { mcpSessionId: this.#responseSessionId, clientInfo, ip: this.#context.ip },
      });
    } catch (err) {
      this.#deps.logger.error({ err }, 'mcp.connect audit write failed');
    }
  }

  #finish(call: PendingCall, status: 'ok' | 'error', error: ErrorText | null): void {
    const durationMs = Math.max(0, this.#deps.clock.now() - call.startedAt);
    try {
      this.#deps.audit.update(call.auditId, {
        status,
        data: { ...call.data, durationMs, error: error === null ? null : errorOf(call, error) },
      });
    } catch (err) {
      this.#deps.logger.error({ err, auditId: call.auditId }, 'mcp.tool_call audit update failed');
    }
  }

  #finishAll(reason: ErrorText): void {
    this.#done = true;
    for (const call of this.#calls.values()) this.#finish(call, 'error', reason);
    this.#calls.clear();
    this.#initializes.clear();
  }
}
