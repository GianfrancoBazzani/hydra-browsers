import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf, type ApiRequest } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

type Route = Omit<ApiRequest, 'cookie'>;

/*
 * The route-table guard (last describe block) fails when the app registers a route that is in none
 * of loginRoutes()/sessionRoutes(), PUBLIC_ROUTES, or OTHER_RULES. Plans 05 (MCP) and 06 (live) add
 * routes: for each new route, add it to loginRoutes()/sessionRoutes() (needs a login), or to
 * PUBLIC_ROUTES with the reason why it needs no login (its own rule), or to OTHER_RULES.
 */

/** Routes without a login. Each has its own rule; the key is `METHOD pattern` as Fastify prints it. */
const PUBLIC_ROUTES: Record<string, string> = {
  'GET /healthz': 'liveness probe of kubelet, answers { status: ok } (spec section 14)',
  'GET /readyz': 'readiness probe of kubelet, checks the database and Kubernetes (spec section 14)',
  'POST /api/auth/login': 'this is the login; it has its own rate limits (spec section 6.4)',
  // MCP uses bearer tokens (no login cookie, no CSRF); its rules are tested in mcp-gate.test.ts.
  'POST /s/:sid/mcp': 'bearer token of the session (spec section 8.2), tested in mcp-gate.test.ts',
  'GET /s/:sid/mcp': 'bearer token of the session (spec section 8.2), tested in mcp-gate.test.ts',
  'DELETE /s/:sid/mcp':
    'bearer token of the session (spec section 8.2), tested in mcp-gate.test.ts',
  // Live host (plan 06): `/s/:sid/*` (all methods) is printed as `METHOD *` by find-my-way. The rule is
  // the grant cookie of the sid; ticket redemption is GET /s/:sid/?ticket= (redeemed by the ticket).
  ...Object.fromEntries(
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'QUERY'].map((method) => [
      `${method} *`,
      'live grant cookie of the sid (spec section 9.3), tested in live-http-proxy.test.ts',
    ]),
  ),
};

/** Routes that need a login, but another rule covers them: they are allowed with must_change_password. */
const OTHER_RULES: Record<string, string> = {
  'GET /api/auth/me': 'must work when must_change_password is true (tests below)',
  'POST /api/auth/password': 'the way out of must_change_password (tests below)',
  'POST /api/auth/logout': 'must work when must_change_password is true (tests below)',
};

/** Every route that needs a login. Plans 05 and 06 add their routes to this list. */
function loginRoutes(sid: string, userId: string): Route[] {
  return [
    { method: 'GET', url: '/api/users' },
    {
      method: 'POST',
      url: '/api/users',
      body: { email: 'new@example.com', displayName: 'New', role: 'member' },
    },
    { method: 'PATCH', url: `/api/users/${userId}`, body: { displayName: 'X' } },
    { method: 'POST', url: `/api/users/${userId}/reset-password` },
    { method: 'POST', url: `/api/users/${userId}/unlock` },
    { method: 'GET', url: '/api/sessions' }, // plan 04
    { method: 'POST', url: '/api/sessions', body: { name: 'x', allowlist: ['example.com'] } }, // plan 04
    { method: 'GET', url: '/api/events' }, // plan 04: answers 401/403 before the stream opens
    { method: 'DELETE', url: `/api/sessions/${sid}/live-grant` }, // plan 06: login only
    ...sessionRoutes(sid, userId),
  ];
}

