import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../app.js';
import { newSid } from '../crypto/index.js';
import { auditEvents, sessions } from '../db/schema.js';
import type { HydraEvent } from '../events/index.js';
import { createTestApp } from '../../test/helpers/app.js';
import type { FakeClock } from '../../test/helpers/clock.js';
import { FakeKubeClient } from '../../test/helpers/fake-kube.js';
import { seedUser } from '../../test/helpers/seed.js';
import { buildSessionObjects } from './manifests/index.js';
import { backoffDelayMs, BACKOFF_MAX_MS, Reconciler, RECONCILE_INTERVAL_MS } from './reconciler.js';
import { START_TIMEOUT_MS } from './state-rules.js';
import type { KubeObject } from './types.js';

let kube: FakeKubeClient;
let deps: AppDeps;
let clock: FakeClock;
let close: () => Promise<void>;
let ownerId: string;
let reconciler: Reconciler;

beforeEach(async () => {
  kube = new FakeKubeClient();
  const testApp = await createTestApp();
  ({ deps, clock } = testApp);
  ownerId = (await seedUser(deps)).user.id;
  reconciler = new Reconciler({ ...deps, kube });
  close = async () => {
    await reconciler.stop();
    await testApp.close();
  };
});

afterEach(async () => {
  vi.useRealTimers();
  await close();
});

type SessionInsert = typeof sessions.$inferInsert;

/** A session row as Start leaves it (spec section 7.9), with field overrides. */
function insertSession(fields: Partial<SessionInsert> = {}): string {
  const now = clock.now();
  const id = fields.id ?? newSid();
  const settings = {
    allowlist: ['example.com'],
    timezone: 'UTC',
    language: 'en-US',
    screen: '1920x1080' as const,
  };
  deps.db
    .insert(sessions)
    .values({
      id,
      name: 'Research',
      ownerId,
      desiredState: 'running',
      state: 'stopped',
      errorReason: null,
      mediaPort: 52000,
      allowlist: settings.allowlist,
      timezone: settings.timezone,
      language: settings.language,
      screen: settings.screen,
      appliedSettings: settings,
      startedAt: now,
      readyAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...fields,
    })
    .run();
  return id;
}

const rowOf = (sid: string) => deps.db.select().from(sessions).where(eq(sessions.id, sid)).get()!;
const update = (sid: string, fields: Partial<SessionInsert>) =>
  deps.db.update(sessions).set(fields).where(eq(sessions.id, sid)).run();
const pass = (sid: string) => reconciler.reconcileSession(sid);
const replicasOf = (sid: string) =>
  (kube.object('StatefulSet', `session-${sid}`) as KubeObject & { spec: { replicas: number } }).spec
    .replicas;

function objectKeys(sid: string, withMedia: boolean): string[] {
  return [
    `ConfigMap/chromium-${sid}`,
    `PersistentVolumeClaim/profile-${sid}`,
    `Secret/neko-${sid}`,
    ...(withMedia ? [`Service/media-${sid}`] : []),
    `Service/session-${sid}`,
    `StatefulSet/session-${sid}`,
  ];
}

describe('backoffDelayMs', () => {
  it('doubles from 1 s up to 5 min', () => {
    expect([1, 2, 3, 4, 9, 10, 30].map(backoffDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 256000, 300000, 300000,
    ]);
    expect(BACKOFF_MAX_MS).toBe(300000);
  });
});

