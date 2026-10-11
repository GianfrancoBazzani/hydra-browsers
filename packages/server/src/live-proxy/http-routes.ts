import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request as undiciRequest, type Dispatcher } from 'undici';
import { HydraError } from '../lib/errors.js';
import { NEKO_PORT } from './constants.js';
import { liveCookieName, readCookie, serializeLiveCookie } from './cookies.js';
import type { LiveProxyDeps } from './deps.js';
import { filterResponseHeaders, forwardRequestHeaders, liveSecurityHeaders } from './headers.js';
import { parseLivePath, upstreamPathOf, type LivePath } from './paths.js';
import type { LiveGrant } from './types.js';

/**
 * Live host routes (spec sections 9.2 step 3 and 9.3): ticket redemption, and the HTTP proxy of
 * /s/<sid>/* to podEndpoint(sid, 8080) without the /s/<sid> prefix. `scope` is the live scope of
 * buildApp, so all routes get the host constraint config.liveUrl.host.
 */
export function registerLiveHostRoutes(scope: FastifyInstance, deps: LiveProxyDeps): void {
  // The proxy streams request bodies to the pod: no body parsing in this scope.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });

  // The headers of the live origin on each response of this scope (spec section 6.8).
  const securityHeaders = liveSecurityHeaders(deps.config);
  scope.addHook('onSend', async (_request, reply, payload) => {
    reply.headers(securityHeaders);
    return payload;
  });

  scope.all('/s/:sid/*', async (request, reply) => {
    const target = parseLivePath(request.url);
    if (target === null) throw new HydraError('not_found', 'Not found.');
    const ticket = new URLSearchParams(target.search).get('ticket');
    if (request.method === 'GET' && target.path === '/' && ticket !== null) {
      return redeem(deps, target.sessionId, ticket, request, reply);
    }
    const cookie = readCookie(request.headers.cookie, liveCookieName(target.sessionId));
    const grant = deps.live.validateGrant(target.sessionId, cookie);
    if (grant === null) {
      throw new HydraError(
        'unauthenticated',
        'No live grant for this session. Open the live view again.',
      );
    }
    return proxy(deps, grant, target, request, reply);
  });
}

function redeem(
  deps: LiveProxyDeps,
  sessionId: string,
  ticket: string,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const { cookieValue, displayName } = deps.live.redeemTicket(sessionId, ticket, {
    ip: request.ip,
  });
  const client = new URL(`/s/${sessionId}/`, deps.config.liveUrl);
  // pwd=x is a dummy: it only makes the legacy Neko client log in automatically (spec section 9.2).
  const location = `${client.href}?embed=1&usr=${encodeURIComponent(displayName)}&pwd=x`;
  return reply
    .header('set-cookie', serializeLiveCookie(sessionId, cookieValue))
    .header('cache-control', 'no-store')
    .redirect(location, 303);
}

async function proxy(
  deps: LiveProxyDeps,
  grant: LiveGrant,
  target: LivePath,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // Outside the try: an error here is unexpected, and api/errors.ts answers 500 `internal`.
  const displayName = deps.live.displayNameOf(grant.userId) ?? '';
  let response: Dispatcher.ResponseData;
  try {
    // String concatenation, not new URL(path, base): a path like //other.host stays a path.
    const base = await deps.podEndpoints.endpoint(grant.sessionId, NEKO_PORT);
    const endpoint = base.replace(/\/+$/, '');
    const patch = await deps.live.nekoLogin.forHttp({ grant, displayName, endpoint });
    response = await undiciRequest(`${endpoint}${upstreamPathOf(target, patch.query)}`, {
      method: request.method,
      headers: { ...forwardRequestHeaders(request.headers), ...patch.headers },
      // The catch-all content type parser of this scope gives the raw request stream.
      body: request.body instanceof Readable ? request.body : null,
    });
  } catch (error) {
    request.log.warn(
      { err: error, sessionId: grant.sessionId },
      'live proxy: the pod is not reachable',
    );
    return reply
      .code(502)
      .type('text/plain; charset=utf-8')
      .send('The live view is not reachable.');
  }
  return reply
    .code(response.statusCode)
    .headers(filterResponseHeaders(response.headers))
    .send(response.body);
}
