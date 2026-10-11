import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RateLimitedError } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';
import { errorHandler, toErrorResponse, zodFields } from './errors.js';

const apiRequest = { routeOptions: { url: '/api/auth/login' } } as FastifyRequest;
const mcpRequest = { routeOptions: { url: '/s/:sid/mcp' } } as FastifyRequest;

function fastifyError(code: string, statusCode: number, message = code): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

describe('toErrorResponse', () => {
  it('maps a HydraError to its status and code, without fields', () => {
    const response = toErrorResponse(new HydraError('not_found', 'Session not found.'), apiRequest);
    expect(response).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'Session not found.' } },
      headers: {},
    });
  });

  it('keeps fields only for validation_failed', () => {
    const withFields = new HydraError('validation_failed', 'Bad.', {
      email: 'Enter an email address.',
    });
    expect(toErrorResponse(withFields, apiRequest).body.error.fields).toEqual({
      email: 'Enter an email address.',
    });
    const conflict = new HydraError('conflict', 'Exists.', { email: 'ignored' });
    expect(toErrorResponse(conflict, apiRequest).body.error).not.toHaveProperty('fields');
  });

  it('adds Retry-After for a rate limit', () => {
    const response = toErrorResponse(new RateLimitedError(900_000), apiRequest);
    expect(response.status).toBe(429);
    expect(response.headers).toEqual({ 'retry-after': '900' });
    expect(response.body.error.code).toBe('rate_limited');
  });

  it('maps a zod error to validation_failed with one message for each field', () => {
    const schema = z.object({ email: z.string(), nested: z.object({ n: z.number() }) });
    const result = schema.safeParse({ nested: { n: 'x' } });
    if (result.success) throw new Error('expected a failure');
    const response = toErrorResponse(result.error, apiRequest);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(Object.keys(response.body.error.fields ?? {})).toEqual(['email', 'nested.n']);
  });

  it('names the root "body"', () => {
    const result = z.object({}).safeParse(null);
    if (result.success) throw new Error('expected a failure');
    expect(Object.keys(zodFields(result.error))).toEqual(['body']);
  });

  it('turns an empty or broken JSON body into csrf_failed on /api routes only', () => {
    const empty = fastifyError('FST_ERR_CTP_EMPTY_JSON_BODY', 400);
    const broken = fastifyError('FST_ERR_CTP_INVALID_JSON_BODY', 400);
    expect(toErrorResponse(empty, apiRequest)).toMatchObject({
      status: 403,
      body: { error: { code: 'csrf_failed' } },
    });
    expect(toErrorResponse(broken, apiRequest)).toMatchObject({
      status: 403,
      body: { error: { code: 'csrf_failed' } },
    });
    expect(toErrorResponse(broken, mcpRequest)).toMatchObject({
      status: 400,
      body: { error: { code: 'validation_failed' } },
    });
  });

  it('answers 413 body_too_large for a body that is too large (spec section 12.2)', () => {
    const response = toErrorResponse(fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413), apiRequest);
    expect(response).toEqual({
      status: 413,
      body: { error: { code: 'body_too_large', message: 'The request body is too large.' } },
      headers: {},
    });
  });

  it('maps any other Fastify 4xx error to 400 validation_failed, keeping the message (spec section 12.2)', () => {
    const unsupported = fastifyError(
      'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      415,
      'Unsupported Media Type',
    );
    expect(toErrorResponse(unsupported, apiRequest)).toEqual({
      status: 400,
      body: { error: { code: 'validation_failed', message: 'Unsupported Media Type', fields: {} } },
      headers: {},
    });
  });

  it('hides unknown errors behind a 500 internal without details (spec section 12.2)', () => {
    const response = toErrorResponse(new Error('database password is xyz'), apiRequest);
    expect(response).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'Internal server error.' } },
      headers: {},
    });
  });
});

describe('errorHandler', () => {
  interface FakeReply {
    code(status: number): FakeReply;
    headers(values: Record<string, string>): FakeReply;
    send(payload: unknown): FakeReply;
  }

  interface Handled {
    status?: number;
    payload?: unknown;
    logged: unknown[][];
  }

  function handle(error: unknown): Handled {
    const result: Handled = { logged: [] };
    const reply: FakeReply = {
      code(status) {
        result.status = status;
        return reply;
      },
      headers() {
        return reply;
      },
      send(payload) {
        result.payload = payload;
        return reply;
      },
    };
    const request = {
      routeOptions: { url: '/api/auth/me' },
      log: { error: (...args: unknown[]) => result.logged.push(args) },
    };
    errorHandler(error, request as unknown as FastifyRequest, reply as unknown as FastifyReply);
    return result;
  }

  it('logs an unexpected error and sends internal without details', () => {
    const error = new Error('database password is xyz');
    const result = handle(error);
    expect(result.status).toBe(500);
    expect(result.payload).toEqual({
      error: { code: 'internal', message: 'Internal server error.' },
    });
    expect(result.logged).toEqual([[{ err: error }, 'request failed']]);
  });

  it('does not log an expected error', () => {
    const result = handle(new HydraError('not_found', 'Session not found.'));
    expect(result.status).toBe(404);
    expect(result.logged).toEqual([]);
  });
});
