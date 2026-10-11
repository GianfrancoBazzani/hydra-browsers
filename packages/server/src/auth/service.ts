import { and, eq, lte, ne, or, sql } from 'drizzle-orm';
import { MESSAGES } from '@hydra/shared';
import type { AuditWriter } from '../audit/index.js';
import {
  hmac,
  newUlid,
  randomBase64Url,
  type PasswordHasher,
  type Subkeys,
} from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { liveGrants, loginSessions, users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { checkPasswordRules } from './passwords.js';
import { RateLimitedError, RateLimiter } from './rate-limit.js';
import { LoginThrottle } from './throttle.js';
import type { AuthedUser, LoginContext } from './types.js';

export const LOGIN_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const LOGIN_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most one time per minute for each login session. */
export const LAST_SEEN_WRITE_MS = 60_000;
export const LOCK_AFTER_FAILURES = 100;
export const LOGIN_LIMIT_PER_IP = 10;
export const LOGIN_LIMIT_WINDOW_MS = 60_000;
/** Wrong current passwords on POST /api/auth/password, for each user. */
export const PASSWORD_CHANGE_LIMIT = 10;
const USER_AGENT_MAX = 512;

export type PasswordHashing = Pick<
  PasswordHasher,
  'hash' | 'verify' | 'verifyDummy' | 'needsRehash'
>;

export interface AuthDeps {
  db: Db;
  clock: Clock;
  subkeys: Subkeys;
  hasher: PasswordHashing;
  audit: AuditWriter;
  bus: EventBus;
}

type UserRow = typeof users.$inferSelect;
type FailureReason = 'unknown_email' | 'disabled' | 'locked' | 'wrong_password';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toAuthedUser(row: UserRow): AuthedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
  };
}

export class AuthService {
  readonly #deps: AuthDeps;
  readonly #ipLimiter: RateLimiter;
  readonly #passwordLimiter: RateLimiter;
  readonly #throttle: LoginThrottle;

