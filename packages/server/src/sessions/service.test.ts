import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../app.js';
import type { LoginContext } from '../auth/index.js';
import { agentTokens, auditEvents, sessions } from '../db/schema.js';
import { HydraError } from '../lib/errors.js';
import { createTestApp } from '../../test/helpers/app.js';
import type { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { FakeKubeClient } from '../../test/helpers/fake-kube.js';
import { seedUser } from '../../test/helpers/seed.js';

let kube: FakeKubeClient;
let deps: AppDeps;
let clock: FakeClock;
let close: () => Promise<void>;
let owner: LoginContext;

beforeEach(async () => {
  kube = new FakeKubeClient();
  const config = testConfig({ maxRunning: 2, mediaPortRange: { first: 52000, last: 52002 } });
  const testApp = await createTestApp({ kube, config });
  ({ deps, clock } = testApp);
  close = () => testApp.close();
  owner = { user: (await seedUser(deps)).user, loginSessionId: 'login-owner' };
});

afterEach(async () => {
  await close();
});

const rowOf = (sid: string) => deps.db.select().from(sessions).where(eq(sessions.id, sid)).get()!;
const create = (start = true, name = 'Research') =>
  deps.sessions.create(owner, { name, allowlist: ['example.com'], start });
const auditKinds = (sid: string) =>
  deps.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.sessionId, sid))
    .all()
    .map((event) => event.kind);
/** What the reconciler does when the pod is gone (rule 7). */
const releasePort = (sid: string, state: 'stopped' | 'error' = 'stopped') =>
  deps.db
    .update(sessions)
    .set({ state, desiredState: 'stopped', mediaPort: null })
    .where(eq(sessions.id, sid))
    .run();
const setState = (sid: string, state: 'starting' | 'running' | 'stopping' | 'error' | 'deleting') =>
  deps.db.update(sessions).set({ state }).where(eq(sessions.id, sid)).run();

function expectHydraError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HydraError);
    expect((error as HydraError).code).toBe(code);
    return;
  }
  throw new Error(`expected HydraError ${code}`);
}

describe('SessionsService.create', () => {
  it('inserts the row with the defaults and continues as Start', () => {
    const resource = create();
    expect(resource).toMatchObject({
      name: 'Research',
      owner: { id: owner.user.id, email: owner.user.email, displayName: owner.user.displayName },
      myRole: 'owner',
      state: 'stopped',
      errorReason: null,
      settings: {
        allowlist: ['example.com'],
        timezone: 'UTC',
        language: 'en-US',
        screen: '1920x1080',
      },
      restartRequired: false,
      agentActivity: { activeAgentCount: 0, lastToolCall: null },
    });
    expect(resource.id).toMatch(/^[a-z2-7]{12}$/);
    expect(resource.rights).toContain('session.delete');
    expect(rowOf(resource.id)).toMatchObject({
      desiredState: 'running',
      mediaPort: 52000,
      startedAt: clock.now(),
      readyAt: null,
      appliedSettings: {
        allowlist: ['example.com'],
        timezone: 'UTC',
        language: 'en-US',
        screen: '1920x1080',
      },
    });
    expect(auditKinds(resource.id)).toEqual(['session.created', 'session.started']);
  });

  it('does not start when start is false', () => {
    const resource = create(false);
    expect(rowOf(resource.id)).toMatchObject({
      desiredState: 'stopped',
      state: 'stopped',
      mediaPort: null,
      startedAt: null,
    });
    expect(auditKinds(resource.id)).toEqual(['session.created']);
  });
});

describe('capacity check and media port allocation', () => {
  it('assigns the lowest free port', () => {
    const a = create().id;
    const b = create().id;
    expect([rowOf(a).mediaPort, rowOf(b).mediaPort]).toEqual([52000, 52001]);
    deps.sessions.stop(owner, a);
    releasePort(a);
    const c = create().id;
    expect(rowOf(c).mediaPort).toBe(52000);
  });

  it('rejects a start when HYDRA_MAX_RUNNING sessions hold a media port', () => {
    create();
    create();
    const stopped = create(false).id;
    expectHydraError(() => deps.sessions.start(owner, stopped), 'capacity_reached');
    expect(rowOf(stopped)).toMatchObject({ desiredState: 'stopped', mediaPort: null });
  });

  it('creates nothing when Create cannot start', () => {
    create();
    create();
    const before = deps.db.select().from(sessions).all().length;
    expectHydraError(() => create(true, 'Third'), 'capacity_reached');
    expect(deps.db.select().from(sessions).all()).toHaveLength(before);
  });

  it('counts a session that still holds its port while it stops or after an error', () => {
    const a = create().id;
    create();
    deps.sessions.stop(owner, a);
    setState(a, 'stopping');
    const c = create(false).id;
    expectHydraError(() => deps.sessions.start(owner, c), 'capacity_reached');
    releasePort(a);
    expect(deps.sessions.start(owner, c).id).toBe(c);
    expect(rowOf(c).mediaPort).toBe(52000);
  });

  it('keeps the held port when an error session starts again', () => {
    const a = create().id;
    deps.db
      .update(sessions)
      .set({ state: 'error', desiredState: 'stopped', errorReason: 'CrashLoopBackOff: x' })
      .where(eq(sessions.id, a))
      .run();
    create();
    clock.advance(1_000);
    deps.sessions.start(owner, a);
    expect(rowOf(a)).toMatchObject({
      mediaPort: 52000,
      desiredState: 'running',
      errorReason: null,
      startedAt: clock.now(),
    });
  });
});

