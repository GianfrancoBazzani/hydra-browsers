import { lt } from 'drizzle-orm';
import type { Db } from '../db/open.js';
import { auditEvents } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes the audit events older than `retentionDays` (spec section 13.3). Returns the count. */
export function runAuditRetention(deps: { db: Db; clock: Clock }, retentionDays: number): number {
  const cutoff = deps.clock.now() - retentionDays * DAY_MS;
  return deps.db.delete(auditEvents).where(lt(auditEvents.ts, cutoff)).run().changes;
}
