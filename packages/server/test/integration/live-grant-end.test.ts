import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../src/app.js';
import { nekoPassword } from '../../src/crypto/index.js';
import { liveGrants, loginSessions } from '../../src/db/schema.js';
import { attachLiveUpgrade } from '../../src/live-proxy/index.js';
import { createTestApp } from '../helpers/app.js';
import type { FakeClock } from '../helpers/clock.js';
import {
  openLiveWebSocket,
  startFakeNeko,
  waitFor,
  type FakeNeko,
  type TestWebSocket,
} from '../helpers/fake-neko.js';
import { loginAs, seedSession } from '../helpers/seed.js';
import { addMember, getLive, loggedInUser, openGrant, publicHeaders } from './live-helpers.js';

const HOUR = 60 * 60 * 1000;

let neko: FakeNeko;
let app: FastifyInstance;
let deps: AppDeps;
let clock: FakeClock;
let testApp: Awaited<ReturnType<typeof createTestApp>>;
let port: number;

beforeEach(async () => {
  neko = await startFakeNeko();
  testApp = await createTestApp({
    podEndpoints: { endpoint: () => Promise.resolve(neko.url), close: () => Promise.resolve() },
  });
  ({ app, deps, clock } = testApp);
  attachLiveUpgrade(app.server, deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  await testApp.close();
  await neko.stop();
});

async function openWs(sid: string, grant: string): Promise<TestWebSocket> {
  const ws = await openLiveWebSocket({
    port,
    host: deps.config.liveUrl.host,
    path: `/s/${sid}/ws`,
    cookie: grant,
  });
  expect(ws.statusCode).toBe(101);
  return ws;
}

async function ownerWithSession() {
  const owner = await loggedInUser(app, deps, { displayName: 'Owner' });
  const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
  return { owner, session };
}

describe('grant end rules with real WebSockets', () => {
  it('a downgrade from operator to viewer ends the grant, and the new grant uses the user profile (spec section 15.2)', async () => {
    const { owner, session } = await ownerWithSession();
    const member = await loggedInUser(app, deps, { displayName: 'Member' });
    await addMember(app, deps, owner.cookie, session.id, member.email, 'operator');
    const operatorGrant = await openGrant(app, deps, member.cookie, session.id);
    const ws = await openWs(session.id, operatorGrant);
    expect(neko.upgrades[0]?.query.get('password')).toBe(
      nekoPassword(deps.subkeys.neko, session.id, 'admin'),
    );

    const downgrade = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}/members/${member.userId}`,
      headers: publicHeaders(deps, owner.cookie),
      payload: { role: 'viewer' },
    });
    expect(downgrade.statusCode).toBeLessThan(300);
    await ws.closed;
    expect((await getLive(app, deps, session.id, operatorGrant)).statusCode).toBe(401);

    const viewerGrant = await openGrant(app, deps, member.cookie, session.id);
    await openWs(session.id, viewerGrant);
    expect(neko.upgrades[1]?.query.get('password')).toBe(
      nekoPassword(deps.subkeys.neko, session.id, 'user'),
    );
  });

  it('a member removal ends the grant', async () => {
    const { owner, session } = await ownerWithSession();
    const member = await loggedInUser(app, deps);
    await addMember(app, deps, owner.cookie, session.id, member.email, 'viewer');
    const ws = await openWs(session.id, await openGrant(app, deps, member.cookie, session.id));
    const removal = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}/members/${member.userId}`,
      headers: publicHeaders(deps, owner.cookie),
      payload: {},
    });
    expect(removal.statusCode).toBeLessThan(300);
    await ws.closed;
  });

  it('a logout ends the live views of that login session only', async () => {
    const { owner, session } = await ownerWithSession();
    const secondBrowser = await loginAs(app, owner.email, owner.password);
    const firstGrant = await openGrant(app, deps, owner.cookie, session.id);
    const secondGrant = await openGrant(app, deps, secondBrowser, session.id);
    const first = await openWs(session.id, firstGrant);
    await openWs(session.id, secondGrant);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: publicHeaders(deps, owner.cookie),
      payload: {},
    });
    expect(logout.statusCode).toBeLessThan(300);
    await first.closed;
    await waitFor(() => deps.live.openSocketCount() === 1);
    expect((await getLive(app, deps, session.id, firstGrant)).statusCode).toBe(401);
    expect((await getLive(app, deps, session.id, secondGrant)).statusCode).toBe(200);
  });

  it('a session state other than starting or running ends the grants', async () => {
    const { owner, session } = await ownerWithSession();
    const grant = await openGrant(app, deps, owner.cookie, session.id);
    const ws = await openWs(session.id, grant);
    deps.bus.publish({
      type: 'session.state',
      sessionId: session.id,
      state: 'stopping',
      previous: 'running',
      errorReason: null,
    });
    await ws.closed;
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(401);
  });

  it('DELETE live-grant closes the WebSockets at once', async () => {
    const { owner, session } = await ownerWithSession();
    const ws = await openWs(session.id, await openGrant(app, deps, owner.cookie, session.id));
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}/live-grant`,
      headers: publicHeaders(deps, owner.cookie),
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    await ws.closed;
    expect(deps.db.select().from(liveGrants).all()).toHaveLength(0);
  });

  it('a grant ends 30 s after its last WebSocket closes', async () => {
    const { owner, session } = await ownerWithSession();
    const grant = await openGrant(app, deps, owner.cookie, session.id);
    const ws = await openWs(session.id, grant);
    clock.advance(HOUR);
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(200);
    ws.socket?.destroy();
    await waitFor(() => deps.live.openSocketCount() === 0);
    clock.advance(29_999);
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(200);
    clock.advance(1);
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(401);
  });

  it('the same session in two browser tabs: closing one tab does not close the other', async () => {
    const { owner, session } = await ownerWithSession();
    const firstTab = await openGrant(app, deps, owner.cookie, session.id);
    const first = await openWs(session.id, firstTab);
    // The second redemption replaces the cookie in the browser; both WebSockets stay open.
    const secondTab = await openGrant(app, deps, owner.cookie, session.id);
    const second = await openWs(session.id, secondTab);
    second.socket?.destroy();
    await waitFor(() => deps.live.openSocketCount() === 1);
    clock.advance(30_000);
    deps.live.checkConnections();
    expect(first.socket?.destroyed).toBe(false);
    expect(deps.live.openSocketCount()).toBe(1);
    expect((await getLive(app, deps, session.id, secondTab)).statusCode).toBe(401);
  });

  it('the 60 s check closes the WebSockets of an idle login session', async () => {
    const { owner, session } = await ownerWithSession();
    const ws = await openWs(session.id, await openGrant(app, deps, owner.cookie, session.id));
    deps.db
      .update(loginSessions)
      .set({ lastSeenAt: clock.now() - 12 * HOUR })
      .where(eq(loginSessions.id, owner.context.loginSessionId))
      .run();
    expect(deps.live.checkConnections()).toBe(1);
    await ws.closed;
  });

  it('closeAll (SIGTERM) closes the WebSockets and the grant stays for 30 s', async () => {
    const { owner, session } = await ownerWithSession();
    const grant = await openGrant(app, deps, owner.cookie, session.id);
    const ws = await openWs(session.id, grant);
    expect(deps.live.closeAll('shutdown')).toBe(1);
    await ws.closed;
    await waitFor(() => deps.live.openSocketCount() === 0);
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(200);
  });
});
