import type { V1Service } from '@kubernetes/client-node';
import { objectNames, SESSION_ID_LABEL, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

/**
 * NodePort Service media-<sid> (spec sections 7.3 and 7.8). port, targetPort, and nodePort are all
 * the media port, for UDP and TCP. It exists only while the session holds a media port.
 */
export function buildMediaService(
  sid: string,
  namespace: string,
  mediaPort: number,
): V1Service & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: objectNames(sid).mediaService, namespace, labels: sessionLabels(sid) },
    spec: {
      type: 'NodePort',
      externalTrafficPolicy: 'Local',
      selector: { [SESSION_ID_LABEL]: sid },
      ports: [
        {
          name: 'media-udp',
          protocol: 'UDP',
          port: mediaPort,
          targetPort: mediaPort,
          nodePort: mediaPort,
        },
        {
          name: 'media-tcp',
          protocol: 'TCP',
          port: mediaPort,
          targetPort: mediaPort,
          nodePort: mediaPort,
        },
      ],
    },
  };
}
