import { eq } from 'drizzle-orm';
import { type UserSummary } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedUser } from '../helpers/seed.js';

// Many real Argon2 verifies: a longer timeout for slow CI runners.
describe('brute-force protection (spec section 6.4)', { timeout: 15_000 }, () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  const login = (email: string, password: string, remoteAddress = '203.0.113.20') =>
    apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email, password },
      remoteAddress,
    });

  it('permits 10 login attempts per minute for each IP, then 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await login(`nobody${i}@example.com`, 'whatever password')).statusCode).toBe(401);
    }
    const limited = await login('nobody10@example.com', 'whatever password');
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('other@example.com', 'whatever password', '203.0.113.21')).statusCode).toBe(
      401,
    );
    t.clock.advance(60_000);
    expect((await login('nobody11@example.com', 'whatever password')).statusCode).toBe(401);
  });

  it('throttles a pair after 5 failures: 429 with Retry-After, doubling, other IPs unaffected', async () => {
    const { user, password } = await seedUser(t.deps);
    for (let i = 0; i < 5; i += 1)
      expect((await login(user.email, 'wrong password!!')).statusCode).toBe(401);
    const throttled = await login(user.email, password);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBe('900');
    expect((await login(user.email, password, '198.51.100.200')).statusCode).toBe(200);
    t.clock.advance(15 * 60_000);
    expect((await login(user.email, 'wrong password!!')).statusCode).toBe(401);
    expect((await login(user.email, password)).headers['retry-after']).toBe('1800');
  });

  it('throttles an email that does not exist in the same way', async () => {
    for (let i = 0; i < 5; i += 1)
      expect((await login('ghost@example.com', 'wrong password!!')).statusCode).toBe(401);
    expect((await login('ghost@example.com', 'wrong password!!')).statusCode).toBe(429);
  });

  it('gives the same status and body for a locked account, an unknown email, and a wrong password', async () => {
    const locked = await seedUser(t.deps, { email: 'locked@example.com' });
    t.deps.db
      .update(users)
      .set({ lockedAt: t.clock.now(), failedLogins: 100 })
      .where(eq(users.id, locked.user.id))
      .run();
    const valid = await seedUser(t.deps, { email: 'valid@example.com' });
    const responses = [
      await login(locked.user.email, locked.password, '192.0.2.1'),
      await login('unknown@example.com', 'some password!!', '192.0.2.2'),
      await login(valid.user.email, 'wrong password!!', '192.0.2.3'),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe(responses[0]?.body);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(responses[0]?.json<unknown>()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid email or password' },
    });
  });

  it('locks after 100 failures in a row; an admin unlock ends the lock', async () => {
    const { user, password } = await seedUser(t.deps, { email: 'target@example.com' });
    t.deps.db.update(users).set({ failedLogins: 99 }).where(eq(users.id, user.id)).run();
    expect((await login(user.email, 'wrong password!!', '192.0.2.10')).statusCode).toBe(401);
    expect((await login(user.email, password, '192.0.2.11')).statusCode).toBe(401);
    const admin = await seedUser(t.deps, { role: 'admin' });
    const adminCookie = await loginAs(t.app, admin.user.email, admin.password);
    const listed = await apiRequest(t.app, {
      method: 'GET',
      url: '/api/users',
      cookie: adminCookie,
    });
    expect(listed.json<UserSummary[]>().find((row) => row.id === user.id)?.locked).toBe(true);
    const unlocked = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/users/${user.id}/unlock`,
      cookie: adminCookie,
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json<UserSummary>().locked).toBe(false);
    expect((await login(user.email, password, '192.0.2.12')).statusCode).toBe(200);
  });
});