describe('SessionsService actions', () => {
  it('Start does nothing for a session that starts or runs, and rejects other states', () => {
    const sid = create().id;
    setState(sid, 'running');
    deps.sessions.start(owner, sid);
    expect(auditKinds(sid)).toEqual(['session.created', 'session.started']);
    setState(sid, 'stopping');
    expectHydraError(() => deps.sessions.start(owner, sid), 'invalid_state');
  });

  it('Stop sets desired_state stopped once, and rejects a deleting session', () => {
    const sid = create().id;
    deps.sessions.stop(owner, sid);
    deps.sessions.stop(owner, sid);
    expect(rowOf(sid).desiredState).toBe('stopped');
    expect(auditKinds(sid)).toEqual(['session.created', 'session.started', 'session.stopped']);
    setState(sid, 'deleting');
    expectHydraError(() => deps.sessions.stop(owner, sid), 'invalid_state');
  });

  it('Restart copies the settings, sets a new started_at, and keeps the port', () => {
    const sid = create().id;
    setState(sid, 'running');
    deps.db.update(sessions).set({ readyAt: clock.now() }).where(eq(sessions.id, sid)).run();
    deps.sessions.update(owner, sid, { allowlist: ['other.example.com'] });
    expect(deps.sessions.get(owner, sid).restartRequired).toBe(true);
    clock.advance(5_000);
    const resource = deps.sessions.restart(owner, sid);
    expect(resource.restartRequired).toBe(false);
    expect(rowOf(sid)).toMatchObject({
      mediaPort: 52000,
      startedAt: clock.now(),
      readyAt: null,
      appliedSettings: { allowlist: ['other.example.com'] },
    });
    expect(auditKinds(sid)).toContain('session.restarted');
  });

  it('Restart is only for a session that starts or runs', () => {
    const sid = create(false).id;
    expectHydraError(() => deps.sessions.restart(owner, sid), 'invalid_state');
  });

  it('Update writes the changed fields and the audit event session.updated', () => {
    const sid = create(false).id;
    const resource = deps.sessions.update(owner, sid, {
      name: 'Renamed',
      screen: '1280x720',
      timezone: 'UTC',
    });
    expect(resource).toMatchObject({ name: 'Renamed', settings: { screen: '1280x720' } });
    const updated = deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'session.updated'))
      .all();
    expect(updated.map((event) => event.data)).toEqual([
      { changes: { name: 'Renamed', screen: '1280x720' } },
    ]);
  });

  it('Delete needs the exact name, revokes the tokens, and sets desired_state deleted', () => {
    const sid = create().id;
    const { token } = deps.tokens.create(owner, sid, { name: 'agent', expiresInDays: 30 });
    expectHydraError(() => deps.sessions.remove(owner, sid, 'research'), 'confirm_mismatch');
    expect(rowOf(sid).desiredState).toBe('running');
    deps.sessions.remove(owner, sid, 'Research');
    expect(rowOf(sid).desiredState).toBe('deleted');
    expect(deps.tokens.isValid(token.id)).toBe(false);
    expect(auditKinds(sid)).toContain('session.deleted');
  });

  it.each([
    ['running', true],
    ['stopped', false],
  ] as const)(
    'rejects Stop, Start, Restart and Update of a deleting session (state %s)',
    (state, started) => {
      const sid = create(started).id;
      if (state === 'running') setState(sid, state);
      deps.sessions.remove(owner, sid, 'Research');
      expect(rowOf(sid)).toMatchObject({ state, desiredState: 'deleted' });
      expectHydraError(() => deps.sessions.stop(owner, sid), 'invalid_state');
      expectHydraError(() => deps.sessions.start(owner, sid), 'invalid_state');
      expectHydraError(() => deps.sessions.restart(owner, sid), 'invalid_state');
      expectHydraError(
        () => deps.sessions.update(owner, sid, { name: 'Renamed' }),
        'invalid_state',
      );
      expect(rowOf(sid)).toMatchObject({ state, desiredState: 'deleted', name: 'Research' });
      expect(auditKinds(sid)).not.toContain('session.stopped');
    },
  );

  it('revokes the tokens again when Delete is repeated', () => {
    const sid = create().id;
    const { token } = deps.tokens.create(owner, sid, { name: 'early', expiresInDays: 30 });
    deps.sessions.remove(owner, sid, 'Research');
    expect(deps.tokens.isValid(token.id)).toBe(false);
    // A token that is not revoked after the first Delete (the DB has it): the repeat revokes it.
    deps.db
      .insert(agentTokens)
      .values({
        id: 'tok-late',
        sessionId: sid,
        createdBy: owner.user.id,
        name: 'late',
        tokenHmac: Buffer.alloc(32, 7),
        prefix: 'hyd_late…',
        createdAt: clock.now(),
        expiresAt: clock.now() + 30 * 24 * 60 * 60 * 1000,
        lastUsedAt: null,
        lastUsedIp: null,
        revokedAt: null,
        revokedBy: null,
      })
      .run();
    deps.sessions.remove(owner, sid, 'Research');
    const late = deps.db.select().from(agentTokens).where(eq(agentTokens.id, 'tok-late')).get();
    expect(late?.revokedAt).toBe(clock.now());
    expect(auditKinds(sid).filter((kind) => kind === 'session.deleted')).toHaveLength(1);
  });

  it('refuses a new token on a session with a pending Delete', () => {
    const sid = create().id;
    deps.sessions.remove(owner, sid, 'Research');
    expectHydraError(
      () => deps.tokens.create(owner, sid, { name: 'late', expiresInDays: 30 }),
      'invalid_state',
    );
  });

  it('reads the last 50 log lines of a container', async () => {
    const sid = create().id;
    const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    kube.setLog(`session-${sid}-0`, 'mcp', `${text}\n`);
    const logs = await deps.sessions.logs(owner, sid, 'mcp');
    expect(logs.container).toBe('mcp');
    expect(logs.lines).toHaveLength(50);
    expect(logs.lines[0]).toBe('line 11');
    expect(logs.lines[49]).toBe('line 60');
    await expect(deps.sessions.logs(owner, sid, 'neko')).resolves.toEqual({
      container: 'neko',
      lines: [],
    });
  });
});

