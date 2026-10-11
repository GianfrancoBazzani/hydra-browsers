import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../src/app.js';
import { liveGrants, loginSessions, sessionMembers } from '../../src/db/schema.js';
import type { LiveSocket } from '../../src/live-proxy/index.js';
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

/** A LiveSocket that records the reasons of close(). */
function fakeSocket(): LiveSocket & { reasons: string[] } {
  const reasons: string[] = [];
  return { reasons, close: (reason) => reasons.push(reason) };
}

function grantCount(): number {
  return deps.db.select().from(liveGrants).all().length;
}

async function ownerGrant() {
  const owner = await loggedInUser(app, deps);
  const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
  return { owner, session, ...grantFor(deps, owner.context, session.id) };
}

describe('WebSocket registry and the 30 s rule', () => {
  it('keeps a grant while a WebSocket is open, and ends it 30 s after the last one closes', async () => {
    const { session, grant, cookieValue } = await ownerGrant();
    const releaseFirst = deps.live.openSocket(grant, fakeSocket());
    const releaseSecond = deps.live.openSocket(grant, fakeSocket());
    expect(deps.live.openSocketCount(grant.id)).toBe(2);
    clock.advance(HOUR);
    releaseFirst();
    clock.advance(HOUR);
    expect(deps.live.validateGrant(session.id, cookieValue)).not.toBeNull();
    releaseSecond();
    releaseSecond();
    expect(deps.live.openSocketCount()).toBe(0);
    clock.advance(29_999);
    expect(deps.live.validateGrant(session.id, cookieValue)).not.toBeNull();
    clock.advance(1);
    expect(deps.live.validateGrant(session.id, cookieValue)).toBeNull();
  });
});

describe('grant end events', () => {
  it('login.ended ends the grants of those login sessions and closes their WebSockets', async () => {
    const { owner, session, grant, cookieValue } = await ownerGrant();
    const other = await loggedInUser(app, deps);
    const otherSession = seedSession(deps, { ownerId: other.userId, state: 'running' });
    const otherGrant = grantFor(deps, other.context, otherSession.id);
    const socket = fakeSocket();
    const otherSocket = fakeSocket();
    deps.live.openSocket(grant, socket);
    deps.live.openSocket(otherGrant.grant, otherSocket);

    deps.db.delete(loginSessions).where(eq(loginSessions.id, owner.context.loginSessionId)).run();
    deps.bus.publish({
      type: 'login.ended',
      userId: owner.userId,
      loginSessionIds: [owner.context.loginSessionId],
    });

    expect(socket.reasons).toEqual(['login_ended']);
    expect(otherSocket.reasons).toEqual([]);
    expect(deps.live.openSocketCount()).toBe(1);
    expect(deps.live.validateGrant(session.id, cookieValue)).toBeNull();
    expect(deps.live.validateGrant(otherSession.id, otherGrant.cookieValue)).not.toBeNull();
  });

  it('rights.changed ends a grant when the Neko profile changes or live.watch is lost, and keeps it otherwise', async () => {
    const owner = await loggedInUser(app, deps);
    const member = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const other = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    await addMember(app, deps, owner.cookie, session.id, member.email, 'operator');

    const operatorGrant = grantFor(deps, member.context, session.id);
    const socket = fakeSocket();
    deps.live.openSocket(operatorGrant.grant, socket);
    await addMember(app, deps, owner.cookie, other.id, member.email, 'viewer');
    expect(socket.reasons).toEqual([]);

    deps.db
      .update(sessionMembers)
      .set({ role: 'viewer' })
      .where(eq(sessionMembers.sessionId, session.id))
      .run();
    deps.bus.publish({ type: 'rights.changed', userId: member.userId });
    expect(socket.reasons).toEqual(['rights_changed']);
    expect(deps.live.validateGrant(session.id, operatorGrant.cookieValue)).toBeNull();

    const viewerGrant = grantFor(deps, member.context, session.id);
    expect(viewerGrant.grant.nekoProfile).toBe('user');
    const viewerSocket = fakeSocket();
    deps.live.openSocket(viewerGrant.grant, viewerSocket);
    deps.db.delete(sessionMembers).where(eq(sessionMembers.sessionId, session.id)).run();
    deps.bus.publish({ type: 'rights.changed', userId: member.userId });
    expect(viewerSocket.reasons).toEqual(['rights_changed']);
  });

  it('session.state ends the grants of the session for states other than starting and running', async () => {
    const { session, grant } = await ownerGrant();
    const socket = fakeSocket();
    deps.live.openSocket(grant, socket);
    deps.bus.publish({
      type: 'session.state',
      sessionId: session.id,
      state: 'starting',
      previous: 'running',
      errorReason: null,
    });
    deps.bus.publish({
      type: 'session.state',
      sessionId: 'abcdefgh2345',
      state: 'stopped',
      previous: 'stopping',
      errorReason: null,
    });
    expect(socket.reasons).toEqual([]);
    deps.bus.publish({
      type: 'session.state',
      sessionId: session.id,
      state: 'error',
      previous: 'starting',
      errorReason: 'CrashLoopBackOff',
    });
    expect(socket.reasons).toEqual(['session_state']);
    expect(grantCount()).toBe(0);
  });

  it('endGrant closes the WebSockets of the ended grants at once', async () => {
    const { owner, session, grant } = await ownerGrant();
    const socket = fakeSocket();
    deps.live.openSocket(grant, socket);
    deps.live.endGrant(owner.context, session.id);
    expect(socket.reasons).toEqual(['ended_by_user']);
  });

  it('dispose() stops the event handling', async () => {
    const { session, grant } = await ownerGrant();
    const socket = fakeSocket();
    deps.live.openSocket(grant, socket);
    deps.live.dispose();
    deps.bus.publish({
      type: 'session.state',
      sessionId: session.id,
      state: 'stopped',
      previous: 'stopping',
      errorReason: null,
    });
    expect(socket.reasons).toEqual([]);
  });
});