function sessionRoutes(sid: string, userId: string): Route[] {
  return [
    { method: 'GET', url: `/api/sessions/${sid}/members` },
    {
      method: 'POST',
      url: `/api/sessions/${sid}/members`,
      body: { email: 'x@example.com', role: 'viewer' },
    },
    { method: 'PATCH', url: `/api/sessions/${sid}/members/${userId}`, body: { role: 'viewer' } },
    { method: 'DELETE', url: `/api/sessions/${sid}/members/${userId}` },
    { method: 'GET', url: `/api/sessions/${sid}/tokens` },
    { method: 'POST', url: `/api/sessions/${sid}/tokens`, body: { name: 'x', expiresInDays: 1 } },
    { method: 'DELETE', url: `/api/sessions/${sid}/tokens/some-token` },
    { method: 'GET', url: `/api/sessions/${sid}/audit` },
    { method: 'GET', url: `/api/sessions/${sid}/events` },
    { method: 'GET', url: `/api/sessions/${sid}` }, // plan 04
    { method: 'PATCH', url: `/api/sessions/${sid}`, body: { name: 'x' } }, // plan 04
    { method: 'POST', url: `/api/sessions/${sid}/start` }, // plan 04
    { method: 'POST', url: `/api/sessions/${sid}/stop` }, // plan 04
    { method: 'POST', url: `/api/sessions/${sid}/restart` }, // plan 04
    { method: 'POST', url: `/api/sessions/${sid}/delete`, body: { confirmName: 'x' } }, // plan 04
    { method: 'GET', url: `/api/sessions/${sid}/logs?container=neko` }, // plan 04
    { method: 'POST', url: `/api/sessions/${sid}/live-ticket` }, // plan 06
    { method: 'GET', url: `/api/sessions/${sid}/vault` }, // secrets vault
    {
      method: 'POST',
      url: `/api/sessions/${sid}/vault`,
      body: { name: 'x', website: 'example.com', password: 'p' },
    },
    { method: 'PATCH', url: `/api/sessions/${sid}/vault/some-credential`, body: { name: 'x' } },
    { method: 'DELETE', url: `/api/sessions/${sid}/vault/some-credential` },
    {
      method: 'POST',
      url: `/api/sessions/${sid}/vault/some-credential/reveal`,
      body: { field: 'password' },
    },
  ];
}

describe('rules over all routes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let sid: string;
  let ownerId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const owner = await seedUser(t.deps);
    ownerId = owner.user.id;
    sid = seedSession(t.deps, { ownerId, state: 'running' }).id;
  });

  afterEach(async () => {
    await t.close();
  });

  it('every route except login needs a login session: 401 unauthenticated', async () => {
    for (const route of [
      ...loginRoutes(sid, ownerId),
      { method: 'GET' as const, url: '/api/auth/me' },
    ]) {
      const response = await apiRequest(t.app, route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(errorOf(response).code).toBe('unauthenticated');
    }
  });

  it('POST /api/auth/logout and POST /api/auth/password without a cookie: 401 unauthenticated', async () => {
    for (const route of [
      { method: 'POST' as const, url: '/api/auth/logout' },
      {
        method: 'POST' as const,
        url: '/api/auth/password',
        body: { current: 'anything', new: 'a new passphrase of length' },
      },
    ]) {
      const response = await apiRequest(t.app, route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(errorOf(response).code).toBe('unauthenticated');
    }
  });

  it('must_change_password: only me, password, and logout work; all others are 403 (spec section 6.3)', async () => {
    const admin = await seedUser(t.deps, { role: 'admin' });
    t.deps.db
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, admin.user.id))
      .run();
    const cookie = await loginAs(t.app, admin.user.email, admin.password);
    for (const route of loginRoutes(sid, ownerId)) {
      const response = await apiRequest(t.app, { ...route, cookie });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(errorOf(response).code).toBe('password_change_required');
    }
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
    ).toBe(200);
    const changed = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/password',
      cookie,
      body: { current: admin.password, new: 'my own new passphrase' },
    });
    expect(changed.statusCode).toBe(204);
    expect((await apiRequest(t.app, { method: 'GET', url: '/api/users', cookie })).statusCode).toBe(
      200,
    );
    expect(
      (await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie })).statusCode,
    ).toBe(204);
  });

  it('logout works while must_change_password is true', async () => {
    const member = await seedUser(t.deps);
    t.deps.db
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, member.user.id))
      .run();
    const cookie = await loginAs(t.app, member.user.email, member.password);
    expect(
      (await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie })).statusCode,
    ).toBe(204);
  });

  it('a user without session.read gets the same 404 as for a missing session (spec section 6.5)', async () => {
    const stranger = await seedUser(t.deps);
    const cookie = await loginAs(t.app, stranger.user.email, stranger.password);
    for (const route of sessionRoutes(sid, ownerId)) {
      const response = await apiRequest(t.app, { ...route, cookie });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
      expect(response.json<unknown>()).toEqual({
        error: { code: 'not_found', message: 'Session not found.' },
      });
      const missing = await apiRequest(t.app, {
        ...route,
        url: route.url.replace(sid, 'nosuchsession'),
        cookie,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toBe(response.body);
    }
  });
});

