import type { ActorType, AuditEvent, AuditKind, AuditStatus } from '@hydra/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/open.js';
import { agentTokens, auditEvents, users, type AuditEventRow } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';

export interface AuditInput {
  kind: AuditKind;
  actorType: ActorType;
  actorId: string | null;
  sessionId: string | null;
  status?: AuditStatus | null;
  data: Record<string, unknown>;
}

/**
 * The display name of an actor: the user display name for 'user', the token name for 'token',
 * and null for 'system' or for an ID that does not exist.
 */
export function actorNameOf(db: Db, actorType: ActorType, actorId: string | null): string | null {
  if (actorId === null) return null;
  if (actorType === 'user') {
    const row = db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, actorId))
      .get();
    return row?.name ?? null;
  }
  if (actorType === 'token') {
    const row = db
      .select({ name: agentTokens.name })
      .from(agentTokens)
      .where(eq(agentTokens.id, actorId))
      .get();
    return row?.name ?? null;
  }
  return null;
}

/** The API shape of an audit row. */
export function toAuditEvent(row: AuditEventRow, actorName: string | null): AuditEvent {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName,
    sessionId: row.sessionId,
    status: row.status,
    data: row.data,
  };
}

/**
 * Writes audit events and publishes each written or updated event on the bus at once. Inside a
 * database transaction, call write() after the commit, or the bus can announce a row that a
 * rollback removes.
 */
export class AuditWriter {
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #clock: Clock;

  constructor(deps: { db: Db; bus: EventBus; clock: Clock }) {
    this.#db = deps.db;
    this.#bus = deps.bus;
    this.#clock = deps.clock;
  }

  /** Inserts the event (ts = clock time), then publishes { type: 'audit' }. */
  write(input: AuditInput): AuditEvent {
    const row = this.#db
      .insert(auditEvents)
      .values({
        ts: this.#clock.now(),
        kind: input.kind,
        actorType: input.actorType,
        actorId: input.actorId,
        sessionId: input.sessionId,
        status: input.status ?? null,
        data: input.data,
      })
      .returning()
      .get();
    return this.#publish(row);
  }

  /**
   * Changes the status and merges `patch.data` into the stored data (top-level keys), for
   * example when the response of a pending `mcp.tool_call` arrives. Publishes the updated event.
   */
  update(
    id: number,
    patch: { status?: 'ok' | 'error'; data?: Record<string, unknown> },
  ): AuditEvent {
    const row = this.#db.transaction((tx) => {
      const current = tx.select().from(auditEvents).where(eq(auditEvents.id, id)).get();
      if (!current) throw new HydraError('not_found', `Audit event ${String(id)} not found`);
      return tx
        .update(auditEvents)
        .set({
          status: patch.status ?? current.status,
          data: patch.data ? { ...current.data, ...patch.data } : current.data,
        })
        .where(eq(auditEvents.id, id))
        .returning()
        .get();
    });
    return this.#publish(row);
  }

  #publish(row: AuditEventRow): AuditEvent {
    const event = toAuditEvent(row, actorNameOf(this.#db, row.actorType, row.actorId));
    this.#bus.publish({ type: 'audit', event });
    return event;
  }
}