describe('rights and the session resource', () => {
  it('gives a viewer the viewer rights and no lifecycle action', async () => {
    const sid = create().id;
    const viewer = await seedUser(deps);
    deps.access.addMember(owner, sid, { email: viewer.user.email, role: 'viewer' });
    const context = { user: viewer.user, loginSessionId: 'login-viewer' };
    expect(deps.sessions.get(context, sid)).toMatchObject({
      myRole: 'viewer',
      rights: ['session.read', 'live.watch', 'vault.read'],
    });
    expectHydraError(() => deps.sessions.stop(context, sid), 'forbidden');
    await expect(deps.sessions.logs(context, sid, 'neko')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('hides a session from a user without access', async () => {
    const sid = create().id;
    const stranger = { user: (await seedUser(deps)).user, loginSessionId: 'login-stranger' };
    expectHydraError(() => deps.sessions.get(stranger, sid), 'not_found');
    expectHydraError(() => deps.sessions.remove(stranger, sid, 'Research'), 'not_found');
    expect(deps.sessions.list(stranger, { all: true })).toEqual([]);
  });

  it('lists own and shared sessions, and all sessions for an admin with all', async () => {
    const other = { user: (await seedUser(deps)).user, loginSessionId: 'login-other' };
    const own = create(false, 'Own').id;
    clock.advance(1_000);
    const shared = deps.sessions.create(other, {
      name: 'Shared',
      allowlist: ['*'],
      start: false,
    }).id;
    clock.advance(1_000);
    const hidden = deps.sessions.create(other, {
      name: 'Hidden',
      allowlist: ['*'],
      start: false,
    }).id;
    deps.access.addMember(other, shared, { email: owner.user.email, role: 'operator' });
    expect(deps.sessions.list(owner, { all: true }).map((s) => s.id)).toEqual([own, shared]);

    const admin = {
      user: (await seedUser(deps, { role: 'admin' })).user,
      loginSessionId: 'login-admin',
    };
    expect(deps.sessions.list(admin, { all: false })).toEqual([]);
    const all = deps.sessions.list(admin, { all: true });
    expect(all.map((s) => s.id)).toEqual([own, shared, hidden]);
    expect(all[0]?.myRole).toBe('admin');
  });

  it('checks session.read for events also after the delete', async () => {
    const sid = create().id;
    const stranger = (await seedUser(deps)).user;
    deps.sessions.remove(owner, sid, 'Research');
    deps.db
      .update(sessions)
      .set({ state: 'deleted', deletedAt: clock.now() })
      .where(eq(sessions.id, sid))
      .run();
    expect(deps.sessions.readableBy(owner.user, sid)).toBe(true);
    expect(deps.sessions.readableBy(stranger, sid)).toBe(false);
    expect(deps.sessions.readableBy(owner.user, 'nosuchsessio')).toBe(false);
  });
});
