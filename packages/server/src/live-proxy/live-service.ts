import { and, eq, inArray, type SQL } from 'drizzle-orm';
import {
  MESSAGES,
  type LiveTicketResponse,
  type NekoProfile,
  type SessionState,
} from '@hydra/shared';
import { authorize, effectiveRole, nekoProfileOf, type AccessService } from '../access/index.js';
import type { AuditWriter } from '../audit/index.js';
import { LOGIN_SESSION_IDLE_MS, type AuthedUser, type LoginContext } from '../auth/index.js';
import type { Config } from '../config/index.js';
import { hmac, newUlid, randomBase64Url, type Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { liveGrants, loginSessions, sessions, users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { LIVE_GRANT_IDLE_MS, LIVE_GRANT_TTL_MS, LIVE_TICKET_TTL_MS } from './constants.js';
import { createNekoLoginStrategy, type NekoLoginStrategy } from './neko-login.js';
import type { GrantEndReason, LiveGrant, LiveSocket } from './types.js';

export interface LiveServiceDeps {
  config: Config;
  clock: Clock;
  logger: Logger;
  db: Db;
  bus: EventBus;
  subkeys: Subkeys;
  audit: AuditWriter;
  access: AccessService;
}

interface Ticket {
  loginSessionId: string;
  userId: string;
  sessionId: string;
  nekoProfile: NekoProfile;
  expiresAt: number;
}

interface GrantActivity {
  grant: LiveGrant;
  sockets: Set<LiveSocket>;
  /** Start of the 30 s idle time. Used only while `sockets` is empty. */
  idleSince: number;
}

// A grant ends when its session state changes to a state other than these (spec section 9.2).
const GRANT_STATES: ReadonlySet<SessionState> = new Set<SessionState>(['starting', 'running']);

function toGrant(row: typeof liveGrants.$inferSelect): LiveGrant {
  return {
    id: row.id,
    loginSessionId: row.loginSessionId,
    userId: row.userId,
    sessionId: row.sessionId,
    nekoProfile: row.nekoProfile,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function invalidTicket(): HydraError {
  return new HydraError(
    'unauthenticated',
    'The live ticket is not valid. Open the live view again.',
  );
}

/**
 * Live tickets (in memory), live grants (table `live_grants`), the WebSocket registry, and the
 * grant end rules of spec section 9.2.
 */
export class LiveService {
  /** The Neko login strategy (spec section 9.2 steps 4 and 5). */
  readonly nekoLogin: NekoLoginStrategy;
  private readonly deps: LiveServiceDeps;
  /** After a gateway restart, the 30 s idle time of old grants starts here (spec section 9.2). */
  private readonly startedAt: number;
  /** Key: hex HMAC (subkey liveGrant) of the ticket. The ticket itself is not kept. */
  private readonly tickets = new Map<string, Ticket>();
  /** Key: grant ID. Grants that this process created or that have WebSockets. */
  private readonly activity = new Map<string, GrantActivity>();
  private readonly unsubscribers: Array<() => void>;

  constructor(deps: LiveServiceDeps) {
    this.deps = deps;
    this.startedAt = deps.clock.now();
    this.nekoLogin = createNekoLoginStrategy(deps);
    this.unsubscribers = [
      deps.bus.subscribe('login.ended', (event) => {
        this.onLoginEnded(event.loginSessionIds);
      }),
      deps.bus.subscribe('rights.changed', (event) => {
        this.onRightsChanged(event.userId);
      }),
      deps.bus.subscribe('session.state', (event) => {
        this.onSessionState(event.sessionId, event.state);
      }),
    ];
  }

  /** POST /api/sessions/:sid/live-ticket (spec section 9.2 steps 1 and 2). */
  createTicket(context: LoginContext, sessionId: string): LiveTicketResponse {
    const view = this.deps.access.requireSession(context, sessionId, 'live.watch', {
      method: 'POST',
      path: `/api/sessions/${sessionId}/live-ticket`,
    });
    if (this.sessionState(sessionId) !== 'running') {
      throw new HydraError('invalid_state', MESSAGES.sessionNotRunning);
    }
    const role = effectiveRole(context.user, view);
    if (role === null) throw new HydraError('not_found', 'Session not found.');
    const now = this.deps.clock.now();
    this.pruneTickets(now);
    const ticket = randomBase64Url(32);
    this.tickets.set(this.ticketKey(ticket), {
      loginSessionId: context.loginSessionId,
      userId: context.user.id,
      sessionId,
      nekoProfile: nekoProfileOf(role),
      expiresAt: now + LIVE_TICKET_TTL_MS,
    });
    const url = new URL(`/s/${sessionId}/`, this.deps.config.liveUrl);
    url.searchParams.set('ticket', ticket);
    return { url: url.href };
  }

  /**
   * GET /s/:sid/?ticket=… on the live host (spec section 9.2 step 3). Removes the ticket, checks
   * the grant rules, creates the grant, and writes `live.opened`. Throws `unauthenticated`.
   */
  redeemTicket(
    sessionId: string,
    ticket: string,
    meta: { ip: string },
  ): { cookieValue: string; grant: LiveGrant; displayName: string } {
    const key = this.ticketKey(ticket);
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    const now = this.deps.clock.now();
    if (entry === undefined || entry.expiresAt <= now || entry.sessionId !== sessionId) {
      throw invalidTicket();
    }
    const displayName = this.displayNameOf(entry.userId);
    if (
      displayName === null ||
      !this.loginSessionActive(entry.loginSessionId, now) ||
      !GRANT_STATES.has(this.sessionState(sessionId) ?? 'deleted') ||
      this.currentProfile(entry.userId, sessionId) !== entry.nekoProfile
    ) {
      throw invalidTicket();
    }
    const cookieValue = randomBase64Url(32);
    const grant: LiveGrant = {
      id: newUlid(this.deps.clock),
      loginSessionId: entry.loginSessionId,
      userId: entry.userId,
      sessionId,
      nekoProfile: entry.nekoProfile,
      createdAt: now,
      expiresAt: now + LIVE_GRANT_TTL_MS,
    };
    this.deps.db
      .insert(liveGrants)
      .values({ ...grant, cookieHmac: hmac(this.deps.subkeys.liveGrant, cookieValue) })
      .run();
    this.activity.set(grant.id, { grant, sockets: new Set(), idleSince: now });
    this.deps.audit.write({
      kind: 'live.opened',
      actorType: 'user',
      actorId: grant.userId,
      sessionId,
      data: { grantId: grant.id, nekoProfile: grant.nekoProfile, ip: meta.ip },
    });
    return { cookieValue, grant, displayName };
  }

  /**
   * The grant of this cookie value for this session, or null. A grant that breaks a rule of spec
   * section 9.2 ends here (its WebSockets close).
   */
  validateGrant(sessionId: string, cookieValue: string | undefined): LiveGrant | null {
    if (cookieValue === undefined || cookieValue === '') return null;
    const row = this.deps.db
      .select()
      .from(liveGrants)
      .where(eq(liveGrants.cookieHmac, hmac(this.deps.subkeys.liveGrant, cookieValue)))
      .get();
    if (row === undefined || row.sessionId !== sessionId) return null;
    const grant = toGrant(row);
    const reason = this.endReason(grant, this.deps.clock.now());
    if (reason !== null) {
      this.endGrants([grant], reason);
      return null;
    }
    return grant;
  }

  /** DELETE /api/sessions/:sid/live-grant: ends the grants of this login session there. */
  endGrant(context: LoginContext, sessionId: string): void {
    const matches = (item: { loginSessionId: string; sessionId: string }): boolean =>
      item.loginSessionId === context.loginSessionId && item.sessionId === sessionId;
    const where = and(
      eq(liveGrants.loginSessionId, context.loginSessionId),
      eq(liveGrants.sessionId, sessionId),
    );
    this.endGrants(this.findGrants(where, matches), 'ended_by_user');
    this.dropTickets(matches);
  }

  /**
   * Adds an open WebSocket of a valid grant to the registry. Call it in the same tick as
   * validateGrant(). Returns the function that removes it; the 30 s idle time starts when the last
   * WebSocket of the grant is removed.
   */
  openSocket(grant: LiveGrant, socket: LiveSocket): () => void {
    let entry = this.activity.get(grant.id);
    if (entry === undefined) {
      entry = { grant, sockets: new Set(), idleSince: this.deps.clock.now() };
      this.activity.set(grant.id, entry);
    }
    const registered = entry;
    registered.sockets.add(socket);
    return () => {
      if (!registered.sockets.delete(socket)) return;
      if (registered.sockets.size === 0) registered.idleSince = this.deps.clock.now();
    };
  }

  /** The number of open WebSockets (all grants, or one grant). */
  openSocketCount(grantId?: string): number {
    if (grantId !== undefined) return this.activity.get(grantId)?.sockets.size ?? 0;
    let count = 0;
    for (const entry of this.activity.values()) count += entry.sockets.size;
    return count;
  }

  /** The current Hydra display name of a user, or null. */
  displayNameOf(userId: string): string | null {
    const row = this.deps.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return row?.displayName ?? null;
  }

  /**
   * The connection check (every 60 s, spec sections 9.2 and 13.3): checks each grant, and so each
   * open WebSocket, against all rules, and ends the grants that break one. It also removes expired
   * tickets and expired grants. Returns the number of ended grants.
   */
  checkConnections(): number {
    const now = this.deps.clock.now();
    this.pruneTickets(now);
    const rows = this.deps.db.select().from(liveGrants).all();
    const stored = new Set(rows.map((row) => row.id));
    let ended = 0;
    for (const row of rows) {
      const grant = toGrant(row);
      const reason = this.endReason(grant, now);
      if (reason !== null) ended += this.endGrants([grant], reason);
    }
    // A grant row can go without an event, for example by the cascade of a deleted login session.
    const gone = [...this.activity.values()]
      .filter((entry) => !stored.has(entry.grant.id))
      .map((entry) => entry.grant);
    ended += this.endGrants(gone, 'grant_deleted');
    return ended;
  }

  /** Closes all open WebSockets (SIGTERM, spec section 14). The grants stay in the DB. */
  closeAll(reason: string): number {
    let closed = 0;
    for (const entry of this.activity.values()) {
      for (const socket of [...entry.sockets]) {
        socket.close(reason);
        closed += 1;
      }
    }
    return closed;
  }

  /** Removes the event bus subscriptions. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private onLoginEnded(loginSessionIds: string[]): void {
    if (loginSessionIds.length === 0) return;
    const ended = new Set(loginSessionIds);
    const grants = this.findGrants(inArray(liveGrants.loginSessionId, loginSessionIds), (grant) =>
      ended.has(grant.loginSessionId),
    );
    this.endGrants(grants, 'login_ended');
  }

  private onRightsChanged(userId: string): void {
    const grants = this.findGrants(
      eq(liveGrants.userId, userId),
      (grant) => grant.userId === userId,
    );
    const changed = grants.filter(
      (grant) => this.currentProfile(grant.userId, grant.sessionId) !== grant.nekoProfile,
    );
    this.endGrants(changed, 'rights_changed');
  }

  private onSessionState(sessionId: string, state: SessionState): void {
    if (GRANT_STATES.has(state)) return;
    const grants = this.findGrants(
      eq(liveGrants.sessionId, sessionId),
      (grant) => grant.sessionId === sessionId,
    );
    this.endGrants(grants, 'session_state');
  }

  /** The first rule of spec section 9.2 that the grant breaks, or null. */
  private endReason(grant: LiveGrant, now: number): GrantEndReason | null {
    if (now >= grant.expiresAt) return 'expired';
    const entry = this.activity.get(grant.id);
    if (entry === undefined || entry.sockets.size === 0) {
      const idleSince = entry?.idleSince ?? Math.max(grant.createdAt, this.startedAt);
      if (now - idleSince >= LIVE_GRANT_IDLE_MS) return 'idle';
    }
    if (!this.loginSessionActive(grant.loginSessionId, now)) return 'login_ended';
    if (!GRANT_STATES.has(this.sessionState(grant.sessionId) ?? 'deleted')) return 'session_state';
    if (this.currentProfile(grant.userId, grant.sessionId) !== grant.nekoProfile) {
      return 'rights_changed';
    }
    return null;
  }

  // Idle timeout 12 h and maximum life (expires_at) of spec section 6.4, with the same rule as
  // AuthService.resolve() of plan 03.
  private loginSessionActive(loginSessionId: string, now: number): boolean {
    const row = this.deps.db
      .select({ lastSeenAt: loginSessions.lastSeenAt, expiresAt: loginSessions.expiresAt })
      .from(loginSessions)
      .where(eq(loginSessions.id, loginSessionId))
      .get();
    return row !== undefined && row.expiresAt > now && now - row.lastSeenAt < LOGIN_SESSION_IDLE_MS;
  }

  private sessionState(sessionId: string): SessionState | null {
    const row = this.deps.db
      .select({ state: sessions.state, deletedAt: sessions.deletedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row === undefined || row.deletedAt !== null ? null : row.state;
  }

  /** The Neko profile that the user has now on the session, or null without `live.watch`. */
  private currentProfile(userId: string, sessionId: string): NekoProfile | null {
    const user = this.loadUser(userId);
    const view = this.deps.access.view(userId, sessionId);
    if (user === null || view === null || !authorize(user, view, 'live.watch')) return null;
    const role = effectiveRole(user, view);
    return role === null ? null : nekoProfileOf(role);
  }

  private loadUser(userId: string): AuthedUser | null {
    const row = this.deps.db
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
    return row ?? null;
  }

  /** Grants from the DB plus grants that are only in memory (their row is already gone). */
  private findGrants(where: SQL | undefined, matches: (grant: LiveGrant) => boolean): LiveGrant[] {
    const found = new Map<string, LiveGrant>();
    for (const row of this.deps.db.select().from(liveGrants).where(where).all()) {
      found.set(row.id, toGrant(row));
    }
    for (const entry of this.activity.values()) {
      if (matches(entry.grant)) found.set(entry.grant.id, entry.grant);
    }
    return [...found.values()];
  }

  /** Deletes the grants and closes their WebSockets at once. Returns the number of grants. */
  private endGrants(grants: LiveGrant[], reason: GrantEndReason): number {
    const unique = [...new Map(grants.map((grant) => [grant.id, grant])).values()];
    if (unique.length === 0) return 0;
    const ids = unique.map((grant) => grant.id);
    this.deps.db.delete(liveGrants).where(inArray(liveGrants.id, ids)).run();
    for (const grant of unique) {
      const entry = this.activity.get(grant.id);
      this.activity.delete(grant.id);
      this.nekoLogin.forget(grant.id);
      const sockets = entry === undefined ? [] : [...entry.sockets];
      for (const socket of sockets) socket.close(reason);
      this.deps.logger.info(
        {
          grantId: grant.id,
          sessionId: grant.sessionId,
          userId: grant.userId,
          reason,
          sockets: sockets.length,
        },
        'live grant ended',
      );
    }
    return unique.length;
  }

  private ticketKey(ticket: string): string {
    return hmac(this.deps.subkeys.liveGrant, ticket).toString('hex');
  }

  private pruneTickets(now: number): void {
    this.dropTickets((ticket) => ticket.expiresAt <= now);
  }

  private dropTickets(matches: (ticket: Ticket) => boolean): void {
    for (const [key, ticket] of this.tickets) {
      if (matches(ticket)) this.tickets.delete(key);
    }
  }
}
