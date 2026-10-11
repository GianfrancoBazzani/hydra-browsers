import { createServer, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../src/app.js';
import { nekoPassword } from '../../src/crypto/index.js';
import { attachLiveUpgrade } from '../../src/live-proxy/index.js';
import { createTestApp } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import {
  clientTextFrame,
  openLiveWebSocket,
  serverTextFrame,
  startFakeNeko,
  waitFor,
  type FakeNeko,
} from '../helpers/fake-neko.js';
import { seedSession, seedUser } from '../helpers/seed.js';
import {
  addMember,
  getLive,
  grantFor,
  loggedInUser,
  openGrant,
  publicHeaders,
} from './live-helpers.js';

let neko: FakeNeko;
let app: FastifyInstance;
let deps: AppDeps;
let testApp: Awaited<ReturnType<typeof createTestApp>>;
let port: number;
let resolveEndpoint: () => Promise<string>;

beforeEach(async () => {
  neko = await startFakeNeko();
  resolveEndpoint = () => Promise.resolve(neko.url);
  testApp = await createTestApp({
    podEndpoints: { endpoint: () => resolveEndpoint(), close: () => Promise.resolve() },
  });
  ({ app, deps } = testApp);
  attachLiveUpgrade(app.server, deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  await testApp.close();
  await neko.stop();
});

function openWs(
  sid: string,
  cookie?: string,
  path = '/ws?password=x&username=evil',
  origin?: string,
) {
  return openLiveWebSocket({
    port,
    host: deps.config.liveUrl.host,
    path: `/s/${sid}${path}`,
    cookie,
    origin,
  });
}

async function ownerWithGrant(displayName = 'Ada') {
  const owner = await loggedInUser(app, deps, { displayName });
  const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
  const grant = await openGrant(app, deps, owner.cookie, session.id);
  return { owner, session, grant };
}

describe('live WebSocket proxy', () => {
  it('sends the upgrade to the pod with the display name and the Neko password of the profile', async () => {
    const owner = await loggedInUser(app, deps, { displayName: 'Zoë Ångström & Co + 100%' });
    const viewer = await loggedInUser(app, deps, { displayName: 'Grace Hopper' });
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    await addMember(app, deps, owner.cookie, session.id, viewer.email, 'viewer');

    const ownerWs = await openWs(session.id, await openGrant(app, deps, owner.cookie, session.id));
    const viewerWs = await openWs(
      session.id,
      await openGrant(app, deps, viewer.cookie, session.id),
    );
    expect(ownerWs.statusCode).toBe(101);
    expect(viewerWs.statusCode).toBe(101);

    expect(neko.upgrades).toHaveLength(2);
    const [first, second] = neko.upgrades;
    expect(first?.path).toBe('/ws');
    expect(first?.query.getAll('username')).toEqual(['Zoë Ångström & Co + 100%']);
    expect(first?.query.getAll('password')).toEqual([
      nekoPassword(deps.subkeys.neko, session.id, 'admin'),
    ]);
    expect(second?.query.getAll('username')).toEqual(['Grace Hopper']);
    expect(second?.query.getAll('password')).toEqual([
      nekoPassword(deps.subkeys.neko, session.id, 'user'),
    ]);
    expect(first?.headers.cookie).toBeUndefined();
    expect(first?.headers.host).toBe(new URL(neko.url).host);
  });

  it('removes Set-Cookie from the 101 response and connects the two sockets', async () => {
    const { session, grant } = await ownerWithGrant();
    const ws = await openWs(session.id, grant);
    expect(ws.statusCode).toBe(101);
    expect(ws.headers['set-cookie']).toBeUndefined();
    expect(ws.headers['sec-websocket-accept']).toBeTypeOf('string');
    await waitFor(() => ws.received().includes(serverTextFrame('hello')));
    const frame = clientTextFrame('ping');
    ws.socket?.write(frame);
    await waitFor(() => ws.received().includes(frame));
  });

  it('refuses an upgrade without a grant (401), and for another host or path (404)', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    expect((await openWs(session.id)).statusCode).toBe(401);
    expect((await openWs(session.id, `__Host-hydra_live_${session.id}=forged`)).statusCode).toBe(
      401,
    );
    const publicHost = await openLiveWebSocket({
      port,
      host: deps.config.publicUrl.host,
      path: `/s/${session.id}/ws`,
    });
    expect(publicHost.statusCode).toBe(404);
    const otherPath = await openLiveWebSocket({
      port,
      host: deps.config.liveUrl.host,
      path: '/ws',
    });
    expect(otherPath.statusCode).toBe(404);
    expect(neko.upgrades).toHaveLength(0);
  });

  it('answers 502 when the pod is not reachable or its address is not known, and the grant stays', async () => {
    const { session, grant } = await ownerWithGrant();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const closedPort = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    resolveEndpoint = () => Promise.resolve(`http://127.0.0.1:${String(closedPort)}`);
    expect((await openWs(session.id, grant)).statusCode).toBe(502);
    resolveEndpoint = () => Promise.reject(new Error('no pod'));
    expect((await openWs(session.id, grant)).statusCode).toBe(502);
    await waitFor(() => deps.live.openSocketCount() === 0);
    resolveEndpoint = () => Promise.resolve(neko.url);
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(200);
  });

  it('registers the WebSocket with its grant until the browser closes it', async () => {
    const { session, grant } = await ownerWithGrant();
    const ws = await openWs(session.id, grant);
    expect(deps.live.openSocketCount()).toBe(1);
    ws.socket?.destroy();
    await waitFor(() => deps.live.openSocketCount() === 0);
  });

  it('closes the browser socket when the pod goes away', async () => {
    const { session, grant } = await ownerWithGrant();
    const ws = await openWs(session.id, grant);
    expect(ws.statusCode).toBe(101);
    await neko.stop();
    await ws.closed;
    await waitFor(() => deps.live.openSocketCount() === 0);
  });

  it('closes the WebSockets when the grant ends', async () => {
    const { owner, session, grant } = await ownerWithGrant();
    const ws = await openWs(session.id, grant);
    deps.live.endGrant(owner.context, session.id);
    await ws.closed;
    await waitFor(() => deps.live.openSocketCount() === 0);
  });

  it('refuses a foreign Origin with 403 before the grant is checked, and accepts the live origin', async () => {
    const { session, grant } = await ownerWithGrant();
    const validate = vi.spyOn(deps.live, 'validateGrant');
    const foreign = await openWs(session.id, grant, undefined, 'https://evil.example');
    expect(foreign.statusCode).toBe(403);
    expect(validate).not.toHaveBeenCalled();
    expect(neko.upgrades).toHaveLength(0);
    expect(deps.live.openSocketCount()).toBe(0);
    // The grant is untouched: a normal upgrade with the cookie still works.
    expect((await openWs(session.id, grant)).statusCode).toBe(101);
    const own = await openWs(session.id, grant, undefined, deps.config.liveUrl.origin);
    expect(own.statusCode).toBe(101);
    expect(neko.upgrades).toHaveLength(2);
  });

  it('answers 502 and logs the status when the pod answers the upgrade with a plain HTTP response', async () => {
    const { session, grant } = await ownerWithGrant();
    const warn = vi.spyOn(deps.logger, 'warn');
    neko.upgradeMode = 'refuse';
    expect((await openWs(session.id, grant)).statusCode).toBe(502);
    expect(warn).toHaveBeenCalledWith(
      { sessionId: session.id, status: 403 },
      'live proxy: the pod refused the WebSocket upgrade',
    );
    await waitFor(() => deps.live.openSocketCount() === 0);
    neko.upgradeMode = 'accept';
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(200);
    expect((await openWs(session.id, grant)).statusCode).toBe(101);
  });

  it('closes the browser socket when the grant ends while the pod connection opens', async () => {
    const { owner, session, grant } = await ownerWithGrant();
    neko.upgradeMode = 'hold';
    const pending = openWs(session.id, grant);
    await waitFor(() => neko.upgrades.length === 1);
    expect(deps.live.openSocketCount()).toBe(1);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}/live-grant`,
      headers: publicHeaders(deps, owner.cookie),
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    await waitFor(() => deps.live.openSocketCount() === 0);
    await expect(pending).rejects.toThrow();
    // The proxy is still alive.
    neko.upgradeMode = 'accept';
    expect(
      (await openWs(session.id, await openGrant(app, deps, owner.cookie, session.id))).statusCode,
    ).toBe(101);
  });

  it('refuses the upgrade with 500 for an unexpected error', async () => {
    const { session, grant } = await ownerWithGrant();
    vi.spyOn(deps.live, 'validateGrant').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect((await openWs(session.id, grant)).statusCode).toBe(500);
    expect(neko.upgrades).toHaveLength(0);
  });

  it('accepts an upgrade on the dev live URL with its port, and not without the port (spec section 4)', async () => {
    const dev = await createTestApp({
      config: testConfig({
        publicUrl: new URL('http://hydra.localhost:5173'),
        liveUrl: new URL('http://live.hydra.localhost:8080'),
      }),
      podEndpoints: { endpoint: () => resolveEndpoint(), close: () => Promise.resolve() },
    });
    try {
      attachLiveUpgrade(dev.app.server, dev.deps);
      await dev.app.listen({ port: 0, host: '127.0.0.1' });
      const devPort = (dev.app.server.address() as AddressInfo).port;
      // loginAs() of plan 03 uses the fixed host hydra.localhost, so log in through the service.
      const { user, password } = await seedUser(dev.deps);
      const { context } = await dev.deps.auth.login(user.email, password, {
        ip: '203.0.113.7',
        userAgent: 'vitest',
      });
      const session = seedSession(dev.deps, { ownerId: user.id, state: 'running' });
      const { cookieValue } = grantFor(dev.deps, context, session.id);
      const cookie = `__Host-hydra_live_${session.id}=${cookieValue}`;
      const path = `/s/${session.id}/ws`;

      const withPort = await openLiveWebSocket({
        port: devPort,
        host: 'live.hydra.localhost:8080',
        path,
        cookie,
        origin: 'http://live.hydra.localhost:8080',
      });
      expect(withPort.statusCode).toBe(101);
      const withoutPort = await openLiveWebSocket({
        port: devPort,
        host: 'live.hydra.localhost',
        path,
        cookie,
      });
      expect(withoutPort.statusCode).toBe(404);
    } finally {
      await dev.close();
    }
  });
});
