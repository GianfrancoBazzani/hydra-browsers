import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  DEFAULT_SCREEN,
  type Action,
  type CreateSessionRequest,
  type LogsResponse,
  type MemberRole,
  type SessionResource,
  type SessionSettings,
  type UpdateSessionRequest,
} from '@hydra/shared';
import {
  authorize,
  effectiveRole,
  rightsOf,
  type AccessService,
  type SessionAccessView,
} from '../access/index.js';
import type { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/index.js';
import type { Config } from '../config/index.js';
import { newSid } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import {
  sessionMembers,
  sessions,
  users,
  vaultCredentials,
  type SessionRow,
} from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { objectNames } from '../orchestrator/names.js';
import { stateOf } from '../orchestrator/row-fields.js';
import type { Reconciler } from '../orchestrator/reconciler.js';
import type { KubeClient } from '../orchestrator/types.js';
import type { TokensService } from '../tokens/index.js';
import type { ActivityProvider } from './activity.js';
import { lowestFreePort } from './ports.js';
import { currentSettings, restartRequired } from './settings.js';

export const LOG_TAIL_LINES = 50;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Typed read of a text enum column; a `string` parameter works with text and enum column types.
const memberRoleOf = (role: string | undefined): MemberRole | null =>
  role === undefined ? null : (role as MemberRole);

export interface SessionsServiceDeps {
  db: Db;
  config: Config;
  clock: Clock;
  audit: AuditWriter;
  access: AccessService;
  tokens: TokensService;
  kube: KubeClient;
  reconciler: Pick<Reconciler, 'trigger'>;
  activity: ActivityProvider;
}

/** Session actions of spec section 7.9 and the session resource of index section 5.1. */
export class SessionsService {
  private readonly deps: SessionsServiceDeps;

  constructor(deps: SessionsServiceDeps) {
    this.deps = deps;
  }

  create(context: LoginContext, input: CreateSessionRequest): SessionResource {
    const { config, clock } = this.deps;
    const now = clock.now();
    const sid = newSid();
    const settings: SessionSettings = {
      allowlist: [...input.allowlist],
      timezone: input.timezone ?? config.defaultTimezone,
      language: input.language ?? config.defaultLanguage,
      screen: input.screen ?? DEFAULT_SCREEN,
    };
    const start = input.start ?? true;
    // Create continues as Start in the same transaction: capacity_reached creates nothing.
    this.deps.db.transaction(
      (tx) => {
        tx.insert(sessions)
          .values({
            id: sid,
            name: input.name,
            ownerId: context.user.id,
            desiredState: 'stopped',
            state: 'stopped',
            errorReason: null,
            mediaPort: null,
            allowlist: settings.allowlist,
            timezone: settings.timezone,
            language: settings.language,
            screen: settings.screen,
            appliedSettings: settings,
            startedAt: null,
            readyAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          .run();
        if (start) this.startLocked(tx, this.rowIn(tx, sid), now);
      },
      { behavior: 'immediate' },
    );
    this.audit(context, sid, 'session.created', { name: input.name, settings });
    if (start) this.audit(context, sid, 'session.started', {});
    this.deps.reconciler.trigger(sid);
    return this.toResource(this.rowIn(this.deps.db, sid), context.user);
  }

  update(context: LoginContext, sessionId: string, input: UpdateSessionRequest): SessionResource {
    this.requireRight(context, sessionId, 'session.update', 'PATCH', `/api/sessions/${sessionId}`);
    const row = this.rowIn(this.deps.db, sessionId);
    this.rejectIfDeleting(row);
    const changes: UpdateSessionRequest = {};
    if (input.name !== undefined && input.name !== row.name) changes.name = input.name;
    if (
      input.allowlist !== undefined &&
      JSON.stringify(input.allowlist) !== JSON.stringify(row.allowlist)
    ) {
      changes.allowlist = [...input.allowlist];
    }
    if (input.timezone !== undefined && input.timezone !== row.timezone)
      changes.timezone = input.timezone;
    if (input.language !== undefined && input.language !== row.language)
      changes.language = input.language;
    if (input.screen !== undefined && input.screen !== row.screen) changes.screen = input.screen;
    if (Object.keys(changes).length > 0) {
      this.deps.db
        .update(sessions)
        .set({ ...changes, updatedAt: this.deps.clock.now() })
        .where(eq(sessions.id, sessionId))
        .run();
      this.audit(context, sessionId, 'session.updated', { changes });
    }
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  start(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(
      context,
      sessionId,
      'session.lifecycle',
      'POST',
      `/api/sessions/${sessionId}/start`,
    );
    const now = this.deps.clock.now();
    const changed = this.deps.db.transaction(
      (tx) => this.startLocked(tx, this.rowIn(tx, sessionId), now),
      {
        behavior: 'immediate',
      },
    );
    if (changed) {
      this.audit(context, sessionId, 'session.started', {});
      this.deps.reconciler.trigger(sessionId);
    }
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  stop(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(
      context,
      sessionId,
      'session.lifecycle',
      'POST',
      `/api/sessions/${sessionId}/stop`,
    );
    const now = this.deps.clock.now();
    const changed = this.deps.db.transaction(
      (tx) => {
        const row = this.rowIn(tx, sessionId);
        this.rejectIfDeleting(row);
        if (row.desiredState === 'stopped') return false;
        tx.update(sessions)
          .set({ desiredState: 'stopped', updatedAt: now })
          .where(eq(sessions.id, sessionId))
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
    if (changed) {
      this.audit(context, sessionId, 'session.stopped', {});
      this.deps.reconciler.trigger(sessionId);
    }
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  restart(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(
      context,
      sessionId,
      'session.lifecycle',
      'POST',
      `/api/sessions/${sessionId}/restart`,
    );
    const now = this.deps.clock.now();
    this.deps.db.transaction(
      (tx) => {
        const row = this.rowIn(tx, sessionId);
        this.rejectIfDeleting(row);
        const state = stateOf(row);
        if (state !== 'starting' && state !== 'running') {
          throw new HydraError('invalid_state', `The session is ${state}. Use Start.`);
        }
        // The new started_at changes the hydra/started-at annotation, so the StatefulSet replaces the pod.
        tx.update(sessions)
          .set({
            appliedSettings: currentSettings(row),
            startedAt: now,
            readyAt: null,
            updatedAt: now,
          })
          .where(eq(sessions.id, sessionId))
          .run();
      },
      { behavior: 'immediate' },
    );
    this.audit(context, sessionId, 'session.restarted', {});
    this.deps.reconciler.trigger(sessionId);
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  remove(context: LoginContext, sessionId: string, confirmName: string): void {
    this.requireRight(
      context,
      sessionId,
      'session.delete',
      'POST',
      `/api/sessions/${sessionId}/delete`,
    );
    const row = this.rowIn(this.deps.db, sessionId);
    if (confirmName !== row.name) {
      throw new HydraError('confirm_mismatch', 'Type the exact session name to delete the session');
    }
    // Revoke first: a repeated Delete after a crash between the two steps still revokes the tokens.
    this.deps.tokens.revokeAllForSession(sessionId);
    if (row.desiredState === 'deleted') return;
    // Spec section 7.9: desired_state and the vault credentials change in one transaction.
    this.deps.db.transaction((tx) => {
      tx.update(sessions)
        .set({ desiredState: 'deleted', updatedAt: this.deps.clock.now() })
        .where(eq(sessions.id, sessionId))
        .run();
      tx.delete(vaultCredentials).where(eq(vaultCredentials.sessionId, sessionId)).run();
    });
    this.audit(context, sessionId, 'session.deleted', { name: row.name });
    this.deps.reconciler.trigger(sessionId);
  }

  get(context: LoginContext, sessionId: string): SessionResource {
    this.requireRight(context, sessionId, 'session.read', 'GET', `/api/sessions/${sessionId}`);
    return this.toResource(this.rowIn(this.deps.db, sessionId), context.user);
  }

  list(context: LoginContext, options: { all: boolean }): SessionResource[] {
    const all = options.all && context.user.role === 'admin';
    const ids = this.deps.access.listReadable(context.user, { all });
    if (ids.length === 0) return [];
    const rows = this.deps.db
      .select()
      .from(sessions)
      .where(and(inArray(sessions.id, ids), ne(sessions.state, 'deleted')))
      .orderBy(asc(sessions.createdAt), asc(sessions.id))
      .all();
    return rows.map((row) => this.toResource(row, context.user));
  }

  async logs(
    context: LoginContext,
    sessionId: string,
    container: 'neko' | 'mcp',
  ): Promise<LogsResponse> {
    this.requireRight(context, sessionId, 'session.logs', 'GET', `/api/sessions/${sessionId}/logs`);
    const text = await this.deps.kube.readLog(
      objectNames(sessionId).pod,
      container,
      LOG_TAIL_LINES,
    );
    const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
    if (lines.at(-1) === '') lines.pop();
    return { container, lines: lines.slice(-LOG_TAIL_LINES) };
  }

  toResource(row: SessionRow, user: AuthedUser): SessionResource {
    const view = this.viewOf(row, user.id);
    const myRole = effectiveRole(user, view);
    if (myRole === null) throw new HydraError('not_found', 'Session not found');
    const owner = this.deps.db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .get();
    return {
      id: row.id,
      name: row.name,
      owner: owner ?? { id: row.ownerId, email: '', displayName: '' },
      myRole,
      rights: rightsOf(user, view),
      state: stateOf(row),
      errorReason: row.errorReason,
      settings: currentSettings(row),
      restartRequired: restartRequired(row),
      agentActivity: this.deps.activity.get(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * session.read at send time, for GET /api/events. Uses the row also when the session is deleted, so
   * the people who could read the session get its last `deleted` event.
   */
  readableBy(user: AuthedUser, sessionId: string): boolean {
    const row = this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    return row !== undefined && authorize(user, this.viewOf(row, user.id), 'session.read');
  }

  /** Start of spec section 7.9 inside a transaction. Returns false if the session already starts or runs. */
  private startLocked(tx: Tx, row: SessionRow, now: number): boolean {
    const { config } = this.deps;
    this.rejectIfDeleting(row);
    const state = stateOf(row);
    if (state === 'starting' || state === 'running') return false;
    if (state !== 'stopped' && state !== 'error')
      throw new HydraError('invalid_state', `The session is ${state}`);
    let mediaPort = row.mediaPort;
    if (mediaPort === null) {
      const used = tx
        .select({ port: sessions.mediaPort })
        .from(sessions)
        .where(isNotNull(sessions.mediaPort))
        .all()
        .map((entry) => entry.port)
        .filter((port): port is number => port !== null);
      if (used.length >= config.maxRunning) {
        throw new HydraError(
          'capacity_reached',
          `${config.maxRunning} sessions are running. Stop a session first.`,
        );
      }
      mediaPort = lowestFreePort(config.mediaPortRange, used);
      if (mediaPort === null) throw new HydraError('capacity_reached', 'No free media port');
    }
    tx.update(sessions)
      .set({
        mediaPort,
        appliedSettings: currentSettings(row),
        startedAt: now,
        readyAt: null,
        errorReason: null,
        desiredState: 'running',
        updatedAt: now,
      })
      .where(eq(sessions.id, row.id))
      .run();
    return true;
  }

  /** A session with desired_state deleted is deleting, also before the reconciler writes the state. */
  private rejectIfDeleting(row: SessionRow): void {
    const state = stateOf(row);
    if (state === 'deleting' || state === 'deleted' || row.desiredState === 'deleted') {
      throw new HydraError(
        'invalid_state',
        `The session is ${state === 'deleted' ? state : 'deleting'}`,
      );
    }
  }

  private rowIn(db: Db | Tx, sessionId: string): SessionRow {
    const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) throw new HydraError('not_found', 'Session not found');
    return row;
  }

  private viewOf(row: SessionRow, userId: string): SessionAccessView {
    const member = this.deps.db
      .select({ role: sessionMembers.role })
      .from(sessionMembers)
      .where(and(eq(sessionMembers.sessionId, row.id), eq(sessionMembers.userId, userId)))
      .get();
    return {
      id: row.id,
      ownerId: row.ownerId,
      memberRole: memberRoleOf(member?.role),
    };
  }

  private requireRight(
    context: LoginContext,
    sessionId: string,
    action: Action,
    method: string,
    path: string,
  ): void {
    this.deps.access.requireSession(context, sessionId, action, { method, path });
  }

  private audit(
    context: LoginContext,
    sessionId: string,
    kind:
      | 'session.created'
      | 'session.updated'
      | 'session.started'
      | 'session.stopped'
      | 'session.restarted'
      | 'session.deleted',
    data: Record<string, unknown>,
  ): void {
    this.deps.audit.write({ kind, actorType: 'user', actorId: context.user.id, sessionId, data });
  }
}
