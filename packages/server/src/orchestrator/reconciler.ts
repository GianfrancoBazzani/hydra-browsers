import { and, eq, isNull, ne, type SQL } from 'drizzle-orm';
import type { V1StatefulSet } from '@kubernetes/client-node';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AuditWriter } from '../audit/index.js';
import type { Config } from '../config/index.js';
import type { Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { sessions, type SessionRow } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import { buildSessionObjects } from './manifests/index.js';
import { MANAGED_BY_SELECTOR, objectNames, SESSION_ID_LABEL, sessionObjectRefs } from './names.js';
import { observePod } from './pod-status.js';
import { desiredStateOf, stateOf } from './row-fields.js';
import { decideState, type StatePlan } from './state-rules.js';
import type { KubeClient, KubeKind, KubeObject, KubeWatchEvent } from './types.js';

export const RECONCILE_INTERVAL_MS = 30_000;
export const BACKOFF_MAX_MS = 300_000;

/** 1 s, 2 s, 4 s, … up to 5 min (spec section 7.9). */
export function backoffDelayMs(failures: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

export interface ReconcilerDeps {
  db: Db;
  kube: KubeClient;
  config: Config;
  subkeys: Subkeys;
  clock: Clock;
  logger: Logger;
  audit: AuditWriter;
  bus: EventBus;
}

/** Kinds that the orphan pass lists (spec section 7.9 "Orphans"). Pods belong to their StatefulSet. */
const ORPHAN_KINDS: readonly KubeKind[] = [
  'StatefulSet',
  'Service',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
];

function sameOrNull(column: SQLiteColumn, value: number | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

/** An apply object made from an object that the API returned: no status and no server metadata. */
export function toApplyObject(object: KubeObject): KubeObject {
  const spec = (object as { spec?: unknown }).spec;
  return {
    apiVersion: object.apiVersion,
    kind: object.kind,
    metadata: {
      name: object.metadata.name,
      namespace: object.metadata.namespace,
      labels: object.metadata.labels,
    },
    ...(spec === undefined ? {} : { spec }),
  };
}

export class Reconciler {
  private readonly deps: ReconcilerDeps;
  private started = false;
  private readonly queue = new Set<string>();
  private orphanPassQueued = false;
  private draining: Promise<void> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopWatch: (() => void) | null = null;
  private readonly failures = new Map<
    string,
    { count: number; retryAt: number; timer: NodeJS.Timeout }
  >();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly warnedOrphans = new Set<string>();

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
  }

  /** First pass over all sessions and orphans, then the watch, then a pass every 30 s. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.enqueueAll();
    this.kick();
    await this.idle();
    // stop() may have run while the first pass waited for Kubernetes: then start no watch and no interval.
    if (!this.started) return;
    await this.startWatch();
    if (!this.started) return;
    this.interval = setInterval(() => this.onInterval(), RECONCILE_INTERVAL_MS);
    this.interval.unref();
  }

  /** One 30 s tick. A throw here would be an uncaught exception from a timer, so it is logged. */
  private onInterval(): void {
    try {
      if (!this.stopWatch) void this.startWatch();
      this.enqueueAll();
      this.kick();
    } catch (error) {
      this.deps.logger.error({ err: error }, 'reconcile tick failed');
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.stopWatch?.();
    this.stopWatch = null;
    for (const failure of this.failures.values()) clearTimeout(failure.timer);
    this.failures.clear();
    this.queue.clear();
    this.orphanPassQueued = false;
    await this.idle();
  }

  /** A pass for one session soon (after an API action). Ignores the backoff. No effect before start(). */
  trigger(sessionId: string): void {
    if (!this.started) return;
    this.queue.add(sessionId);
    this.kick();
  }

  /** One pass for one session (spec section 7.9, steps 1 and 2). Throws if a Kubernetes call fails. */
  async reconcileSession(sessionId: string): Promise<void> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.pass(sessionId));
    this.locks.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    }
  }

  /** The backoff state of a session, or null (tests and diagnostics). */
  backoff(sessionId: string): { failures: number; retryAt: number } | null {
    const failure = this.failures.get(sessionId);
    return failure ? { failures: failure.count, retryAt: failure.retryAt } : null;
  }

  /** Resolves when the queue is empty. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async startWatch(): Promise<void> {
    try {
      this.stopWatch = await this.deps.kube.watch((event) => this.onWatchEvent(event));
      if (!this.started) {
        this.stopWatch();
        this.stopWatch = null;
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, 'kubernetes watch failed to start');
    }
  }

  private onWatchEvent(event: KubeWatchEvent): void {
    const sessionId = event.object.metadata.labels[SESSION_ID_LABEL];
    if (!sessionId) return;
    this.enqueue(sessionId);
    this.kick();
  }

  private enqueue(sessionId: string): void {
    const failure = this.failures.get(sessionId);
    if (failure && failure.retryAt > this.deps.clock.now()) return;
    this.queue.add(sessionId);
  }

  private enqueueAll(): void {
    const rows = this.deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(ne(sessions.state, 'deleted'))
      .all();
    for (const row of rows) this.enqueue(row.id);
    this.orphanPassQueued = true;
  }

  private kick(): void {
    if (!this.started || this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.started && (this.queue.size > 0 || this.orphanPassQueued)) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.started) {
      if (this.orphanPassQueued) {
        this.orphanPassQueued = false;
        await this.runOrphanPass();
        continue;
      }
      const next = this.queue.values().next();
      if (next.done) return;
      this.queue.delete(next.value);
      await this.runSession(next.value);
    }
  }

  private async runSession(sessionId: string): Promise<void> {
    try {
      await this.reconcileSession(sessionId);
      const failure = this.failures.get(sessionId);
      if (failure) clearTimeout(failure.timer);
      this.failures.delete(sessionId);
    } catch (error) {
      // A pass that fails after stop() schedules no retry: stop() has cleared the timers.
      if (!this.started) {
        this.deps.logger.error({ err: error, sessionId }, 'reconcile failed after stop');
        return;
      }
      const count = (this.failures.get(sessionId)?.count ?? 0) + 1;
      const delayMs = backoffDelayMs(count);
      const previous = this.failures.get(sessionId);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => {
        if (!this.started) return;
        this.queue.add(sessionId);
        this.kick();
      }, delayMs);
      timer.unref();
      this.failures.set(sessionId, { count, retryAt: this.deps.clock.now() + delayMs, timer });
      this.deps.logger.error({ err: error, sessionId, retryInMs: delayMs }, 'reconcile failed');
    }
  }

  private loadRow(sessionId: string): SessionRow | undefined {
    return this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  }

  private async pass(sessionId: string): Promise<void> {
    const row = this.loadRow(sessionId);
    if (!row) {
      await this.handleOrphan(sessionId);
      return;
    }
    const { kube } = this.deps;
    const names = objectNames(sessionId);
    const desiredState = desiredStateOf(row);

    // Step 1: objects.
    if (desiredState === 'deleted') {
      for (const ref of sessionObjectRefs(sessionId)) await kube.remove(ref.kind, ref.name);
    } else {
      for (const object of buildSessionObjects(row, this.deps)) await kube.apply(object);
      if (row.mediaPort === null) await kube.remove('Service', names.mediaService);
    }

    // Step 2: state.
    const pod = await kube.get('Pod', names.pod);
    let allObjectsGone = false;
    if (desiredState === 'deleted' && pod === null) {
      allObjectsGone = true;
      for (const ref of sessionObjectRefs(sessionId)) {
        if ((await kube.get(ref.kind, ref.name)) !== null) {
          allObjectsGone = false;
          break;
        }
      }
    }
    const plan = decideState({
      state: stateOf(row),
      desiredState,
      startedAt: row.startedAt,
      readyAt: row.readyAt,
      mediaPort: row.mediaPort,
      pod: observePod(pod, row.startedAt),
      allObjectsGone,
      now: this.deps.clock.now(),
    });
    // Release order of spec section 7.8: the Service first, then media_port = NULL.
    if (plan.releasePort) await kube.remove('Service', names.mediaService);
    this.write(row, plan);
  }

  /** Writes the plan only if the row did not change during the pass. Else the next pass decides again. */
  private write(row: SessionRow, plan: StatePlan): void {
    if (Object.keys(plan.patch).length === 0) return;
    const result = this.deps.db
      .update(sessions)
      .set({ ...plan.patch, updatedAt: this.deps.clock.now() })
      .where(
        and(
          eq(sessions.id, row.id),
          eq(sessions.state, row.state),
          eq(sessions.desiredState, row.desiredState),
          sameOrNull(sessions.startedAt, row.startedAt),
          sameOrNull(sessions.mediaPort, row.mediaPort),
        ),
      )
      .run();
    if (result.changes === 0) {
      this.trigger(row.id);
      return;
    }
    const previous = stateOf(row);
    const state = plan.patch.state;
    if (state === undefined || state === previous) return;
    const errorReason = plan.patch.errorReason ?? (state === 'error' ? row.errorReason : null);
    this.deps.audit.write({
      kind: 'session.state',
      actorType: 'system',
      actorId: null,
      sessionId: row.id,
      data: { state, previous, errorReason },
    });
    this.deps.bus.publish({
      type: 'session.state',
      sessionId: row.id,
      state,
      previous,
      errorReason,
    });
  }

  private async runOrphanPass(): Promise<void> {
    try {
      const rows = this.deps.db
        .select({ id: sessions.id, state: sessions.state })
        .from(sessions)
        .all();
      const known = new Map(rows.map((row) => [row.id, row.state]));
      const orphans = new Set<string>();
      for (const kind of ORPHAN_KINDS) {
        for (const object of await this.deps.kube.list(kind, MANAGED_BY_SELECTOR)) {
          const sessionId = object.metadata.labels[SESSION_ID_LABEL];
          if (!sessionId) continue;
          const state = known.get(sessionId);
          if (state === undefined) orphans.add(sessionId);
          else if (state === 'deleted') this.queue.add(sessionId);
        }
      }
      for (const sessionId of orphans) await this.handleOrphan(sessionId);
    } catch (error) {
      this.deps.logger.error({ err: error }, 'orphan pass failed');
    }
  }

  /**
   * Objects without a session row, for example after a restore of an older DB backup. Never delete
   * the PVC or the Secret: scale the StatefulSet to 0, delete media-<sid> (it holds a node port), and
   * log a warning. The operator removes the other objects by hand.
   */
  private async handleOrphan(sessionId: string): Promise<void> {
    const names = objectNames(sessionId);
    const statefulSet = await this.deps.kube.get('StatefulSet', names.statefulSet);
    if (statefulSet && (statefulSet as V1StatefulSet).spec?.replicas !== 0) {
      const object = toApplyObject(statefulSet) as KubeObject & { spec: Record<string, unknown> };
      await this.deps.kube.apply({
        ...object,
        spec: { ...object.spec, replicas: 0 },
      } as KubeObject);
    }
    await this.deps.kube.remove('Service', names.mediaService);
    if (!this.warnedOrphans.has(sessionId)) {
      this.warnedOrphans.add(sessionId);
      this.deps.logger.warn(
        { sessionId },
        'orphan session objects without a session row: StatefulSet scaled to 0, media Service deleted; remove the other objects with kubectl delete',
      );
    }
  }
}
