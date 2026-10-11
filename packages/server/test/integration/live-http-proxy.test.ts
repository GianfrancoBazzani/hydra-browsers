import { createServer, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth/index.js';
import { createTestApp } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import { startFakeNeko, type FakeNeko } from '../helpers/fake-neko.js';
import { seedSession, seedUser } from '../helpers/seed.js';
import {
  cookieOf,
  getLive,
  liveHeaders,
  loggedInUser,
  openGrant,
  redeem,
  requestTicket,
} from './live-helpers.js';

let neko: FakeNeko;
let app: FastifyInstance;
let deps: AppDeps;
let testApp: Awaited<ReturnType<typeof createTestApp>>;
let resolveEndpoint: () => Promise<string>;

beforeEach(async () => {
  neko = await startFakeNeko();
  resolveEndpoint = () => Promise.resolve(neko.url);
  testApp = await createTestApp({
    podEndpoints: { endpoint: () => resolveEndpoint(), close: () => Promise.resolve() },
  });
  ({ app, deps } = testApp);
});

afterEach(async () => {
  await testApp.close();
  await neko.stop();
});

async function ownerWithGrant(displayName = 'Ada') {
  const owner = await loggedInUser(app, deps, { displayName });
  const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
  const grant = await openGrant(app, deps, owner.cookie, session.id);
  return { owner, session, grant };
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(port)}`;
}

interface Echo {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe('GET /s/:sid/?ticket= (redemption)', () => {
  it('sets the grant cookie and redirects to the Neko client with the display name', async () => {
    const owner = await loggedInUser(app, deps, { displayName: 'Zoë Ångström & Co + 100%' });
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const ticket = await requestTicket(app, deps, owner.cookie, session.id);
    const response = await redeem(app, deps, ticket.json<{ url: string }>().url);

    expect(response.statusCode).toBe(303);
    const location = new URL(String(response.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(
      `http://live.hydra.localhost/s/${session.id}/`,
    );
    expect(location.searchParams.get('embed')).toBe('1');
    expect(location.searchParams.get('usr')).toBe('Zoë Ångström & Co + 100%');
    expect(
      decodeURIComponent(String(response.headers.location).split('usr=')[1]?.split('&')[0] ?? ''),
    ).toBe('Zoë Ångström & Co + 100%');
    expect(location.searchParams.get('pwd')).toBe('x');
    expect(String(response.headers['set-cookie'])).toMatch(
      new RegExp(
        `^__Host-hydra_live_${session.id}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Strict$`,
      ),
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBe(
      'frame-ancestors http://hydra.localhost',
    );
    const value = cookieOf(response).slice(cookieOf(response).indexOf('=') + 1);
    expect(deps.live.validateGrant(session.id, value)).not.toBeNull();
  });

  it('answers 401 for a used ticket and sets no cookie', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const { url } = (await requestTicket(app, deps, owner.cookie, session.id)).json<{
      url: string;
    }>();
    expect((await redeem(app, deps, url)).statusCode).toBe(303);
    const again = await redeem(app, deps, url);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(again.headers['set-cookie']).toBeUndefined();
  });
});