  constructor(deps: AuthDeps) {
    this.#deps = deps;
    this.#ipLimiter = new RateLimiter({
      limit: LOGIN_LIMIT_PER_IP,
      windowMs: LOGIN_LIMIT_WINDOW_MS,
      clock: deps.clock,
    });
    this.#passwordLimiter = new RateLimiter({
      limit: PASSWORD_CHANGE_LIMIT,
      windowMs: LOGIN_LIMIT_WINDOW_MS,
      clock: deps.clock,
    });
    this.#throttle = new LoginThrottle({ clock: deps.clock });
  }

  async login(
    email: string,
    password: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ cookieValue: string; context: LoginContext }> {
    const { db, hasher, clock, subkeys, audit } = this.#deps;
    const normalized = normalizeEmail(email);
    if (!this.#ipLimiter.take(meta.ip)) {
      throw new RateLimitedError(this.#ipLimiter.retryAfterMs(meta.ip));
    }
    const pairKey = `${normalized}\n${meta.ip}`;
    const waitMs = this.#throttle.waitMs(pairKey);
    if (waitMs > 0) throw new RateLimitedError(waitMs);

    const found = db.select().from(users).where(eq(users.email, normalized)).get();
    // The Argon2 verify runs in all cases, so the response time does not show the reason.
    const passwordOk = found
      ? await hasher.verify(found.passwordHash, password)
      : await hasher.verifyDummy(password);
    // Read the row again: an admin can lock, disable, or reset the user during the verify.
    const user = found ? db.select().from(users).where(eq(users.id, found.id)).get() : undefined;
    // A changed hash means the password changed during the verify: the result is for the old one.
    const reason = failureReason(user, passwordOk && user?.passwordHash === found?.passwordHash);
    if (reason !== null || !user) {
      this.#recordFailure(user, normalized, pairKey, reason ?? 'unknown_email', meta.ip);
      throw new HydraError('invalid_credentials', MESSAGES.invalidCredentials);
    }

    this.#throttle.reset(pairKey);
    const passwordHash = hasher.needsRehash(user.passwordHash)
      ? await hasher.hash(password)
      : user.passwordHash;
    const now = clock.now();
    const cookieValue = randomBase64Url(32);
    const loginSessionId = newUlid(clock);
    const userAgent = meta.userAgent.slice(0, USER_AGENT_MAX);
    const created = db.transaction((tx) => {
      // The hash must still be the one that was verified (the rehash await is a race window).
      const updated = tx
        .update(users)
        .set({ failedLogins: 0, lastLoginAt: now, passwordHash })
        .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
        .run().changes;
      if (updated === 0) return false;
      tx.insert(loginSessions)
        .values({
          id: loginSessionId,
          userId: user.id,
          tokenHmac: hmac(subkeys.loginSession, cookieValue),
          ip: meta.ip,
          userAgent,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + LOGIN_SESSION_MAX_MS,
        })
        .run();
      return true;
    });
    if (!created) {
      this.#recordFailure(user, normalized, pairKey, 'wrong_password', meta.ip);
      throw new HydraError('invalid_credentials', MESSAGES.invalidCredentials);
    }
    audit.write({
      kind: 'auth.login',
      actorType: 'user',
      actorId: user.id,
      sessionId: null,
      data: { ip: meta.ip, userAgent },
    });
    return { cookieValue, context: { user: toAuthedUser(user), loginSessionId } };
  }

  /** Spec section 6.4: idle timeout 12 h, maximum life 7 days. Ends a login session that failed. */
  resolve(cookieValue: string | undefined): LoginContext | null {
    if (!cookieValue) return null;
    const { db, clock, subkeys } = this.#deps;
    const row = db
      .select({ session: loginSessions, user: users })
      .from(loginSessions)
      .innerJoin(users, eq(users.id, loginSessions.userId))
      .where(eq(loginSessions.tokenHmac, hmac(subkeys.loginSession, cookieValue)))
      .get();
    if (!row) return null;
    const now = clock.now();
    const expired =
      now >= row.session.expiresAt || now - row.session.lastSeenAt >= LOGIN_SESSION_IDLE_MS;
    if (expired || row.user.status !== 'active') {
      this.#endIds(row.user.id, [row.session.id]);
      return null;
    }
    if (now - row.session.lastSeenAt >= LAST_SEEN_WRITE_MS) {
      db.update(loginSessions)
        .set({ lastSeenAt: now })
        .where(eq(loginSessions.id, row.session.id))
        .run();
    }
    return { user: toAuthedUser(row.user), loginSessionId: row.session.id };
  }

  /** Logout deletes the row (spec section 6.4) and publishes login.ended. */
  logout(context: LoginContext): void {
    const ended = this.#endIds(context.user.id, [context.loginSessionId]);
    if (ended.length > 0) {
      this.#deps.audit.write({
        kind: 'auth.logout',
        actorType: 'user',
        actorId: context.user.id,
        sessionId: null,
        data: {},
      });
    }
  }

  /** Changes the password of the current user and ends all other login sessions of the user. */
  async changePassword(context: LoginContext, current: string, next: string): Promise<void> {
    const { db, hasher, clock, audit } = this.#deps;
    if (!this.#passwordLimiter.take(context.user.id)) {
      throw new RateLimitedError(this.#passwordLimiter.retryAfterMs(context.user.id));
    }
    const user = db.select().from(users).where(eq(users.id, context.user.id)).get();
    if (!user) throw new HydraError('unauthenticated', 'Log in first.');
    checkPasswordRules(next, user.email);
    if (!(await hasher.verify(user.passwordHash, current))) {
      throw new HydraError('password_rejected', 'The current password is not correct.');
    }
    if (next === current) {
      throw new HydraError(
        'password_rejected',
        'The new password must be different from the current password.',
      );
    }
    const passwordHash = await hasher.hash(next);
    const now = clock.now();
    db.update(users)
      .set({ passwordHash, mustChangePassword: false, passwordChangedAt: now, updatedAt: now })
      .where(eq(users.id, user.id))
      .run();
    this.endLoginSessions(user.id, context.loginSessionId);
    audit.write({
      kind: 'auth.password_changed',
      actorType: 'user',
      actorId: user.id,
      sessionId: null,
      data: {},
    });
  }

  /** Ends all login sessions of a user, except one if given. Publishes login.ended. */
  endLoginSessions(userId: string, exceptLoginSessionId?: string): void {
    const where =
      exceptLoginSessionId === undefined
        ? eq(loginSessions.userId, userId)
        : and(eq(loginSessions.userId, userId), ne(loginSessions.id, exceptLoginSessionId));
    const ended = this.#deps.db
      .delete(loginSessions)
      .where(where)
      .returning({ id: loginSessions.id })
      .all()
      .map((row) => row.id);
    if (ended.length > 0) {
      this.#deps.bus.publish({ type: 'login.ended', userId, loginSessionIds: ended });
    }
  }

  /** Daily job (spec section 13.3): deletes expired login sessions and expired live grants. */
  cleanupExpired(): { loginSessions: number; liveGrants: number } {
    const { db, clock, bus } = this.#deps;
    const now = clock.now();
    const expired = db
      .delete(loginSessions)
      .where(
        or(
          lte(loginSessions.expiresAt, now),
          lte(loginSessions.lastSeenAt, now - LOGIN_SESSION_IDLE_MS),
        ),
      )
      .returning({ id: loginSessions.id, userId: loginSessions.userId })
      .all();
    const byUser = new Map<string, string[]>();
    for (const row of expired) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id]);
    for (const [userId, loginSessionIds] of byUser) {
      bus.publish({ type: 'login.ended', userId, loginSessionIds });
    }
    const grants = db.delete(liveGrants).where(lte(liveGrants.expiresAt, now)).run().changes;
    return { loginSessions: expired.length, liveGrants: grants };
  }

  #endIds(userId: string, ids: string[]): string[] {
    const ended: string[] = [];
    for (const id of ids) {
      const deleted = this.#deps.db
        .delete(loginSessions)
        .where(eq(loginSessions.id, id))
        .returning({ id: loginSessions.id })
        .get();
      if (deleted) ended.push(deleted.id);
    }
    if (ended.length > 0) {
      this.#deps.bus.publish({ type: 'login.ended', userId, loginSessionIds: ended });
    }
    return ended;
  }

  #recordFailure(
    user: UserRow | undefined,
    email: string,
    pairKey: string,
    reason: FailureReason,
    ip: string,
  ): void {
    const { db, clock, audit } = this.#deps;
    this.#throttle.fail(pairKey);
    let lockedNow = false;
    if (user) {
      const now = clock.now();
      // One statement, so parallel failures do not lose a count. SET reads the old row values.
      const after = db
        .update(users)
        .set({
          failedLogins: sql`${users.failedLogins} + 1`,
          lockedAt: sql`CASE WHEN ${users.lockedAt} IS NULL AND ${users.failedLogins} + 1 >= ${LOCK_AFTER_FAILURES} THEN ${now} ELSE ${users.lockedAt} END`,
        })
        .where(eq(users.id, user.id))
        .returning({ lockedAt: users.lockedAt })
        .get();
      const lockedAt = after?.lockedAt ?? null;
      lockedNow = user.lockedAt === null && lockedAt !== null;
    }
    audit.write({
      kind: 'auth.login_failed',
      actorType: 'user',
      actorId: user?.id ?? null,
      sessionId: null,
      data: lockedNow ? { email, reason, ip, locked: true } : { email, reason, ip },
    });
  }
}

function failureReason(user: UserRow | undefined, passwordOk: boolean): FailureReason | null {
  if (!user) return 'unknown_email';
  if (user.status !== 'active') return 'disabled';
  if (user.lockedAt !== null) return 'locked';
  if (!passwordOk) return 'wrong_password';
  return null;
}
