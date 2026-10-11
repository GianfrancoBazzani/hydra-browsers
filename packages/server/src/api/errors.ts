import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ErrorCode } from '@hydra/shared';
import { RateLimitedError } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';
import { SHARED_SECURITY_HEADERS } from '../static/headers.js';

/** Spec section 12.2 format. `fields` only for validation_failed. */
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; fields?: Record<string, string> };
}

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  headers: Record<string, string>;
}

function body(code: ErrorCode, message: string, fields?: Record<string, string>): ApiErrorBody {
  return { error: fields === undefined ? { code, message } : { code, message, fields } };
}

/** zod issues → `fields`: one message for each path (`a.b.0`), `body` for the root. */
export function zodFields(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'body';
    fields[key] ??= issue.message;
  }
  return fields;
}

function isApiRoute(request: FastifyRequest): boolean {
  return request.routeOptions.url?.startsWith('/api/') ?? false;
}

/** The only place that turns errors into HTTP responses (index section 2.4). */
export function toErrorResponse(error: unknown, request: FastifyRequest): ErrorResponse {
  if (error instanceof HydraError) {
    const headers: Record<string, string> =
      error instanceof RateLimitedError ? { 'retry-after': String(error.retryAfterSeconds) } : {};
    const fields = error.code === 'validation_failed' ? (error.fields ?? {}) : undefined;
    return { status: error.status, body: body(error.code, error.message, fields), headers };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: body('validation_failed', 'The request is not valid.', zodFields(error)),
      headers: {},
    };
  }
  const fastifyError = error as Partial<FastifyError>;
  const code = fastifyError.code;
  if (
    (code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_JSON_BODY') &&
    isApiRoute(request)
  ) {
    // Spec section 6.4: a request that is not GET/HEAD must have a JSON body.
    return {
      status: 403,
      body: body('csrf_failed', 'The request body must be JSON.'),
      headers: {},
    };
  }
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    // Spec section 12.2: 413 body_too_large, without fields.
    return {
      status: 413,
      body: body('body_too_large', 'The request body is too large.'),
      headers: {},
    };
  }
  const status = fastifyError.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Spec section 12.2 gives validation_failed HTTP 400 only, whatever Fastify's own 4xx status is.
    const message = fastifyError.message ?? 'The request is not valid.';
    return { status: 400, body: body('validation_failed', message, {}), headers: {} };
  }
  // Spec section 12.2: the message gives no details; errorHandler logs the error.
  return { status: 500, body: body('internal', 'Internal server error.'), headers: {} };
}

/** Fastify error handler. Logs each 500 with the error (spec section 12.2, `internal`). */
export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const response = toErrorResponse(error, request);
  if (response.status >= 500) request.log.error({ err: error }, 'request failed');
  void reply.code(response.status).headers(response.headers).send(response.body);
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send(body('not_found', 'Not found.'));
}

/** Fastify `frameworkErrors`: errors before routing, for example a malformed URL. */
export function frameworkErrorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Framework errors run before any hook, so the shared headers (spec 6.8) are set here too.
  void reply
    .headers(SHARED_SECURITY_HEADERS)
    .code(400)
    .send(body('validation_failed', error.message, {}));
}
