import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HydraEvent } from '../events/index.js';
import { AuditWriter } from '../audit/index.js';
import { deriveSubkeys, hmac, newUlid } from '../crypto/index.js';
import { auditEvents, liveGrants, loginSessions, users } from '../db/schema.js';
import { EventBus } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { createTestDb } from '../../test/helpers/db.js';
import { DEFAULT_PASSWORD, plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { testConfig } from '../../test/helpers/config.js';
import { RateLimitedError } from './rate-limit.js';
import {
  AuthService,
  LOGIN_SESSION_IDLE_MS,
  LOGIN_SESSION_MAX_MS,
  type PasswordHashing,
} from './service.js';

const HOUR = 60 * 60 * 1000;
const META = { ip: '203.0.113.5', userAgent: 'vitest' };

describe('AuthService', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let bus: EventBus;
  let events: HydraEvent[];
  let auth: AuthService;
  const subkeys = deriveSubkeys(Buffer.alloc(32, 1));

  beforeEach(() => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    bus = new EventBus(createLogger('fatal'));
    events = [];
    bus.subscribe('login.ended', (event) => events.push(event));
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    auth = new AuthService({ db: testDb.db, clock, subkeys, hasher: plainHasher, audit, bus });
  });

  afterEach(() => testDb.close());

  const seed = (input: Parameters<typeof seedUser>[1] = {}) =>
    seedUser({ db: testDb.db, clock, hasher: plainHasher }, input);

  const auditRows = (kind: string) =>
    testDb.db
      .select()
      .from(auditEvents)
      .all()
      .filter((row) => row.kind === kind);

  async function failure(promise: Promise<unknown>): Promise<HydraError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HydraError) return error;
      throw error;
    }
    throw new Error('expected a HydraError');
  }

  describe('login', () => {
    it('creates a login session and stores only the HMAC of the cookie value', async () => {
      const { user, password } = await seed({ email: 'alice@example.com' });
      const { cookieValue, context } = await auth.login(' Alice@Example.COM ', password, META);
      expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(context.user).toEqual(user);
      const row = testDb.db
        .select()
        .from(loginSessions)
        .where(eq(loginSessions.id, context.loginSessionId))
        .get();
      expect(row?.tokenHmac.equals(hmac(subkeys.loginSession, cookieValue))).toBe(true);
      expect(row?.tokenHmac.toString('utf8')).not.toContain(cookieValue);
      expect(row?.expiresAt).toBe(clock.now() + LOGIN_SESSION_MAX_MS);
      expect(row?.ip).toBe(META.ip);
      expect(auditRows('auth.login')[0]?.data).toEqual({ ip: META.ip, userAgent: 'vitest' });
    });

    it('gives a new cookie value at each login', async () => {
      const { user, password } = await seed();
      const first = await auth.login(user.email, password, META);
      const second = await auth.login(user.email, password, META);
      expect(first.cookieValue).not.toBe(second.cookieValue);
      expect(first.context.loginSessionId).not.toBe(second.context.loginSessionId);
    });

    it('gives the same error for a wrong password, an unknown email, a locked and a disabled user', async () => {
      const { user } = await seed({ email: 'alice@example.com' });
      const locked = await seed({ email: 'locked@example.com' });
      testDb.db
        .update(users)
        .set({ lockedAt: clock.now() })
        .where(eq(users.id, locked.user.id))
        .run();
      const disabled = await seed({ email: 'disabled@example.com', status: 'disabled' });
      const errors = [
        await failure(auth.login(user.email, 'wrong password!!', META)),
        await failure(auth.login('nobody@example.com', 'whatever password', META)),
        await failure(auth.login(locked.user.email, locked.password, META)),
        await failure(auth.login(disabled.user.email, disabled.password, META)),
      ];
      for (const error of errors) {
        expect(error.code).toBe('invalid_credentials');
        expect(error.status).toBe(401);
        expect(error.message).toBe('Invalid email or password');
      }
      expect(auditRows('auth.login_failed').map((row) => row.data.reason)).toEqual([
        'wrong_password',
        'unknown_email',
        'locked',
        'disabled',
      ]);
    });

    it('runs the Argon2 verify for an unknown email, a locked and a disabled user', async () => {
      const calls: string[] = [];
      const spied: PasswordHashing = {
        ...plainHasher,
        verify: (phc, password) => {
          calls.push('verify');
          return plainHasher.verify(phc, password);
        },
        verifyDummy: (password) => {
          calls.push('verifyDummy');
          return plainHasher.verifyDummy(password);
        },
      };
      const spiedAuth = new AuthService({
        db: testDb.db,
        clock,
        subkeys,
        hasher: spied,
        audit: new AuditWriter({ db: testDb.db, bus, clock }),
        bus,
      });
      const locked = await seed({ email: 'locked@example.com' });
      testDb.db
        .update(users)
        .set({ lockedAt: clock.now() })
        .where(eq(users.id, locked.user.id))
        .run();
      const disabled = await seed({ email: 'disabled@example.com', status: 'disabled' });
      await failure(spiedAuth.login('nobody@example.com', 'whatever password', META));
      await failure(spiedAuth.login(locked.user.email, locked.password, META));
      await failure(spiedAuth.login(disabled.user.email, disabled.password, META));
      expect(calls).toEqual(['verifyDummy', 'verify', 'verify']);
    });

    it('rejects a login whose verify overlaps a password change', async () => {
      let release: () => void = () => undefined;
      let gate: Promise<void> | null = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gated: PasswordHashing = {
        ...plainHasher,
        // Only the first verify (the login) waits; later calls are not gated.
        verify: async (phc, password) => {
          const wait = gate;
          gate = null;
          if (wait) await wait;
          return plainHasher.verify(phc, password);
        },
      };
      const gatedAuth = new AuthService({
        db: testDb.db,
        clock,
        subkeys,
        hasher: gated,
        audit: new AuditWriter({ db: testDb.db, bus, clock }),
        bus,
      });
      const { user, password } = await seed();
      const pending = failure(gatedAuth.login(user.email, password, META));
      // The login holds a verify of the old hash. Change the password through the service.
      const session = { user, loginSessionId: newUlid(clock) };
      await gatedAuth.changePassword(session, password, 'a new long passphrase');
      release();
      const error = await pending;
      expect(error.code).toBe('invalid_credentials');
      expect(error.status).toBe(401);
      expect(testDb.db.select().from(loginSessions).all()).toHaveLength(0);
      expect(auditRows('auth.login_failed').map((row) => row.data.reason)).toEqual([
        'wrong_password',
      ]);
      expect(auditRows('auth.login')).toHaveLength(0);
    });

    it('does not overwrite a password that changes during the rehash', async () => {
      let release: () => void = () => undefined;
      let hashStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        hashStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gated: PasswordHashing = {
        ...plainHasher,
        hash: async (password) => {
          if (password === DEFAULT_PASSWORD) {
            hashStarted();
            await gate;
          }
          return plainHasher.hash(password);
        },
      };
      const { user } = await seed();
      // A hash that needsRehash, but that verifies for the password.
      const legacy = 'legacy-hash';
      testDb.db.update(users).set({ passwordHash: legacy }).where(eq(users.id, user.id)).run();
      const legacyHasher: PasswordHashing = {
        ...gated,
        verify: (phc, password) =>
          phc === legacy
            ? Promise.resolve(password === DEFAULT_PASSWORD)
            : gated.verify(phc, password),
      };
      const legacyAuth = new AuthService({
        db: testDb.db,
        clock,
        subkeys,
        hasher: legacyHasher,
        audit: new AuditWriter({ db: testDb.db, bus, clock }),
        bus,
      });
      const pending = failure(legacyAuth.login(user.email, DEFAULT_PASSWORD, META));
      await started; // the row was read again and the rehash is pending
      const changed = await plainHasher.hash('a new long passphrase');
      testDb.db.update(users).set({ passwordHash: changed }).where(eq(users.id, user.id)).run();
      release();
      expect((await pending).code).toBe('invalid_credentials');
      const row = testDb.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(row?.passwordHash).toBe(changed);
      expect(testDb.db.select().from(loginSessions).all()).toHaveLength(0);
    });

    it('locks the account after 100 failures in a row from many IPs', async () => {
      const { user, password } = await seed();
      for (let i = 0; i < 100; i += 1) {
        const ip = `10.1.${Math.floor(i / 200)}.${i % 200}`;
        await failure(auth.login(user.email, 'wrong password!!', { ip, userAgent: 'x' }));
      }
      const row = testDb.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(row?.failedLogins).toBe(100);
      expect(row?.lockedAt).toBe(clock.now());
      const failed = auditRows('auth.login_failed');
      expect(failed.at(-1)?.data.locked).toBe(true);
      expect(failed.filter((event) => event.data.locked === true)).toHaveLength(1);
      const error = await failure(
        auth.login(user.email, password, { ip: '10.9.9.9', userAgent: 'x' }),
      );
      expect(error.code).toBe('invalid_credentials');
      expect(auditRows('auth.login_failed').at(-1)?.data.reason).toBe('locked');
    });

    it('resets the failure count after a good login before the lock', async () => {
      const { user, password } = await seed();
      for (let i = 0; i < 99; i += 1) {
        await failure(
          auth.login(user.email, 'wrong password!!', { ip: `10.2.0.${i}`, userAgent: 'x' }),
        );
      }
      await auth.login(user.email, password, { ip: '10.3.0.1', userAgent: 'x' });
      await failure(auth.login(user.email, 'wrong password!!', { ip: '10.3.0.2', userAgent: 'x' }));
      const row = testDb.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(row?.failedLogins).toBe(1);
      expect(row?.lockedAt).toBeNull();
    });

    it('throttles a pair of email and IP after 5 failures, also for a good password', async () => {
      const { user, password } = await seed();
      for (let i = 0; i < 5; i += 1)
        await failure(auth.login(user.email, 'wrong password!!', META));
      const throttled = await failure(auth.login(user.email, password, META));
      expect(throttled).toBeInstanceOf(RateLimitedError);
      expect((throttled as RateLimitedError).retryAfterSeconds).toBe(900);
      const otherIp = await auth.login(user.email, password, {
        ip: '198.51.100.9',
        userAgent: 'x',
      });
      expect(otherIp.context.user.id).toBe(user.id);
      clock.advance(15 * 60 * 1000);
      await failure(auth.login(user.email, 'wrong password!!', META));
      const doubled = await failure(auth.login(user.email, password, META));
      expect((doubled as RateLimitedError).retryAfterSeconds).toBe(1800);
    });

    it('throttles an email that does not exist in the same way', async () => {
      for (let i = 0; i < 5; i += 1) {
        expect((await failure(auth.login('ghost@example.com', 'whatever pass', META))).code).toBe(
          'invalid_credentials',
        );
      }
      expect((await failure(auth.login('ghost@example.com', 'whatever pass', META))).code).toBe(
        'rate_limited',
      );
    });

    it('permits 10 attempts per minute for each IP', async () => {
      for (let i = 0; i < 10; i += 1) {
        await failure(auth.login(`u${i}@example.com`, 'whatever pass', META));
      }
      const limited = await failure(auth.login('u10@example.com', 'whatever pass', META));
      expect(limited.code).toBe('rate_limited');
      clock.advance(60_000);
      expect((await failure(auth.login('u11@example.com', 'whatever pass', META))).code).toBe(
        'invalid_credentials',
      );
    });

    it('hashes the password again when the parameters changed', async () => {
      const { user, password } = await seed();
      testDb.db
        .update(users)
        .set({ passwordHash: `old:${password}` })
        .where(eq(users.id, user.id))
        .run();
      const legacy = { ...plainHasher, verify: () => Promise.resolve(true) };
      const audit = new AuditWriter({ db: testDb.db, bus, clock });
      const service = new AuthService({
        db: testDb.db,
        clock,
        subkeys,
        hasher: legacy,
        audit,
        bus,
      });
      await service.login(user.email, password, META);
      const row = testDb.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(row?.passwordHash).toBe(`plain:${password}`);
    });
  });

  describe('resolve', () => {
    it('returns the context for a valid cookie and null for others', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      expect(auth.resolve(cookieValue)).toEqual(context);
      expect(auth.resolve(undefined)).toBeNull();
      expect(auth.resolve('not-a-cookie')).toBeNull();
    });

    it('ends a login session after 12 h without a request', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      clock.advance(LOGIN_SESSION_IDLE_MS - 1);
      expect(auth.resolve(cookieValue)).not.toBeNull();
      clock.advance(LOGIN_SESSION_IDLE_MS);
      expect(auth.resolve(cookieValue)).toBeNull();
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [context.loginSessionId] },
      ]);
    });

    it('ends a login session 7 days after the login, also when it is used', async () => {
      const { user, password } = await seed();
      const { cookieValue } = await auth.login(user.email, password, META);
      let elapsed = 0;
      while (elapsed + 11 * HOUR < LOGIN_SESSION_MAX_MS) {
        clock.advance(11 * HOUR);
        elapsed += 11 * HOUR;
        expect(auth.resolve(cookieValue)).not.toBeNull();
      }
      clock.advance(LOGIN_SESSION_MAX_MS - elapsed - 1);
      expect(auth.resolve(cookieValue)).not.toBeNull();
      clock.advance(1);
      expect(auth.resolve(cookieValue)).toBeNull();
    });

    it('writes last_seen_at at most one time per minute', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      const lastSeen = () =>
        testDb.db
          .select()
          .from(loginSessions)
          .where(eq(loginSessions.id, context.loginSessionId))
          .get()?.lastSeenAt;
      const start = clock.now();
      clock.advance(59_999);
      auth.resolve(cookieValue);
      expect(lastSeen()).toBe(start);
      clock.advance(1);
      auth.resolve(cookieValue);
      expect(lastSeen()).toBe(start + 60_000);
    });

    it('returns null and ends the login session of a disabled user', async () => {
      const { user, password } = await seed();
      const { cookieValue } = await auth.login(user.email, password, META);
      testDb.db.update(users).set({ status: 'disabled' }).where(eq(users.id, user.id)).run();
      expect(auth.resolve(cookieValue)).toBeNull();
      expect(testDb.db.select().from(loginSessions).all()).toHaveLength(0);
    });
  });

  describe('logout and endLoginSessions', () => {
    it('deletes the row, publishes login.ended, and writes auth.logout', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      auth.logout(context);
      expect(auth.resolve(cookieValue)).toBeNull();
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [context.loginSessionId] },
      ]);
      expect(auditRows('auth.logout')).toHaveLength(1);
    });

    it('ends all login sessions of a user except one, and publishes nothing if none ended', async () => {
      const { user, password } = await seed();
      const a = await auth.login(user.email, password, META);
      const b = await auth.login(user.email, password, META);
      const c = await auth.login(user.email, password, META);
      auth.endLoginSessions(user.id, a.context.loginSessionId);
      expect(auth.resolve(a.cookieValue)).not.toBeNull();
      expect(auth.resolve(b.cookieValue)).toBeNull();
      expect(auth.resolve(c.cookieValue)).toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'login.ended', userId: user.id });
      expect(new Set((events[0] as { loginSessionIds: string[] }).loginSessionIds)).toEqual(
        new Set([b.context.loginSessionId, c.context.loginSessionId]),
      );
      auth.endLoginSessions('nobody');
      expect(events).toHaveLength(1);
    });
  });

  describe('changePassword', () => {
    it('changes the password and ends the other login sessions', async () => {
      const { user, password } = await seed();
      testDb.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id)).run();
      const current = await auth.login(user.email, password, META);
      const other = await auth.login(user.email, password, META);
      await auth.changePassword(current.context, password, 'a new long passphrase');
      expect(auth.resolve(current.cookieValue)?.user.mustChangePassword).toBe(false);
      expect(auth.resolve(other.cookieValue)).toBeNull();
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [other.context.loginSessionId] },
      ]);
      await auth.login(user.email, 'a new long passphrase', META);
      expect(auditRows('auth.password_changed')).toHaveLength(1);
    });

    it('rejects a wrong current password, a weak password, and the same password', async () => {
      const { user, password } = await seed();
      const { context } = await auth.login(user.email, password, META);
      const wrong = await failure(
        auth.changePassword(context, 'not my password', 'another long passphrase'),
      );
      expect(wrong.code).toBe('password_rejected');
      expect(wrong.message).toBe('The current password is not correct.');
      expect((await failure(auth.changePassword(context, password, 'short'))).code).toBe(
        'password_rejected',
      );
      expect((await failure(auth.changePassword(context, password, password))).message).toBe(
        'The new password must be different from the current password.',
      );
    });

    it('permits 10 attempts per minute for each user', async () => {
      const { user, password } = await seed();
      const { context } = await auth.login(user.email, password, META);
      for (let i = 0; i < 10; i += 1) {
        await failure(auth.changePassword(context, 'not my password', 'another long passphrase'));
      }
      expect(
        (await failure(auth.changePassword(context, password, 'another long passphrase'))).code,
      ).toBe('rate_limited');
    });
  });

  describe('cleanupExpired', () => {
    it('deletes expired login sessions and expired live grants only', async () => {
      const { user, password } = await seed();
      const idle = await auth.login(user.email, password, META);
      clock.advance(LOGIN_SESSION_IDLE_MS);
      const fresh = await auth.login(user.email, password, META);
      const session = seedSession(
        { db: testDb.db, clock, config: testConfig() },
        { ownerId: user.id },
      );
      const grant = (id: string, expiresAt: number) => ({
        id,
        loginSessionId: fresh.context.loginSessionId,
        userId: user.id,
        sessionId: session.id,
        nekoProfile: 'admin' as const,
        cookieHmac: Buffer.from(id),
        createdAt: clock.now(),
        expiresAt,
      });
      testDb.db
        .insert(liveGrants)
        .values([grant(newUlid(clock), clock.now() - 1), grant(newUlid(clock), clock.now() + HOUR)])
        .run();
      expect(auth.cleanupExpired()).toEqual({ loginSessions: 1, liveGrants: 1 });
      expect(auth.resolve(fresh.cookieValue)).not.toBeNull();
      expect(testDb.db.select().from(liveGrants).all()).toHaveLength(1);
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [idle.context.loginSessionId] },
      ]);
    });
  });
});
