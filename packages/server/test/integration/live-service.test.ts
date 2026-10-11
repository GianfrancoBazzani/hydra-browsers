import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../src/app.js';
import { hmac } from '../../src/crypto/index.js';
import {
  auditEvents,
  liveGrants,
  loginSessions,
  sessionMembers,
  sessions,
} from '../../src/db/schema.js';
import { HydraError } from '../../src/lib/errors.js';
import { LiveService } from '../../src/live-proxy/index.js';
import { createTestApp } from '../helpers/app.js';
import type { FakeClock } from '../helpers/clock.js';
import { seedSession } from '../helpers/seed.js';
import { addMember, grantFor, loggedInUser } from './live-helpers.js';

const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let deps: AppDeps;
let clock: FakeClock;
let testApp: Awaited<ReturnType<typeof createTestApp>>;

beforeEach(async () => {
  testApp = await createTestApp();
  ({ app, deps, clock } = testApp);
});

afterEach(async () => {
  await testApp.close();
});

function ticketOf(url: string): string {
  return new URL(url).searchParams.get('ticket') ?? '';
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof HydraError) return error.code;
    throw error;
  }
  throw new Error('no error');
}

describe('LiveService tickets', () => {
  it('creates a one-use ticket URL on the live origin for a running session', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const { url } = deps.live.createTicket(owner.context, session.id);
    expect(url).toMatch(
      new RegExp(`^http://live\\.hydra\\.localhost/s/${session.id}/\\?ticket=[A-Za-z0-9_-]{43}$`),
    );
  });

  it('needs session.read (404) and the state running (409)', async () => {
    const owner = await loggedInUser(app, deps);
    const stranger = await loggedInUser(app, deps);
    const running = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const starting = seedSession(deps, { ownerId: owner.userId, state: 'starting' });
    expect(errorCode(() => deps.live.createTicket(stranger.context, running.id))).toBe('not_found');
    expect(errorCode(() => deps.live.createTicket(owner.context, starting.id))).toBe(
      'invalid_state',
    );
    expect(errorCode(() => deps.live.createTicket(owner.context, 'abcdefgh2345'))).toBe(
      'not_found',
    );
  });

  it('redeems a ticket: grant row, cookie HMAC, 12 h expiry, live.opened, display name', async () => {
    const owner = await loggedInUser(app, deps, { displayName: 'Ada Lovelace' });
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const ticket = ticketOf(deps.live.createTicket(owner.context, session.id).url);
    const result = deps.live.redeemTicket(session.id, ticket, { ip: '203.0.113.7' });

    expect(result.displayName).toBe('Ada Lovelace');
    expect(result.cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = deps.db.select().from(liveGrants).where(eq(liveGrants.id, result.grant.id)).get();
    expect(row).toMatchObject({
      loginSessionId: owner.context.loginSessionId,
      userId: owner.userId,
      sessionId: session.id,
      nekoProfile: 'admin',
      createdAt: clock.now(),
      expiresAt: clock.now() + 12 * HOUR,
    });
    expect(row?.cookieHmac.equals(hmac(deps.subkeys.liveGrant, result.cookieValue))).toBe(true);
    const opened = deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'live.opened'))
      .all();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      actorType: 'user',
      actorId: owner.userId,
      sessionId: session.id,
    });
    expect(opened[0]?.data).toEqual({
      grantId: result.grant.id,
      nekoProfile: 'admin',
      ip: '203.0.113.7',
    });
  });

  it('gives a viewer the Neko user profile', async () => {
    const owner = await loggedInUser(app, deps);
    const viewer = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    await addMember(app, deps, owner.cookie, session.id, viewer.email, 'viewer');
    expect(grantFor(deps, viewer.context, session.id).grant.nekoProfile).toBe('user');
  });

  it('accepts a ticket one time, for 60 s, and only for its session', async () => {
    const owner = await loggedInUser(app, deps);
    const a = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const b = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const once = ticketOf(deps.live.createTicket(owner.context, a.id).url);
    deps.live.redeemTicket(a.id, once, { ip: '::1' });
    expect(errorCode(() => deps.live.redeemTicket(a.id, once, { ip: '::1' }))).toBe(
      'unauthenticated',
    );

    const early = ticketOf(deps.live.createTicket(owner.context, a.id).url);
    const late = ticketOf(deps.live.createTicket(owner.context, a.id).url);
    clock.advance(59_999);
    expect(deps.live.redeemTicket(a.id, early, { ip: '::1' }).grant.sessionId).toBe(a.id);
    clock.advance(1);
    expect(errorCode(() => deps.live.redeemTicket(a.id, late, { ip: '::1' }))).toBe(
      'unauthenticated',
    );

    const wrong = ticketOf(deps.live.createTicket(owner.context, a.id).url);
    expect(errorCode(() => deps.live.redeemTicket(b.id, wrong, { ip: '::1' }))).toBe(
      'unauthenticated',
    );
    expect(errorCode(() => deps.live.redeemTicket(a.id, wrong, { ip: '::1' }))).toBe(
      'unauthenticated',
    );
    expect(errorCode(() => deps.live.redeemTicket(a.id, 'not-a-ticket', { ip: '::1' }))).toBe(
      'unauthenticated',
    );
  });

  it('checks the grant rules again at redemption', async () => {
    const owner = await loggedInUser(app, deps);
    const member = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    await addMember(app, deps, owner.cookie, session.id, member.email, 'operator');

    const changedProfile = ticketOf(deps.live.createTicket(member.context, session.id).url);
    deps.db
      .update(sessionMembers)
      .set({ role: 'viewer' })
      .where(eq(sessionMembers.userId, member.userId))
      .run();
    expect(errorCode(() => deps.live.redeemTicket(session.id, changedProfile, { ip: '::1' }))).toBe(
      'unauthenticated',
    );

    const stopped = ticketOf(deps.live.createTicket(owner.context, session.id).url);
    deps.db.update(sessions).set({ state: 'stopping' }).where(eq(sessions.id, session.id)).run();
    expect(errorCode(() => deps.live.redeemTicket(session.id, stopped, { ip: '::1' }))).toBe(
      'unauthenticated',
    );
    deps.db.update(sessions).set({ state: 'running' }).where(eq(sessions.id, session.id)).run();

    const loggedOut = ticketOf(deps.live.createTicket(owner.context, session.id).url);
    deps.db.delete(loginSessions).where(eq(loginSessions.id, owner.context.loginSessionId)).run();
    expect(errorCode(() => deps.live.redeemTicket(session.id, loggedOut, { ip: '::1' }))).toBe(
      'unauthenticated',
    );
    expect(deps.db.select().from(liveGrants).all()).toHaveLength(0);
  });
});

