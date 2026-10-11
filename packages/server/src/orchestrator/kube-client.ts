import {
  ApiException,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  Observable,
  PatchStrategy,
  PortForward,
  VersionApi,
  Watch,
  type ConfigurationOptions,
  type KubernetesObject,
  type RequestContext,
  type V1Pod,
  type V1Service,
} from '@kubernetes/client-node';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Duplex } from 'node:stream';
import type { Config } from '../config/index.js';
import { MANAGED_BY_LABEL, MANAGED_BY_SELECTOR } from './names.js';
import type { KubeClient, KubeKind, KubeObject, KubeWatchEvent } from './types.js';

const FIELD_MANAGER = 'hydra';
const PING_TIMEOUT_MS = 3_000;
/**
 * Timeout of every Kubernetes API call except the watches. client-node 2.0.0 has no request
 * timeout of its own (undici waits 300 s), so a hung API server would stall the reconciler.
 */
export const KUBE_CALL_TIMEOUT_MS = 15_000;
/** The server ends each watch after 25 s, before the 30 s request timeout of client-node 2.0.0. */
const WATCH_SERVER_TIMEOUT_S = 25;
const WATCH_RESTART_MS = 1_000;
const WATCH_RETRY_MAX_MS = 30_000;
const OUT_OF_RANGE_TEXT = 'provided port is not in the valid range';

const KINDS: Record<KubeKind, { apiVersion: string; plural: string }> = {
  PersistentVolumeClaim: { apiVersion: 'v1', plural: 'persistentvolumeclaims' },
  Secret: { apiVersion: 'v1', plural: 'secrets' },
  ConfigMap: { apiVersion: 'v1', plural: 'configmaps' },
  Service: { apiVersion: 'v1', plural: 'services' },
  StatefulSet: { apiVersion: 'apps/v1', plural: 'statefulsets' },
  Pod: { apiVersion: 'v1', plural: 'pods' },
};

export const WATCHED_KINDS: readonly KubeKind[] = [
  'Pod',
  'StatefulSet',
  'Service',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
];

/** In-cluster config if the pod has the service environment, else KUBECONFIG or ~/.kube/config. */
export function loadKubeConfig(env: Record<string, string | undefined> = process.env): KubeConfig {
  const kubeConfig = new KubeConfig();
  if (env['KUBERNETES_SERVICE_HOST'] && env['KUBERNETES_SERVICE_PORT'])
    kubeConfig.loadFromCluster();
  else kubeConfig.loadFromDefault();
  return kubeConfig;
}

export function isApiStatus(error: unknown, code: number): boolean {
  return error instanceof ApiException && error.code === code;
}

/** The `message` of a Kubernetes Status body, or the error message. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiException) {
    const body: unknown = error.body;
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
      return body.message;
    if (typeof body === 'string') {
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'message' in parsed &&
          typeof parsed.message === 'string'
        ) {
          return parsed.message;
        }
      } catch {
        return body;
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A 410 Gone error. client-node reports a non-200 watch answer with `statusCode`; ApiException has
 * `code`.
 */
function isGone(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (
    ('statusCode' in error && error.statusCode === 410) || ('code' in error && error.code === 410)
  );
}

function watchPath(kind: KubeKind, namespace: string): string {
  const { apiVersion, plural } = KINDS[kind];
  const prefix = apiVersion === 'v1' ? '/api/v1' : `/apis/${apiVersion}`;
  return `${prefix}/namespaces/${namespace}/${plural}`;
}

/** List items and watch objects have no kind; reads return class instances. Make them plain KubeObjects. */
function normalize(kind: KubeKind, object: KubernetesObject, namespace: string): KubeObject {
  const metadata = object.metadata ?? {};
  return {
    ...object,
    apiVersion: KINDS[kind].apiVersion,
    kind,
    metadata: {
      ...metadata,
      name: metadata.name ?? '',
      namespace: metadata.namespace ?? namespace,
      labels: metadata.labels ?? {},
    },
  };
}

/** The part of the port-forward WebSocket that the gateway uses. */
interface TunnelSocket {
  on(event: 'close' | 'error', listener: () => void): void;
  close(): void;
}

function containerHasStarted(pod: KubeObject, container: string): boolean {
  const status = (pod as V1Pod).status?.containerStatuses?.find(
    (entry) => entry.name === container,
  );
  return Boolean(
    status && (status.state?.running || status.state?.terminated || status.lastState?.terminated),
  );
}

