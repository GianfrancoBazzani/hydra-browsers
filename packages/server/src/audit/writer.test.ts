import type { AuditEvent } from '@hydra/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { createTestDb, type TestDb } from '../../test/helpers/db.js';
import { agentTokens, auditEvents, sessions, users } from '../db/schema.js';
import { EventBus } from '../events/bus.js';
import { HydraError } from '../lib/errors.js';
import { AuditWriter } from './writer.js';

describe('AuditWriter', () => {
  let testDb: TestDb;
  let clock: FakeClock;
  let published: AuditEvent[];
  let audit: AuditWriter;

  beforeEach(() => {
    clock = new FakeClock(1_000_000);
    testDb = createTestDb(clock);
    const bus = new EventBus(pino({ level: 'silent' }));
    published = [];
    bus.subscribe('audit', (event) => published.push(event.event));
    audit = new AuditWriter({ db: testDb.db, bus, clock });
    testDb.db
      .insert(users)
      .values({
        id: 'u1',
        email: 'alice@example.com',
        displayName: 'Alice',
        passwordHash: 'x',
        role: 'member',
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

  it('inserts the event with the clock time and publishes the API shape', () => {
    const event = audit.write({
      kind: 'auth.login',
      actorType: 'user',
      actorId: 'u1',
      sessionId: null,
      data: { ip: '203.0.113.5' },
    });
    expect(event.id).toBeGreaterThan(0);
    expect(event).toEqual({
      id: event.id,
      ts: 1_000_000,
      kind: 'auth.login',
      actorType: 'user',
      actorId: 'u1',
      actorName: 'Alice',
      sessionId: null,
      status: null,
      data: { ip: '203.0.113.5' },
    });
    expect(published).toEqual([event]);
    expect(testDb.db.select().from(auditEvents).all()).toHaveLength(1);
  });

  it('names a token actor by the token name, and a system actor not at all', () => {
    testDb.db
      .insert(sessions)
      .values({
        id: 'aaaaaaaaaaaa',
        name: 'S',
        ownerId: 'u1',
        desiredState: 'stopped',
        state: 'stopped',
        allowlist: ['*'],
        timezone: 'UTC',
        language: 'en-US',
        screen: '1920x1080',
        appliedSettings: {
          allowlist: ['*'],
          timezone: 'UTC',
          language: 'en-US',
          screen: '1920x1080',
        },
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    testDb.db
      .insert(agentTokens)
      .values({
        id: 't1',
        sessionId: 'aaaaaaaaaaaa',
        createdBy: 'u1',
        name: 'claude-laptop',
        tokenHmac: Buffer.alloc(32),
        prefix: 'hyd_12345678…',
        createdAt: 1,
        expiresAt: 2,
      })
      .run();
    const tokenEvent = audit.write({
      kind: 'mcp.connect',
      actorType: 'token',
      actorId: 't1',
      sessionId: 'aaaaaaaaaaaa',
      data: {},
    });
    const systemEvent = audit.write({
      kind: 'session.state',
      actorType: 'system',
      actorId: null,
      sessionId: 'aaaaaaaaaaaa',
      data: { state: 'running' },
    });
    expect(tokenEvent.actorName).toBe('claude-laptop');
    expect(systemEvent.actorName).toBeNull();
  });

  it('gives increasing IDs', () => {
    const first = audit.write({
      kind: 'auth.logout',
      actorType: 'user',
      actorId: 'u1',
      sessionId: null,
      data: {},
    });
    const second = audit.write({
      kind: 'auth.logout',
      actorType: 'user',
      actorId: 'u1',
      sessionId: null,
      data: {},
    });
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('updates the status, merges the data, and publishes the updated event', () => {
    const pending = audit.write({
      kind: 'mcp.tool_call',
      actorType: 'user',
      actorId: 'u1',
      sessionId: null,
      status: 'pending',
      data: { tool: 'browser_click', rpcId: 7 },
    });
    clock.advance(500);
    const done = audit.update(pending.id, { status: 'ok', data: { durationMs: 230 } });
    expect(done).toEqual({
      ...pending,
      status: 'ok',
      data: { tool: 'browser_click', rpcId: 7, durationMs: 230 },
    });
    expect(published).toEqual([pending, done]);
  });

  it('keeps the status when the patch has only data', () => {
    const pending = audit.write({
      kind: 'mcp.tool_call',
      actorType: 'user',
      actorId: 'u1',
      sessionId: null,
      status: 'pending',
      data: {},
    });
    expect(audit.update(pending.id, { data: { note: 'x' } }).status).toBe('pending');
  });

  it('throws not_found for an unknown ID', () => {
    expect(() => audit.update(999, { status: 'error' })).toThrow(HydraError);
    expect(published).toEqual([]);
  });
});
