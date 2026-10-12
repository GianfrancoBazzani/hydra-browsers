import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../test/helpers/db.js';
import {
  agentTokens,
  liveGrants,
  loginSessions,
  sessions,
  users,
  vaultCredentials,
} from './schema.js';

describe('schema', () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
    testDb.db
      .insert(users)
      .values({
        id: 'u1',
        email: 'owner@example.com',
        displayName: 'Owner',
        passwordHash: '$argon2id$x',
        role: 'admin',
        status: 'active',
        mustChangePassword: false,
        passwordChangedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  });
  afterEach(() => {
    testDb.close();
  });

  function insertSession(id: string, mediaPort: number | null): void {
    testDb.db
      .insert(sessions)
      .values({
        id,
        name: id,
        ownerId: 'u1',
        desiredState: 'stopped',
        state: 'stopped',
        mediaPort,
        allowlist: ['example.com'],
        timezone: 'UTC',
        language: 'en-US',
        screen: '1920x1080',
        appliedSettings: {
          allowlist: ['example.com'],
          timezone: 'UTC',
          language: 'en-US',
          screen: '1920x1080',
        },
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  }

  it('reads back JSON, boolean, and blob columns', () => {
    insertSession('aaaaaaaaaaaa', null);
    const row = testDb.db.select().from(sessions).where(eq(sessions.id, 'aaaaaaaaaaaa')).get();
    expect(row?.allowlist).toEqual(['example.com']);
    expect(row?.appliedSettings.screen).toBe('1920x1080');
    expect(testDb.db.select().from(users).get()?.mustChangePassword).toBe(false);

    testDb.db
      .insert(agentTokens)
      .values({
        id: 't1',
        sessionId: 'aaaaaaaaaaaa',
        createdBy: 'u1',
        name: 'ci',
        tokenHmac: Buffer.alloc(32, 7),
        prefix: 'hyd_abcdefgh…',
        createdAt: 1,
        expiresAt: 2,
      })
      .run();
    expect(testDb.db.select().from(agentTokens).get()?.tokenHmac).toEqual(Buffer.alloc(32, 7));
  });

  it('permits many sessions without a media port, and no duplicate port', () => {
    insertSession('aaaaaaaaaaaa', null);
    insertSession('bbbbbbbbbbbb', null);
    insertSession('cccccccccccc', 52000);
    expect(() => {
      insertSession('dddddddddddd', 52000);
    }).toThrow(/UNIQUE/);
  });

  it('enforces foreign keys', () => {
    expect(() =>
      testDb.db
        .insert(loginSessions)
        .values({
          id: 'l1',
          userId: 'missing',
          tokenHmac: Buffer.alloc(32),
          ip: '127.0.0.1',
          userAgent: 'test',
          createdAt: 1,
          lastSeenAt: 1,
          expiresAt: 2,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('deletes the live grants of a deleted login session (cascade)', () => {
    insertSession('aaaaaaaaaaaa', null);
    testDb.db
      .insert(loginSessions)
      .values({
        id: 'l1',
        userId: 'u1',
        tokenHmac: Buffer.alloc(32, 1),
        ip: '127.0.0.1',
        userAgent: 'test',
        createdAt: 1,
        lastSeenAt: 1,
        expiresAt: 2,
      })
      .run();
    testDb.db
      .insert(liveGrants)
      .values({
        id: 'g1',
        loginSessionId: 'l1',
        userId: 'u1',
        sessionId: 'aaaaaaaaaaaa',
        nekoProfile: 'admin',
        cookieHmac: Buffer.alloc(32, 2),
        createdAt: 1,
        expiresAt: 2,
      })
      .run();
    testDb.db.delete(loginSessions).where(eq(loginSessions.id, 'l1')).run();
    expect(testDb.db.select().from(liveGrants).all()).toEqual([]);
  });

  it('deletes the login sessions of a deleted user (cascade)', () => {
    testDb.db
      .insert(loginSessions)
      .values({
        id: 'l1',
        userId: 'u1',
        tokenHmac: Buffer.alloc(32, 1),
        ip: '127.0.0.1',
        userAgent: 'test',
        createdAt: 1,
        lastSeenAt: 1,
        expiresAt: 2,
      })
      .run();
    testDb.db.delete(users).where(eq(users.id, 'u1')).run();
    expect(testDb.db.select().from(loginSessions).all()).toEqual([]);
  });

  it('rejects a vault credential without a value (CHECK constraint)', () => {
    insertSession('vaultsession', null);
    const row = {
      id: '01J9ZC0000000000000000CRD1',
      sessionId: 'vaultsession',
      name: 'x',
      website: 'https://example.com',
      usernameEnc: null,
      passwordEnc: null,
      totpEnc: null,
      createdBy: 'u1',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(() => testDb.db.insert(vaultCredentials).values(row).run()).toThrow(/CHECK/);
    testDb.db
      .insert(vaultCredentials)
      .values({ ...row, passwordEnc: Buffer.alloc(29) })
      .run();
    expect(testDb.db.select().from(vaultCredentials).all()).toHaveLength(1);
  });
});
