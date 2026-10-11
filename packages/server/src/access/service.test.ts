import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/types.js';
import { auditEvents } from '../db/schema.js';
import { EventBus, type HydraEvent } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { AccessService } from './service.js';

const START = { method: 'POST', path: '/api/sessions/:sid/start' };

describe('AccessService', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let events: HydraEvent[];
  let access: AccessService;
  let owner: AuthedUser;
  let operator: AuthedUser;
  let viewer: AuthedUser;
  let stranger: AuthedUser;
  let admin: AuthedUser;
  let sid: string;

  const ctx = (user: AuthedUser): LoginContext => ({ user, loginSessionId: 'ls-1' });

  beforeEach(async () => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    const bus = new EventBus(createLogger('fatal'));
    events = [];
    bus.subscribe('rights.changed', (event) => events.push(event));
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    access = new AccessService({ db: testDb.db, clock, audit, bus });
    const deps = { db: testDb.db, clock, hasher: plainHasher };
    owner = (await seedUser(deps, { email: 'owner@example.com' })).user;
    operator = (await seedUser(deps, { email: 'operator@example.com' })).user;
    viewer = (await seedUser(deps, { email: 'viewer@example.com' })).user;
    stranger = (await seedUser(deps, { email: 'stranger@example.com' })).user;
    admin = (await seedUser(deps, { email: 'admin@example.com', role: 'admin' })).user;
    sid = seedSession({ db: testDb.db, clock, config: testConfig() }, { ownerId: owner.id }).id;
    access.addMember(ctx(owner), sid, { email: operator.email, role: 'operator' });
    access.addMember(ctx(owner), sid, { email: viewer.email, role: 'viewer' });
    events.length = 0;
  });

  afterEach(() => testDb.close());

  const adminAccessRows = () =>
    testDb.db
      .select()
      .from(auditEvents)
      .all()
      .filter((row) => row.kind === 'admin.session_access');

  function codeOf(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (error) {
      return error instanceof HydraError ? error.code : 'other';
    }
  }

  describe('view and can', () => {
    it('returns the owner and the member role', () => {
      expect(access.view(viewer.id, sid)).toEqual({
        id: sid,
        ownerId: owner.id,
        memberRole: 'viewer',
      });
      expect(access.view(stranger.id, sid)).toEqual({
        id: sid,
        ownerId: owner.id,
        memberRole: null,
      });
      expect(access.view(owner.id, 'nosuchsession')).toBeNull();
    });

    it('treats a deleted session as missing', () => {
      const deleted = seedSession(
        { db: testDb.db, clock, config: testConfig() },
        { ownerId: owner.id, state: 'deleted' },
      );
      expect(access.view(owner.id, deleted.id)).toBeNull();
      expect(access.can(owner.id, deleted.id, 'session.read')).toBe(false);
    });

    it('checks the current user row', async () => {
      expect(access.can(operator.id, sid, 'token.create')).toBe(true);
      expect(access.can(viewer.id, sid, 'token.create')).toBe(false);
      expect(access.can('nobody', sid, 'session.read')).toBe(false);
      const disabled = await seedUser(
        { db: testDb.db, clock, hasher: plainHasher },
        { status: 'disabled' },
      );
      access.addMember(ctx(owner), sid, { email: disabled.user.email, role: 'operator' });
      expect(access.can(disabled.user.id, sid, 'session.read')).toBe(false);
    });
  });

  describe('requireSession', () => {
    it('returns 404 for a user without session.read, also for a missing session', () => {
      expect(codeOf(() => access.requireSession(ctx(stranger), sid, 'session.read', START))).toBe(
        'not_found',
      );
      expect(codeOf(() => access.requireSession(ctx(stranger), sid, 'session.delete', START))).toBe(
        'not_found',
      );
      expect(
        codeOf(() => access.requireSession(ctx(owner), 'nosuchsession', 'session.read', START)),
      ).toBe('not_found');
    });

    it('returns 403 for a user who can see the session but has no right', () => {
      expect(codeOf(() => access.requireSession(ctx(viewer), sid, 'audit.read', START))).toBe(
        'forbidden',
      );
      expect(codeOf(() => access.requireSession(ctx(operator), sid, 'session.share', START))).toBe(
        'forbidden',
      );
    });

    it('returns 404 for a disabled owner', () => {
      const disabledOwner = { ...owner, status: 'disabled' as const };
      expect(
        codeOf(() => access.requireSession(ctx(disabledOwner), sid, 'session.read', START)),
      ).toBe('not_found');
    });

    it('returns the view when the right exists', () => {
      expect(access.requireSession(ctx(operator), sid, 'audit.read', START).memberRole).toBe(
        'operator',
      );
      expect(adminAccessRows()).toHaveLength(0);
    });

    it('writes admin.session_access when the right comes only from the admin role', () => {
      access.requireSession(ctx(admin), sid, 'session.lifecycle', START);
      const rows = adminAccessRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'user',
        actorId: admin.id,
        sessionId: sid,
        data: { action: 'session.lifecycle', method: 'POST', path: '/api/sessions/:sid/start' },
      });
    });

    it('does not write it for the exempt reads, with a pattern or a real path', () => {
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: '/api/sessions/:sid',
      });
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: `/api/sessions/${sid}/members`,
      });
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: '/api/sessions',
      });
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: '/api/events',
      });
      expect(adminAccessRows()).toHaveLength(0);
      access.requireSession(ctx(admin), sid, 'audit.read', {
        method: 'GET',
        path: '/api/sessions/:sid/audit',
      });
      expect(adminAccessRows()).toHaveLength(1);
    });

    it('does not write it when an admin member uses a right of the member role', () => {
      access.addMember(ctx(owner), sid, { email: admin.email, role: 'operator' });
      access.requireSession(ctx(admin), sid, 'audit.read', START);
      expect(adminAccessRows()).toHaveLength(0);
      access.requireSession(ctx(admin), sid, 'session.share', START);
      expect(adminAccessRows()).toHaveLength(1);
    });
  });

  describe('listReadable', () => {
    it('lists owned and shared sessions, not deleted ones, and all sessions for admins', () => {
      const config = testConfig();
      clock.advance(1_000); // a later createdAt than `sid`; equal values are ordered by id
      const other = seedSession({ db: testDb.db, clock, config }, { ownerId: stranger.id });
      seedSession({ db: testDb.db, clock, config }, { ownerId: viewer.id, state: 'deleted' });
      expect(access.listReadable(viewer, { all: false })).toEqual([sid]);
      expect(access.listReadable(stranger, { all: true })).toEqual([other.id]);
      expect(access.listReadable(admin, { all: false })).toEqual([]);
      expect(access.listReadable(admin, { all: true })).toEqual([sid, other.id]);
      expect(access.listReadable({ ...viewer, status: 'disabled' }, { all: false })).toEqual([]);
    });

    it('orders sessions with the same createdAt by id', () => {
      const seeds = { db: testDb.db, clock, config: testConfig() };
      // The clock does not advance, so every session below has the createdAt of `sid`.
      const ownedByStranger = [1, 2, 3].map(() => seedSession(seeds, { ownerId: stranger.id }).id);
      const ownedByViewer = [1, 2, 3].map(() => seedSession(seeds, { ownerId: viewer.id }).id);
      for (const shared of ownedByStranger.slice(0, 2)) {
        access.addMember(ctx(stranger), shared, { email: viewer.email, role: 'viewer' });
      }
      const byId = (ids: string[]): string[] => [...ids].sort((a, b) => (a < b ? -1 : 1));
      expect(access.listReadable(admin, { all: true })).toEqual(
        byId([sid, ...ownedByStranger, ...ownedByViewer]),
      );
      expect(access.listReadable(viewer, { all: false })).toEqual(
        byId([sid, ...ownedByStranger.slice(0, 2), ...ownedByViewer]),
      );
    });
  });

  describe('members', () => {
    it('lists the owner and the members', () => {
      expect(access.members(sid)).toEqual({
        owner: {
          userId: owner.id,
          email: owner.email,
          displayName: owner.displayName,
          role: 'owner',
        },
        members: [
          {
            userId: operator.id,
            email: operator.email,
            displayName: operator.displayName,
            role: 'operator',
          },
          {
            userId: viewer.id,
            email: viewer.email,
            displayName: viewer.displayName,
            role: 'viewer',
          },
        ],
      });
    });

    it('adds a member by email in any case and publishes rights.changed', () => {
      const member = access.addMember(ctx(owner), sid, {
        email: ' STRANGER@example.com ',
        role: 'viewer',
      });
      expect(member).toEqual({
        userId: stranger.id,
        email: stranger.email,
        displayName: stranger.displayName,
        role: 'viewer',
      });
      expect(events).toEqual([{ type: 'rights.changed', userId: stranger.id }]);
    });

    it('rejects an unknown email, the owner, and an existing member', () => {
      expect(
        codeOf(() =>
          access.addMember(ctx(owner), sid, { email: 'ghost@example.com', role: 'viewer' }),
        ),
      ).toBe('not_found');
      expect(
        codeOf(() => access.addMember(ctx(owner), sid, { email: owner.email, role: 'viewer' })),
      ).toBe('conflict');
      expect(
        codeOf(() => access.addMember(ctx(owner), sid, { email: viewer.email, role: 'operator' })),
      ).toBe('conflict');
      expect(events).toEqual([]);
    });

    it('changes a member role and publishes rights.changed', () => {
      const member = access.updateMember(ctx(owner), sid, operator.id, 'viewer');
      expect(member.role).toBe('viewer');
      expect(access.view(operator.id, sid)?.memberRole).toBe('viewer');
      expect(events).toEqual([{ type: 'rights.changed', userId: operator.id }]);
      access.updateMember(ctx(owner), sid, operator.id, 'viewer');
      expect(events).toHaveLength(1);
    });

    it('removes a member and publishes rights.changed', () => {
      access.removeMember(ctx(owner), sid, viewer.id);
      expect(access.view(viewer.id, sid)?.memberRole).toBeNull();
      expect(events).toEqual([{ type: 'rights.changed', userId: viewer.id }]);
      const kinds = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .map((row) => row.kind);
      expect(kinds).toContain('session.unshared');
    });

    it('does not change or remove the owner, or a user who is not a member', () => {
      expect(codeOf(() => access.updateMember(ctx(owner), sid, owner.id, 'viewer'))).toBe(
        'conflict',
      );
      expect(codeOf(() => access.removeMember(ctx(owner), sid, owner.id))).toBe('conflict');
      expect(codeOf(() => access.updateMember(ctx(owner), sid, stranger.id, 'viewer'))).toBe(
        'not_found',
      );
      expect(codeOf(() => access.removeMember(ctx(owner), sid, stranger.id))).toBe('not_found');
      expect(events).toEqual([]);
    });
  });
});
