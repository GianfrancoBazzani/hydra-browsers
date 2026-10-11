/*
 * FakeKubeClient: an in-memory KubeClient. Differences from the real client (kube-client.ts), so
 * that plans 05 and 06 do not depend on them:
 * - Watch events are emitted synchronously inside apply and remove, not later.
 * - There is no initial ADDED replay on watch, and no label filter.
 * - Removing a StatefulSet does not remove its pod.
 * - ping() ignores failNext.
 * - readLog returns the text of setLog even if there is no pod.
 * - checkNodePorts creates no Service in the store.
 */
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { objectNames, sessionLabels, STARTED_AT_ANNOTATION } from '../../src/orchestrator/names.js';
import type {
  KubeClient,
  KubeKind,
  KubeObject,
  KubeWatchEvent,
} from '../../src/orchestrator/types.js';

export type FakeKubeOperation =
  'apply' | 'remove' | 'get' | 'list' | 'readLog' | 'checkNodePorts' | 'portForward';

interface FakePodStatus {
  phase: string;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
  containerStatuses: Array<{
    name: string;
    ready: boolean;
    state: { running?: Record<string, never>; waiting?: { reason: string; message: string } };
  }>;
}

type FakePod = KubeObject & { status: FakePodStatus };
type WithTemplate = {
  spec?: { template?: { metadata?: { annotations?: Record<string, string> } } };
};

const key = (kind: KubeKind, name: string): string => `${kind}/${name}`;

/** Compares two objects without the fields that the fake API server sets. */
function sameContent(a: KubeObject, b: KubeObject): boolean {
  const strip = (o: KubeObject) =>
    JSON.stringify({
      ...o,
      metadata: { ...o.metadata, uid: undefined, resourceVersion: undefined },
    });
  return strip(a) === strip(b);
}

/**
 * KubeClient in memory (index section 5.12). Objects live in a map; each change emits a watch event
 * to all handlers. The test helpers model the pod that the StatefulSet controller and the kubelet
 * create. Like a real client, each method returns a rejected promise on failure.
 */
export class FakeKubeClient implements KubeClient {
  readonly namespace: string;
  /** Each call of a KubeClient method, in order. */
  readonly calls: Array<{ op: FakeKubeOperation; kind?: KubeKind; name?: string }> = [];
  /** service-node-port-range of the fake API server, for checkNodePorts (spec section 11.6 default). */
  nodePortRange = { first: 30000, last: 52099 };
  /** Result of ping(). */
  pingResult = true;
  private readonly store = new Map<string, KubeObject>();
  private readonly handlers = new Set<(event: KubeWatchEvent) => void>();
  private readonly failures: Array<{ op: FakeKubeOperation; error: Error }> = [];
  private readonly logs = new Map<string, string>();
  private readonly forwardTargets = new Map<string, { host: string; port: number }>();
  private version = 0;

  constructor(namespace = 'hydra-sessions') {
    this.namespace = namespace;
  }

  apply(object: KubeObject): Promise<void> {
    return this.perform('apply', object.kind, object.metadata.name, () => {
      const id = key(object.kind, object.metadata.name);
      const existing = this.store.get(id);
      const next = structuredClone(object);
      next.metadata.namespace = this.namespace;
      next.metadata.uid = existing?.metadata.uid ?? `uid-${++this.version}`;
      next.metadata.resourceVersion = existing?.metadata.resourceVersion ?? '0';
      if (existing && sameContent(existing, next)) return;
      next.metadata.resourceVersion = String(++this.version);
      this.store.set(id, next);
      this.emit(existing ? 'MODIFIED' : 'ADDED', next);
    });
  }

  remove(kind: KubeKind, name: string): Promise<void> {
    return this.perform('remove', kind, name, () => {
      const existing = this.store.get(key(kind, name));
      if (!existing) return;
      this.store.delete(key(kind, name));
      this.emit('DELETED', existing);
    });
  }

  get(kind: KubeKind, name: string): Promise<KubeObject | null> {
    return this.perform('get', kind, name, () => {
      const object = this.store.get(key(kind, name));
      return object ? structuredClone(object) : null;
    });
  }

  list(kind: KubeKind, labelSelector: string): Promise<KubeObject[]> {
    return this.perform('list', kind, undefined, () => {
      const terms = labelSelector
        .split(',')
        .filter((term) => term !== '')
        .map((term) => term.split('=') as [string, string]);
      return [...this.store.values()]
        .filter((o) => o.kind === kind && terms.every(([k, v]) => o.metadata.labels[k] === v))
        .map((o) => structuredClone(o));
    });
  }

  watch(handler: (event: KubeWatchEvent) => void): Promise<() => void> {
    this.handlers.add(handler);
    return Promise.resolve(() => {
      this.handlers.delete(handler);
    });
  }

  readLog(podName: string, container: 'neko' | 'mcp', tailLines: number): Promise<string> {
    return this.perform('readLog', 'Pod', podName, () => {
      const lines = (this.logs.get(`${podName}/${container}`) ?? '').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.length === 0 ? '' : `${lines.slice(-tailLines).join('\n')}\n`;
    });
  }

  checkNodePorts(ports: number[]): Promise<{ outOfRange: boolean; message: string | null }> {
    return this.perform('checkNodePorts', undefined, undefined, () => {
      const { first, last } = this.nodePortRange;
      const bad = ports.find((port) => port < first || port > last);
      if (bad === undefined) return { outOfRange: false, message: null };
      return {
        outOfRange: true,
        message: `Service "hydra-port-check-${bad}" is invalid: spec.ports[0].nodePort: Invalid value: ${bad}: provided port is not in the valid range. The range of valid ports is ${first}-${last}`,
      };
    });
  }

