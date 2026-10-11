import type { FastifyRequest } from 'fastify';
import type { RequestInfo } from '../access/index.js';
import type { LoginContext } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    login: LoginContext | null;
  }
}

/** Spec section 6.3: the only routes for a login session with must_change_password. */
export const PASSWORD_CHANGE_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/auth/me',
  'POST /api/auth/password',
  'POST /api/auth/logout',
]);

/** The route pattern, never the raw URL: `/%61pi/...` routes to `/api/...` (see the plan, Task 9). */
export function routeKey(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? ''}`;
}

export function requireLogin(request: FastifyRequest): LoginContext {
  const login = request.login;
  if (!login) throw new HydraError('unauthenticated', 'Log in first.');
  if (login.user.mustChangePassword && !PASSWORD_CHANGE_ROUTES.has(routeKey(request))) {
    throw new HydraError('password_change_required', 'Change your password first.');
  }
  return login;
}

export function requireAdmin(request: FastifyRequest): LoginContext {
  const login = requireLogin(request);
  if (login.user.role !== 'admin') throw new HydraError('forbidden', 'Only admins can do this.');
  return login;
}

/** For `AccessService.requireSession`: the method and the route pattern. */
export function requestInfo(request: FastifyRequest): RequestInfo {
  return { method: request.method, path: request.routeOptions.url ?? request.url };
}
