import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEvents } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf, LIVE_HOST, PUBLIC_HOST } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import { createTestDb } from '../helpers/db.js';
import { seedUser } from '../helpers/seed.js';

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://live.hydra.localhost; " +
  "img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

describe('app', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  describe('health', () => {
    it('answers /healthz and /readyz on any host', async () => {
      for (const host of [PUBLIC_HOST, LIVE_HOST, '10.42.0.17:8080']) {
        const health = await t.app.inject({ method: 'GET', url: '/healthz', headers: { host } });
        expect(health.statusCode).toBe(200);
        expect(health.json<unknown>()).toEqual({ status: 'ok' });
        const ready = await t.app.inject({ method: 'GET', url: '/readyz', headers: { host } });
        expect(ready.statusCode).toBe(200);
        expect(ready.json<unknown>()).toEqual({
          status: 'ok',
          checks: { db: true, kubernetes: true },
        });
      }
    });

    it('reports not ready when the database does not answer', async () => {
      const broken = createTestDb();
      const app = await createTestApp({ db: broken.db });
      broken.sqlite.close();
      const ready = await app.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json<unknown>()).toEqual({
        status: 'unavailable',
        checks: { db: false, kubernetes: true },
      });
      await app.close();
      broken.close();
    });
  });

  describe('hosts', () => {
    it('serves the API only on the public host', async () => {
      const onPublic = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me' });
      expect(onPublic.statusCode).toBe(401);
      for (const host of [LIVE_HOST, 'evil.example', 'hydra.localhost:8080']) {
        const response = await t.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { host },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json<unknown>()).toEqual({
          error: { code: 'not_found', message: 'Not found.' },
        });
      }
    });

    it('returns not_found for an unknown API path', async () => {
      const response = await apiRequest(t.app, { method: 'GET', url: '/api/nothing-here' });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    });
  });

  describe('headers', () => {
    it('sets the dashboard headers of spec section 6.8 on API responses', async () => {
      const response = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me' });
      expect(response.headers['content-security-policy']).toBe(CSP);
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  describe('shared security headers', () => {
    const SHARED = {
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    const cases = [
      { name: 'an unknown API path (404)', method: 'GET', url: '/api/nope', status: 404 },
      {
        name: 'an unknown API path with POST (404)',
        method: 'POST',
        url: '/api/unknown',
        status: 404,
      },
      {
        name: 'an unknown non-API path without a web root (404)',
        method: 'POST',
        url: '/nope',
        status: 404,
      },
      { name: 'a malformed URL (400)', method: 'GET', url: '/api/%zz', status: 400 },
      { name: '/healthz', method: 'GET', url: '/healthz', status: 200 },
    ] as const;

    it.each(cases)('sets them on $name', async ({ method, url, status }) => {
      const response = await t.app.inject({ method, url, headers: { host: PUBLIC_HOST } });
      expect(response.statusCode).toBe(status);
      expect(response.headers).toMatchObject(SHARED);
    });
  });

  describe('errors', () => {
    it('answers a zod failure with validation_failed and fields', async () => {
      const response = await apiRequest(t.app, {
        method: 'POST',
        url: '/api/auth/login',
        body: { email: 'a@b.c' },
      });
      expect(response.statusCode).toBe(400);
      const error = errorOf(response);
      expect(error.code).toBe('validation_failed');
      expect(error.message).toBe('The request is not valid.');
      expect(Object.keys(error.fields ?? {})).toEqual(['password']);
    });

    it('answers 413 body_too_large for a body over 1 MiB', async () => {
      const response = await apiRequest(t.app, {
        method: 'POST',
        url: '/api/auth/login',
        body: { email: 'a@b.c', password: 'x'.repeat(1_048_576) },
      });
      expect(response.statusCode).toBe(413);
      expect(response.json<unknown>()).toEqual({
        error: { code: 'body_too_large', message: 'The request body is too large.' },
      });
    });

    it('answers an unexpected error with 500 internal and no details', async () => {
      vi.spyOn(t.deps.auth, 'resolve').mockImplementation(() => {
        throw new Error('database password is xyz');
      });
      const response = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me' });
      expect(response.statusCode).toBe(500);
      expect(response.json<unknown>()).toEqual({
        error: { code: 'internal', message: 'Internal server error.' },
      });
      expect(response.body).not.toContain('xyz');
    });

    it('answers a malformed URL in the API error format', async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/%zz',
        headers: { host: PUBLIC_HOST },
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_failed');
    });
  });

  describe('client address', () => {
    it('trusts X-Forwarded-For only from HYDRA_TRUSTED_PROXIES', async () => {
      const { user, password } = await seedUser(t.deps);
      const login = (remoteAddress: string) =>
        apiRequest(t.app, {
          method: 'POST',
          url: '/api/auth/login',
          body: { email: user.email, password },
          headers: { 'x-forwarded-for': '203.0.113.50' },
          remoteAddress,
        });
      expect((await login('10.42.3.4')).statusCode).toBe(200);
      expect((await login('192.0.2.1')).statusCode).toBe(200);
      const ips = t.deps.db
        .select()
        .from(auditEvents)
        .all()
        .filter((row) => row.kind === 'auth.login')
        .map((row) => row.data.ip);
      expect(ips).toEqual(['203.0.113.50', '192.0.2.1']);
    });

    it('trusts no proxy when the list is empty', async () => {
      const strict = await createTestApp({ config: testConfig({ trustedProxies: [] }) });
      const { user, password } = await seedUser(strict.deps);
      await apiRequest(strict.app, {
        method: 'POST',
        url: '/api/auth/login',
        body: { email: user.email, password },
        headers: { 'x-forwarded-for': '203.0.113.50' },
        remoteAddress: '10.42.3.4',
      });
      const row = strict.deps.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.kind === 'auth.login');
      expect(row?.data.ip).toBe('10.42.3.4');
      await strict.close();
    });
  });
});
