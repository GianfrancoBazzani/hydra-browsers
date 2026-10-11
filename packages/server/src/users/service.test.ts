import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessService } from '../access/index.js';
import { AuditWriter } from '../audit/index.js';
import { AuthService, type AuthedUser, type LoginContext } from '../auth/index.js';
import { deriveSubkeys } from '../crypto/index.js';
import { agentTokens, auditEvents, users } from '../db/schema.js';
import { EventBus, type HydraEvent } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { TokensService } from '../tokens/index.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { UsersService } from './service.js';

const META = { ip: '203.0.113.7', userAgent: 'vitest' };

describe('UsersService', () => {
  const subkeys = deriveSubkeys(Buffer.alloc(32, 1));
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let events: HydraEvent[];
  let auth: AuthService;
  let access: AccessService;
  let tokens: TokensService;
  let service: UsersService;
  let admin: AuthedUser;
  let adminCtx: LoginContext;

  beforeEach(async () => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    const bus = new EventBus(createLogger('fatal'));
    events = [];
    for (const type of ['rights.changed', 'login.ended', 'token.revoked'] as const) {
      bus.subscribe(type, (event) => events.push(event));
    }
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    auth = new AuthService({ db: testDb.db, clock, subkeys, hasher: plainHasher, audit, bus });
    access = new AccessService({ db: testDb.db, clock, audit, bus });
    tokens = new TokensService({ db: testDb.db, clock, subkeys, access, audit, bus });
    service = new UsersService({
      db: testDb.db,
      clock,
      hasher: plainHasher,
      auth,
      tokens,
      audit,
      bus,
    });
    admin = (
      await seedUser(
        { db: testDb.db, clock, hasher: plainHasher },
        { email: 'admin@example.com', role: 'admin' },
      )
    ).user;
    adminCtx = { user: admin, loginSessionId: 'ls-admin' };
  });

  afterEach(() => testDb.close());

  const seed = (input: Parameters<typeof seedUser>[1] = {}) =>
    seedUser({ db: testDb.db, clock, hasher: plainHasher }, input);
  const userRow = (id: string) => testDb.db.select().from(users).where(eq(users.id, id)).get();
  const auditKinds = () =>
    testDb.db
      .select()
      .from(auditEvents)
      .all()
      .map((row) => row.kind);

  async function codeOf(fn: () => unknown): Promise<string | null> {
    try {
      await fn();
      return null;
    } catch (error) {
      return error instanceof HydraError ? error.code : 'other';
    }
  }

  describe('create', () => {
    it('creates a user with a one-time password that must be changed', async () => {
      const { user, oneTimePassword } = await service.create(adminCtx, {
        email: ' Bob@Example.com ',
        displayName: ' Bob ',
        role: 'member',
      });
      expect(oneTimePassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(user).toMatchObject({
        email: 'bob@example.com',
        displayName: 'Bob',
        role: 'member',
        status: 'active',
        locked: false,
        lastLoginAt: null,
      });
      expect(userRow(user.id)?.mustChangePassword).toBe(true);
      const { context } = await auth.login('bob@example.com', oneTimePassword, META);
      expect(context.user.mustChangePassword).toBe(true);
      const created = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((row) => row.kind === 'user.created');
      expect(created).toMatchObject({
        actorType: 'user',
        actorId: admin.id,
        data: { userId: user.id, email: 'bob@example.com', role: 'member' },
      });
    });

    it('rejects an email that exists, in any case', async () => {
      await seed({ email: 'carol@example.com' });
      expect(
        await codeOf(() =>
          service.create(adminCtx, {
            email: 'CAROL@example.com',
            displayName: 'C',
            role: 'member',
          }),
        ),
      ).toBe('conflict');
    });

    it('creates a user with a typed password for the CLI', async () => {
      const user = await service.createWithPassword({
        email: 'ops@example.com',
        displayName: 'Ops',
        role: 'admin',
        password: 'a long admin passphrase',
      });
      expect(user.role).toBe('admin');
      expect(userRow(user.id)?.mustChangePassword).toBe(false);
      expect(
        await codeOf(() =>
          service.createWithPassword({
            email: 'x@example.com',
            displayName: 'X',
            role: 'member',
            password: 'short',
          }),
        ),
      ).toBe('password_rejected');
      expect(
        await codeOf(() =>
          service.createWithPassword({
            email: 'not-an-email',
            displayName: 'X',
            role: 'member',
            password: 'a long admin passphrase',
          }),
        ),
      ).toBe('validation_failed');
      const created = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((row) => row.kind === 'user.created');
      expect(created).toMatchObject({ actorType: 'system', actorId: null });
    });
  });

  describe('list', () => {
    it('lists all users by email with the locked flag', async () => {
      const zed = await seed({ email: 'zed@example.com' });
      await seed({ email: 'amy@example.com' });
      testDb.db.update(users).set({ lockedAt: clock.now() }).where(eq(users.id, zed.user.id)).run();
      const listed = service.list();
      expect(listed.map((user) => user.email)).toEqual([
        'admin@example.com',
        'amy@example.com',
        'zed@example.com',
      ]);
      expect(listed.find((user) => user.email === 'zed@example.com')?.locked).toBe(true);
    });
  });

  describe('update', () => {
    it('changes the display name without a rights event', async () => {
      const { user } = await seed();
      expect(service.update(adminCtx, user.id, { displayName: 'New Name' }).displayName).toBe(
        'New Name',
      );
      expect(events).toEqual([]);
      expect(auditKinds()).toContain('user.updated');
    });

    it('publishes rights.changed for a role change', async () => {
      const { user } = await seed();
      expect(service.update(adminCtx, user.id, { role: 'admin' }).role).toBe('admin');
      expect(events).toEqual([{ type: 'rights.changed', userId: user.id }]);
    });

    it('disables: ends login sessions, revokes tokens, publishes rights.changed; enable keeps tokens revoked', async () => {
      const { user, password } = await seed();
      const owner = (await seed()).user;
      const session = seedSession(
        { db: testDb.db, clock, config: testConfig() },
        { ownerId: owner.id },
      );
      access.addMember({ user: owner, loginSessionId: 'x' }, session.id, {
        email: user.email,
        role: 'operator',
      });
      const login = await auth.login(user.email, password, META);
      const { token } = tokens.create(login.context, session.id, { name: 't', expiresInDays: 7 });
      events.length = 0;
      expect(service.update(adminCtx, user.id, { status: 'disabled' }).status).toBe('disabled');
      expect(auth.resolve(login.cookieValue)).toBeNull();
      const revokedAt = testDb.db
        .select()
        .from(agentTokens)
        .where(eq(agentTokens.id, token.id))
        .get()?.revokedAt;
      expect(revokedAt).toBe(clock.now());
      expect(events.map((event) => event.type)).toEqual([
        'login.ended',
        'token.revoked',
        'rights.changed',
      ]);
      events.length = 0;
      service.update(adminCtx, user.id, { status: 'active' });
      expect(events).toEqual([]);
      expect(
        testDb.db.select().from(agentTokens).where(eq(agentTokens.id, token.id)).get()?.revokedAt,
      ).toBe(revokedAt);
    });

    it('does not let an admin change the own role or status', async () => {
      expect(await codeOf(() => service.update(adminCtx, admin.id, { role: 'member' }))).toBe(
        'conflict',
      );
      expect(await codeOf(() => service.update(adminCtx, admin.id, { status: 'disabled' }))).toBe(
        'conflict',
      );
      expect(
        service.update(adminCtx, admin.id, { displayName: 'Boss', role: 'admin' }).displayName,
      ).toBe('Boss');
    });

    it('returns not_found for an unknown user', async () => {
      expect(await codeOf(() => service.update(adminCtx, 'nope', { role: 'admin' }))).toBe(
        'not_found',
      );
    });
  });

  describe('resetPassword, setPassword, unlock', () => {
    it('resets: new one-time password, all login sessions end, the lock ends', async () => {
      const { user, password } = await seed();
      const a = await auth.login(user.email, password, META);
      const b = await auth.login(user.email, password, { ...META, ip: '203.0.113.8' });
      testDb.db
        .update(users)
        .set({ lockedAt: clock.now(), failedLogins: 100 })
        .where(eq(users.id, user.id))
        .run();
      const { oneTimePassword } = await service.resetPassword(adminCtx, user.id);
      expect(auth.resolve(a.cookieValue)).toBeNull();
      expect(auth.resolve(b.cookieValue)).toBeNull();
      expect(userRow(user.id)).toMatchObject({
        lockedAt: null,
        failedLogins: 0,
        mustChangePassword: true,
      });
      const again = await auth.login(user.email, oneTimePassword, { ...META, ip: '203.0.113.9' });
      expect(again.context.user.mustChangePassword).toBe(true);
      expect(auditKinds()).toContain('user.password_reset');
    });

    it('sets a typed password by email for the CLI', async () => {
      const { user } = await seed({ email: 'dave@example.com' });
      await service.setPassword('DAVE@example.com', 'a brand new passphrase');
      expect(userRow(user.id)?.mustChangePassword).toBe(false);
      await auth.login(user.email, 'a brand new passphrase', META);
      expect(
        await codeOf(() => service.setPassword('ghost@example.com', 'a brand new passphrase')),
      ).toBe('not_found');
      expect(await codeOf(() => service.setPassword(user.email, 'dave@example.com'))).toBe(
        'password_rejected',
      );
    });

    it('unlocks a locked account', async () => {
      const { user } = await seed();
      testDb.db
        .update(users)
        .set({ lockedAt: clock.now(), failedLogins: 100 })
        .where(eq(users.id, user.id))
        .run();
      expect(service.unlock(adminCtx, user.id).locked).toBe(false);
      expect(userRow(user.id)?.failedLogins).toBe(0);
      const updated = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .filter((row) => row.kind === 'user.updated');
      expect(updated.at(-1)?.data).toEqual({ userId: user.id, unlocked: true });
    });
  });
});
