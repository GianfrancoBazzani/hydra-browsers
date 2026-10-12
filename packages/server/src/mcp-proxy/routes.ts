// POST, GET, DELETE /s/:sid/mcp (spec sections 8.1 and 8.2).
import type { Socket } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Agent, request as undiciRequest, type Dispatcher } from 'undici';
import { MESSAGES, VAULT_TEXTS } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { redactArguments } from '../audit/index.js';
import { RateLimiter } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';
import type { AgentPrincipal } from '../tokens/index.js';
import { VaultDecryptError, type Redactor } from '../vault/index.js';
import { subscribeStreamClosers } from './closers.js';
import { McpExchange, STREAM_CLOSED, cutClientField } from './exchange.js';
import { SECURITY_HEADERS, clientResponseHeaders, upstreamRequestHeaders } from './headers.js';
import {
  jsonRpcError,
  jsonRpcErrorBody,
  parseJsonRpcBody,
  toolCallArguments,
  toolCallName,
  type JsonRpcMessage,
} from './jsonrpc.js';
import { bodyModeOf, createRedactionTransform } from './redact-stream.js';
import { isSessionRunning } from './session-state.js';
import {
  BATCH_REJECTED_MESSAGE,
  DENIED_TOOL_ERROR_CODE,
  deniedToolMessage,
  isToolDenied,
} from './tool-policy.js';
import {
  VAULT_UNREADABLE_BODY,
  isVaultCall,
  planVaultCall,
  withoutHydraFill,
} from './vault-calls.js';

export const MCP_PATH = '/s/:sid/mcp';
export const MCP_POD_PORT = 8931;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_BATCH_MESSAGES = 100;
export const RATE_LIMIT_PER_SECOND = 20;
export const RATE_LIMIT_WINDOW_MS = 1_000;
/** No timeout while the pod sends the headers or the body of an MCP stream (spec section 8.2 step 6). */
export const POD_DISPATCHER_OPTIONS = { headersTimeout: 0, bodyTimeout: 0 } as const;

/** Spec section 8.2 step 2, byte for byte. */
export const SESSION_NOT_RUNNING_BODY = jsonRpcErrorBody(null, -32000, MESSAGES.sessionNotRunning);
/** Spec sections 8.2 step 3 and 12.2: 413 `body_too_large` in the API error format. */
export const BODY_TOO_LARGE_MESSAGE = 'The request body is larger than 1 MiB.';
export const PARSE_ERROR_BODY = jsonRpcErrorBody(null, -32700, 'Parse error');
export const BATCH_TOO_LARGE_BODY = jsonRpcErrorBody(
  null,
  -32600,
  `A batch can contain at most ${String(MAX_BATCH_MESSAGES)} messages.`,
);
export const POD_UNREACHABLE_BODY = jsonRpcErrorBody(
  null,
  -32000,
  'The MCP server of the session is not reachable.',
);
const INVALID_TOKEN_MESSAGE = 'Missing or invalid agent token.';

interface McpRoute {
  Params: { sid: string };
}

type ProxyDeps = Pick<AppDeps, 'audit' | 'clock' | 'logger' | 'mcpStreams' | 'podEndpoints'>;

function mcpSessionIdOf(request: FastifyRequest): string | null {
  const value = request.headers['mcp-session-id'];
  return typeof value === 'string' ? value : null;
}

function deniedTool(message: JsonRpcMessage): string | null {
  const tool = toolCallName(message);
  return tool !== null && isToolDenied(tool) ? tool : null;
}

/**
 * Answers a body that the gateway rejects: a denied tools/call (spec section 8.7), or a batch with a
 * vault tool call (spec section 8.8.2 step 1). Nothing goes to the pod.
 */
function rejectCalls(
  deps: Pick<AppDeps, 'audit'>,
  principal: AgentPrincipal,
  request: FastifyRequest,
  reply: FastifyReply,
  messages: readonly JsonRpcMessage[],
  batch: boolean,
  errorFor: (message: JsonRpcMessage) => string,
): FastifyReply {
  const responses: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.kind !== 'request') continue;
    const error = errorFor(message);
    responses.push(jsonRpcError(message.id, DENIED_TOOL_ERROR_CODE, error));
    const tool = toolCallName(message);
    if (tool === null) continue;
    deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: principal.tokenId,
      sessionId: principal.sessionId,
      status: 'error',
      data: {
        mcpSessionId: cutClientField(mcpSessionIdOf(request)),
        rpcId: cutClientField(message.id),
        tool: cutClientField(tool),
        arguments: redactArguments(tool, toolCallArguments(message)),
        durationMs: 0,
        error,
      },
    });
  }
  if (responses.length === 0) return reply.code(202).send();
  return reply
    .code(200)
    .type('application/json')
    .send(JSON.stringify(batch ? responses : responses[0]));
}

