import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser, LoginContext } from '../auth/types.js';
import { AuditWriter } from '../audit/index.js';
import { deriveSubkeys } from '../crypto/index.js';
import { auditEvents, vaultCredentials } from '../db/schema.js';
import { EventBus } from '../events/index.js';
import { createLogger } from '../lib/logger.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { totpAt } from './totp.js';
import { REDACTION_CACHE_IDLE_MS, VaultService } from './service.js';

const SECRET = 'JBSWY3DPEHPK3PXP';
const TOTP = { secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 } as const;

let clock: FakeClock;
let testDb: ReturnType<typeof createTestDb>;
let bus: EventBus;
let vault: VaultService;
let owner: AuthedUser;
let context: LoginContext;
let sid: string;

beforeEach(async () => {
  clock = new FakeClock(Date.UTC(2026, 9, 12, 12, 0, 0));
  testDb = createTestDb(clock);
  const config = testConfig({ vaultHttpHosts: ['testsite.local'] });
  bus = new EventBus(createLogger('fatal'));
  const audit = new AuditWriter({ db: testDb.db, bus, clock });
  vault = new VaultService({
    db: testDb.db,
    clock,
    subkeys: deriveSubkeys(config.secretKey),
    config,
    audit,
    bus,
  });
  vault.start();
  owner = (await seedUser({ db: testDb.db, clock, hasher: plainHasher })).user;
  context = { user: owner, loginSessionId: 'ls-1' };
  sid = seedSession({ db: testDb.db, clock, config }, { ownerId: owner.id, state: 'running' }).id;
});

afterEach(() => {
  vault.stop();
  testDb.close();
});

function auditKinds(): string[] {
  return testDb.db
    .select()
    .from(auditEvents)
    .all()
    .map((row) => row.kind);
}

