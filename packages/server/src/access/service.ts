import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Action, AddMemberRequest, Member, MemberRole, MembersResponse } from '@hydra/shared';
import type { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/types.js';
import type { Db } from '../db/index.js';
import { sessionMembers, sessions, users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { authorize, rightOnlyFromAdmin, type SessionAccessView } from './rules.js';

export interface AccessDeps {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  bus: EventBus;
}

export interface RequestInfo {
  method: string;
  /** The route pattern (for example `/api/sessions/:sid/members`) or the path. */
  path: string;
}

/** Requests that do not write admin.session_access (index section 5.8). */
const ADMIN_AUDIT_EXEMPT = [
  /^GET \/api\/sessions\/?$/,
  /^GET \/api\/sessions\/[^/]+\/?$/,
  /^GET \/api\/sessions\/[^/]+\/members\/?$/,
  /^GET \/api\/events\/?$/,
];

function isAdminAuditExempt(request: RequestInfo): boolean {
  const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
  const key = `${method} ${request.path.split('?')[0] ?? ''}`;
  return ADMIN_AUDIT_EXEMPT.some((pattern) => pattern.test(key));
}

function notFound(): HydraError {
  return new HydraError('not_found', 'Session not found.');
}

export class AccessService {
  readonly #deps: AccessDeps;

  constructor(deps: AccessDeps) {
    this.#deps = deps;
  }

  /** Null if the session does not exist or is deleted. */
  view(userId: string, sessionId: string): SessionAccessView | null {
    const { db } = this.#deps;
    const session = db
      .select({ id: sessions.id, ownerId: sessions.ownerId })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
      .get();
    if (!session) return null;
    const member = db
      .select({ role: sessionMembers.role })
      .from(sessionMembers)
      .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
      .get();
    return { id: session.id, ownerId: session.ownerId, memberRole: member?.role ?? null };
  }

  /**
   * No session.read → not_found (spec section 6.5, never 403). No right → forbidden.
   * Writes admin.session_access when the right comes only from the global admin role.
   */
  requireSession(
    context: LoginContext,
    sessionId: string,
    action: Action,
    request: RequestInfo,
  ): SessionAccessView {
    const view = this.view(context.user.id, sessionId);
    if (!view || !authorize(context.user, view, 'session.read')) throw notFound();
    if (!authorize(context.user, view, action)) {
      throw new HydraError('forbidden', 'You do not have the right for this action.');
    }
    if (rightOnlyFromAdmin(context.user, view, action) && !isAdminAuditExempt(request)) {
      this.#deps.audit.write({
        kind: 'admin.session_access',
        actorType: 'user',
        actorId: context.user.id,
        sessionId,
        data: { action, method: request.method, path: request.path },
      });
    }
    return view;
  }

  /** Reads the user again from the DB. False for a missing or disabled user or session. */
  can(userId: string, sessionId: string, action: Action): boolean {
    const row = this.#deps.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!row) return false;
    const view = this.view(userId, sessionId);
    return view !== null && authorize(row, view, action);
  }

  /** Session IDs that the user can read. `all` lists all sessions, for admins only. */
  listReadable(user: AuthedUser, options: { all: boolean }): string[] {
    if (user.status !== 'active') return [];
    const { db } = this.#deps;
    const notDeleted = isNull(sessions.deletedAt);
    if (options.all && user.role === 'admin') {
      return db
        .select({ id: sessions.id })
        .from(sessions)
        .where(notDeleted)
        .orderBy(asc(sessions.createdAt), asc(sessions.id))
        .all()
        .map((row) => row.id);
    }
    const owned = db
      .select({ id: sessions.id, createdAt: sessions.createdAt })
      .from(sessions)
      .where(and(eq(sessions.ownerId, user.id), notDeleted))
      .all();
    const shared = db
      .select({ id: sessions.id, createdAt: sessions.createdAt })
      .from(sessionMembers)
      .innerJoin(sessions, eq(sessions.id, sessionMembers.sessionId))
      .where(and(eq(sessionMembers.userId, user.id), notDeleted))
      .all();
    return [...owned, ...shared]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => row.id)
      .filter((id, index, ids) => ids.indexOf(id) === index);
  }

  members(sessionId: string): MembersResponse {
    const { db } = this.#deps;
    const owner = db
      .select({ userId: users.id, email: users.email, displayName: users.displayName })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerId))
      .where(eq(sessions.id, sessionId))
      .get();
    if (!owner) throw notFound();
    const members = db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: sessionMembers.role,
      })
      .from(sessionMembers)
      .innerJoin(users, eq(users.id, sessionMembers.userId))
      .where(eq(sessionMembers.sessionId, sessionId))
      .orderBy(asc(sessionMembers.createdAt), asc(users.email))
      .all();
    return { owner: { ...owner, role: 'owner' }, members };
  }

  addMember(context: LoginContext, sessionId: string, input: AddMemberRequest): Member {
    const { db, clock, audit, bus } = this.#deps;
    const ownerId = this.#ownerId(sessionId);
    const user = db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()))
      .get();
    if (!user) throw new HydraError('not_found', 'No user has this email.');
    if (user.id === ownerId) {
      throw new HydraError('conflict', 'The owner cannot be added as a member.');
    }
    if (this.#memberRole(sessionId, user.id) !== null) {
      throw new HydraError('conflict', 'This user is already a member.');
    }
    db.insert(sessionMembers)
      .values({
        sessionId,
        userId: user.id,
        role: input.role,
        grantedBy: context.user.id,
        createdAt: clock.now(),
      })
      .run();
    audit.write({
      kind: 'session.shared',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { userId: user.id, email: user.email, role: input.role },
    });
    bus.publish({ type: 'rights.changed', userId: user.id });
    return { userId: user.id, email: user.email, displayName: user.displayName, role: input.role };
  }

  updateMember(context: LoginContext, sessionId: string, userId: string, role: MemberRole): Member {
    const { db, audit, bus } = this.#deps;
    if (userId === this.#ownerId(sessionId)) {
      throw new HydraError('conflict', 'The owner cannot be changed.');
    }
    const previous = this.#memberRole(sessionId, userId);
    if (previous === null) throw new HydraError('not_found', 'Member not found.');
    db.update(sessionMembers)
      .set({ role })
      .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
      .run();
    const user = db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!user) throw new HydraError('not_found', 'Member not found.');
    if (previous !== role) {
      audit.write({
        kind: 'session.shared',
        actorType: 'user',
        actorId: context.user.id,
        sessionId,
        data: { userId, email: user.email, role, previousRole: previous },
      });
      bus.publish({ type: 'rights.changed', userId });
    }
    return { userId, email: user.email, displayName: user.displayName, role };
  }

  removeMember(context: LoginContext, sessionId: string, userId: string): void {
    const { db, audit, bus } = this.#deps;
    if (userId === this.#ownerId(sessionId)) {
      throw new HydraError('conflict', 'The owner cannot be removed.');
    }
    const removed = db
      .delete(sessionMembers)
      .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
      .returning({ role: sessionMembers.role })
      .get();
    if (!removed) throw new HydraError('not_found', 'Member not found.');
    audit.write({
      kind: 'session.unshared',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { userId, previousRole: removed.role },
    });
    bus.publish({ type: 'rights.changed', userId });
  }

  #ownerId(sessionId: string): string {
    const session = this.#deps.db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
      .get();
    if (!session) throw notFound();
    return session.ownerId;
  }

  #memberRole(sessionId: string, userId: string): MemberRole | null {
    return (
      this.#deps.db
        .select({ role: sessionMembers.role })
        .from(sessionMembers)
        .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
        .get()?.role ?? null
    );
  }
}
