import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import type { LoginContext } from '../../src/auth/index.js';
import type { LiveGrant } from '../../src/live-proxy/index.js';
import { loginAs, seedUser } from '../helpers/seed.js';

/** Headers of a dashboard request that passes the CSRF check (spec section 6.4). */
export function publicHeaders(deps: AppDeps, cookie: string): Record<string, string> {
  return {
    host: deps.config.publicUrl.host,
    origin: deps.config.publicUrl.origin,
    'content-type': 'application/json',
    cookie,
  };
}

/** A user with a login session: the Cookie header value and the LoginContext. */
export async function loggedInUser(
  app: FastifyInstance,
  deps: AppDeps,
  input: { displayName?: string } = {},
): Promise<{
  userId: string;
  email: string;
  password: string;
  cookie: string;
  context: LoginContext;
}> {
  const { user, password } = await seedUser(deps, input);
  const cookie = await loginAs(app, user.email, password);
  const context = deps.auth.resolve(cookie.slice(cookie.indexOf('=') + 1));
  if (context === null) throw new Error('login failed');
  return { userId: user.id, email: user.email, password, cookie, context };
}

/** A grant through the service (ticket plus redemption), without HTTP. */
export function grantFor(
  deps: AppDeps,
  context: LoginContext,
  sid: string,
): { cookieValue: string; grant: LiveGrant } {
  const { url } = deps.live.createTicket(context, sid);
  const ticket = new URL(url).searchParams.get('ticket') ?? '';
  const { cookieValue, grant } = deps.live.redeemTicket(sid, ticket, { ip: '203.0.113.7' });
  return { cookieValue, grant };
}

/** POST /api/sessions/:sid/members (the owner adds a member). */
export async function addMember(
  app: FastifyInstance,
  deps: AppDeps,
  ownerCookie: string,
  sid: string,
  email: string,
  role: 'operator' | 'viewer',
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sid}/members`,
    headers: publicHeaders(deps, ownerCookie),
    payload: { email, role },
  });
  expect(response.statusCode).toBeLessThan(300);
}

/** POST /api/sessions/:sid/live-ticket. */
export function requestTicket(
  app: FastifyInstance,
  deps: AppDeps,
  loginCookie: string,
  sid: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/sessions/${sid}/live-ticket`,
    headers: publicHeaders(deps, loginCookie),
    payload: {},
  });
}

/** Headers of a request to the live host. */
export function liveHeaders(deps: AppDeps, cookie?: string): Record<string, string> {
  return cookie === undefined
    ? { host: deps.config.liveUrl.host }
    : { host: deps.config.liveUrl.host, cookie };
}

/** Opens the ticket URL on the live host, like the iframe does. */
export function redeem(
  app: FastifyInstance,
  deps: AppDeps,
  ticketUrl: string,
): Promise<LightMyRequestResponse> {
  const url = new URL(ticketUrl);
  return app.inject({
    method: 'GET',
    url: `${url.pathname}${url.search}`,
    headers: liveHeaders(deps),
  });
}

/** The "name=value" part of the Set-Cookie header. */
export function cookieOf(response: LightMyRequestResponse): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  return (value ?? '').split(';')[0] ?? '';
}

/** Ticket plus redemption over HTTP. Returns the Cookie value "__Host-hydra_live_<sid>=<value>". */
export async function openGrant(
  app: FastifyInstance,
  deps: AppDeps,
  loginCookie: string,
  sid: string,
): Promise<string> {
  const ticket = await requestTicket(app, deps, loginCookie, sid);
  expect(ticket.statusCode).toBe(200);
  const redirect = await redeem(app, deps, ticket.json<{ url: string }>().url);
  expect(redirect.statusCode).toBe(303);
  return cookieOf(redirect);
}

/** GET /s/<sid><path> on the live host. */
export function getLive(
  app: FastifyInstance,
  deps: AppDeps,
  sid: string,
  cookie?: string,
  path = '/',
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/s/${sid}${path}`, headers: liveHeaders(deps, cookie) });
}