/** The signal of the call that is running, for the calls of the dynamic object client. */
const callSignal = new AsyncLocalStorage<AbortSignal>();

/** KubernetesObjectApi has no per-call middleware: the request gets the signal of the call here. */
class AbortableObjectApi extends KubernetesObjectApi {
  static create(kubeConfig: KubeConfig): AbortableObjectApi {
    const client = kubeConfig.makeApiClient(AbortableObjectApi);
    client.setDefaultNamespace(kubeConfig);
    return client;
  }

  protected override requestPromise<T extends KubernetesObject>(
    requestContext: RequestContext,
    type?: string,
    options?: Parameters<KubernetesObjectApi['resource']>[2],
  ): Promise<T> {
    const signal = callSignal.getStore();
    if (signal) requestContext.setSignal(signal);
    return super.requestPromise<T>(requestContext, type, options);
  }
}

/** Per-call options of the generated clients: the request gets the signal. */
function withSignal(signal: AbortSignal): ConfigurationOptions {
  return {
    middleware: [
      {
        pre: (context) => {
          context.setSignal(signal);
          return new Observable(Promise.resolve(context));
        },
        post: (response) => new Observable(Promise.resolve(response)),
      },
    ],
    middlewareMergeStrategy: 'append',
  };
}

/**
 * Runs one API call. After `ms` the call rejects with an Error and its request is aborted, so no
 * request outlives the timeout.
 */