describe('checkConnections (every 60 s)', () => {
  it('closes the WebSockets of a login session that reached its idle timeout', async () => {
    const { owner, grant } = await ownerGrant();
    const socket = fakeSocket();
    deps.live.openSocket(grant, socket);
    clock.advance(HOUR);
    expect(deps.live.checkConnections()).toBe(0);
    deps.db
      .update(loginSessions)
      .set({ lastSeenAt: clock.now() - 12 * HOUR })
      .where(eq(loginSessions.id, owner.context.loginSessionId))
      .run();
    expect(deps.live.checkConnections()).toBe(1);
    expect(socket.reasons).toEqual(['login_ended']);
  });

  it('closes the WebSockets of a grant 12 h after its creation', async () => {
    const { owner, grant } = await ownerGrant();
    const socket = fakeSocket();
    deps.live.openSocket(grant, socket);
    clock.advance(12 * HOUR - 1);
    deps.db
      .update(loginSessions)
      .set({ lastSeenAt: clock.now() })
      .where(eq(loginSessions.id, owner.context.loginSessionId))
      .run();
    expect(deps.live.checkConnections()).toBe(0);
    clock.advance(1);
    expect(deps.live.checkConnections()).toBe(1);
    expect(socket.reasons).toEqual(['expired']);
  });

  it('closes the WebSockets of a grant whose row is gone without an event', async () => {
    const { owner, grant } = await ownerGrant();
    const socket = fakeSocket();
    deps.live.openSocket(grant, socket);
    deps.db.delete(loginSessions).where(eq(loginSessions.id, owner.context.loginSessionId)).run();
    expect(grantCount()).toBe(0);
    expect(deps.live.checkConnections()).toBe(1);
    expect(socket.reasons).toEqual(['grant_deleted']);
    expect(deps.live.openSocketCount()).toBe(0);
  });

  it('deletes grants that are idle for 30 s', async () => {
    await ownerGrant();
    clock.advance(30_000);
    expect(deps.live.checkConnections()).toBe(1);
    expect(grantCount()).toBe(0);
  });
});

describe('closeAll (SIGTERM)', () => {
  it('closes all WebSockets and keeps the grants', async () => {
    const { session, grant, cookieValue } = await ownerGrant();
    const first = fakeSocket();
    const second = fakeSocket();
    deps.live.openSocket(grant, first);
    deps.live.openSocket(grant, second);
    expect(deps.live.closeAll('shutdown')).toBe(2);
    expect(first.reasons).toEqual(['shutdown']);
    expect(second.reasons).toEqual(['shutdown']);
    expect(deps.live.validateGrant(session.id, cookieValue)).not.toBeNull();
  });
});