  ping(): Promise<boolean> {
    return Promise.resolve(this.pingResult);
  }

  async portForward(podName: string, port: number, socket: Duplex): Promise<void> {
    const target = await this.perform('portForward', 'Pod', podName, () => {
      if (!this.store.has(key('Pod', podName))) throw new Error(`pod ${podName} not found`);
      const found = this.forwardTargets.get(`${podName}:${port}`);
      if (!found) throw new Error(`no port-forward target for ${podName}:${port}`);
      return found;
    });
    const upstream = connect(target.port, target.host);
    await new Promise<void>((resolve, reject) => {
      upstream.once('connect', resolve);
      upstream.once('error', reject);
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.on('close', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }

  // Test helpers of index section 5.12.

  /** Creates the pod `session-<sid>-0` if it is missing, with the annotation of the current template, and sets Ready. */
  setPodReady(sid: string, ready: boolean): void {
    const pod = this.podOf(sid);
    pod.status.conditions = [
      { type: 'PodScheduled', status: 'True' },
      ready
        ? { type: 'Ready', status: 'True' }
        : {
            type: 'Ready',
            status: 'False',
            reason: 'ContainersNotReady',
            message: 'containers with unready status: [neko]',
          },
    ];
    pod.status.containerStatuses = ['neko', 'mcp'].map((name) => ({
      name,
      ready,
      state: { running: {} },
    }));
    this.storePod(pod);
  }

  /** Makes the neko container of the pod wait with this reason (the pod is created if it is missing). */
  setContainerWaiting(sid: string, reason: string, message = `${reason}: back-off`): void {
    const pod = this.podOf(sid);
    pod.status.conditions = [
      { type: 'PodScheduled', status: 'True' },
      {
        type: 'Ready',
        status: 'False',
        reason: 'ContainersNotReady',
        message: 'containers with unready status: [neko]',
      },
    ];
    pod.status.containerStatuses = [
      { name: 'neko', ready: false, state: { waiting: { reason, message } } },
      { name: 'mcp', ready: true, state: { running: {} } },
    ];
    this.storePod(pod);
  }

  /** Deletes the pod, as the StatefulSet controller does after a scale to 0 or a template change. */
  removePod(sid: string): void {
    const id = key('Pod', objectNames(sid).pod);
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.delete(id);
    this.emit('DELETED', existing);
  }

  /** The stored object, without a recorded call. */
  object(kind: KubeKind, name: string): KubeObject | undefined {
    const object = this.store.get(key(kind, name));
    return object ? structuredClone(object) : undefined;
  }

  /** The keys of all stored objects of one session, sorted: ['ConfigMap/chromium-<sid>', …]. */
  objectsOf(sid: string): string[] {
    return [...this.store.entries()]
      .filter(([, object]) => object.metadata.labels['hydra/session-id'] === sid)
      .map(([id]) => id)
      .sort();
  }

  /** The next call of this operation fails with the error. */
  failNext(op: FakeKubeOperation, error: Error = new Error(`fake ${op} failure`)): void {
    this.failures.push({ op, error });
  }

  setLog(podName: string, container: 'neko' | 'mcp', text: string): void {
    this.logs.set(`${podName}/${container}`, text);
  }

  setPortForwardTarget(
    podName: string,
    port: number,
    target: { host: string; port: number },
  ): void {
    this.forwardTargets.set(`${podName}:${port}`, target);
  }

  private perform<T>(
    op: FakeKubeOperation,
    kind: KubeKind | undefined,
    name: string | undefined,
    run: () => T,
  ): Promise<T> {
    this.calls.push({ op, ...(kind ? { kind } : {}), ...(name ? { name } : {}) });
    const index = this.failures.findIndex((failure) => failure.op === op);
    if (index !== -1) {
      const failure = this.failures.splice(index, 1)[0];
      return Promise.reject(failure?.error ?? new Error(`fake ${op} failure`));
    }
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private podOf(sid: string): FakePod {
    const name = objectNames(sid).pod;
    const existing = this.store.get(key('Pod', name));
    if (existing) return structuredClone(existing) as FakePod;
    const statefulSet: unknown = this.store.get(key('StatefulSet', objectNames(sid).statefulSet));
    const template = (statefulSet as WithTemplate | undefined)?.spec?.template;
    const startedAt = template?.metadata?.annotations?.[STARTED_AT_ANNOTATION] ?? '0';
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: this.namespace,
        labels: sessionLabels(sid),
        annotations: { [STARTED_AT_ANNOTATION]: startedAt },
        uid: `uid-${++this.version}`,
      },
      status: { phase: 'Running', conditions: [], containerStatuses: [] },
    };
  }

  private storePod(pod: FakePod): void {
    const id = key('Pod', pod.metadata.name);
    const existed = this.store.has(id);
    pod.metadata.resourceVersion = String(++this.version);
    this.store.set(id, pod);
    this.emit(existed ? 'MODIFIED' : 'ADDED', pod);
  }

  private emit(type: KubeWatchEvent['type'], object: KubeObject): void {
    for (const handler of [...this.handlers]) {
      handler({ kind: object.kind, type, object: structuredClone(object) });
    }
  }
}