function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`timeout after ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
    callSignal
      .run(controller.signal, () => run(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

export interface KubeClientOptions {
  /** Timeout of each API call except the watches. */
  callTimeoutMs?: number;
  pingTimeoutMs?: number;
}

export function createKubeClient(
  config: Config,
  kubeConfig: KubeConfig = loadKubeConfig(),
  { callTimeoutMs = KUBE_CALL_TIMEOUT_MS, pingTimeoutMs = PING_TIMEOUT_MS }: KubeClientOptions = {},
): KubeClient {
  const namespace = config.sessionNamespace;
  const objects = AbortableObjectApi.create(kubeConfig);
  const core = kubeConfig.makeApiClient(CoreV1Api);
  const version = kubeConfig.makeApiClient(VersionApi);
  const ref = (kind: KubeKind, name: string) => ({
    apiVersion: KINDS[kind].apiVersion,
    kind,
    metadata: { name, namespace },
  });

  const get = async (kind: KubeKind, name: string): Promise<KubeObject | null> => {
    try {
      const object = await withTimeout(callTimeoutMs, () => objects.read(ref(kind, name)));
      return normalize(kind, object, namespace);
    } catch (error) {
      if (isApiStatus(error, 404)) return null;
      throw error;
    }
  };

  const remove = async (kind: KubeKind, name: string): Promise<void> => {
    try {
      await withTimeout(callTimeoutMs, () => objects.delete(ref(kind, name)));
    } catch (error) {
      if (!isApiStatus(error, 404)) throw error;
    }
  };

  return {
    async apply(object) {
      await withTimeout(callTimeoutMs, () =>
        objects.patch(
          object,
          undefined,
          undefined,
          FIELD_MANAGER,
          true,
          PatchStrategy.ServerSideApply,
        ),
      );
    },

    remove,

    get,

    async list(kind, labelSelector) {
      const result = await withTimeout(callTimeoutMs, () =>
        objects.list(
          KINDS[kind].apiVersion,
          kind,
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          labelSelector,
        ),
      );
      return result.items.map((item) => normalize(kind, item, namespace));
    },

    async watch(handler: (event: KubeWatchEvent) => void) {
      const watcher = new Watch(kubeConfig);
      const controllers = new Map<KubeKind, AbortController>();
      const timers = new Set<NodeJS.Timeout>();
      const resourceVersions = new Map<KubeKind, string>();
      let stopped = false;

      const start = async (kind: KubeKind, failures: number): Promise<void> => {
        if (stopped) return;
        const retry = (delayMs: number, nextFailures: number) => {
          if (stopped) return;
          const timer = setTimeout(() => {
            timers.delete(timer);
            void start(kind, nextFailures);
          }, delayMs);
          timers.add(timer);
        };
        const backoffMs = Math.min(1_000 * 2 ** failures, WATCH_RETRY_MAX_MS);
        let received = false;
        let controller: AbortController;
        try {
          controller = await watcher.watch(
            watchPath(kind, namespace),
            {
              labelSelector: MANAGED_BY_SELECTOR,
              allowWatchBookmarks: true,
              timeoutSeconds: WATCH_SERVER_TIMEOUT_S,
              resourceVersion: resourceVersions.get(kind),
            },
            (phase: string, apiObject: unknown) => {
              received = true;
              const object = apiObject as KubernetesObject & { code?: number };
              if (phase === 'ERROR') {
                // 410 Gone: the resource version is too old. The next start lists all objects.
                if (object.code === 410) resourceVersions.delete(kind);
                return;
              }
              const resourceVersion = object.metadata?.resourceVersion;
              if (resourceVersion) resourceVersions.set(kind, resourceVersion);
              if (phase === 'ADDED' || phase === 'MODIFIED' || phase === 'DELETED') {
                handler({ kind, type: phase, object: normalize(kind, object, namespace) });
              }
            },
            (error: unknown) => {
              controllers.delete(kind);
              // An HTTP 410 answer: drop the resource version, so the next watch lists again.
              if (isGone(error)) resourceVersions.delete(kind);
              // The next watch resumes at the last resource version, so a restart loses no event.
              if (error && !received) retry(backoffMs, failures + 1);
              else retry(WATCH_RESTART_MS, 0);
            },
          );
        } catch (error) {
          if (isGone(error)) resourceVersions.delete(kind);
          retry(backoffMs, failures + 1);
          return;
        }
        if (stopped) controller.abort();
        else controllers.set(kind, controller);
      };

      await Promise.all(WATCHED_KINDS.map((kind) => start(kind, 0)));
      return () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        for (const controller of controllers.values()) controller.abort();
      };
    },

    async readLog(podName, container, tailLines) {
      // A pod without a node gives 204 without a body, which client-node cannot parse. Thus read the
      // log only after the container has started.
      const pod = await get('Pod', podName);
      if (!pod || !containerHasStarted(pod, container)) return '';
      try {
        return await withTimeout(callTimeoutMs, (signal) =>
          core.readNamespacedPodLog(
            { name: podName, namespace, container, tailLines },
            withSignal(signal),
          ),
        );
      } catch (error) {
        // 404: the pod is gone. 400: the container does not run (race with the check above).
        if (isApiStatus(error, 404) || isApiStatus(error, 400)) return '';
        throw error;
      }
    },

    async checkNodePorts(ports) {
      for (const port of ports) {
        const name = `hydra-port-check-${port}`;
        await remove('Service', name);
        const service: V1Service = {
          apiVersion: 'v1',
          kind: 'Service',
          // No selector and no hydra/session-id label (spec section 4): the reconciler ignores it.
          metadata: { name, namespace, labels: { [MANAGED_BY_LABEL]: 'hydra' } },
          spec: {
            type: 'NodePort',
            ports: [{ name: 'check', protocol: 'TCP', port, targetPort: port, nodePort: port }],
          },
        };
        try {
          await withTimeout(callTimeoutMs, (signal) =>
            core.createNamespacedService(
              { namespace, body: service, fieldManager: FIELD_MANAGER },
              withSignal(signal),
            ),
          );
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
          const message = apiErrorMessage(error);
          if (error.code === 422 && message.includes(OUT_OF_RANGE_TEXT))
            return { outOfRange: true, message };
          // Other answers pass the check, for example a port in use (spec section 4).
          continue;
        }
        await remove('Service', name);
      }
      return { outOfRange: false, message: null };
    },

    async ping() {
      try {
        await withTimeout(pingTimeoutMs, (signal) => version.getCode({}, withSignal(signal)));
        return true;
      } catch {
        return false;
      }
    },

    async portForward(podName: string, port: number, socket: Duplex) {
      const forward = new PortForward(kubeConfig);
      // The WebSocket type of client-node comes from isomorphic-ws, whose types need @types/ws.
      const opened: unknown = await forward.portForward(
        namespace,
        podName,
        [port],
        socket,
        null,
        socket,
      );
      const webSocket = (
        typeof opened === 'function' ? (opened as () => unknown)() : opened
      ) as TunnelSocket | null;
      if (!webSocket) {
        socket.destroy();
        throw new Error(`port-forward to ${podName}:${port} did not open`);
      }
      webSocket.on('close', () => socket.destroy());
      webSocket.on('error', () => socket.destroy());
      socket.on('close', () => webSocket.close());
      socket.on('error', () => webSocket.close());
    },
  };
}
