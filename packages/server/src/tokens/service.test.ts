import { TOKEN_EXPIRY_DAYS, type TokenExpiryDays } from '@hydra/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessService } from '../access/index.js';
import { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/types.js';
import { deriveSubkeys, hmac } from '../crypto/index.js';
import { agentTokens, auditEvents, sessions, users } from '../db/schema.js';
import { EventBus, type HydraEvent } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { TokensService, parseBearer } from './service.js';

const DAY = 24 * 60 * 60 * 1000;
const IP = '192.0.2.10';

describe('TokensService', () => {
  const subkeys = deriveSubkeys(Buffer.alloc(32, 1));
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let events: HydraEvent[];
  let access: AccessService;
  let tokens: TokensService;
  let owner: AuthedUser;
  let operator: AuthedUser;
  let otherOperator: AuthedUser;
  let sid: string;
  let otherSid: string;

  const ctx = (user: AuthedUser): LoginContext => ({ user, loginSessionId: 'ls-1' });
  const view = (user: AuthedUser) => {
    const result = access.view(user.id, sid);
    if (!result) throw new Error('no view');
    return result;
  };

  beforeEach(async () => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    const bus = new EventBus(createLogger('fatal'));
    events = [];
    bus.subscribe('token.revoked', (event) => events.push(event));
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    access = new AccessService({ db: testDb.db, clock, audit, bus });
    tokens = new TokensService({ db: testDb.db, clock, subkeys, access, audit, bus });
    const deps = { db: testDb.db, clock, hasher: plainHasher };
    owner = (await seedUser(deps, { displayName: 'Owner' })).user;
    operator = (await seedUser(deps, { displayName: 'Op One' })).user;
    otherOperator = (await seedUser(deps, { displayName: 'Op Two' })).user;
    const config = testConfig();
    sid = seedSession({ db: testDb.db, clock, config }, { ownerId: owner.id, state: 'running' }).id;
    otherSid = seedSession({ db: testDb.db, clock, config }, { ownerId: owner.id }).id;
    access.addMember(ctx(owner), sid, { email: operator.email, role: 'operator' });
    access.addMember(ctx(owner), sid, { email: otherOperator.email, role: 'operator' });
  });

  afterEach(() => testDb.close());

  const create = (user = operator, expiresInDays: TokenExpiryDays = 30) =>
    tokens.create(ctx(user), sid, { name: 'claude', expiresInDays });

  const row = (id: string) =>
    testDb.db.select().from(agentTokens).where(eq(agentTokens.id, id)).get();

  const setDesiredState = (id: string, desiredState: 'running' | 'stopped' | 'deleted') =>
    testDb.db.update(sessions).set({ desiredState }).where(eq(sessions.id, id)).run();

  function codeOf(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (error) {
      return error instanceof HydraError ? error.code : 'other';
    }
  }

  describe('create', () => {
    it('returns the secret one time and stores only its HMAC', () => {
      const { token, secret } = create();
      expect(secret).toMatch(/^hyd_[0-9A-Za-z]+$/);
      expect(token.prefix).toBe(`${secret.slice(0, 12)}…`);
      expect(token.createdBy).toEqual({ id: operator.id, displayName: 'Op One' });
      const stored = row(token.id);
      expect(stored?.tokenHmac.equals(hmac(subkeys.agentToken, secret))).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(secret.slice(4));
      const audit = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.kind === 'token.created');
      expect(audit?.data).toEqual({
        tokenId: token.id,
        name: 'claude',
        prefix: token.prefix,
        expiresAt: token.expiresAt,
      });
    });

    it.each(TOKEN_EXPIRY_DAYS)('expires after %i days', (days) => {
      const { token } = create(operator, days);
      expect(token.expiresAt).toBe(clock.now() + days * DAY);
    });

    it('refuses a session with a pending Delete (spec section 6.6)', () => {
      setDesiredState(sid, 'deleted');
      let thrown: unknown;
      try {
        create();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HydraError);
      expect(thrown).toMatchObject({ code: 'invalid_state', message: 'The session is deleting.' });
      expect(testDb.db.select().from(agentTokens).all()).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('lists all tokens of the session, newest first, without secrets', () => {
      const first = create(operator).token;
      clock.advance(1000);
      const second = create(otherOperator).token;
      tokens.revoke(ctx(owner), first.id);
      tokens.create(ctx(owner), otherSid, { name: 'elsewhere', expiresInDays: 1 });
      const listed = tokens.list(sid);
      expect(listed.map((token) => token.id)).toEqual([second.id, first.id]);
      expect(listed[1]?.revokedAt).toBe(clock.now());
      expect(listed[0]?.createdBy.displayName).toBe('Op Two');
      expect(JSON.stringify(listed)).not.toContain('secret');
    });
  });

  describe('resolve', () => {
    it('accepts a valid bearer token for its own session only', () => {
      const { token, secret } = create();
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toEqual({
        tokenId: token.id,
        userId: operator.id,
        sessionId: sid,
      });
      expect(tokens.resolve(`bearer ${secret}`, sid, IP)).not.toBeNull();
      expect(tokens.resolve(`Bearer ${secret}`, otherSid, IP)).toBeNull();
      expect(tokens.resolve(undefined, sid, IP)).toBeNull();
      expect(tokens.resolve(secret, sid, IP)).toBeNull();
      expect(tokens.resolve(`Basic ${secret}`, sid, IP)).toBeNull();
      expect(tokens.resolve('Bearer hyd_doesnotexist', sid, IP)).toBeNull();
    });

    it('rejects an expired token', () => {
      const { secret } = create(operator, 1);
      clock.advance(DAY - 1);
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).not.toBeNull();
      clock.advance(1);
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toBeNull();
    });

    it('rejects a token of a session with a pending Delete', () => {
      const { token, secret } = create();
      expect(tokens.isValid(token.id)).toBe(true);
      // After Delete the row keeps state and deleted_at until the reconciler is done.
      setDesiredState(sid, 'deleted');
      expect(tokens.isValid(token.id)).toBe(false);
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toBeNull();
      expect(row(token.id)?.lastUsedAt).toBeNull();
    });

    it('rejects a token of a deleted session', () => {
      const { secret } = create();
      testDb.db
        .update(sessions)
        .set({ state: 'deleted', deletedAt: clock.now() })
        .where(eq(sessions.id, sid))
        .run();
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toBeNull();
    });

    it('rejects a token whose creator lost token.create or was disabled', () => {
      const first = create(operator);
      const second = create(otherOperator);
      access.updateMember(ctx(owner), sid, operator.id, 'viewer');
      expect(tokens.resolve(`Bearer ${first.secret}`, sid, IP)).toBeNull();
      expect(tokens.isValid(first.token.id)).toBe(false);
      testDb.db
        .update(users)
        .set({ status: 'disabled' })
        .where(eq(users.id, otherOperator.id))
        .run();
      expect(tokens.resolve(`Bearer ${second.secret}`, sid, IP)).toBeNull();
    });

    it('writes last_used_at and last_used_ip at most one time per minute', () => {
      const { token, secret } = create();
      const start = clock.now();
      tokens.resolve(`Bearer ${secret}`, sid, IP);
      expect(row(token.id)).toMatchObject({ lastUsedAt: start, lastUsedIp: IP });
      clock.advance(59_999);
      tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.99');
      expect(row(token.id)).toMatchObject({ lastUsedAt: start, lastUsedIp: IP });
      clock.advance(1);
      tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.99');
      expect(row(token.id)).toMatchObject({ lastUsedAt: start + 60_000, lastUsedIp: '192.0.2.99' });
    });
  });

  describe('revoke', () => {
    it('revokes, writes token.revoked, publishes token.revoked, and is a no-op the second time', () => {
      const { token, secret } = create();
      tokens.revoke(ctx(operator), token.id);
      expect(row(token.id)).toMatchObject({ revokedAt: clock.now(), revokedBy: operator.id });
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toBeNull();
      expect(events).toEqual([{ type: 'token.revoked', tokenId: token.id, sessionId: sid }]);
      tokens.revoke(ctx(operator), token.id);
      expect(events).toHaveLength(1);
      const audits = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .filter((event) => event.kind === 'token.revoked');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: 'user', actorId: operator.id, sessionId: sid });
    });

    it('records the system as the actor', () => {
      const { token } = create();
      tokens.revoke('system', token.id);
      expect(row(token.id)?.revokedBy).toBeNull();
      const audit = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.kind === 'token.revoked');
      expect(audit).toMatchObject({ actorType: 'system', actorId: null });
    });

    it('fails for an unknown token', () => {
      expect(codeOf(() => tokens.revoke('system', 'nope'))).toBe('not_found');
    });
  });

  describe('revokeInSession', () => {
    it('lets an operator revoke an own token but not the token of another user', () => {
      const own = create(operator).token;
      const others = create(otherOperator).token;
      tokens.revokeInSession(ctx(operator), view(operator), own.id);
      expect(row(own.id)?.revokedAt).not.toBeNull();
      expect(codeOf(() => tokens.revokeInSession(ctx(operator), view(operator), others.id))).toBe(
        'forbidden',
      );
      expect(row(others.id)?.revokedAt).toBeNull();
    });

    it('lets the owner revoke any token', () => {
      const others = create(otherOperator).token;
      tokens.revokeInSession(ctx(owner), view(owner), others.id);
      expect(row(others.id)?.revokedBy).toBe(owner.id);
    });

    it('returns not_found for a token of another session', () => {
      const elsewhere = tokens.create(ctx(owner), otherSid, { name: 'x', expiresInDays: 1 }).token;
      expect(codeOf(() => tokens.revokeInSession(ctx(owner), view(owner), elsewhere.id))).toBe(
        'not_found',
      );
    });
  });

  describe('bulk revoke', () => {
    it('revokes all active tokens of a session, or of a creator', () => {
      const a = create(operator).token;
      const b = create(otherOperator).token;
      const c = tokens.create(ctx(operator), otherSid, { name: 'x', expiresInDays: 1 });
      tokens.revokeAllCreatedBy(operator.id);
      expect(
        [row(a.id)?.revokedAt, row(c.token.id)?.revokedAt].every((value) => value !== null),
      ).toBe(true);
      expect(row(b.id)?.revokedAt).toBeNull();
      tokens.revokeAllForSession(sid);
      expect(row(b.id)?.revokedAt).not.toBeNull();
      expect(events.map((event) => (event as { tokenId: string }).tokenId).sort()).toEqual(
        [a.id, b.id, c.token.id].sort(),
      );
    });
  });

  describe('isValid', () => {
    it('is true for a valid token', () => {
      expect(tokens.isValid(create().token.id)).toBe(true);
    });

    it('is false for an expired token', () => {
      const { token } = create(operator, 1);
      clock.advance(DAY - 1);
      expect(tokens.isValid(token.id)).toBe(true);
      clock.advance(1);
      expect(tokens.isValid(token.id)).toBe(false);
    });

    it('is false for a revoked token', () => {
      const { token } = create();
      tokens.revoke(ctx(operator), token.id);
      expect(tokens.isValid(token.id)).toBe(false);
    });

    it('is false for an unknown token id', () => {
      expect(tokens.isValid('does-not-exist')).toBe(false);
    });

    it('is false for a token of a session with desired_state deleted', () => {
      const { token } = create();
      setDesiredState(sid, 'deleted');
      expect(tokens.isValid(token.id)).toBe(false);
    });
  });
});

describe('parseBearer', () => {
  it('accepts only the Bearer scheme with a hyd_ token', () => {
    expect(parseBearer('Bearer hyd_abc123')).toBe('hyd_abc123');
    expect(parseBearer('BEARER   hyd_abc123  ')).toBe('hyd_abc123');
    expect(parseBearer('Bearer abc123')).toBeNull();
    expect(parseBearer('Bearer hyd_abc 123')).toBeNull();
    expect(parseBearer('Token hyd_abc123')).toBeNull();
    expect(parseBearer('')).toBeNull();
  });
});
