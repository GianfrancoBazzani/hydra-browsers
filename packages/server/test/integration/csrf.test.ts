import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRequest, createTestApp, errorOf, PUBLIC_HOST, PUBLIC_ORIGIN } from '../helpers/app.js';
import { loginAs, seedUser } from '../helpers/seed.js';

describe('CSRF check (spec section 6.4)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let cookie: string;

  beforeEach(async () => {
    t = await createTestApp();
    const { user, password } = await seedUser(t.deps);
    cookie = await loginAs(t.app, user.email, password);
  });

  afterEach(async () => {
    await t.close();
  });

  const logout = (headers: Record<string, string>, payload?: string, url = '/api/auth/logout') =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { host: PUBLIC_HOST, cookie, ...headers },
      payload,
    });

  async function expectCsrfFailed(response: Awaited<ReturnType<typeof logout>>): Promise<void> {
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('csrf_failed');
    const me = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(me.statusCode).toBe(200);
  }

  it('accepts the dashboard request: public Origin, JSON type, JSON body', async () => {
    const response = await logout(
      { origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      '{}',
    );
    expect(response.statusCode).toBe(204);
  });

  it('rejects a missing Origin', async () => {
    await expectCsrfFailed(await logout({ 'content-type': 'application/json' }, '{}'));
  });

  it('rejects another Origin, also the live origin', async () => {
    await expectCsrfFailed(
      await logout({ origin: 'https://evil.example', 'content-type': 'application/json' }, '{}'),
    );
    await expectCsrfFailed(
      await logout(
        { origin: 'http://live.hydra.localhost', 'content-type': 'application/json' },
        '{}',
      ),
    );
  });

  it('rejects a body that is not JSON by its Content-Type', async () => {
    await expectCsrfFailed(
      await logout({ origin: PUBLIC_ORIGIN, 'content-type': 'text/plain' }, '{}'),
    );
    await expectCsrfFailed(
      await logout(
        { origin: PUBLIC_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        'a=b',
      ),
    );
    await expectCsrfFailed(await logout({ origin: PUBLIC_ORIGIN }));
  });

  it('rejects a missing or broken JSON body', async () => {
    await expectCsrfFailed(
      await logout({ origin: PUBLIC_ORIGIN, 'content-type': 'application/json' }),
    );
    await expectCsrfFailed(
      await logout({ origin: PUBLIC_ORIGIN, 'content-type': 'application/json' }, '{oops'),
    );
  });

  it('cannot be skipped with a percent-encoded path', async () => {
    await expectCsrfFailed(
      await logout({ 'content-type': 'application/json' }, '{}', '/%61pi/auth/logout'),
    );
  });

  it('protects the login route too', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: PUBLIC_HOST, 'content-type': 'text/plain' },
      payload: '{"email":"a@b.c","password":"x"}',
    });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('csrf_failed');
  });

  it('does not apply to GET and HEAD', async () => {
    const get = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { host: PUBLIC_HOST, cookie },
    });
    expect(get.statusCode).toBe(200);
    const head = await t.app.inject({
      method: 'HEAD',
      url: '/api/auth/me',
      headers: { host: PUBLIC_HOST, cookie },
    });
    expect(head.statusCode).toBe(200);
  });
});
