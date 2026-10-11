import type { FastifyInstance } from 'fastify';
import { CreateUserRequestSchema, UpdateUserRequestSchema } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requireAdmin } from './context.js';

interface UserParams {
  Params: { id: string };
}

export function registerUserRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get('/api/users', (request) => {
    requireAdmin(request);
    return deps.users.list();
  });

  scope.post('/api/users', async (request, reply) => {
    const context = requireAdmin(request);
    const input = CreateUserRequestSchema.parse(request.body);
    return reply.code(201).send(await deps.users.create(context, input));
  });

  scope.patch<UserParams>('/api/users/:id', (request) => {
    const context = requireAdmin(request);
    const input = UpdateUserRequestSchema.parse(request.body);
    return deps.users.update(context, request.params.id, input);
  });

  scope.post<UserParams>('/api/users/:id/reset-password', (request) => {
    const context = requireAdmin(request);
    return deps.users.resetPassword(context, request.params.id);
  });

  scope.post<UserParams>('/api/users/:id/unlock', (request) => {
    const context = requireAdmin(request);
    return deps.users.unlock(context, request.params.id);
  });
}
