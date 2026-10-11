import type { V1PersistentVolumeClaim } from '@kubernetes/client-node';
import { objectNames, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

/** PVC profile-<sid> (spec sections 5.2 and 7.3). local-path does not enforce the size. */
export function buildPvc(sid: string, namespace: string): V1PersistentVolumeClaim & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: objectNames(sid).pvc, namespace, labels: sessionLabels(sid) },
    spec: {
      storageClassName: 'hydra-profile',
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '5Gi' } },
    },
  };
}