describe('Reconciler.reconcileSession', () => {
  it('creates the objects of a started session and reaches running when the pod is Ready', async () => {
    const sid = insertSession();
    await pass(sid);
    expect(kube.objectsOf(sid)).toEqual(objectKeys(sid, true));
    expect(replicasOf(sid)).toBe(1);
    expect(rowOf(sid).state).toBe('starting');

    clock.advance(5_000);
    kube.setPodReady(sid, true);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'running', readyAt: clock.now() });
  });

  it('creates objects with 0 replicas and no media Service for a stopped session', async () => {
    const sid = insertSession({ desiredState: 'stopped', mediaPort: null, startedAt: null });
    await pass(sid);
    expect(kube.objectsOf(sid)).toEqual(objectKeys(sid, false));
    expect(replicasOf(sid)).toBe(0);
    expect(rowOf(sid).state).toBe('stopped');
  });

  it('writes the audit event session.state and publishes session.state for each change', async () => {
    const events: HydraEvent[] = [];
    deps.bus.subscribe('session.state', (event) => events.push(event));
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    await pass(sid);
    expect(events).toEqual([
      {
        type: 'session.state',
        sessionId: sid,
        state: 'starting',
        previous: 'stopped',
        errorReason: null,
      },
      {
        type: 'session.state',
        sessionId: sid,
        state: 'running',
        previous: 'starting',
        errorReason: null,
      },
    ]);
    const audits = deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'session.state'))
      .all();
    expect(audits.map((a) => [a.actorType, a.actorId, a.sessionId, a.data])).toEqual([
      ['system', null, sid, { state: 'starting', previous: 'stopped', errorReason: null }],
      ['system', null, sid, { state: 'running', previous: 'starting', errorReason: null }],
    ]);
  });

  it('repairs a missing object and a changed object', async () => {
    const sid = insertSession();
    await pass(sid);
    await kube.remove('ConfigMap', `chromium-${sid}`);
    const changed = kube.object('StatefulSet', `session-${sid}`) as KubeObject & {
      spec: { replicas: number };
    };
    changed.spec.replicas = 3;
    await kube.apply(changed);
    await pass(sid);
    expect(kube.object('ConfigMap', `chromium-${sid}`)).toBeDefined();
    expect(replicasOf(sid)).toBe(1);
  });

  it('deletes the media Service while media_port is null', async () => {
    const sid = insertSession({ desiredState: 'stopped', mediaPort: null, startedAt: null });
    const withPort = { ...rowOf(sid), mediaPort: 52009 };
    for (const object of buildSessionObjects(withPort, deps)) await kube.apply(object);
    await pass(sid);
    expect(kube.object('Service', `media-${sid}`)).toBeUndefined();
  });

  it('goes to error for a container wait reason, keeps it, and releases the port when the pod is gone', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setContainerWaiting(sid, 'ImagePullBackOff', 'Back-off pulling image "x"');
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({
      state: 'error',
      errorReason: 'ImagePullBackOff: Back-off pulling image "x"',
      desiredState: 'stopped',
      mediaPort: 52000,
    });

    // Rule 6 does not apply to error (spec section 7.9): the state and error_reason stay.
    await pass(sid);
    expect(replicasOf(sid)).toBe(0);
    expect(rowOf(sid)).toMatchObject({
      state: 'error',
      errorReason: 'ImagePullBackOff: Back-off pulling image "x"',
    });

    kube.removePod(sid);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({
      state: 'error',
      errorReason: 'ImagePullBackOff: Back-off pulling image "x"',
      mediaPort: null,
    });
    expect(kube.object('Service', `media-${sid}`)).toBeUndefined();
    const states = deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.kind, 'session.state'))
      .all()
      .map((event) => event.data['state']);
    expect(states).toEqual(['starting', 'error']);
  });

  it('goes to error 120 s after the start while the pod is not Ready', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, false);
    clock.advance(START_TIMEOUT_MS);
    await pass(sid);
    expect(rowOf(sid).state).toBe('starting');
    clock.advance(1);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({
      state: 'error',
      desiredState: 'stopped',
      errorReason:
        'Timeout: the pod was not Ready 120 s after the start (ContainersNotReady: containers with unready status: [neko])',
    });
  });

  it('does not use the 120 s rule after the pod was Ready', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    kube.setPodReady(sid, false);
    clock.advance(START_TIMEOUT_MS * 2);
    await pass(sid);
    expect(rowOf(sid).state).toBe('starting');
  });

  it('stops: stopping while the pod exists, then stopped, and the media Service goes first', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    update(sid, { desiredState: 'stopped' });
    await pass(sid);
    expect(rowOf(sid).state).toBe('stopping');
    expect(replicasOf(sid)).toBe(0);

    kube.removePod(sid);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'stopped', mediaPort: null });
    expect(kube.object('Service', `media-${sid}`)).toBeUndefined();
  });

  it('keeps media_port when the media Service cannot be deleted', async () => {
    const sid = insertSession();
    await pass(sid);
    update(sid, { desiredState: 'stopped' });
    const realRemove = kube.remove.bind(kube);
    vi.spyOn(kube, 'remove').mockImplementation((kind, name) =>
      name === `media-${sid}`
        ? Promise.reject(new Error('API server unavailable'))
        : realRemove(kind, name),
    );
    await expect(pass(sid)).rejects.toThrow('API server unavailable');
    expect(rowOf(sid).mediaPort).toBe(52000);
  });

  it('deletes: deleting while objects remain, deleted when all are gone', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    update(sid, { desiredState: 'deleted' });
    await pass(sid);
    expect(rowOf(sid).state).toBe('deleting');
    expect(kube.objectsOf(sid)).toEqual([`Pod/session-${sid}-0`]);

    kube.removePod(sid);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'deleted', deletedAt: clock.now(), mediaPort: null });
  });

  it('does not count the old pod as Ready after a restart', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    clock.advance(1_000);
    update(sid, { startedAt: clock.now(), readyAt: null });
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'starting', readyAt: null });

    kube.removePod(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'running', readyAt: clock.now() });
  });

  it('uses the 120 s rule for the new pod after a restart', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    clock.advance(1_000);
    update(sid, { startedAt: clock.now(), readyAt: null });
    await pass(sid);
    clock.advance(START_TIMEOUT_MS + 1);
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({ state: 'error', desiredState: 'stopped' });
    expect(rowOf(sid).errorReason).toMatch(/^Timeout: the pod was not Ready 120 s after the start/);
  });

  it('does not write a decision when the row changed during the pass', async () => {
    const sid = insertSession();
    await pass(sid);
    clock.advance(START_TIMEOUT_MS + 1);
    const realGet = kube.get.bind(kube);
    vi.spyOn(kube, 'get').mockImplementation(async (kind, name) => {
      const result = await realGet(kind, name);
      // A Restart arrives while the pass waits for Kubernetes.
      if (kind === 'Pod') update(sid, { startedAt: clock.now() });
      return result;
    });
    await pass(sid);
    expect(rowOf(sid)).toMatchObject({
      state: 'starting',
      desiredState: 'running',
      errorReason: null,
    });
  });

  it('scales an orphan StatefulSet to 0 and deletes its media Service, but keeps the PVC and the Secret', async () => {
    const warn = vi.spyOn(deps.logger, 'warn');
    const orphan = { ...rowOf(insertSession()), id: 'orphanorphan' };
    for (const object of buildSessionObjects(orphan, deps)) await kube.apply(object);
    await pass(orphan.id);
    expect(replicasOf(orphan.id)).toBe(0);
    expect(kube.object('Service', 'media-orphanorphan')).toBeUndefined();
    expect(kube.object('PersistentVolumeClaim', 'profile-orphanorphan')).toBeDefined();
    expect(kube.object('Secret', 'neko-orphanorphan')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      { sessionId: 'orphanorphan' },
      expect.stringContaining('orphan'),
    );
  });
});