describe('live HTTP proxy', () => {
  it('sends the request to the pod without the /s/<sid> prefix and keeps the query', async () => {
    const { session, grant } = await ownerWithGrant();
    const response = await getLive(app, deps, session.id, grant, '/api/oauth/config?x=1&y=%20');
    expect(response.statusCode).toBe(200);
    const echo = response.json<Echo>();
    expect(echo.method).toBe('GET');
    expect(echo.url).toBe('/api/oauth/config?x=1&y=%20');
    expect(echo.headers.host).toBe(new URL(neko.url).host);
  });

  it('keeps the method and streams the body', async () => {
    const { session, grant } = await ownerWithGrant();
    const post = await app.inject({
      method: 'POST',
      url: `/s/${session.id}/upload`,
      headers: liveHeaders(deps, grant),
      payload: 'raw body without type',
    });
    expect(post.json<Echo>()).toMatchObject({
      method: 'POST',
      url: '/upload',
      body: 'raw body without type',
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/s/${session.id}/api/x`,
      headers: { ...liveHeaders(deps, grant), 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(put.json<Echo>()).toMatchObject({ method: 'PUT', url: '/api/x', body: '{"a":1}' });
    const head = await app.inject({
      method: 'HEAD',
      url: `/s/${session.id}/`,
      headers: liveHeaders(deps, grant),
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  it('does not send cookies, credentials, or hop-by-hop headers to the pod', async () => {
    const { session, grant } = await ownerWithGrant();
    const response = await app.inject({
      method: 'GET',
      url: `/s/${session.id}/echo`,
      headers: {
        ...liveHeaders(deps, `${grant}; __Host-hydra_live_bbbbbbbbbbbb=other; theme=dark`),
        authorization: 'Bearer secret',
        connection: 'keep-alive, x-private',
        'x-private': 'hop',
        'accept-language': 'de-CH',
      },
    });
    const echo = response.json<Echo>();
    expect(echo.headers.cookie).toBeUndefined();
    expect(echo.headers.authorization).toBeUndefined();
    expect(echo.headers['x-private']).toBeUndefined();
    expect(echo.headers['accept-language']).toBe('de-CH');
  });

  it('removes Set-Cookie and the security headers of the pod, and sets the live origin headers', async () => {
    const { session, grant } = await ownerWithGrant();
    const response = await getLive(app, deps, session.id, grant, '/?embed=1');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>neko</title>');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBe(
      'frame-ancestors http://hydra.localhost',
    );
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-neko']).toBe('fake');
  });

  it('answers 401 without a valid grant for the sid in the path', async () => {
    const { owner, session } = await ownerWithGrant();
    const other = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const otherGrant = await openGrant(app, deps, owner.cookie, other.id);
    const otherValueForSession = otherGrant.replace(other.id, session.id);
    for (const cookie of [
      undefined,
      `__Host-hydra_live_${session.id}=forged`,
      otherGrant,
      otherValueForSession,
    ]) {
      const response = await getLive(app, deps, session.id, cookie);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
      expect(response.headers['content-security-policy']).toBe(
        'frame-ancestors http://hydra.localhost',
      );
    }
  });

  it('keeps one grant per sid, so two browser tabs can show two sessions', async () => {
    const { owner, session: a, grant: grantA } = await ownerWithGrant();
    const b = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const grantB = await openGrant(app, deps, owner.cookie, b.id);
    expect(grantA.startsWith(`__Host-hydra_live_${a.id}=`)).toBe(true);
    expect(grantB.startsWith(`__Host-hydra_live_${b.id}=`)).toBe(true);
    const both = `${grantA}; ${grantB}`;
    expect((await getLive(app, deps, a.id, both)).statusCode).toBe(200);
    expect((await getLive(app, deps, b.id, both)).statusCode).toBe(200);
    expect((await getLive(app, deps, a.id, grantB)).statusCode).toBe(401);
  });

  it('keeps a path that starts with // on the pod', async () => {
    const { session, grant } = await ownerWithGrant();
    const response = await getLive(app, deps, session.id, grant, '//evil.example/x');
    expect(response.statusCode).toBe(200);
    expect(response.json<Echo>().url).toBe('//evil.example/x');
  });

  it('answers 502 when the pod is not reachable or its address is not known', async () => {
    const { session, grant } = await ownerWithGrant();
    const unreachable = await closedPortUrl();
    resolveEndpoint = () => Promise.resolve(unreachable);
    const refused = await getLive(app, deps, session.id, grant);
    expect(refused.statusCode).toBe(502);
    expect(refused.headers['content-security-policy']).toBe(
      'frame-ancestors http://hydra.localhost',
    );
    resolveEndpoint = () => Promise.reject(new Error('no pod'));
    expect((await getLive(app, deps, session.id, grant)).statusCode).toBe(502);
  });

  it('serves /s/:sid/* only on the live host', async () => {
    const { session, grant } = await ownerWithGrant();
    const onPublic = await app.inject({
      method: 'GET',
      url: `/s/${session.id}/`,
      headers: { host: deps.config.publicUrl.host, cookie: grant },
    });
    expect(onPublic.statusCode).toBe(404);
    expect((await getLive(app, deps, session.id, grant, '')).statusCode).toBe(404);
  });

  it('answers 500 internal without details for an unexpected error', async () => {
    const { session, grant } = await ownerWithGrant();
    vi.spyOn(deps.live, 'validateGrant').mockImplementation(() => {
      throw new Error('database is locked: secret detail');
    });
    const response = await getLive(app, deps, session.id, grant);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'internal' } });
    expect(response.body).not.toContain('secret detail');
    expect(response.headers['content-security-policy']).toBe(
      'frame-ancestors http://hydra.localhost',
    );
  });
});

describe('dev URLs with ports (spec section 4)', () => {
  it('uses the ports of the dev URLs in the ticket URL, the redirect, the CSP, and the host check', async () => {
    const dev = await createTestApp({
      config: testConfig({
        publicUrl: new URL('http://hydra.localhost:5173'),
        liveUrl: new URL('http://live.hydra.localhost:8080'),
      }),
      podEndpoints: { endpoint: () => resolveEndpoint(), close: () => Promise.resolve() },
    });
    try {
      // loginAs() of plan 03 uses the fixed host hydra.localhost, so log in through the service.
      const { user, password } = await seedUser(dev.deps, { displayName: 'Ada' });
      const { cookieValue } = await dev.deps.auth.login(user.email, password, {
        ip: '203.0.113.7',
        userAgent: 'vitest',
      });
      const session = seedSession(dev.deps, { ownerId: user.id, state: 'running' });

      // The public routes have the host constraint hydra.localhost:5173.
      const ticket = await requestTicket(
        dev.app,
        dev.deps,
        `${SESSION_COOKIE}=${cookieValue}`,
        session.id,
      );
      expect(ticket.statusCode).toBe(200);
      const { url } = ticket.json<{ url: string }>();
      expect(url.startsWith(`http://live.hydra.localhost:8080/s/${session.id}/?ticket=`)).toBe(
        true,
      );

      // redeem() sends Host: live.hydra.localhost:8080 (dev.deps.config.liveUrl.host).
      const redirect = await redeem(dev.app, dev.deps, url);
      expect(redirect.statusCode).toBe(303);
      expect(redirect.headers.location).toBe(
        `http://live.hydra.localhost:8080/s/${session.id}/?embed=1&usr=Ada&pwd=x`,
      );
      expect(redirect.headers['content-security-policy']).toBe(
        'frame-ancestors http://hydra.localhost:5173',
      );
      const grant = cookieOf(redirect);
      expect((await getLive(dev.app, dev.deps, session.id, grant)).statusCode).toBe(200);

      // The host check compares the whole Host value: without the port, no live route matches.
      const withoutPort = await dev.app.inject({
        method: 'GET',
        url: `/s/${session.id}/`,
        headers: { host: 'live.hydra.localhost', cookie: grant },
      });
      expect(withoutPort.statusCode).toBe(404);
    } finally {
      await dev.close();
    }
  });
});
