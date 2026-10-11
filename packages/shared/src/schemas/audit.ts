import { z } from 'zod';
import { ACTOR_TYPES, AUDIT_KINDS, AUDIT_PAGE_MAX_LIMIT, AUDIT_STATUSES } from '../constants.js';
import { TimestampSchema, UlidSchema } from './common.js';

export const AuditEventSchema = z.object({
  id: z.number().int().positive(),
  ts: TimestampSchema,
  kind: z.enum(AUDIT_KINDS),
  actorType: z.enum(ACTOR_TYPES),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  sessionId: z.string().nullable(),
  status: z.enum(AUDIT_STATUSES).nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Query string of `GET /api/sessions/:sid/audit`. Without `limit`, the server uses 50. */
export const AuditQuerySchema = z.object({
  kind: z.enum(AUDIT_KINDS).optional(),
  tool: z.string().min(1).max(200).optional(),
  status: z.enum(AUDIT_STATUSES).optional(),
  tokenId: UlidSchema.optional(),
  /** Event ID: only events with a smaller ID. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX_LIMIT).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditPageSchema = z.object({
  events: z.array(AuditEventSchema),
  nextBefore: z.number().int().positive().nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;