describe('Reconciler scheduling', () => {
  it('start() runs the first pass over all sessions and the orphans', async () => {
    const sid = insertSession();
    const orphan = { ...rowOf(sid), id: 'orphanorphan' };
    for (const object of buildSessionObjects(orphan, deps)) await kube.apply(object);
    await reconciler.start();
    expect(kube.objectsOf(sid)).toEqual(objectKeys(sid, true));
    expect(replicasOf('orphanorphan')).toBe(0);
  });

  it('runs a pass after trigger() and after a watch event', async () => {
    await reconciler.start();
    const sid = insertSession();
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(rowOf(sid).state).toBe('starting');
    kube.setPodReady(sid, true);
    await reconciler.idle();
    expect(rowOf(sid).state).toBe('running');
  });

  it('does nothing on trigger() before start()', async () => {
    const sid = insertSession();
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(kube.objectsOf(sid)).toEqual([]);
  });

  it('backs off after a failed pass and logs the error', async () => {
    const error = vi.spyOn(deps.logger, 'error');
    await reconciler.start();
    const sid = insertSession();
    kube.failNext('apply');
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(reconciler.backoff(sid)).toEqual({ failures: 1, retryAt: clock.now() + 1000 });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: sid, retryInMs: 1000 }),
      'reconcile failed',
    );
    expect(kube.objectsOf(sid)).toEqual([]);

    // A watch event does not run a pass during the backoff.
    kube.setPodReady(sid, false);
    await reconciler.idle();
    expect(kube.objectsOf(sid)).toEqual([`Pod/session-${sid}-0`]);

    // An API action runs a pass at once. A second failure doubles the delay.
    kube.failNext('apply');
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(reconciler.backoff(sid)).toEqual({ failures: 2, retryAt: clock.now() + 2000 });

    // A good pass ends the backoff.
    reconciler.trigger(sid);
    await reconciler.idle();
    expect(reconciler.backoff(sid)).toBeNull();
    expect(kube.objectsOf(sid)).toEqual([...objectKeys(sid, true), `Pod/session-${sid}-0`].sort());
  });

  it('runs a pass every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sid = insertSession({ desiredState: 'stopped', mediaPort: null, startedAt: null });
    await reconciler.start();
    const spy = vi.spyOn(reconciler, 'reconcileSession');
    vi.advanceTimersByTime(RECONCILE_INTERVAL_MS - 1);
    await reconciler.idle();
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await reconciler.idle();
    expect(spy).toHaveBeenCalledWith(sid);
  });

  it('never removes a pod, not even for a deleted session or an orphan', async () => {
    const sid = insertSession();
    await pass(sid);
    kube.setPodReady(sid, true);
    await pass(sid);
    update(sid, { desiredState: 'deleted' });
    await pass(sid);
    const orphan = { ...rowOf(sid), id: 'orphanorphan' };
    for (const object of buildSessionObjects(orphan, deps)) await kube.apply(object);
    kube.setPodReady('orphanorphan', true);
    await reconciler.start();
    expect(kube.object('Pod', `session-${sid}-0`)).toBeDefined();
    expect(kube.object('Pod', 'session-orphanorphan-0')).toBeDefined();
    expect(kube.calls.filter((call) => call.op === 'remove' && call.kind === 'Pod')).toEqual([]);
  });

  it('ignores the hydra-port-check Service, which has no session label', async () => {
    const warn = vi.spyOn(deps.logger, 'warn');
    const portCheck = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'hydra-port-check-52000',
        namespace: 'hydra-sessions',
        labels: { 'app.kubernetes.io/managed-by': 'hydra' },
      },
      spec: { type: 'NodePort' },
    } as KubeObject;
    await kube.apply(portCheck);
    await reconciler.start();
    // The Service is in the store: the orphan pass lists it and skips it (no session label).
    const before = kube.calls.length;
    // A watch event for the Service: it names no session, so no pass runs.
    await kube.apply({
      ...portCheck,
      spec: { type: 'NodePort', ports: [{ port: 80 }] },
    } as KubeObject);
    await reconciler.idle();
    expect(kube.object('Service', 'hydra-port-check-52000')).toBeDefined();
    expect(kube.calls.slice(before)).toEqual([
      { op: 'apply', kind: 'Service', name: 'hydra-port-check-52000' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Reconciler.stop and the interval', () => {
  it('stop() during the first pass leaves no interval and no watch behind', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realList = kube.list.bind(kube);
    vi.spyOn(kube, 'list').mockImplementation(async (kind, labelSelector) => {
      await gate;
      return realList(kind, labelSelector);
    });
    const watch = vi.spyOn(kube, 'watch');
    const starting = reconciler.start();
    const stopping = reconciler.stop();
    release();
    await Promise.all([starting, stopping]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RECONCILE_INTERVAL_MS * 2);
    await reconciler.idle();
    expect(watch).not.toHaveBeenCalled();
  });

  it('a pass that fails after stop() leaves no retry timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    await reconciler.start();
    const sid = insertSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = vi.spyOn(kube, 'apply').mockImplementation(async () => {
      await gate;
      throw new Error('API server unavailable');
    });
    reconciler.trigger(sid);
    const stopping = reconciler.stop();
    release();
    await stopping;
    expect(reconciler.backoff(sid)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(BACKOFF_MAX_MS);
    await reconciler.idle();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('an interval tick whose database read fails logs the error and does not throw', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await reconciler.start();
    const error = vi.spyOn(deps.logger, 'error');
    const select = vi.spyOn(deps.db, 'select').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect(() => vi.advanceTimersByTime(RECONCILE_INTERVAL_MS)).not.toThrow();
    select.mockRestore();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'reconcile tick failed',
    );
  });
});