describe('VaultService', () => {
  it('creates a credential, stores only ciphertext, and lists metadata without secrets', () => {
    const created = vault.create(context, sid, {
      name: 'Google - Catalina',
      website: 'https://www.google.com',
      username: 'catalina@example.com',
      password: 'hunter2-secret',
      totp: TOTP,
    });
    expect(created).toMatchObject({
      name: 'Google - Catalina',
      website: 'https://www.google.com',
      matchDomain: 'google.com',
      matchSubdomains: true,
      username: 'catalina@example.com',
      hasPassword: true,
      hasTotp: true,
      createdBy: { id: owner.id, displayName: owner.displayName },
    });
    const row = testDb.db.select().from(vaultCredentials).get();
    const stored = Buffer.concat([
      row?.usernameEnc ?? Buffer.alloc(0),
      row?.passwordEnc ?? Buffer.alloc(0),
      row?.totpEnc ?? Buffer.alloc(0),
    ]);
    for (const plain of ['catalina@example.com', 'hunter2-secret', SECRET]) {
      expect(stored.includes(Buffer.from(plain))).toBe(false);
    }
    expect(JSON.stringify(vault.list(sid))).not.toContain('hunter2-secret');
    expect(JSON.stringify(vault.list(sid))).not.toContain(SECRET);
    expect(auditKinds()).toContain('vault.created');
  });

  it('rejects http for a host that is not listed, and permits a listed one', () => {
    expect(() =>
      vault.create(context, sid, { name: 'x', website: 'http://example.com', password: 'p' }),
    ).toThrow(/HYDRA_VAULT_HTTP_HOSTS/);
    expect(
      vault.create(context, sid, { name: 'x', website: 'http://testsite.local', password: 'p' })
        .website,
    ).toBe('http://testsite.local');
  });

  it('has a limit of 50 credentials', () => {
    for (let i = 0; i < 50; i++)
      vault.create(context, sid, {
        name: `c${String(i)}`,
        website: 'https://a.com',
        password: 'p',
      });
    expect(() =>
      vault.create(context, sid, { name: 'one more', website: 'https://a.com', password: 'p' }),
    ).toThrow(expect.objectContaining({ code: 'vault_limit_reached' }));
  });

  it('updates with the null rule and keeps one value', () => {
    const { id } = vault.create(context, sid, {
      name: 'x',
      website: 'https://a.com',
      username: 'user',
      password: 'pass',
    });
    expect(vault.update(context, sid, id, { password: null })).toMatchObject({
      username: 'user',
      hasPassword: false,
    });
    expect(() => vault.update(context, sid, id, { username: null })).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
    const updated = testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'vault.updated'))
      .get();
    expect(updated?.data).toMatchObject({ credentialId: id, changed: ['password'] });
  });

  it('reveals a password and the current TOTP code, and writes vault.revealed', () => {
    const { id } = vault.create(context, sid, {
      name: 'x',
      website: 'https://a.com',
      password: 'pass',
      totp: TOTP,
    });
    expect(vault.reveal(context, sid, id, 'password')).toEqual({
      field: 'password',
      value: 'pass',
    });
    const code = totpAt(TOTP, clock.now());
    expect(vault.reveal(context, sid, id, 'totp')).toEqual({
      field: 'totp',
      code: code.code,
      validUntil: code.validUntil,
      period: 30,
    });
    const reveals = testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'vault.revealed'))
      .all();
    expect(reveals.map((row) => row.data)).toEqual([
      { credentialId: id, name: 'x', field: 'password' },
      { credentialId: id, name: 'x', field: 'totp' },
    ]);
  });

  it('gives the fill value with the site match, and the texts of section 8.8.2', () => {
    const { id } = vault.create(context, sid, {
      name: 'x',
      website: 'https://login.example.co.uk',
      username: 'user',
    });
    expect(vault.fillValue(sid, id, 'username')).toEqual({
      ok: true,
      fill: {
        value: 'user',
        match: { scheme: 'https:', matchDomain: 'example.co.uk', matchSubdomains: true },
        waitMs: 0,
      },
    });
    expect(vault.fillValue(sid, id, 'password')).toEqual({
      ok: false,
      message: `Credential ${id} has no password.`,
    });
    expect(vault.fillValue(sid, '01J9ZC0000000000000000NONE', 'password')).toEqual({
      ok: false,
      message:
        'Credential 01J9ZC0000000000000000NONE does not exist in this session. Call vault_list.',
    });
  });

  it('rejects a fill of an http credential after its host leaves HYDRA_VAULT_HTTP_HOSTS', () => {
    const { id } = vault.create(context, sid, {
      name: 'x',
      website: 'http://testsite.local',
      password: 'pass',
    });
    const strict = new VaultService({
      db: testDb.db,
      clock,
      subkeys: deriveSubkeys(testConfig().secretKey),
      config: { vaultHttpHosts: [] },
      audit: new AuditWriter({ db: testDb.db, bus, clock }),
      bus,
    });
    expect(strict.fillValue(sid, id, 'password')).toEqual({
      ok: false,
      message: `Credential ${id} uses http, and http is not permitted for testsite.local.`,
    });
  });

  it('waits for the next TOTP period if the code is valid for less than 5 s', () => {
    const { id } = vault.create(context, sid, { name: 'x', website: 'https://a.com', totp: TOTP });
    const periodEnd = Math.ceil(clock.now() / 30_000) * 30_000 + 30_000;
    clock.set(periodEnd - 2_000);
    const lookup = vault.fillValue(sid, id, 'totp');
    expect(lookup).toEqual({
      ok: true,
      fill: { value: totpAt(TOTP, periodEnd).code, match: expect.anything(), waitMs: 2_000 },
    });
  });

  it('lists the credentials for the agent without values', () => {
    expect(vault.agentList(sid)).toBe(
      'The vault of this session is empty. A person adds credentials in the Vault view of the dashboard.',
    );
    const { id } = vault.create(context, sid, {
      name: 'Google',
      website: 'https://www.google.com',
      username: 'u',
      totp: TOTP,
    });
    expect(vault.agentList(sid)).toBe(
      `- ${id} · Google · https://www.google.com · values: username, totp`,
    );
  });

  it('redacts usernames and passwords of 4 characters or more and three TOTP codes', () => {
    const { id } = vault.create(context, sid, {
      name: 'x',
      website: 'https://a.com',
      username: 'abc',
      password: 'hunter22',
      totp: TOTP,
    });
    const now = clock.now();
    const text = vault
      .redactor(sid)
      .text(
        `abc hunter22 ${totpAt(TOTP, now - 30_000).code} ${totpAt(TOTP, now).code} ${totpAt(TOTP, now + 30_000).code}`,
      );
    expect(text).toBe(
      `abc [vault:${id}.password] [vault:${id}.totp] [vault:${id}.totp] [vault:${id}.totp]`,
    );
  });

  it('drops the cache after a change, at a stop, and after 10 min without use', () => {
    const { id } = vault.create(context, sid, {
      name: 'x',
      website: 'https://a.com',
      password: 'first-pass',
    });
    expect(vault.redactor(sid).text('first-pass')).toBe(`[vault:${id}.password]`);
    vault.update(context, sid, id, { password: 'second-pass' });
    expect(vault.redactor(sid).text('second-pass')).toBe(`[vault:${id}.password]`);

    testDb.db
      .update(vaultCredentials)
      .set({ passwordEnc: Buffer.from('broken') })
      .where(eq(vaultCredentials.id, id))
      .run();
    expect(vault.redactor(sid).text('second-pass')).toBe(`[vault:${id}.password]`); // still cached
    bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'stopped',
      previous: 'running',
      errorReason: null,
    });
    expect(() => vault.redactor(sid)).toThrow(/cannot be decrypted/);

    testDb.db.delete(vaultCredentials).run();
    clock.advance(REDACTION_CACHE_IDLE_MS);
    vault.sweep();
    expect(vault.redactor(sid).empty).toBe(true);
  });
});
