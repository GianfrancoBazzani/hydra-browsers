import type { FastifyInstance } from 'fastify';
import type { LiveService } from '../live-proxy/index.js';
import { requireLogin } from './context.js';

/** Public scope routes of spec section 12.1: POST live-ticket and DELETE live-grant. */
export function registerLiveTicketRoutes(
  scope: FastifyInstance,
  deps: { live: LiveService },
): void {
  scope.post<{ Params: { sid: string } }>('/api/sessions/:sid/live-ticket', (request, reply) => {
    return reply.send(deps.live.createTicket(requireLogin(request), request.params.sid));
  });
  scope.delete<{ Params: { sid: string } }>('/api/sessions/:sid/live-grant', (request, reply) => {
    deps.live.endGrant(requireLogin(request), request.params.sid);
    return reply.code(204).send();
  });
}
