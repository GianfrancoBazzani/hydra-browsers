import { type CreateTokenResponse } from '@hydra/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { hmac } from '../../src/crypto/index.js';
import { agentTokens, sessions } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

const DAY = 24 * 60 * 60 * 1000;

describe('agent token routes (spec section 6.6)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let operator: AuthedUser;
  let ownerCookie: string;
  let operatorCookie: string;
  let otherOperatorCookie: string;
  let viewerCookie: string;
  let sid: string;
  let events: HydraEvent[];

  beforeEach(async () => {
    t = await createTestApp();
    const owner = await seedUser(t.deps);
    const op = await seedUser(t.deps, { displayName: 'Operator' });
    const op2 = await seedUser(t.deps);
    const viewer = await seedUser(t.deps);
    operator = op.user;
    sid = seedSession(t.deps, { ownerId: owner.user.id, state: 'running' }).id;
    ownerCookie = await loginAs(t.app, owner.user.email, owner.password);
    for (const [user, role] of [
      [op.user, 'operator'],
      [op2.user, 'operator'],
      [viewer.user, 'viewer'],
    ] as const) {
      await apiRequest(t.app, {
        method: 'POST',
        url: `/api/sessions/${sid}/members`,
        cookie: ownerCookie,
        body: { email: user.email, role },
      });
    }
    operatorCookie = await loginAs(t.app, op.user.email, op.password);
    otherOperatorCookie = await loginAs(t.app, op2.user.email, op2.password);
    viewerCookie = await loginAs(t.app, viewer.user.email, viewer.password);
    events = [];
    t.deps.bus.subscribe('token.revoked', (event) => events.push(event));
  });

  afterEach(async () => {
    await t.close();
  });

  const create = (cookie: string, body: unknown = { name: 'claude', expiresInDays: 30 }) =>
    apiRequest(t.app, { method: 'POST', url: `/api/sessions/${sid}/tokens`, cookie, body });

  it('creates a token: the secret one time, the HMAC in the DB, 30 days', async () => {
    const response = await create(operatorCookie);
    expect(response.statusCode).toBe(201);
    const { token, secret } = response.json<CreateTokenResponse>();
    expect(secret).toMatch(/^hyd_[0-9A-Za-z]+$/);
    expect(token).toMatchObject({
      name: 'claude',
      prefix: `${String(secret).slice(0, 12)}…`,
      createdBy: { id: operator.id, displayName: 'Operator' },
      createdAt: t.clock.now(),
      expiresAt: t.clock.now() + 30 * DAY,
      lastUsedAt: null,
      revokedAt: null,
    });
    const row = t.deps.db.select().from(agentTokens).get();
    expect(row?.tokenHmac.equals(hmac(t.deps.subkeys.agentToken, secret))).toBe(true);
    const list = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/tokens`,
      cookie: ownerCookie,
    });
    expect(list.json<unknown>()).toEqual([token]);
    expect(list.body).not.toContain(secret);
    expect(t.deps.tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.1')?.tokenId).toBe(token.id);
  });

  it('accepts only the expiry values 1, 7, 30, 90, and 365 days', async () => {
    const bad = await create(operatorCookie, { name: 'x', expiresInDays: 3 });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).fields).toHaveProperty('expiresInDays');
    const week = await create(operatorCookie, { name: 'x', expiresInDays: 7 });
    expect(week.json<CreateTokenResponse>().token.expiresAt).toBe(t.clock.now() + 7 * DAY);
  });

  it('a viewer gets 403 for the token routes', async () => {
    expect(
      (
        await apiRequest(t.app, {
          method: 'GET',
          url: `/api/sessions/${sid}/tokens`,
          cookie: viewerCookie,
        })
      ).statusCode,
    ).toBe(403);
    expect((await create(viewerCookie)).statusCode).toBe(403);
  });

  it('revokes an own token: 204, token.revoked event, the token stops working', async () => {
    const { token, secret } = (await create(operatorCookie)).json<CreateTokenResponse>();
    const response = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: operatorCookie,
    });
    expect(response.statusCode).toBe(204);
    expect(events).toEqual([{ type: 'token.revoked', tokenId: token.id, sessionId: sid }]);
    expect(t.deps.tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.1')).toBeNull();
    const again = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: operatorCookie,
    });
    expect(again.statusCode).toBe(204);
    expect(events).toHaveLength(1);
  });

  it('an operator cannot revoke the token of another user; the owner can', async () => {
    const { token } = (await create(otherOperatorCookie)).json<CreateTokenResponse>();
    const denied = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: operatorCookie,
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: ownerCookie,
    });
    expect(allowed.statusCode).toBe(204);
  });

  it('answers 404 for a token of another session', async () => {
    const owner2 = await seedUser(t.deps);
    const other = seedSession(t.deps, { ownerId: owner2.user.id });
    const cookie = await loginAs(t.app, owner2.user.email, owner2.password);
    const { token } = (
      await apiRequest(t.app, {
        method: 'POST',
        url: `/api/sessions/${other.id}/tokens`,
        cookie,
        body: { name: 'x', expiresInDays: 1 },
      })
    ).json<CreateTokenResponse>();
    const response = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: ownerCookie,
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 409 invalid_state for a token on a session with a pending Delete', async () => {
    t.deps.db.update(sessions).set({ desiredState: 'deleted' }).where(eq(sessions.id, sid)).run();
    const response = await create(operatorCookie);
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('invalid_state');
  });
});
