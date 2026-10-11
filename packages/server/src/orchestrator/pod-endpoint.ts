import { createServer, type Server, type Socket } from 'node:net';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import { objectNames, SESSION_ID_LABEL } from './names.js';
import type { KubeClient, KubeWatchEvent } from './types.js';

export interface PodEndpointResolver {
  /** 'http://host:port' of one port of the session pod (spec section 7.3). */
  endpoint(sessionId: string, port: 8080 | 8931): Promise<string>;
  close(): Promise<void>;
}

/** HYDRA_SESSION_TRANSPORT=cluster-dns: the pod DNS name through the headless Service. */
export function clusterDnsEndpoint(namespace: string, sessionId: string, port: number): string {
  const names = objectNames(sessionId);
  return `http://${names.pod}.${names.headlessService}.${namespace}.svc.cluster.local:${port}`;
}

interface Listener {
  server: Server;
  sockets: Set<Socket>;
  url: string;
}

interface Forward {
  podUid: string;
  listeners: Map<number, Promise<Listener>>;
}

/**
 * HYDRA_SESSION_TRANSPORT=port-forward (spec sections 7.3 and 11.7): one port-forward for each pod, with
 * a local listener for each pod port. Each TCP connection opens one tunnel through the API server
 * (client-node supports one port per tunnel). When the pod goes away, the listeners close.
 */
class PortForwardResolver implements PodEndpointResolver {
  private readonly kube: KubeClient;
  private readonly logger: Logger;
  private readonly forwards = new Map<string, Forward>();
  private watchStarted: Promise<void> | null = null;
  private stopWatch: (() => void) | null = null;
  private closed = false;

  constructor(kube: KubeClient, logger: Logger) {
    this.kube = kube;
    this.logger = logger;
  }

  async endpoint(sessionId: string, port: 8080 | 8931): Promise<string> {
    if (this.closed) throw new Error('pod endpoint resolver is closed');
    await this.ensureWatch();
    if (this.closed) throw new Error('pod endpoint resolver is closed');
    let forward = this.forwards.get(sessionId);
    if (!forward) {
      const pod = await this.kube.get('Pod', objectNames(sessionId).pod);
      // close() may have run while the pod was read: create no listener then.
      if (this.closed) throw new Error('pod endpoint resolver is closed');
      if (!pod) throw new Error(`pod ${objectNames(sessionId).pod} does not exist`);
      forward = this.forwards.get(sessionId) ?? {
        podUid: pod.metadata.uid ?? '',
        listeners: new Map(),
      };
      this.forwards.set(sessionId, forward);
    }
    let listener = forward.listeners.get(port);
    if (!listener) {
      const created = this.listen(sessionId, port);
      listener = created;
      forward.listeners.set(port, created);
      // A failed listen is not cached: the next call tries again.
      created.catch(() => {
        if (forward.listeners.get(port) === created) forward.listeners.delete(port);
      });
    }
    return (await listener).url;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopWatch?.();
    this.stopWatch = null;
    await Promise.all([...this.forwards.keys()].map((sessionId) => this.closeForward(sessionId)));
  }

  private ensureWatch(): Promise<void> {
    this.watchStarted ??= this.kube
      .watch((event) => this.onWatchEvent(event))
      .then(
        (stop) => {
          if (this.closed) stop();
          else this.stopWatch = stop;
        },
        (error: unknown) => {
          // A failed watch start is retried by the next endpoint() call.
          this.watchStarted = null;
          throw error;
        },
      );
    return this.watchStarted;
  }

  private onWatchEvent(event: KubeWatchEvent): void {
    if (event.kind !== 'Pod') return;
    const sessionId = event.object.metadata.labels[SESSION_ID_LABEL];
    if (!sessionId) return;
    const forward = this.forwards.get(sessionId);
    if (!forward) return;
    const uid = event.object.metadata.uid ?? '';
    if (
      event.type === 'DELETED' ||
      (uid !== '' && forward.podUid !== '' && uid !== forward.podUid)
    ) {
      void this.closeForward(sessionId);
    }
  }

  private listen(sessionId: string, port: number): Promise<Listener> {
    const podName = objectNames(sessionId).pod;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // Attached first: a reset before the tunnel opens must not be an unhandled 'error'.
      socket.on('error', (error) => {
        this.logger.debug({ err: error, sessionId, port }, 'port-forward connection error');
        socket.destroy();
      });
      this.kube.portForward(podName, port, socket).catch((error: unknown) => {
        this.logger.warn({ err: error, sessionId, port }, 'port-forward failed');
        socket.destroy();
      });
    });
    return new Promise<Listener>((resolve, reject) => {
      let listening = false;
      server.on('error', (error) => {
        if (!listening) {
          reject(error);
          return;
        }
        this.logger.warn({ err: error, sessionId, port }, 'port-forward listener error');
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('port-forward listener has no address'));
          return;
        }
        listening = true;
        resolve({ server, sockets, url: `http://127.0.0.1:${address.port}` });
      });
    });
  }

  private async closeForward(sessionId: string): Promise<void> {
    const forward = this.forwards.get(sessionId);
    if (!forward) return;
    this.forwards.delete(sessionId);
    for (const pending of forward.listeners.values()) {
      const listener = await pending.catch(() => null);
      if (!listener) continue;
      for (const socket of listener.sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.server.close(() => resolve()));
    }
  }
}

export function createPodEndpointResolver(
  config: Config,
  kube: KubeClient,
  logger: Logger,
): PodEndpointResolver {
  if (config.sessionTransport === 'port-forward') return new PortForwardResolver(kube, logger);
  const namespace = config.sessionNamespace;
  return {
    endpoint: (sessionId, port) => Promise.resolve(clusterDnsEndpoint(namespace, sessionId, port)),
    close: () => Promise.resolve(),
  };
}
