import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  CreateSessionRequestSchema,
  DeleteSessionRequestSchema,
  ListSessionsQuerySchema,
  LogsQuerySchema,
  UpdateSessionRequestSchema,
} from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { HydraError } from '../lib/errors.js';
import { requireLogin } from './context.js';

type SidParams = { Params: { sid: string } };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    fields[field] ??= issue.message;
  }
  throw new HydraError('validation_failed', 'The request is not valid', fields);
}

/** Session routes of spec section 12.1. Rights: SessionsService calls AccessService.requireSession. */
export function registerSessionRoutes(scope: FastifyInstance, deps: AppDeps): void {
  // Handlers of synchronous service calls are synchronous: Fastify sends the returned value.
  scope.get('/api/sessions', (request) => {
    const login = requireLogin(request);
    const query = parse(ListSessionsQuerySchema, request.query);
    return deps.sessions.list(login, { all: query.all });
  });

  scope.post('/api/sessions', async (request, reply) => {
    const login = requireLogin(request);
    const input = parse(CreateSessionRequestSchema, request.body);
    return reply.code(201).send(deps.sessions.create(login, input));
  });

  scope.get<SidParams>('/api/sessions/:sid', (request) =>
    deps.sessions.get(requireLogin(request), request.params.sid),
  );

  scope.patch<SidParams>('/api/sessions/:sid', (request) => {
    const login = requireLogin(request);
    const input = parse(UpdateSessionRequestSchema, request.body);
    return deps.sessions.update(login, request.params.sid, input);
  });

  scope.post<SidParams>('/api/sessions/:sid/start', (request) =>
    deps.sessions.start(requireLogin(request), request.params.sid),
  );

  scope.post<SidParams>('/api/sessions/:sid/stop', (request) =>
    deps.sessions.stop(requireLogin(request), request.params.sid),
  );

  scope.post<SidParams>('/api/sessions/:sid/restart', (request) =>
    deps.sessions.restart(requireLogin(request), request.params.sid),
  );

  scope.post<SidParams>('/api/sessions/:sid/delete', async (request, reply) => {
    const login = requireLogin(request);
    // A missing or wrong confirmName is confirm_mismatch, after the rights check (404 rule).
    const body = DeleteSessionRequestSchema.safeParse(request.body);
    deps.sessions.remove(login, request.params.sid, body.success ? body.data.confirmName : '');
    return reply.code(204).send();
  });

  scope.get<SidParams>('/api/sessions/:sid/logs', async (request) => {
    const login = requireLogin(request);
    const query = parse(LogsQuerySchema, request.query);
    return deps.sessions.logs(login, request.params.sid, query.container);
  });
}
