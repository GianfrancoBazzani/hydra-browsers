import type { KubernetesObject } from '@kubernetes/client-node';
import type { Duplex } from 'node:stream';

/** The Kubernetes kinds that the gateway manages in HYDRA_SESSION_NAMESPACE (spec section 7.3). */
export type KubeKind =
  'PersistentVolumeClaim' | 'Secret' | 'ConfigMap' | 'Service' | 'StatefulSet' | 'Pod';

export type KubeObject = KubernetesObject & {
  kind: KubeKind;
  metadata: { name: string; namespace: string; labels: Record<string, string> };
};

export interface KubeWatchEvent {
  kind: KubeKind;
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  object: KubeObject;
}

export interface KubeClient {
  /** Server-side apply, field manager 'hydra', force. */
  apply(object: KubeObject): Promise<void>;
  /** Delete. A 404 answer counts as success. */
  remove(kind: KubeKind, name: string): Promise<void>;
  get(kind: KubeKind, name: string): Promise<KubeObject | null>;
  list(kind: KubeKind, labelSelector: string): Promise<KubeObject[]>;
  /** Watches all kinds with the label app.kubernetes.io/managed-by=hydra. Returns the stop function. */
  watch(handler: (event: KubeWatchEvent) => void): Promise<() => void>;
  /** The last lines of a container log. '' if the pod or the container does not exist yet. */
  readLog(podName: string, container: 'neko' | 'mcp', tailLines: number): Promise<string>;
  /**
   * Startup check of HYDRA_MEDIA_PORT_RANGE (spec section 4). For each port: delete a leftover
   * Service hydra-port-check-<port>, create that NodePort Service, delete it at once.
   */
  checkNodePorts(ports: number[]): Promise<{ outOfRange: boolean; message: string | null }>;
  /** true if the Kubernetes API answers. */
  ping(): Promise<boolean>;
  /** Connects the socket to a port of a pod through the API server (port-forward transport). */
  portForward(podName: string, port: number, socket: Duplex): Promise<void>;
}
