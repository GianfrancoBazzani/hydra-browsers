import { type Me } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_SESSION_IDLE_MS, SESSION_COOKIE } from '../../src/auth/index.js';
import { loginSessions } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedUser } from '../helpers/seed.js';

describe('auth routes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  it('logs in, sets the __Host- cookie, and returns Me', async () => {
    const { user, password } = await seedUser(t.deps, {
      email: 'alice@example.com',
      displayName: 'Alice',
    });
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'ALICE@example.com', password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      id: user.id,
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'member',
      mustChangePassword: false,
    });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^__Host-hydra_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    const value = setCookie.split(';')[0]?.split('=')[1] ?? '';
    const stored = t.deps.db.select().from(loginSessions).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHmac.toString('base64url')).not.toBe(value);
  });

  it('answers 401 invalid_credentials for a wrong password', async () => {
    const { user } = await seedUser(t.deps);
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email: user.email, password: 'not the password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid email or password' },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('GET /api/auth/me needs a login session', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    const me = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json<Me>().id).toBe(user.id);
    const anonymous = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous).code).toBe('unauthenticated');
    const forged = await apiRequest(t.app, {
      method: 'GET',
      url: '/api/auth/me',
      cookie: `${SESSION_COOKIE}=forged`,
    });
    expect(forged.statusCode).toBe(401);
  });

  it('logs out: 204, clears the cookie, deletes the row, publishes login.ended', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    const ended: HydraEvent[] = [];
    t.deps.bus.subscribe('login.ended', (event) => ended.push(event));
    const response = await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toBe(
      '__Host-hydra_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
    expect(t.deps.db.select().from(loginSessions).all()).toHaveLength(0);
    expect(ended).toHaveLength(1);
    const after = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(after.statusCode).toBe(401);
  });

  it('gives a new cookie value at each login and ends the login session of the old cookie', async () => {
    const { user, password } = await seedUser(t.deps);
    const first = await loginAs(t.app, user.email, password);
    const again = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      cookie: first,
      body: { email: user.email, password },
    });
    const second = `${SESSION_COOKIE}=${again.cookies[0]?.value ?? ''}`;
    expect(second).not.toBe(first);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: first })).statusCode,
    ).toBe(401);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: second })).statusCode,
    ).toBe(200);
  });

  it('ends a login session after 12 h idle', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    t.clock.advance(LOGIN_SESSION_IDLE_MS - 60_000);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
    ).toBe(200);
    t.clock.advance(LOGIN_SESSION_IDLE_MS);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
    ).toBe(401);
  });

  it('a password change ends the other login sessions of the user, not the current one', async () => {
    const { user, password } = await seedUser(t.deps);
    const current = await loginAs(t.app, user.email, password);
    const other = await loginAs(t.app, user.email, password);
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/password',
      cookie: current,
      body: { current: password, new: 'a different long passphrase' },
    });
    expect(response.statusCode).toBe(204);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: current })).statusCode,
    ).toBe(200);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: other })).statusCode,
    ).toBe(401);
    await loginAs(t.app, user.email, 'a different long passphrase');
  });

  it('rejects a new password that breaks the rules', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    for (const next of ['short', 'Password1234', user.email]) {
      const response = await apiRequest(t.app, {
        method: 'POST',
        url: '/api/auth/password',
        cookie,
        body: { current: password, new: next },
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('password_rejected');
    }
  });
});