/**
 * The routes that the app registers, as `METHOD pattern` (HEAD is added by Fastify for each GET, and
 * ignored). Parsed from printRoutes: it needs no change of createTestApp. The static/SPA routes
 * are not registered in tests (webRoot is null).
 */
function registeredRoutes(printed: string): string[] {
  const routes: string[] = [];
  const stack: string[] = [];
  for (const line of printed.split('\n')) {
    const match = /^((?:[│ ]{3} |├── |└── )*)(\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!match) continue;
    const depth = (match[1]?.length ?? 0) / 4;
    stack.length = depth;
    stack[depth] = match[2] ?? '';
    const methods = (match[3] ?? '').split(', ').filter((m) => m !== '' && m !== 'HEAD');
    for (const method of methods) routes.push(`${method} ${stack.join('')}`);
  }
  return routes;
}

/** Turns `/api/users/:id/unlock` into a regular expression for a concrete path. */
function patternMatcher(pattern: string): RegExp {
  // A wildcard (`*`) is literal here: it matches no concrete login route, so such a route can only
  // be a PUBLIC_ROUTES entry.
  return new RegExp(`^${pattern.replace(/\*/g, '\\*').replace(/:[A-Za-z]+/g, '[^/]+')}$`);
}

describe('route-table guard', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  it('every registered route is in loginRoutes()/sessionRoutes(), PUBLIC_ROUTES, or OTHER_RULES', () => {
    const registered = registeredRoutes(t.app.printRoutes({ commonPrefix: false }));
    // The parser works: it finds the routes that the app has (and not only a few).
    expect(registered).toEqual(
      expect.arrayContaining(['GET /healthz', 'POST /api/auth/login', 'GET /api/sessions/:sid']),
    );
    expect(new Set(registered).size).toBe(registered.length);

    // The routes of the login lists, as the pattern that they hit. Each hits exactly one pattern.
    const inLoginLists = new Map<string, string[]>(registered.map((key) => [key, []]));
    for (const route of loginRoutes('SID', 'UID')) {
      const path = route.url.split('?')[0] ?? route.url;
      const hits = registered.filter(
        (key) =>
          key.startsWith(`${route.method} `) &&
          patternMatcher(key.slice(route.method.length + 1)).test(path),
      );
      expect(
        hits,
        `${route.method} ${route.url} must match exactly one registered route`,
      ).toHaveLength(1);
      inLoginLists.get(hits[0] ?? '')?.push(`${route.method} ${route.url}`);
    }

    const problems: string[] = [];
    for (const key of registered) {
      const places = [
        ...((inLoginLists.get(key)?.length ?? 0) > 0 ? ['loginRoutes()'] : []),
        ...(key in PUBLIC_ROUTES ? ['PUBLIC_ROUTES'] : []),
        ...(key in OTHER_RULES ? ['OTHER_RULES'] : []),
      ];
      if (places.length === 0) {
        problems.push(
          `${key} is registered but has no rule test: add it to loginRoutes()/sessionRoutes() in this file, or to PUBLIC_ROUTES with a reason`,
        );
      } else if (places.length > 1) {
        problems.push(`${key} is in more than one place (${places.join(', ')}): keep one`);
      }
    }
    for (const key of [...Object.keys(PUBLIC_ROUTES), ...Object.keys(OTHER_RULES)]) {
      if (!registered.includes(key)) {
        problems.push(`${key} is in PUBLIC_ROUTES/OTHER_RULES but the app does not register it`);
      }
    }
    expect(problems).toEqual([]);
  });
});