describe('LiveService grant validation', () => {
  it('returns the grant only for its own cookie value and sid', async () => {
    const owner = await loggedInUser(app, deps);
    const a = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const b = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const { cookieValue, grant } = grantFor(deps, owner.context, a.id);
    expect(deps.live.validateGrant(a.id, cookieValue)).toEqual(grant);
    expect(deps.live.validateGrant(b.id, cookieValue)).toBeNull();
    expect(deps.live.validateGrant(a.id, undefined)).toBeNull();
    expect(deps.live.validateGrant(a.id, '')).toBeNull();
    expect(deps.live.validateGrant(a.id, 'forged')).toBeNull();
    expect(deps.live.validateGrant(a.id, cookieValue)).toEqual(grant);
  });

  it('ends a grant 30 s after its creation when no WebSocket opens', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const { cookieValue } = grantFor(deps, owner.context, session.id);
    clock.advance(29_999);
    expect(deps.live.validateGrant(session.id, cookieValue)).not.toBeNull();
    clock.advance(1);
    expect(deps.live.validateGrant(session.id, cookieValue)).toBeNull();
    expect(deps.db.select().from(liveGrants).all()).toHaveLength(0);
  });

  it('starts the 30 s at the gateway restart for grants of the previous process', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const { cookieValue } = grantFor(deps, owner.context, session.id);
    clock.advance(HOUR);
    const restarted = new LiveService(deps);
    clock.advance(29_999);
    expect(restarted.validateGrant(session.id, cookieValue)).not.toBeNull();
    clock.advance(1);
    expect(restarted.validateGrant(session.id, cookieValue)).toBeNull();
  });

  it('ends a grant whose session state, rights, or login session no longer pass', async () => {
    const owner = await loggedInUser(app, deps);
    const member = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    await addMember(app, deps, owner.cookie, session.id, member.email, 'viewer');

    const starting = grantFor(deps, owner.context, session.id);
    deps.db.update(sessions).set({ state: 'starting' }).where(eq(sessions.id, session.id)).run();
    expect(deps.live.validateGrant(session.id, starting.cookieValue)).not.toBeNull();
    deps.db.update(sessions).set({ state: 'error' }).where(eq(sessions.id, session.id)).run();
    expect(deps.live.validateGrant(session.id, starting.cookieValue)).toBeNull();
    deps.db.update(sessions).set({ state: 'running' }).where(eq(sessions.id, session.id)).run();

    const viewer = grantFor(deps, member.context, session.id);
    deps.db
      .update(sessionMembers)
      .set({ role: 'operator' })
      .where(eq(sessionMembers.userId, member.userId))
      .run();
    expect(deps.live.validateGrant(session.id, viewer.cookieValue)).toBeNull();

    const removed = grantFor(deps, member.context, session.id);
    deps.db.delete(sessionMembers).where(eq(sessionMembers.userId, member.userId)).run();
    expect(deps.live.validateGrant(session.id, removed.cookieValue)).toBeNull();

    const idleLogin = grantFor(deps, owner.context, session.id);
    deps.db
      .update(loginSessions)
      .set({ lastSeenAt: clock.now() - 12 * HOUR })
      .where(eq(loginSessions.id, owner.context.loginSessionId))
      .run();
    expect(deps.live.validateGrant(session.id, idleLogin.cookieValue)).toBeNull();
  });

  it('ends a grant whose login session expired', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const { cookieValue } = grantFor(deps, owner.context, session.id);
    deps.db
      .update(loginSessions)
      .set({ expiresAt: clock.now() })
      .where(eq(loginSessions.id, owner.context.loginSessionId))
      .run();
    expect(deps.live.validateGrant(session.id, cookieValue)).toBeNull();
  });
});

describe('LiveService.endGrant (DELETE live-grant)', () => {
  it('ends only the grants of this login session for this session, and its unused tickets', async () => {
    const first = await loggedInUser(app, deps);
    const second = await loggedInUser(app, deps);
    const a = seedSession(deps, { ownerId: first.userId, state: 'running' });
    const b = seedSession(deps, { ownerId: first.userId, state: 'running' });
    await addMember(app, deps, first.cookie, a.id, second.email, 'viewer');
    const firstA = grantFor(deps, first.context, a.id);
    const firstB = grantFor(deps, first.context, b.id);
    const secondA = grantFor(deps, second.context, a.id);
    const pending = ticketOf(deps.live.createTicket(first.context, a.id).url);

    deps.live.endGrant(first.context, a.id);

    expect(deps.live.validateGrant(a.id, firstA.cookieValue)).toBeNull();
    expect(deps.live.validateGrant(b.id, firstB.cookieValue)).not.toBeNull();
    expect(deps.live.validateGrant(a.id, secondA.cookieValue)).not.toBeNull();
    expect(errorCode(() => deps.live.redeemTicket(a.id, pending, { ip: '::1' }))).toBe(
      'unauthenticated',
    );
  });
});