/** Sends the request to the pod and streams the response to the client (spec section 8.2 steps 5 to 7). */
async function proxyToPod(
  deps: ProxyDeps,
  dispatcher: Dispatcher,
  principal: AgentPrincipal,
  request: FastifyRequest,
  reply: FastifyReply,
  body: Buffer | undefined,
  exchange: McpExchange,
  redactor: () => Redactor,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  // No idle timeout on an open MCP stream, also if the server has a connectionTimeout.
  const socket = request.raw.socket as Socket | undefined;
  if (typeof socket?.setTimeout === 'function') socket.setTimeout(0);
  const controller = new AbortController();
  let registered = true;
  const unregister = deps.mcpStreams.register({
    tokenId: principal.tokenId,
    userId: principal.userId,
    sessionId: principal.sessionId,
    abort: (reason) => {
      request.log.info({ reason, sessionId: principal.sessionId }, 'gateway closed an MCP stream');
      exchange.close(STREAM_CLOSED);
      controller.abort(new Error(reason));
      res.destroy();
    },
  });
  const finish = (): void => {
    if (!registered) return;
    registered = false;
    unregister();
  };
  res.once('close', () => {
    finish();
    if (!res.writableEnded) {
      exchange.close(STREAM_CLOSED);
      controller.abort(new Error('client closed the connection'));
    }
  });

  let upstream: Dispatcher.ResponseData;
  try {
    const endpoint = await deps.podEndpoints.endpoint(principal.sessionId, MCP_POD_PORT);
    upstream = await undiciRequest(new URL('/mcp', endpoint), {
      method: request.method,
      headers: upstreamRequestHeaders(request.headers),
      body,
      signal: controller.signal,
      dispatcher,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    request.log.warn({ err, sessionId: principal.sessionId }, 'MCP request to the pod failed');
    exchange.close('MCP server not reachable');
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      res.end(POD_UNREACHABLE_BODY);
    }
    finish();
    return;
  }

  // The audit reads a copy: each chunk is inspected before it goes to the client, and flush() runs
  // before the end of the body goes to the client.
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      exchange.data(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      exchange.end();
      callback();
    },
  });
  const contentTypeHeader = upstream.headers['content-type'];
  const mode = bodyModeOf(
    upstream.statusCode,
    typeof contentTypeHeader === 'string' ? contentTypeHeader : '',
  );
  try {
    // Spec section 8.9: no redaction stage while the vault of the session is empty.
    const redact = !redactor().empty;
    const headers = clientResponseHeaders(upstream.headers);
    if (redact) delete headers['content-length']; // the redacted body has another length
    exchange.response(upstream.statusCode, upstream.headers); // before the first exchange.data()
    // The gateway headers come last: a pod header of the same name must not override them.
    res.writeHead(upstream.statusCode, { ...headers, ...SECURITY_HEADERS });
    res.flushHeaders();
    // The audit tap reads the response after the redaction (spec section 8.6).
    if (redact) await pipeline(upstream.body, createRedactionTransform(mode, redactor), tap, res);
    else await pipeline(upstream.body, tap, res);
  } catch {
    exchange.close(STREAM_CLOSED);
    upstream.body.destroy();
    res.destroy();
  } finally {
    // Every pending call gets a final status on each path (no-op after a normal end).
    exchange.close(STREAM_CLOSED);
    finish();
  }
}

