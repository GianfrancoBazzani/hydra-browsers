import { type Member } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { auditEvents } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

describe('sharing and the 404 rule (spec section 6.5)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let owner: AuthedUser;
  let member: AuthedUser;
  let ownerCookie: string;
  let memberCookie: string;
  let strangerCookie: string;
  let adminCookie: string;
  let sid: string;
  let events: HydraEvent[];

  beforeEach(async () => {
    t = await createTestApp();
    const o = await seedUser(t.deps, { email: 'owner@example.com', displayName: 'Owner' });
    const m = await seedUser(t.deps, { email: 'member@example.com', displayName: 'Member' });
    const s = await seedUser(t.deps, { email: 'stranger@example.com' });
    const a = await seedUser(t.deps, { email: 'admin@example.com', role: 'admin' });
    owner = o.user;
    member = m.user;
    ownerCookie = await loginAs(t.app, o.user.email, o.password);
    memberCookie = await loginAs(t.app, m.user.email, m.password);
    strangerCookie = await loginAs(t.app, s.user.email, s.password);
    adminCookie = await loginAs(t.app, a.user.email, a.password);
    sid = seedSession(t.deps, { ownerId: owner.id, state: 'running' }).id;
    events = [];
    t.deps.bus.subscribe('rights.changed', (event) => events.push(event));
  });

  afterEach(async () => {
    await t.close();
  });

  const add = (cookie: string, email: string, role: 'viewer' | 'operator') =>
    apiRequest(t.app, {
      method: 'POST',
      url: `/api/sessions/${sid}/members`,
      cookie,
      body: { email, role },
    });

  it('the owner adds, changes, and removes a member; each change publishes rights.changed', async () => {
    const added = await add(ownerCookie, 'MEMBER@example.com', 'viewer');
    expect(added.statusCode).toBe(201);
    expect(added.json<unknown>()).toEqual({
      userId: member.id,
      email: 'member@example.com',
      displayName: 'Member',
      role: 'viewer',
    });
    const list = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/members`,
      cookie: memberCookie,
    });
    expect(list.json<unknown>()).toEqual({
      owner: { userId: owner.id, email: 'owner@example.com', displayName: 'Owner', role: 'owner' },
      members: [
        { userId: member.id, email: 'member@example.com', displayName: 'Member', role: 'viewer' },
      ],
    });
    const changed = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/sessions/${sid}/members/${member.id}`,
      cookie: ownerCookie,
      body: { role: 'operator' },
    });
    expect(changed.json<Member>().role).toBe('operator');
    const removed = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/members/${member.id}`,
      cookie: ownerCookie,
    });
    expect(removed.statusCode).toBe(204);
    expect(events).toEqual([
      { type: 'rights.changed', userId: member.id },
      { type: 'rights.changed', userId: member.id },
      { type: 'rights.changed', userId: member.id },
    ]);
    const after = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/members`,
      cookie: memberCookie,
    });
    expect(after.statusCode).toBe(404);
  });

  it('the owner cannot be removed or changed', async () => {
    const patch = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/sessions/${sid}/members/${owner.id}`,
      cookie: ownerCookie,
      body: { role: 'viewer' },
    });
    expect(patch.statusCode).toBe(409);
    const remove = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/members/${owner.id}`,
      cookie: ownerCookie,
    });
    expect(remove.statusCode).toBe(409);
    expect((await add(ownerCookie, owner.email, 'viewer')).statusCode).toBe(409);
  });

  it('rejects an unknown email and a second add', async () => {
    expect((await add(ownerCookie, 'ghost@example.com', 'viewer')).statusCode).toBe(404);
    expect((await add(ownerCookie, member.email, 'viewer')).statusCode).toBe(201);
    expect((await add(ownerCookie, member.email, 'operator')).statusCode).toBe(409);
  });

  it('an operator can see the members but cannot share: 403', async () => {
    await add(ownerCookie, member.email, 'operator');
    const response = await add(memberCookie, 'stranger@example.com', 'viewer');
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('forbidden');
  });

  it('a user without access gets 404 on the member routes, never 403', async () => {
    const routes = [
      { method: 'GET' as const, url: `/api/sessions/${sid}/members` },
      {
        method: 'POST' as const,
        url: `/api/sessions/${sid}/members`,
        body: { email: 'x@example.com', role: 'viewer' },
      },
      {
        method: 'PATCH' as const,
        url: `/api/sessions/${sid}/members/${member.id}`,
        body: { role: 'viewer' },
      },
      { method: 'DELETE' as const, url: `/api/sessions/${sid}/members/${member.id}` },
    ];
    for (const route of routes) {
      const response = await apiRequest(t.app, { ...route, cookie: strangerCookie });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
      expect(response.json<unknown>()).toEqual({
        error: { code: 'not_found', message: 'Session not found.' },
      });
    }
  });

  it('a deleted session is not found, also for the owner', async () => {
    const deleted = seedSession(t.deps, { ownerId: owner.id, state: 'deleted' });
    const response = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${deleted.id}/members`,
      cookie: ownerCookie,
    });
    expect(response.statusCode).toBe(404);
  });

  it('an admin can share any session, and the audit log records it; reads of members are exempt', async () => {
    const list = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/members`,
      cookie: adminCookie,
    });
    expect(list.statusCode).toBe(200);
    const kinds = () =>
      t.deps.db
        .select()
        .from(auditEvents)
        .all()
        .filter((row) => row.kind === 'admin.session_access');
    expect(kinds()).toHaveLength(0);
    expect((await add(adminCookie, member.email, 'viewer')).statusCode).toBe(201);
    expect(kinds()).toHaveLength(1);
    expect(kinds()[0]?.data).toMatchObject({
      action: 'session.share',
      method: 'POST',
      path: '/api/sessions/:sid/members',
    });
  });
});
