import { eq } from 'drizzle-orm';
import {
  type CreateUserResponse,
  type Me,
  type ResetPasswordResponse,
  type UserSummary,
} from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { agentTokens, users } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

describe('admin user routes (spec section 6.3)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: AuthedUser;
  let adminCookie: string;
  let events: HydraEvent[];

  beforeEach(async () => {
    t = await createTestApp();
    const seeded = await seedUser(t.deps, { email: 'admin@example.com', role: 'admin' });
    admin = seeded.user;
    adminCookie = await loginAs(t.app, admin.email, seeded.password);
    events = [];
    for (const type of ['rights.changed', 'login.ended', 'token.revoked'] as const) {
      t.deps.bus.subscribe(type, (event) => events.push(event));
    }
  });

  afterEach(async () => {
    await t.close();
  });

  it('is forbidden for members and needs a login', async () => {
    const member = await seedUser(t.deps);
    const cookie = await loginAs(t.app, member.user.email, member.password);
    const forbidden = await apiRequest(t.app, { method: 'GET', url: '/api/users', cookie });
    expect(forbidden.statusCode).toBe(403);
    expect(errorOf(forbidden).code).toBe('forbidden');
    const anonymous = await apiRequest(t.app, { method: 'GET', url: '/api/users' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('creates a user with a one-time password shown one time', async () => {
    const created = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/users',
      cookie: adminCookie,
      body: { email: 'bob@example.com', displayName: 'Bob', role: 'member' },
    });
    expect(created.statusCode).toBe(201);
    const { user, oneTimePassword } = created.json<CreateUserResponse>();
    expect(user).toMatchObject({
      email: 'bob@example.com',
      role: 'member',
      status: 'active',
      locked: false,
    });
    expect(oneTimePassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const list = await apiRequest(t.app, { method: 'GET', url: '/api/users', cookie: adminCookie });
    expect(list.body).not.toContain(oneTimePassword);
    const cookie = await loginAs(t.app, 'bob@example.com', oneTimePassword);
    const me = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(me.json<Me>().mustChangePassword).toBe(true);
    const duplicate = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/users',
      cookie: adminCookie,
      body: { email: 'BOB@example.com', displayName: 'Bob 2', role: 'member' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorOf(duplicate).code).toBe('conflict');
  });

  it('rejects a body that does not match the schema', async () => {
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/users',
      cookie: adminCookie,
      body: { email: 'not-an-email', displayName: '', role: 'root' },
    });
    expect(response.statusCode).toBe(400);
    expect(Object.keys(errorOf(response).fields ?? {}).sort()).toEqual([
      'displayName',
      'email',
      'role',
    ]);
  });

  it('changes the role and publishes rights.changed', async () => {
    const { user } = await seedUser(t.deps);
    const response = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${user.id}`,
      cookie: adminCookie,
      body: { role: 'admin', displayName: 'Promoted' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toMatchObject({ role: 'admin', displayName: 'Promoted' });
    expect(events).toEqual([{ type: 'rights.changed', userId: user.id }]);
  });

  it('disables a user: login sessions end, tokens are revoked, rights.changed; enable keeps tokens revoked', async () => {
    const member = await seedUser(t.deps);
    const owner = await seedUser(t.deps);
    const session = seedSession(t.deps, { ownerId: owner.user.id });
    // The member and token routes come in later tasks, so the setup uses the services.
    t.deps.access.addMember({ user: owner.user, loginSessionId: 'setup' }, session.id, {
      email: member.user.email,
      role: 'operator',
    });
    const memberCookie = await loginAs(t.app, member.user.email, member.password);
    const { token } = t.deps.tokens.create(
      { user: member.user, loginSessionId: 'setup' },
      session.id,
      {
        name: 'agent',
        expiresInDays: 7,
      },
    );
    events.length = 0;
    const disabled = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${member.user.id}`,
      cookie: adminCookie,
      body: { status: 'disabled' },
    });
    expect(disabled.json<UserSummary>().status).toBe('disabled');
    expect(events.map((event) => event.type)).toEqual([
      'login.ended',
      'token.revoked',
      'rights.changed',
    ]);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: memberCookie }))
        .statusCode,
    ).toBe(401);
    const login = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email: member.user.email, password: member.password },
    });
    expect(login.statusCode).toBe(401);
    const revoked = () =>
      t.deps.db.select().from(agentTokens).where(eq(agentTokens.id, token.id)).get()?.revokedAt;
    expect(revoked()).not.toBeNull();
    await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${member.user.id}`,
      cookie: adminCookie,
      body: { status: 'active' },
    });
    expect(revoked()).not.toBeNull();
    await loginAs(t.app, member.user.email, member.password);
  });

  it('does not let an admin change the own role or status', async () => {
    const response = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      cookie: adminCookie,
      body: { status: 'disabled' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('resets a password: all login sessions end, the lock ends, a new one-time password works', async () => {
    const member = await seedUser(t.deps);
    const first = await loginAs(t.app, member.user.email, member.password);
    const second = await loginAs(t.app, member.user.email, member.password);
    t.deps.db
      .update(users)
      .set({ lockedAt: t.clock.now(), failedLogins: 100 })
      .where(eq(users.id, member.user.id))
      .run();
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/users/${member.user.id}/reset-password`,
      cookie: adminCookie,
    });
    expect(response.statusCode).toBe(200);
    const { oneTimePassword } = response.json<ResetPasswordResponse>();
    for (const cookie of [first, second]) {
      expect(
        (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
      ).toBe(401);
    }
    const cookie = await loginAs(t.app, member.user.email, oneTimePassword);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).json<Me>()
        .mustChangePassword,
    ).toBe(true);
  });

  it('answers 404 for an unknown user', async () => {
    for (const request of [
      { method: 'PATCH' as const, url: '/api/users/nope', body: { role: 'admin' } },
      { method: 'POST' as const, url: '/api/users/nope/reset-password' },
      { method: 'POST' as const, url: '/api/users/nope/unlock' },
    ]) {
      const response = await apiRequest(t.app, { ...request, cookie: adminCookie });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    }
  });
});
