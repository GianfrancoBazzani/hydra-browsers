import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { type AuditPage, type CreateTokenResponse } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { sessions } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf, PUBLIC_HOST } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

/** Collects an SSE body; `waitFor` resolves when the text contains a string, `ended` when it ends. */
function collect(stream: Readable): {
  text(): string;
  waitFor(part: string): Promise<void>;
  ended: Promise<void>;
} {
  let received = '';
  const waiters: Array<{ part: string; resolve: () => void }> = [];
  stream.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
    for (const waiter of waiters.filter((item) => received.includes(item.part))) waiter.resolve();
  });
  const ended = new Promise<void>((resolve) => stream.on('end', resolve));
  return {
    text: () => received,
    waitFor: (part) =>
      received.includes(part)
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ part, resolve })),
    ended,
  };
}

describe('audit routes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let owner: AuthedUser;
  let operator: AuthedUser;
  let ownerCookie: string;
  let operatorCookie: string;
  let viewerCookie: string;
  let sid: string;
  let otherSid: string;

  beforeEach(async () => {
    t = await createTestApp();
    const o = await seedUser(t.deps);
    const op = await seedUser(t.deps, { displayName: 'Operator' });
    const v = await seedUser(t.deps);
    owner = o.user;
    operator = op.user;
    sid = seedSession(t.deps, { ownerId: owner.id, state: 'running' }).id;
    otherSid = seedSession(t.deps, { ownerId: owner.id }).id;
    ownerCookie = await loginAs(t.app, o.user.email, o.password);
    for (const [email, role] of [
      [op.user.email, 'operator'],
      [v.user.email, 'viewer'],
    ] as const) {
      await apiRequest(t.app, {
        method: 'POST',
        url: `/api/sessions/${sid}/members`,
        cookie: ownerCookie,
        body: { email, role },
      });
    }
    operatorCookie = await loginAs(t.app, op.user.email, op.password);
    viewerCookie = await loginAs(t.app, v.user.email, v.password);
  });

  afterEach(async () => {
    await t.close();
  });

  const audit = (cookie: string, query = '') =>
    apiRequest(t.app, { method: 'GET', url: `/api/sessions/${sid}/audit${query}`, cookie });

  it('a viewer gets 403 on GET audit (spec section 15.2)', async () => {
    const response = await audit(viewerCookie);
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('forbidden');
  });

  it('lists the events of the session newest first, with actor names', async () => {
    const response = await audit(operatorCookie);
    expect(response.statusCode).toBe(200);
    const page = response.json<AuditPage>();
    expect(page.nextBefore).toBeNull();
    expect(page.events.map((event) => event.kind)).toEqual(['session.shared', 'session.shared']);
    const [newest, older] = page.events;
    expect(newest).toMatchObject({
      actorType: 'user',
      actorId: owner.id,
      actorName: owner.displayName,
      sessionId: sid,
    });
    expect(newest?.id).toBeGreaterThan(older?.id ?? Number.POSITIVE_INFINITY);
  });

  it('filters by kind, tool, status, and token', async () => {
    const created = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/sessions/${sid}/tokens`,
      cookie: operatorCookie,
      body: { name: 'claude', expiresInDays: 7 },
    });
    const tokenId = created.json<CreateTokenResponse>().token.id;
    t.deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: tokenId,
      sessionId: sid,
      status: 'ok',
      data: { tool: 'browser_click' },
    });
    t.deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: tokenId,
      sessionId: sid,
      status: 'error',
      data: { tool: 'browser_type' },
    });
    t.deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: tokenId,
      sessionId: otherSid,
      status: 'ok',
      data: { tool: 'browser_click' },
    });
    const kinds = (await audit(operatorCookie, '?kind=mcp.tool_call')).json<AuditPage>().events;
    expect(kinds).toHaveLength(2);
    expect(kinds[0]).toMatchObject({ actorType: 'token', actorName: 'claude', status: 'error' });
    expect(
      (await audit(operatorCookie, '?tool=browser_click')).json<AuditPage>().events,
    ).toHaveLength(1);
    expect((await audit(operatorCookie, '?status=error')).json<AuditPage>().events).toHaveLength(1);
    const byToken = (await audit(operatorCookie, `?tokenId=${tokenId}`)).json<AuditPage>().events;
    expect(byToken.map((event) => event.kind)).toEqual([
      'mcp.tool_call',
      'mcp.tool_call',
      'token.created',
    ]);
  });

  it('pages with before and limit, at most 200', async () => {
    for (let i = 0; i < 5; i += 1) {
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { i },
      });
    }
    const first = (await audit(operatorCookie, '?limit=3')).json<AuditPage>();
    expect(first.events).toHaveLength(3);
    expect(first.nextBefore).toBe(first.events[2]?.id);
    const second = (
      await audit(operatorCookie, `?limit=3&before=${first.nextBefore}`)
    ).json<AuditPage>();
    expect(second.events).toHaveLength(3);
    expect(second.events[0]?.id).toBeLessThan(first.nextBefore ?? 0);
    const last = (
      await audit(operatorCookie, `?limit=3&before=${second.nextBefore}`)
    ).json<AuditPage>();
    expect(last.events).toHaveLength(1);
    expect(last.nextBefore).toBeNull();
    for (const query of ['?limit=201', '?limit=0', '?limit=abc', '?before=-1', '?kind=nope']) {
      const bad = await audit(operatorCookie, query);
      expect(bad.statusCode, query).toBe(400);
      expect(errorOf(bad).code).toBe('validation_failed');
    }
    expect((await audit(operatorCookie, '?limit=200')).statusCode).toBe(200);
  });

  describe('GET /api/sessions/:sid/events (SSE)', () => {
    const open = (cookie: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/events`,
        headers: { host: PUBLIC_HOST, cookie },
        payloadAsStream: true,
      });

    it('streams the audit events of this session only', async () => {
      const response = await open(operatorCookie);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      const body = collect(response.stream());
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: otherSid,
        data: { which: 'other' },
      });
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { which: 'this' },
      });
      await body.waitFor('"which":"this"');
      expect(body.text()).toContain('event: audit\ndata: {');
      expect(body.text()).not.toContain('"which":"other"');
    });

    it('a viewer gets 403', async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/events`,
        headers: { host: PUBLIC_HOST, cookie: viewerCookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it('closes when the user loses audit.read', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      const downgrade = await apiRequest(t.app, {
        method: 'PATCH',
        url: `/api/sessions/${sid}/members/${operator.id}`,
        cookie: ownerCookie,
        body: { role: 'viewer' },
      });
      expect(downgrade.statusCode).toBe(200);
      await body.ended;
    });

    it('closes when the user is removed from the session', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      const removed = await apiRequest(t.app, {
        method: 'DELETE',
        url: `/api/sessions/${sid}/members/${operator.id}`,
        cookie: ownerCookie,
      });
      expect(removed.statusCode).toBe(204);
      await body.ended;
    });

    it('stays open when the user keeps audit.read', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      t.deps.bus.publish({ type: 'rights.changed', userId: operator.id });
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { still: 'open' },
      });
      await body.waitFor('"still":"open"');
    });

    it('closes on session.state when the user no longer has audit.read, without rights.changed', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      const stateEvent = {
        type: 'session.state',
        sessionId: sid,
        state: 'deleted',
        previous: 'deleting',
        errorReason: null,
      } as const;
      // Negative control: while the right holds, a state event of this session does not close.
      t.deps.bus.publish({ ...stateEvent, state: 'stopping', previous: 'running' });
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { after: 'state' },
      });
      await body.waitFor('"after":"state"');

      // The session row is deleted in the db: access.can is false. No rights.changed is published.
      t.deps.db
        .update(sessions)
        .set({ deletedAt: t.clock.now() })
        .where(eq(sessions.id, sid))
        .run();
      expect(t.deps.access.can(operator.id, sid, 'audit.read')).toBe(false);
      // A state event of another session does not close the stream.
      t.deps.bus.publish({ ...stateEvent, sessionId: otherSid });
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { after: 'other' },
      });
      await body.waitFor('"after":"other"');

      t.deps.bus.publish(stateEvent);
      await body.ended;
    });

    it('closes when the login session ends', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie: operatorCookie });
      await body.ended;
    });
  });
});
