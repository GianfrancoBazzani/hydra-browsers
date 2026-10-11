import type { FastifyInstance } from 'fastify';
import { AddMemberRequestSchema, UpdateMemberRequestSchema } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requestInfo, requireLogin } from './context.js';

interface SessionParams {
  Params: { sid: string };
}
interface MemberParams {
  Params: { sid: string; userId: string };
}

// Access is checked before the body, so a user without access gets 404, never 400.
export function registerMemberRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get<SessionParams>('/api/sessions/:sid/members', (request) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'session.read', requestInfo(request));
    return deps.access.members(request.params.sid);
  });

  scope.post<SessionParams>('/api/sessions/:sid/members', (request, reply) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'session.share', requestInfo(request));
    const input = AddMemberRequestSchema.parse(request.body);
    return reply.code(201).send(deps.access.addMember(context, request.params.sid, input));
  });

  scope.patch<MemberParams>('/api/sessions/:sid/members/:userId', (request) => {
    const context = requireLogin(request);
    const { sid, userId } = request.params;
    deps.access.requireSession(context, sid, 'session.share', requestInfo(request));
    const input = UpdateMemberRequestSchema.parse(request.body);
    return deps.access.updateMember(context, sid, userId, input.role);
  });

  scope.delete<MemberParams>('/api/sessions/:sid/members/:userId', (request, reply) => {
    const context = requireLogin(request);
    const { sid, userId } = request.params;
    deps.access.requireSession(context, sid, 'session.share', requestInfo(request));
    deps.access.removeMember(context, sid, userId);
    return reply.code(204).send();
  });
}
