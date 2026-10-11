import type { FastifyInstance } from 'fastify';
import type { SessionActivityEvent, SessionStateEvent } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requireLogin } from './context.js';
import { openSse } from './sse.js';

/**
 * GET /api/events (spec section 10.3): session.state and session.activity of all sessions that the
 * user can read. session.read is checked for each event when it is sent. A rights change of the user
 * closes the stream (spec section 6.5), so `user` does not change while the stream is open.
 */
export function registerEventRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get('/api/events', async (request, reply) => {
    const login = requireLogin(request);
    const { user } = login;
    const sse = openSse(reply, { clock: deps.clock });
    const unsubscribe = [
      deps.bus.subscribe('session.state', (event) => {
        if (!deps.sessions.readableBy(user, event.sessionId)) return;
        const data: SessionStateEvent = {
          sessionId: event.sessionId,
          state: event.state,
          errorReason: event.errorReason,
        };
        sse.send('session.state', data);
      }),
      deps.bus.subscribe('session.activity', (event) => {
        if (!deps.sessions.readableBy(user, event.sessionId)) return;
        const data: SessionActivityEvent = {
          sessionId: event.sessionId,
          agentActivity: event.agentActivity,
        };
        sse.send('session.activity', data);
      }),
      deps.bus.subscribe('login.ended', (event) => {
        if (event.loginSessionIds.includes(login.loginSessionId)) sse.close();
      }),
      // Spec sections 6.5 and 10.3: the client connects again and fetches the session data again.
      deps.bus.subscribe('rights.changed', (event) => {
        if (event.userId === user.id) sse.close();
      }),
    ];
    try {
      await sse.closed;
    } finally {
      for (const off of unsubscribe) off();
    }
  });
}
