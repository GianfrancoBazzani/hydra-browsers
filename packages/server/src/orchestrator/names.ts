import type { KubeKind } from './types.js';

export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const SESSION_ID_LABEL = 'hydra/session-id';
export const STARTED_AT_ANNOTATION = 'hydra/started-at';
export const MANAGED_BY_SELECTOR = `${MANAGED_BY_LABEL}=hydra`;
export const NEKO_PORT = 8080;
export const MCP_PORT = 8931;

export interface SessionObjectNames {
  pvc: string;
  secret: string;
  configMap: string;
  headlessService: string;
  mediaService: string;
  statefulSet: string;
  pod: string;
}

/** Object names of spec section 7.3. */
export function objectNames(sid: string): SessionObjectNames {
  return {
    pvc: `profile-${sid}`,
    secret: `neko-${sid}`,
    configMap: `chromium-${sid}`,
    headlessService: `session-${sid}`,
    mediaService: `media-${sid}`,
    statefulSet: `session-${sid}`,
    pod: `session-${sid}-0`,
  };
}

/** Labels of spec section 7.1. */
export function sessionLabels(sid: string): Record<string, string> {
  return { [MANAGED_BY_LABEL]: 'hydra', [SESSION_ID_LABEL]: sid };
}

/**
 * The objects that the gateway creates for one session, in delete order. The pod is not in the list:
 * the StatefulSet owns it, and the gateway Role has no `delete` on pods (spec section 11.2).
 */
export function sessionObjectRefs(sid: string): Array<{ kind: KubeKind; name: string }> {
  const n = objectNames(sid);
  return [
    { kind: 'StatefulSet', name: n.statefulSet },
    { kind: 'Service', name: n.mediaService },
    { kind: 'Service', name: n.headlessService },
    { kind: 'ConfigMap', name: n.configMap },
    { kind: 'Secret', name: n.secret },
    { kind: 'PersistentVolumeClaim', name: n.pvc },
  ];
}
