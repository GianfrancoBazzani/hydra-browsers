import type { FastifyInstance } from 'fastify';
import { ChangePasswordRequestSchema, LoginRequestSchema, type Me } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { clearedSessionCookie, sessionCookie, type AuthedUser } from '../auth/index.js';
import { requireLogin } from './context.js';

export function toMe(user: AuthedUser): Me {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

export function registerAuthRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.post('/api/auth/login', async (request, reply) => {
    const input = LoginRequestSchema.parse(request.body);
    const previous = request.login;
    const { cookieValue, context } = await deps.auth.login(input.email, input.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
    });
    // The browser replaces its cookie, so the login session of the old cookie ends now.
    if (previous) deps.auth.logout(previous);
    return reply.header('set-cookie', sessionCookie(cookieValue)).send(toMe(context.user));
  });

  scope.post('/api/auth/logout', (request, reply) => {
    deps.auth.logout(requireLogin(request));
    return reply.code(204).header('set-cookie', clearedSessionCookie()).send();
  });

  scope.get('/api/auth/me', (request) => toMe(requireLogin(request).user));

  scope.post('/api/auth/password', async (request, reply) => {
    const context = requireLogin(request);
    const input = ChangePasswordRequestSchema.parse(request.body);
    await deps.auth.changePassword(context, input.current, input.new);
    return reply.code(204).send();
  });
}
