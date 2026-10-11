import { MeSchema } from '@hydra/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, type MockApi } from '../test/mock-api';
import { makeMe } from '../test/fixtures';
import { ApiError, apiRequest, errorMessage } from './client';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
});

describe('apiRequest', () => {
  it('sends GET requests on the same origin with the cookie and validates the response', async () => {
    api.on('GET /api/auth/me', { body: makeMe() });
    const me = await apiRequest('/api/auth/me', { schema: MeSchema });
    expect(me.email).toBe('ana@example.com');
    const [request] = api.calls('GET /api/auth/me');
    expect(request?.credentials).toBe('same-origin');
    expect(request?.body).toBeUndefined();
    expect(request?.headers.get('Content-Type')).toBeNull();
  });

  it('sends {} as the JSON body of a request without data (spec section 6.4)', async () => {
    api.on('POST /api/sessions/q2w3e4r5t6y7/stop', { status: 204 });
    api.on('DELETE /api/sessions/q2w3e4r5t6y7/live-grant', { status: 204 });
    await apiRequest('/api/sessions/q2w3e4r5t6y7/stop', { method: 'POST' });
    await apiRequest('/api/sessions/q2w3e4r5t6y7/live-grant', { method: 'DELETE' });
    for (const request of api.requests) {
      expect(request.body).toEqual({});
      expect(request.headers.get('Content-Type')).toBe('application/json');
    }
  });

  it('sends the data as JSON and drops empty query values', async () => {
    api.on('GET /api/sessions/q2w3e4r5t6y7/audit', {
      body: { events: [], nextBefore: null },
    });
    api.on('PATCH /api/users/u1', { status: 204 });
    await apiRequest('/api/sessions/q2w3e4r5t6y7/audit', {
      query: { kind: 'mcp.tool_call', tool: '', before: undefined, limit: 50 },
    });
    await apiRequest('/api/users/u1', { method: 'PATCH', body: { role: 'admin' } });
    expect(api.requests[0]?.query.toString()).toBe('kind=mcp.tool_call&limit=50');
    expect(api.requests[1]?.body).toEqual({ role: 'admin' });
  });

  it('turns an error body into ApiError', async () => {
    api.on(
      'POST /api/sessions',
      apiError(400, 'validation_failed', 'Invalid input', { name: 'Use 1 to 64 characters' }),
    );
    const error = await apiRequest('/api/sessions', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_failed',
      message: 'Invalid input',
      fields: { name: 'Use 1 to 64 characters' },
    });
  });

  it('reads Retry-After from a 429', async () => {
    api.on('POST /api/auth/login', {
      ...apiError(429, 'rate_limited', 'Too many attempts'),
      headers: { 'Retry-After': '900' },
    });
    await expect(
      apiRequest('/api/auth/login', { method: 'POST', body: { email: 'a', password: 'b' } }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 900 });
  });

  it('keeps the codes body_too_large and internal of spec section 12.2', async () => {
    api.on(
      'PATCH /api/sessions/q2w3e4r5t6y7',
      apiError(413, 'body_too_large', 'The request body is too large.'),
    );
    api.on('GET /api/users', apiError(500, 'internal', 'Internal server error.'));
    await expect(
      apiRequest('/api/sessions/q2w3e4r5t6y7', { method: 'PATCH', body: { name: 'x' } }),
    ).rejects.toMatchObject({ status: 413, code: 'body_too_large' });
    await expect(apiRequest('/api/users')).rejects.toMatchObject({
      status: 500,
      code: 'internal',
      message: 'Internal server error.',
    });
  });

  it('gives http_error for an error without an API body', async () => {
    api.on('GET /api/users', { status: 502, body: 'Bad gateway' });
    await expect(apiRequest('/api/users')).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });
  });

  it('gives invalid_response when the body does not match the schema', async () => {
    api.on('GET /api/auth/me', { body: { id: 1 } });
    await expect(apiRequest('/api/auth/me', { schema: MeSchema })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('gives network_error when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiRequest('/api/auth/me')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });
});

describe('errorMessage', () => {
  it('uses the message of the error', () => {
    expect(errorMessage(new ApiError(409, 'conflict', 'The email exists'))).toBe(
      'The email exists',
    );
    expect(errorMessage('x')).toBe('Something went wrong.');
  });
});
