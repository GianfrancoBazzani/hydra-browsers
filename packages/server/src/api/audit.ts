import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUDIT_KINDS,
  AUDIT_PAGE_DEFAULT_LIMIT,
  AUDIT_PAGE_MAX_LIMIT,
  AUDIT_STATUSES,
  type AuditPage,
} from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { toAuditEvent } from '../audit/index.js';
import type { Db } from '../db/index.js';
import { agentTokens, auditEvents, users } from '../db/schema.js';
import { requestInfo, requireLogin } from './context.js';
import { openSse } from './sse.js';

/** The querystring has only strings, so the numbers are coerced. Limit 1..200, default 50. */
export const AuditQueryParamsSchema = z.object({
  kind: z.enum(AUDIT_KINDS).optional(),
  tool: z.string().min(1).max(200).optional(),
  status: z.enum(AUDIT_STATUSES).optional(),
  tokenId: z.string().min(1).max(64).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX_LIMIT).default(AUDIT_PAGE_DEFAULT_LIMIT),
});
export type AuditQueryParams = z.infer<typeof AuditQueryParamsSchema>;

interface SessionParams {
  Params: { sid: string };
}

/** Newest first. `nextBefore` is the id to pass as `before` for the next page, or null. */
export function listAuditEvents(db: Db, sessionId: string, query: AuditQueryParams): AuditPage {
  const conditions: SQL[] = [eq(auditEvents.sessionId, sessionId)];
  if (query.kind) conditions.push(eq(auditEvents.kind, query.kind));
  if (query.status) conditions.push(eq(auditEvents.status, query.status));
  if (query.tool) conditions.push(sql`json_extract(${auditEvents.data}, '$.tool') = ${query.tool}`);
  if (query.tokenId) {
    const byToken = or(
      and(eq(auditEvents.actorType, 'token'), eq(auditEvents.actorId, query.tokenId)),
      sql`json_extract(${auditEvents.data}, '$.tokenId') = ${query.tokenId}`,
    );
    if (byToken) conditions.push(byToken);
  }
  if (query.before !== undefined) conditions.push(lt(auditEvents.id, query.before));
  const rows = db
    .select({ event: auditEvents, userName: users.displayName, tokenName: agentTokens.name })
    .from(auditEvents)
    .leftJoin(users, and(eq(auditEvents.actorType, 'user'), eq(users.id, auditEvents.actorId)))
    .leftJoin(
      agentTokens,
      and(eq(auditEvents.actorType, 'token'), eq(agentTokens.id, auditEvents.actorId)),
    )
    .where(and(...conditions))
    .orderBy(desc(auditEvents.id))
    .limit(query.limit + 1)
    .all();
  const page = rows.slice(0, query.limit);
  // The actor name rule of AuditWriter: user display name, token name, or null.
  const events = page.map(({ event, userName, tokenName }) =>
    toAuditEvent(
      event,
      event.actorType === 'user' ? userName : event.actorType === 'token' ? tokenName : null,
    ),
  );
  const last = page.at(-1);
  return { events, nextBefore: rows.length > query.limit && last ? last.event.id : null };
}

export function registerAuditRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get<SessionParams>('/api/sessions/:sid/audit', (request) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'audit.read', requestInfo(request));
    return listAuditEvents(
      deps.db,
      request.params.sid,
      AuditQueryParamsSchema.parse(request.query),
    );
  });

  // SSE of the audit events of one session. Ends when the user loses audit.read or the login ends.
  scope.get<SessionParams>('/api/sessions/:sid/events', (request, reply) => {
    const context = requireLogin(request);
    const { sid } = request.params;
    deps.access.requireSession(context, sid, 'audit.read', requestInfo(request));
    const stream = openSse(reply, { clock: deps.clock });
    const stillAllowed = () => deps.access.can(context.user.id, sid, 'audit.read');
    const unsubscribe = [
      deps.bus.subscribe('audit', ({ event }) => {
        if (event.sessionId === sid) stream.send('audit', event);
      }),
      deps.bus.subscribe('rights.changed', ({ userId }) => {
        if (userId === context.user.id && !stillAllowed()) stream.close();
      }),
      deps.bus.subscribe('login.ended', ({ loginSessionIds }) => {
        if (loginSessionIds.includes(context.loginSessionId)) stream.close();
      }),
      deps.bus.subscribe('session.state', ({ sessionId }) => {
        if (sessionId === sid && !stillAllowed()) stream.close();
      }),
    ];
    void stream.closed.then(() => {
      for (const off of unsubscribe) off();
    });
  });
}
