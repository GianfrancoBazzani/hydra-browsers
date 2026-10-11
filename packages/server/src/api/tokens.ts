import type { FastifyInstance } from 'fastify';
import { CreateTokenRequestSchema } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requestInfo, requireLogin } from './context.js';

interface SessionParams {
  Params: { sid: string };
}
interface TokenParams {
  Params: { sid: string; tokenId: string };
}

export function registerTokenRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get<SessionParams>('/api/sessions/:sid/tokens', (request) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'token.create', requestInfo(request));
    return deps.tokens.list(request.params.sid);
  });

  scope.post<SessionParams>('/api/sessions/:sid/tokens', (request, reply) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'token.create', requestInfo(request));
    const input = CreateTokenRequestSchema.parse(request.body);
    return reply.code(201).send(deps.tokens.create(context, request.params.sid, input));
  });

  scope.delete<TokenParams>('/api/sessions/:sid/tokens/:tokenId', (request, reply) => {
    const context = requireLogin(request);
    const { sid, tokenId } = request.params;
    const view = deps.access.requireSession(context, sid, 'token.revoke_own', requestInfo(request));
    deps.tokens.revokeInSession(context, view, tokenId);
    return reply.code(204).send();
  });
}