export function registerMcpRoutes(scope: FastifyInstance, deps: AppDeps): void {
  const limiter = new RateLimiter({
    limit: RATE_LIMIT_PER_SECOND,
    windowMs: RATE_LIMIT_WINDOW_MS,
    clock: deps.clock,
  });
  const dispatcher = new Agent(POD_DISPATCHER_OPTIONS);
  const principals = new WeakMap<FastifyRequest, AgentPrincipal>();
  const unsubscribe = subscribeStreamClosers(deps);
  scope.addHook('onClose', async () => {
    unsubscribe();
    await dispatcher.destroy();
  });

  // Own encapsulated scope: the raw-body parser must not change the JSON parser of the dashboard API.
  void scope.register((mcp, _options, done) => {
    mcp.removeAllContentTypeParsers();
    mcp.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES },
      (_request, rawBody, parsed) => {
        parsed(null, rawBody);
      },
    );
    mcp.setErrorHandler((error: FastifyError) => {
      // The parent error handler (api/errors.ts) formats each HydraError, and answers other errors
      // with 500 internal (spec section 12.2).
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        throw new HydraError('body_too_large', BODY_TOO_LARGE_MESSAGE);
      }
      throw error;
    });

    mcp.route<McpRoute>({
      method: ['POST', 'GET', 'DELETE'],
      url: MCP_PATH,
      exposeHeadRoute: false, // no HEAD /s/:sid/mcp: it would be proxied to the pod
      constraints: { host: deps.config.publicUrl.host },
      // Runs before the body is read: the order is 401, 503, 429, then 413 (spec section 8.2).
      onRequest: (request, reply, next) => {
        const { sid } = request.params;
        const principal = deps.tokens.resolve(request.headers.authorization, sid, request.ip);
        if (principal === null) {
          reply.header('www-authenticate', 'Bearer realm="hydra"');
          next(new HydraError('unauthenticated', INVALID_TOKEN_MESSAGE));
          return;
        }
        if (!isSessionRunning(deps.db, principal.sessionId)) {
          void reply.code(503).type('application/json').send(SESSION_NOT_RUNNING_BODY);
          return;
        }
        if (!limiter.take(principal.tokenId)) {
          reply.header('retry-after', '1');
          const limit = String(RATE_LIMIT_PER_SECOND);
          next(new HydraError('rate_limited', `More than ${limit} requests per second.`));
          return;
        }
        principals.set(request, principal);
        next();
      },
      handler: async (request, reply) => {
        const principal = principals.get(request);
        if (principal === undefined) throw new HydraError('unauthenticated', INVALID_TOKEN_MESSAGE);
        // Only POST carries a body to the pod: a DELETE body is not inspected, so it is dropped.
        const body =
          request.method === 'POST' && Buffer.isBuffer(request.body) ? request.body : undefined;
        let messages: JsonRpcMessage[] = [];
        if (request.method === 'POST') {
          const parsed = parseJsonRpcBody(body ?? Buffer.alloc(0));
          if (!parsed.ok) return reply.code(400).type('application/json').send(PARSE_ERROR_BODY);
          if (parsed.messages.length > MAX_BATCH_MESSAGES) {
            return reply.code(400).type('application/json').send(BATCH_TOO_LARGE_BODY);
          }
          if (parsed.messages.some((message) => deniedTool(message) !== null)) {
            return rejectCalls(
              deps,
              principal,
              request,
              reply,
              parsed.messages,
              parsed.batch,
              (message) => {
                const denied = deniedTool(message);
                return denied !== null ? deniedToolMessage(denied) : BATCH_REJECTED_MESSAGE;
              },
            );
          }
          // Spec section 8.8.2 step 1: vault tool calls only one at a time.
          if (parsed.batch && parsed.messages.some(isVaultCall)) {
            return rejectCalls(
              deps,
              principal,
              request,
              reply,
              parsed.messages,
              true,
              () => VAULT_TEXTS.batchRejected,
            );
          }
          messages = parsed.messages;
        }
        // Spec section 8.9: fail closed if the vault of the session cannot be read.
        try {
          deps.vault.redactor(principal.sessionId);
        } catch (err) {
          const credentialId = err instanceof VaultDecryptError ? err.credentialId : undefined;
          request.log.error(
            { credentialId, sessionId: principal.sessionId },
            'the vault cannot be read',
          );
          return reply.code(502).type('application/json').send(VAULT_UNREADABLE_BODY);
        }
        const redactor = (): Redactor => deps.vault.redactor(principal.sessionId);
        const first = messages[0];
        const vaultCall =
          messages.length === 1 && first?.kind === 'request' && isVaultCall(first) ? first : null;
        const exchange = new McpExchange(deps, {
          principal,
          mcpSessionId: mcpSessionIdOf(request),
          ip: request.ip,
        });
        // Pending records with the arguments of the agent, before the request goes to the pod
        // (spec sections 8.6 and 8.8.2 step 2).
        const agentCall = vaultCall === null ? null : withoutHydraFill(vaultCall);
        const agentMessages = agentCall === null ? messages : [agentCall];
        try {
          exchange.begin(agentMessages);
        } catch (err) {
          // An audit write failed, maybe after earlier calls of this batch: those rows must not stay
          // pending. The request does not go to the pod; the error handler answers 500 internal.
          exchange.close();
          throw err;
        }
        let podBody = body;
        if (agentCall !== null) {
          let outcome;
          try {
            outcome = planVaultCall(deps.vault, principal.sessionId, agentCall, (err) => {
              // Spec section 6.9.3: the credential ID, never a value.
              request.log.error(
                { credentialId: err.credentialId, sessionId: principal.sessionId },
                'a vault value cannot be decrypted',
              );
            });
          } catch (err) {
            exchange.close('internal error');
            throw err;
          }
          if (outcome.kind === 'answer') {
            // The local answer goes through the exchange, so the audit record gets its final status.
            exchange.response(200, { 'content-type': 'application/json' });
            exchange.data(Buffer.from(outcome.body, 'utf8'));
            exchange.end();
            return reply.code(200).type('application/json').send(outcome.body);
          }
          if (outcome.waitMs > 0) await sleep(outcome.waitMs); // spec section 6.9.4
          podBody = outcome.body; // never logged (spec section 8.8.2 step 6)
        }
        await proxyToPod(deps, dispatcher, principal, request, reply, podBody, exchange, redactor);
        return reply;
      },
    });
    done();
  });
}
