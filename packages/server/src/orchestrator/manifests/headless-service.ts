import type { V1Service } from '@kubernetes/client-node';
import { MCP_PORT, NEKO_PORT, objectNames, SESSION_ID_LABEL, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

/** Headless Service session-<sid>: gives the pod its DNS name (spec section 7.3). */
export function buildHeadlessService(sid: string, namespace: string): V1Service & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: objectNames(sid).headlessService, namespace, labels: sessionLabels(sid) },
    spec: {
      clusterIP: 'None',
      selector: { [SESSION_ID_LABEL]: sid },
      ports: [
        { name: 'neko', protocol: 'TCP', port: NEKO_PORT, targetPort: NEKO_PORT },
        { name: 'mcp', protocol: 'TCP', port: MCP_PORT, targetPort: MCP_PORT },
      ],
    },
  };
}
